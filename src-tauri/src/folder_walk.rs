//! Desktop library-folder walker and the cancellation registry shared by
//! folder scans and native ingest.
//!
//! The walk only lists: it never opens a book. It follows symbolic links
//! (walkdir detects loops), skips hidden folders, stops at `MAX_DEPTH`, and
//! reports every folder or book file it could not use with a reason instead
//! of dropping it silently.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use tauri_plugin_mobile_folder_scan::{FolderScan, ScanIssue, ScannedBookFile};

/// Deeper trees than this are almost certainly a link farm or a mistake.
pub const MAX_DEPTH: usize = 64;

pub fn is_supported_book_name(name: &str) -> bool {
    book_format_for_name(name).is_some()
}

/// The library format for a file name, matching `getBookFormat` in
/// `src/core/lib/import.ts` (`.fb2.zip` and `.fbz` are FB2).
pub fn book_format_for_name(name: &str) -> Option<&'static str> {
    let lower = name.to_lowercase();
    if lower.ends_with(".fb2.zip") || lower.ends_with(".fbz") || lower.ends_with(".fb2") {
        return Some("fb2");
    }
    let ext = lower.rsplit_once('.')?.1;
    Some(match ext {
        "epub" => "epub",
        "mobi" => "mobi",
        "azw" => "azw",
        "azw3" => "azw3",
        "cbz" => "cbz",
        "cbr" => "cbr",
        "pdf" => "pdf",
        _ => return None,
    })
}

fn issue(path: &Path, reason: impl Into<String>) -> ScanIssue {
    ScanIssue {
        path: path.to_string_lossy().into_owned().into_boxed_str(),
        reason: reason.into().into_boxed_str(),
    }
}

/// Plain-language reason for an I/O error.
pub fn describe_io_error(error: &std::io::Error) -> String {
    use std::io::ErrorKind;
    match error.kind() {
        ErrorKind::NotFound => "The file is no longer there".to_string(),
        ErrorKind::PermissionDenied => "Permission denied".to_string(),
        ErrorKind::StorageFull => "Not enough free space".to_string(),
        _ => error.to_string(),
    }
}

fn describe_walk_error(error: &walkdir::Error) -> String {
    if let Some(ancestor) = error.loop_ancestor() {
        return format!(
            "Skipped a link that loops back to {}",
            ancestor.to_string_lossy()
        );
    }
    match error.io_error() {
        Some(io) => describe_io_error(io),
        None => error.to_string(),
    }
}

fn is_hidden(name: &std::ffi::OsStr) -> bool {
    name.to_str().is_some_and(|n| n.starts_with('.'))
}

/// Walk `root` and list every supported book file below it.
#[cfg_attr(any(target_os = "android", target_os = "ios"), allow(dead_code))]
pub fn walk_book_folder(root: &Path, cancel: &AtomicBool) -> Result<FolderScan, String> {
    let metadata = std::fs::metadata(root)
        .map_err(|e| format!("Cannot open {}: {}", root.display(), describe_io_error(&e)))?;
    if !metadata.is_dir() {
        return Err(format!("Not a folder: {}", root.display()));
    }

    let root_name = root
        .file_name()
        .unwrap_or(root.as_os_str())
        .to_string_lossy()
        .into_owned()
        .into_boxed_str();

    let mut scan = FolderScan::default();
    let mut walker = walkdir::WalkDir::new(root)
        .follow_links(true)
        .max_depth(MAX_DEPTH)
        .into_iter()
        // Hidden folders (`.Trash`, `.caltrash`) and hidden files (macOS `._x.epub`
        // resource forks, half-written `.x.epub`) are never books.
        .filter_entry(|entry| entry.depth() == 0 || !is_hidden(entry.file_name()));
    let mut depth_warned = false;

    loop {
        if cancel.load(Ordering::Relaxed) {
            scan.cancelled = true;
            break;
        }
        let Some(next) = walker.next() else { break };
        let entry = match next {
            Ok(entry) => entry,
            Err(error) => {
                let path = error.path().unwrap_or(root).to_path_buf();
                // A broken link or unreadable entry that is not a book is noise.
                let is_dir_problem = error.loop_ancestor().is_some()
                    || error.depth() == 0
                    || std::fs::symlink_metadata(&path).is_ok_and(|m| m.is_dir());
                let name = path.file_name().map(|n| n.to_string_lossy().into_owned());
                if is_dir_problem || name.as_deref().is_some_and(is_supported_book_name) {
                    scan.issues.push(issue(&path, describe_walk_error(&error)));
                }
                continue;
            }
        };

        if entry.file_type().is_dir() {
            if entry.depth() == MAX_DEPTH
                && !depth_warned
                && std::fs::read_dir(entry.path()).is_ok_and(|mut it| it.next().is_some())
            {
                depth_warned = true;
                scan.issues.push(issue(
                    entry.path(),
                    format!("Folders nested deeper than {MAX_DEPTH} levels were skipped"),
                ));
            }
            continue;
        }
        if !entry.file_type().is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy();
        if !is_supported_book_name(&name) {
            continue;
        }
        let Ok(relative) = entry.path().strip_prefix(root) else {
            continue;
        };
        // walkdir already stat-ed the entry when following links; this is
        // served from the same inode cache.
        let (size, modified_ms) = match entry.metadata() {
            Ok(m) => (
                Some(m.len()),
                m.modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as i64),
            ),
            Err(error) => {
                scan.issues
                    .push(issue(entry.path(), describe_walk_error(&error)));
                continue;
            }
        };
        scan.files.push(ScannedBookFile {
            path: entry.path().to_string_lossy().into_owned().into_boxed_str(),
            relative_path: relative
                .to_string_lossy()
                .replace('\\', "/")
                .into_boxed_str(),
            root_name: root_name.clone(),
            size,
            modified_ms,
        });
    }

    scan.files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(scan)
}

