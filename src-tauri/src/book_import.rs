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
    let size =
        std::fs::copy(path, &destination).map_err(|e| format!("Failed to copy book: {e}"))?;
    finish_book_import(app, id, format, size)
}
