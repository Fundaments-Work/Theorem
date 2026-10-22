use std::path::Path;
use tauri::AppHandle;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedBinary {
    storage_path: String,
    content_hash: String,
    format: String,
    metadata: Option<crate::batch_ingest::ParsedMetadata>,
}

/// Finalize a bounded binary upload. No archive bytes cross JSON IPC.
pub fn finish_book_import(
    app: AppHandle,
    id: String,
    format: String,
    expected_size: u64,
) -> Result<ImportedBinary, String> {
    uuid::Uuid::parse_str(&id).map_err(|_| "Invalid book ID".to_string())?;
    if !matches!(
        format.as_str(),
        "epub" | "mobi" | "azw" | "azw3" | "fb2" | "fbz" | "cbz" | "cbr" | "pdf"
    ) {
        return Err("Unsupported book format".into());
    }
    let destination = crate::database::materialized_book_path(&app, &id)?;
    let source = destination.with_extension("import");
    let converted = destination.with_extension("converting");
    let result = (|| {
        let size = std::fs::metadata(&source).map_err(|e| e.to_string())?.len();
        if size == 0 || size != expected_size {
            return Err("Incomplete book upload".into());
        }
        // A damaged EPUB is reported now, as the desktop importer does,
        // instead of becoming a book that cannot be opened.
        if format == "epub" {
            crate::batch_ingest::check_epub_readable(&source)?;
        }
        let content_hash = crate::batch_ingest::compute_file_sha256(&source)
            .ok_or_else(|| "Failed to hash imported book".to_string())?;
        let final_format = if format == "cbr" {
            crate::cbr::convert_cbr_to_cbz_file(&source, &converted)?;
            std::fs::rename(&converted, &destination).map_err(|e| e.to_string())?;
            "cbz".to_string()
        } else {
            std::fs::rename(&source, &destination).map_err(|e| e.to_string())?;
            format
        };
        let metadata = if final_format == "cbz" {
            let mut metadata = crate::batch_ingest::parse_cbz_native(&destination)?;
            // The cache filename is a UUID, not book metadata.
            if metadata.title == id {
                metadata.title.clear();
            }
            if metadata.author == "Unknown Author" {
                metadata.author.clear();
            }
            Some(metadata)
        } else {
            None
        };
        crate::database::sqlite_register_materialized_book(app, id)?;
        Ok(ImportedBinary {
            storage_path: destination.to_string_lossy().into_owned(),
            content_hash,
            format: final_format,
            metadata,
        })
    })();
    let _ = std::fs::remove_file(source);
    let _ = std::fs::remove_file(converted);
    if result.is_err() {
        let _ = std::fs::remove_file(destination);
    }
    result
}

pub fn import_book_path(
    app: AppHandle,
    id: String,
    path: String,
    format: String,
) -> Result<ImportedBinary, String> {
    uuid::Uuid::parse_str(&id).map_err(|_| "Invalid book ID".to_string())?;
    let destination = crate::database::materialized_book_path(&app, &id)?.with_extension("import");
    // Android hands over a temporary copy of a content:// document. It is
    // moved into place (same filesystem, no second copy of the bytes) and
    // never left behind.
    let temporary = cfg!(target_os = "android") && is_materialized_temp(Path::new(&path));
    let size = match place_book_file(Path::new(&path), &destination, temporary) {
        Ok(size) => size,
        Err(e) => {
            let _ = std::fs::remove_file(&destination);
            return Err(format!("Failed to copy book: {e}"));
        }
    };
    finish_book_import(app, id, format, size)
}

/// Put `source` at `destination`: moved when it is a temporary copy (and
/// removed even if that fails), copied otherwise. Returns the size.
fn place_book_file(source: &Path, destination: &Path, temporary: bool) -> std::io::Result<u64> {
    if temporary {
        let placed = match std::fs::rename(source, destination) {
            Ok(()) => std::fs::metadata(destination).map(|m| m.len()),
            // Another filesystem: copy, then drop the temporary file.
            Err(_) => std::fs::copy(source, destination),
        };
        let _ = std::fs::remove_file(source);
        return placed;
    }
    std::fs::copy(source, destination)
}

/// A file `materializeContentUri` wrote into the app's `theorem_import` folder.
fn is_materialized_temp(path: &Path) -> bool {
    path.parent()
        .and_then(|dir| dir.file_name())
        .is_some_and(|name| name == MATERIALIZED_IMPORT_DIR)
}

const MATERIALIZED_IMPORT_DIR: &str = "theorem_import";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn temporary_copies_are_moved_and_other_files_copied() {
        let dir = tempfile::tempdir().unwrap();
        let temp = dir.path().join("theorem_import/1-book.epub");
        std::fs::create_dir_all(temp.parent().unwrap()).unwrap();
        std::fs::write(&temp, b"book bytes").unwrap();
        let dest = dir.path().join("a.import");
        assert_eq!(place_book_file(&temp, &dest, true).unwrap(), 10);
        assert!(!temp.exists());
        assert_eq!(std::fs::read(&dest).unwrap(), b"book bytes");

        let kept = dir.path().join("Books/book.epub");
        std::fs::create_dir_all(kept.parent().unwrap()).unwrap();
        std::fs::write(&kept, b"mine").unwrap();
        let dest = dir.path().join("b.import");
        assert_eq!(place_book_file(&kept, &dest, false).unwrap(), 4);
        assert!(kept.exists());
        assert_eq!(std::fs::read(&dest).unwrap(), b"mine");

        // A temporary file that cannot be placed is still removed.
        let temp = dir.path().join("theorem_import/2-book.epub");
        std::fs::write(&temp, b"x").unwrap();
        assert!(place_book_file(&temp, &dir.path().join("missing/dir/c.import"), true).is_err());
        assert!(!temp.exists());
        // A missing source is an error, not a panic.
        assert!(
            place_book_file(&dir.path().join("gone.epub"), &dir.path().join("d"), false).is_err()
        );
    }

    #[test]
    fn only_materialized_copies_count_as_temporary() {
        assert!(is_materialized_temp(Path::new(
            "/data/user/0/app/files/theorem_import/1f-book.epub"
        )));
        assert!(!is_materialized_temp(Path::new(
            "/storage/emulated/0/Books/book.epub"
        )));
        assert!(!is_materialized_temp(Path::new("/home/me/theorem_import")));
        assert!(!is_materialized_temp(Path::new("book.epub")));
    }
}