// ── Cancellation registry ────────────────────────────────────────────────────

fn jobs() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static JOBS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// A registered job's cancel flag; unregistered when dropped.
pub struct JobGuard {
    id: Option<String>,
    pub flag: Arc<AtomicBool>,
}

impl Drop for JobGuard {
    fn drop(&mut self) {
        if let Some(id) = &self.id {
            if let Ok(mut map) = jobs().lock() {
                map.remove(id);
            }
        }
    }
}

/// Register a cancellable job. A job that was cancelled before it started
/// (the cancel raced the start) begins cancelled.
pub fn register_job(job_id: Option<String>) -> JobGuard {
    let flag = Arc::new(AtomicBool::new(false));
    if let Some(id) = &job_id {
        if let Ok(mut map) = jobs().lock() {
            if let Some(existing) = map.get(id) {
                if existing.load(Ordering::Relaxed) {
                    flag.store(true, Ordering::Relaxed);
                }
            }
            map.insert(id.clone(), flag.clone());
        }
    }
    JobGuard { id: job_id, flag }
}

/// Cancel a job by id. Cancelling an id that has not started yet leaves a
/// tombstone so the job starts cancelled.
pub fn cancel_job(job_id: &str) {
    if let Ok(mut map) = jobs().lock() {
        map.entry(job_id.to_string())
            .or_insert_with(|| Arc::new(AtomicBool::new(false)))
            .store(true, Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn write(path: &Path, bytes: &[u8]) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }

    fn rel(scan: &FolderScan) -> Vec<String> {
        scan.files
            .iter()
            .map(|f| f.relative_path.to_string())
            .collect()
    }

    #[test]
    fn lists_nested_books_with_size_and_skips_other_files() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(&root.join("a.epub"), b"x");
        write(
            &root.join("one/two/three/four/five/six/seven/deep.PDF"),
            b"pdf!",
        );
        write(&root.join("one/notes.txt"), b"no");
        write(&root.join("one/cover.jpg"), b"no");
        write(&root.join("c/Book.fb2.zip"), b"zz");
        let scan = walk_book_folder(root, &AtomicBool::new(false)).unwrap();
        assert_eq!(
            rel(&scan),
            vec![
                "a.epub",
                "c/Book.fb2.zip",
                "one/two/three/four/five/six/seven/deep.PDF"
            ]
        );
        assert_eq!(scan.files[2].size, Some(4));
        assert!(scan.files[0].modified_ms.is_some());
        assert!(scan.issues.is_empty());
        assert!(!scan.cancelled);
    }

    #[test]
    fn keeps_non_ascii_and_odd_file_names() {
        let dir = tempfile::tempdir().unwrap();
        let names = [
            "Ünïcödé – 書名 📚.epub",
            "quote's \"double\".epub",
            "hash#percent%20.epub",
            "-leading.epub",
            "Война и мир.epub",
        ];
        for name in names {
            write(&dir.path().join("Odd ü").join(name), b"x");
        }
        let scan = walk_book_folder(dir.path(), &AtomicBool::new(false)).unwrap();
        assert_eq!(scan.files.len(), names.len());
        for name in names {
            assert!(rel(&scan).contains(&format!("Odd ü/{name}")), "{name}");
        }
    }

    #[test]
    fn skips_hidden_folders_but_not_the_root() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join(".hidden-root");
        write(&root.join("visible.epub"), b"x");
        write(&root.join(".caltrash/trashed.epub"), b"x");
        write(&root.join("sub/._visible.epub"), b"resource fork");
        let scan = walk_book_folder(&root, &AtomicBool::new(false)).unwrap();
        assert_eq!(rel(&scan), vec!["visible.epub"]);
    }

    #[test]
    fn rejects_a_missing_root_or_a_file() {
        let dir = tempfile::tempdir().unwrap();
        let err = walk_book_folder(&dir.path().join("gone"), &AtomicBool::new(false)).unwrap_err();
        assert!(err.contains("no longer there"), "{err}");
        write(&dir.path().join("f.epub"), b"x");
        let err =
            walk_book_folder(&dir.path().join("f.epub"), &AtomicBool::new(false)).unwrap_err();
        assert!(err.starts_with("Not a folder"), "{err}");
    }

    #[test]
    fn empty_folder_gives_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let scan = walk_book_folder(dir.path(), &AtomicBool::new(false)).unwrap();
        assert!(scan.files.is_empty() && scan.issues.is_empty());
    }

    #[test]
    fn stops_when_cancelled() {
        let dir = tempfile::tempdir().unwrap();
        write(&dir.path().join("a.epub"), b"x");
        let scan = walk_book_folder(dir.path(), &AtomicBool::new(true)).unwrap();
        assert!(scan.cancelled);
        assert!(scan.files.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn survives_symlink_loops_and_reports_broken_book_links() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(&root.join("lib/book.epub"), b"x");
        write(&root.join("elsewhere/linked-dir/inside.cbz"), b"x");
        symlink(root.join("lib"), root.join("lib/loop")).unwrap();
        symlink(root.join("elsewhere/linked-dir"), root.join("lib/linked")).unwrap();
        symlink(root.join("lib/book.epub"), root.join("lib/alias.epub")).unwrap();
        symlink("/nonexistent/target.epub", root.join("lib/dangling.epub")).unwrap();
        symlink("/nonexistent/target.txt", root.join("lib/dangling.txt")).unwrap();

        let scan = walk_book_folder(&root.join("lib"), &AtomicBool::new(false)).unwrap();
        assert_eq!(
            rel(&scan),
            vec!["alias.epub", "book.epub", "linked/inside.cbz"]
        );
        let reasons: Vec<String> = scan
            .issues
            .iter()
            .map(|i| format!("{} {}", i.path, i.reason))
            .collect();
        assert_eq!(scan.issues.len(), 2, "{reasons:?}");
        assert!(
            reasons
                .iter()
                .any(|r| r.contains("loop") && r.contains("loops back")),
            "{reasons:?}"
        );
        assert!(
            reasons.iter().any(|r| r.contains("dangling.epub")),
            "{reasons:?}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn reports_unreadable_folders_and_continues() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(&root.join("ok/a.epub"), b"x");
        write(&root.join("locked/b.epub"), b"x");
        fs::set_permissions(root.join("locked"), fs::Permissions::from_mode(0o000)).unwrap();
        // Root can read anything; then there is nothing to report.
        let readable_anyway = fs::read_dir(root.join("locked")).is_ok();
        let scan = walk_book_folder(root, &AtomicBool::new(false));
        fs::set_permissions(root.join("locked"), fs::Permissions::from_mode(0o755)).unwrap();
        let scan = scan.unwrap();
        if readable_anyway {
            return;
        }
        assert_eq!(rel(&scan), vec!["ok/a.epub"]);
        assert_eq!(scan.issues.len(), 1);
        assert!(scan.issues[0].path.ends_with("locked"));
        assert_eq!(&*scan.issues[0].reason, "Permission denied");
    }

    #[test]
    fn stops_at_max_depth_and_says_so() {
        let dir = tempfile::tempdir().unwrap();
        let mut deep = dir.path().to_path_buf();
        for i in 0..(MAX_DEPTH + 3) {
            deep = deep.join(format!("{i}"));
        }
        write(&deep.join("too-deep.epub"), b"x");
        write(&dir.path().join("0/shallow.epub"), b"x");
        let scan = walk_book_folder(dir.path(), &AtomicBool::new(false)).unwrap();
        assert_eq!(rel(&scan), vec!["0/shallow.epub"]);
        assert_eq!(scan.issues.len(), 1);
        assert!(scan.issues[0].reason.contains("deeper than"));
    }

    #[test]
    fn maps_names_to_library_formats() {
        assert_eq!(book_format_for_name("A.FB2.ZIP"), Some("fb2"));
        assert_eq!(book_format_for_name("a.fbz"), Some("fb2"));
        assert_eq!(book_format_for_name("a.azw3"), Some("azw3"));
        assert_eq!(book_format_for_name("a.CBR"), Some("cbr"));
        assert_eq!(book_format_for_name("a.zip"), None);
        assert_eq!(book_format_for_name("epub"), None);
        assert_eq!(book_format_for_name("notes.epub.txt"), None);
    }

    #[test]
    fn an_empty_folder_at_the_depth_limit_is_not_reported() {
        let dir = tempfile::tempdir().unwrap();
        let mut deep = dir.path().to_path_buf();
        for i in 0..MAX_DEPTH {
            deep = deep.join(format!("{i}"));
        }
        fs::create_dir_all(&deep).unwrap();
        let scan = walk_book_folder(dir.path(), &AtomicBool::new(false)).unwrap();
        assert!(scan.issues.is_empty(), "{:?}", scan.issues);
    }

    #[test]
    fn cancel_registry_round_trip() {
        let guard = register_job(Some("job-a".into()));
        assert!(!guard.flag.load(Ordering::Relaxed));
        cancel_job("job-a");
        assert!(guard.flag.load(Ordering::Relaxed));
        drop(guard);
        // Cancelled before start: the job begins cancelled.
        cancel_job("job-b");
        let early = register_job(Some("job-b".into()));
        assert!(early.flag.load(Ordering::Relaxed));
    }
}
