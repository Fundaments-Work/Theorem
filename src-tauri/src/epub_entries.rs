//! On-demand EPUB/CBZ entry reads in Rust (`epub_read_entry`).
//!
//! The reader used to inflate every chapter and image with zip.js on the
//! WebView's main thread. Now JS asks for one entry at a time and gets its
//! decompressed bytes back as a raw binary IPC response. The central
//! directory is parsed once per book: a small MRU cache keeps the last few
//! opened archives, re-opened if the file on disk changed (metadata edits
//! rewrite the `.book` file in place).

use std::fs::File;
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use tauri::ipc::Response;
use zip::ZipArchive;

/// Open archives kept (current book + the previously opened one).
const ARCHIVE_CACHE_LIMIT: usize = 2;
/// Refuse single entries larger than this (zip-bomb guard).
const MAX_ENTRY_SIZE: u64 = 512 * 1024 * 1024;

struct OpenArchive {
    path: PathBuf,
    len: u64,
    modified: Option<SystemTime>,
    archive: ZipArchive<BufReader<File>>,
}

type SharedArchive = Arc<Mutex<OpenArchive>>;

static ARCHIVES: Mutex<Vec<SharedArchive>> = Mutex::new(Vec::new());

fn file_stamp(path: &Path) -> Result<(u64, Option<SystemTime>), String> {
    let meta =
        std::fs::metadata(path).map_err(|e| format!("Cannot stat {}: {e}", path.display()))?;
    Ok((meta.len(), meta.modified().ok()))
}

fn open_archive(path: &Path) -> Result<SharedArchive, String> {
    let (len, modified) = file_stamp(path)?;
    let mut cache = ARCHIVES
        .lock()
        .map_err(|_| "archive cache poisoned".to_string())?;

    if let Some(pos) = cache.iter().position(|entry| {
        entry
            .lock()
            .map(|a| a.path == path && a.len == len && a.modified == modified)
            .unwrap_or(false)
    }) {
        let hit = cache.remove(pos);
        cache.push(Arc::clone(&hit));
        return Ok(hit);
    }

    // Stale entry for the same path (file rewritten) or a new book.
    cache.retain(|entry| entry.lock().map(|a| a.path != path).unwrap_or(false));
    let file = File::open(path).map_err(|e| format!("Cannot open {}: {e}", path.display()))?;
    let archive =
        ZipArchive::new(BufReader::new(file)).map_err(|e| format!("Not a valid zip: {e}"))?;
    let opened = Arc::new(Mutex::new(OpenArchive {
        path: path.to_path_buf(),
        len,
        modified,
        archive,
    }));
    cache.push(Arc::clone(&opened));
    while cache.len() > ARCHIVE_CACHE_LIMIT {
        cache.remove(0);
    }
    Ok(opened)
}

/// Same lookup rules as the metadata prefetch: exact, without a leading
/// `/` or `./`, percent-decoded, then case-insensitive.
fn find_entry<R: std::io::Read + std::io::Seek>(
    archive: &ZipArchive<R>,
    name: &str,
) -> Option<usize> {
    let clean = name.trim_start_matches('/').trim_start_matches("./");
    if let Some(index) = archive
        .index_for_name(name)
        .or_else(|| archive.index_for_name(clean))
    {
        return Some(index);
    }
    let decoded = percent_encoding::percent_decode_str(clean).decode_utf8_lossy();
    if let Some(index) = archive.index_for_name(&decoded) {
        return Some(index);
    }
    archive.file_names().position(|candidate| {
        candidate
            .trim_start_matches('/')
            .trim_start_matches("./")
            .eq_ignore_ascii_case(&decoded)
    })
}

/// Decompressed bytes of one entry, or `Ok(None)` when the entry is absent.
pub fn read_entry(path: &Path, name: &str) -> Result<Option<Vec<u8>>, String> {
    let shared = open_archive(path)?;
    let mut open = shared
        .lock()
        .map_err(|_| "archive lock poisoned".to_string())?;
    let Some(index) = find_entry(&open.archive, name) else {
        return Ok(None);
    };
    let mut entry = open
        .archive
        .by_index(index)
        .map_err(|e| format!("Cannot read entry {name}: {e}"))?;
    if entry.is_dir() {
        return Ok(None);
    }
    let declared = entry.size();
    if declared > MAX_ENTRY_SIZE {
        return Err(format!("Entry {name} is too large ({declared} bytes)"));
    }
    let mut bytes = Vec::with_capacity(declared as usize);
    // `take` also bounds entries whose header under-reports their size.
    (&mut entry)
        .take(MAX_ENTRY_SIZE + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("Cannot inflate entry {name}: {e}"))?;
    if bytes.len() as u64 > MAX_ENTRY_SIZE {
        return Err(format!("Entry {name} is too large"));
    }
    Ok(Some(bytes))
}

/// Forget cached archives (e.g. before deleting a book file on Windows).
pub fn clear_cache() {
    if let Ok(mut cache) = ARCHIVES.lock() {
        cache.clear();
    }
}

/// Error text for a missing entry; the JS loader maps it to `null` (an empty
/// response would be ambiguous with a genuinely empty file).
pub const ENTRY_NOT_FOUND: &str = "EPUB_ENTRY_NOT_FOUND";

/// Raw bytes of one entry of the book at `path`.
#[tauri::command]
pub async fn epub_read_entry(
    app: tauri::AppHandle,
    path: String,
    name: String,
) -> Result<Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let resolved = crate::epub_parser::resolve_book_path(&app, &path)
            .ok_or_else(|| format!("file not found: {path}"))?;
        read_entry(&resolved, &name)?
            .map(Response::new)
            .ok_or_else(|| ENTRY_NOT_FOUND.to_string())
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_zip(path: &Path, entries: &[(&str, &[u8])]) {
        let file = File::create(path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        for (name, data) in entries {
            zip.start_file(*name, options).unwrap();
            zip.write_all(data).unwrap();
        }
        zip.finish().unwrap();
    }

    fn temp_path(tag: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "theorem-epub-entries-{tag}-{}-{nanos}.zip",
            std::process::id()
        ))
    }

    #[test]
    fn reads_entries_by_exact_cleaned_decoded_and_case_insensitive_name() {
        let path = temp_path("names");
        let chapter = "<html>chapter one</html>".repeat(200);
        write_zip(
            &path,
            &[
                ("OEBPS/ch 1.xhtml", chapter.as_bytes()),
                ("OEBPS/Images/Cover.PNG", b"\x89PNG-bytes"),
            ],
        );
        assert_eq!(
            read_entry(&path, "OEBPS/ch 1.xhtml").unwrap().unwrap(),
            chapter.as_bytes()
        );
        assert_eq!(
            read_entry(&path, "/OEBPS/ch 1.xhtml").unwrap().unwrap(),
            chapter.as_bytes()
        );
        assert_eq!(
            read_entry(&path, "OEBPS/ch%201.xhtml").unwrap().unwrap(),
            chapter.as_bytes()
        );
        assert_eq!(
            read_entry(&path, "oebps/images/cover.png")
                .unwrap()
                .unwrap(),
            b"\x89PNG-bytes"
        );
        assert_eq!(read_entry(&path, "OEBPS/missing.xhtml").unwrap(), None);
        assert_eq!(read_entry(&path, "").unwrap(), None);
        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn reopens_when_the_file_is_rewritten() {
        let path = temp_path("rewrite");
        write_zip(&path, &[("a.txt", b"first")]);
        assert_eq!(read_entry(&path, "a.txt").unwrap().unwrap(), b"first");
        // Different length guarantees a new stamp even on coarse mtime clocks.
        write_zip(&path, &[("a.txt", b"second version"), ("b.txt", b"new")]);
        assert_eq!(
            read_entry(&path, "a.txt").unwrap().unwrap(),
            b"second version"
        );
        assert_eq!(read_entry(&path, "b.txt").unwrap().unwrap(), b"new");
        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn rejects_missing_and_corrupt_files() {
        assert!(read_entry(Path::new("/nonexistent/theorem.epub"), "a").is_err());
        let path = temp_path("corrupt");
        std::fs::write(&path, b"not a zip at all").unwrap();
        assert!(read_entry(&path, "a").is_err());
        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn keeps_only_a_few_archives_open() {
        let paths: Vec<PathBuf> = (0..4).map(|i| temp_path(&format!("lru{i}"))).collect();
        for (i, path) in paths.iter().enumerate() {
            write_zip(path, &[("x.txt", format!("book {i}").as_bytes())]);
            assert_eq!(
                read_entry(path, "x.txt").unwrap().unwrap(),
                format!("book {i}").as_bytes()
            );
        }
        assert!(ARCHIVES.lock().unwrap().len() <= ARCHIVE_CACHE_LIMIT);
        // An evicted book still reads (re-opened on demand).
        assert_eq!(read_entry(&paths[0], "x.txt").unwrap().unwrap(), b"book 0");
        for path in &paths {
            std::fs::remove_file(path).unwrap();
        }
    }
}
