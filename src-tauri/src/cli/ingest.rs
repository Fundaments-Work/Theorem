//! `theorem library add|import`: ingesting files the way the app does.

use super::*;

pub(super) fn library_add(output: &Output, ctx: &Ctx, paths: &[String]) -> i32 {
    if paths.is_empty() {
        return output
            .usage("usage: theorem library add <files...> | theorem library import <dir>");
    }
    ingest_and_register(output, ctx, paths)
}

pub(super) fn library_import(output: &Output, ctx: &Ctx, dir: &str) -> i32 {
    // The same walker as the app's "Scan Folder": follows links without
    // looping, skips hidden folders, and reports what it could not read.
    let scan = match crate::folder_walk::walk_book_folder(
        std::path::Path::new(dir),
        &std::sync::atomic::AtomicBool::new(false),
    ) {
        Ok(scan) => scan,
        Err(e) => return output.error(&e),
    };
    for issue in &scan.issues {
        output.note(&format!("skipped {}: {}", issue.path, issue.reason));
    }
    if scan.files.is_empty() {
        output.note(&format!("no supported book files found under {dir}"));
        if output.json {
            return output.print_json(&ImportReport::default());
        }
        return 0;
    }
    let files: Vec<String> = scan.files.iter().map(|f| f.path.to_string()).collect();
    ingest_and_register(output, ctx, &files)
}

/// What happened to each file of an import.
#[derive(Default, Serialize)]
struct ImportReport {
    added: Vec<serde_json::Value>,
    duplicates: Vec<ImportDuplicate>,
    failed: Vec<ImportFailure>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportDuplicate {
    path: String,
    existing_id: String,
    title: String,
}

#[derive(Serialize)]
struct ImportFailure {
    path: String,
    error: String,
}

enum Ingested {
    Added(Box<crate::batch_ingest::NativeBookRecord>),
    Duplicate { existing_id: String, title: String },
}

/// The absolute form of a path given on the command line (symlinks
/// resolved), so the stored `filePath` still points at the file later.
fn absolute_path(raw: &str) -> String {
    let path = std::path::Path::new(raw);
    std::fs::canonicalize(path)
        .or_else(|_| std::env::current_dir().map(|cwd| cwd.join(path)))
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| raw.to_string())
}

/// Content hashes already in the library, mapped to (book id, title).
fn library_content_hashes(ctx: &Ctx) -> Result<HashMap<String, (String, String)>, String> {
    Ok(load_books(ctx)?
        .iter()
        .filter_map(|book| {
            let hash = book_str(book, "contentHash")?.trim().to_ascii_lowercase();
            if hash.is_empty() {
                return None;
            }
            Some((
                hash,
                (
                    book_str(book, "id").unwrap_or("").to_string(),
                    book_title(book),
                ),
            ))
        })
        .collect())
}

/// Parse and copy each file into `book-cache/`, in parallel, the way the
/// app's `ingest_books_native` command does (that command reports progress
/// through an `AppHandle`, which the CLI has none of, and drops the reasons
/// files fail). A file whose content is already in the library is not
/// copied. Returns each path with its outcome, in input order.
fn ingest_files(
    ctx: &Ctx,
    paths: &[String],
    known: &HashMap<String, (String, String)>,
) -> Vec<(String, Result<Ingested, String>)> {
    use rayon::prelude::*;
    let cache_dir = ctx.dir().join("book-cache");
    let _ = std::fs::create_dir_all(&cache_dir);
    paths
        .par_iter()
        .map(|raw_path| {
            let absolute = absolute_path(raw_path);
            let outcome = ingest_file(&cache_dir, &absolute, known);
            (absolute, outcome)
        })
        .collect()
}

fn ingest_file(
    cache_dir: &std::path::Path,
    file_path: &str,
    known: &HashMap<String, (String, String)>,
) -> Result<Ingested, String> {
    let path = std::path::Path::new(file_path);
    if !path.exists() {
        return Err("file does not exist".to_string());
    }
    if !path.is_file() {
        return Err("not a file".to_string());
    }
    let supported = path
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(crate::folder_walk::is_supported_book_name);
    if !supported {
        return Err(
            "unsupported file type (supported: epub, mobi, azw, azw3, fb2, fbz, pdf, cbz, cbr)"
                .to_string(),
        );
    }
    let content_hash = crate::batch_ingest::compute_file_sha256(path)
        .ok_or_else(|| "cannot read the file".to_string())?;
    if let Some((existing_id, title)) = known.get(&content_hash) {
        return Ok(Ingested::Duplicate {
            existing_id: existing_id.clone(),
            title: title.clone(),
        });
    }
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();
    let metadata = match ext.as_str() {
        "epub" => crate::batch_ingest::parse_epub_native(path)?,
        "cbz" => crate::batch_ingest::parse_cbz_native(path)?,
        "cbr" => crate::cbr::parse_cbr_native(path)?,
        _ => {
            let (title, author) = crate::batch_ingest::parse_title_author_from_filename(path);
            crate::batch_ingest::ParsedMetadata {
                title,
                author,
                description: None,
                publisher: None,
                published_date: None,
                language: None,
                isbn: None,
                cover_data_url: None,
                series: None,
                series_index: None,
            }
        }
    };

    let file_size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    if file_size == 0 {
        return Err("the file is empty".to_string());
    }
    let id = uuid::Uuid::new_v4().to_string();
    let dest_path = cache_dir.join(format!("{id}.book"));
    let format = if ext == "cbr" {
        match crate::cbr::convert_cbr_to_cbz_file(path, &dest_path) {
            Ok(()) => "cbz".to_string(),
            // As the app does: keep the original archive when it cannot be
            // converted.
            Err(_) => {
                std::fs::copy(path, &dest_path)
                    .map_err(|e| format!("cannot copy the file into the library: {e}"))?;
                ext
            }
        }
    } else {
        std::fs::copy(path, &dest_path)
            .map_err(|e| format!("cannot copy the file into the library: {e}"))?;
        ext
    };

    Ok(Ingested::Added(Box::new(
        crate::batch_ingest::NativeBookRecord {
            id,
            title: metadata.title,
            author: metadata.author,
            file_path: file_path.to_string(),
            storage_path: Some(dest_path.to_string_lossy().into_owned()),
            format,
            content_hash: Some(content_hash),
            cover_extraction_done: metadata.cover_data_url.is_some(),
            cover_path: metadata.cover_data_url,
            description: metadata.description,
            publisher: metadata.publisher,
            published_date: metadata.published_date,
            language: metadata.language,
            isbn: metadata.isbn,
            series: metadata.series,
            series_index: metadata.series_index,
            file_size,
            added_at: now_iso(),
            progress: 0.0,
            is_favorite: false,
            tags: Vec::new(),
        },
    )))
}

/// Covers shorter than this stay inline in the book record (the app's
/// `INLINE_COVER_MAX_CHARS`); longer ones are served from the `covers` table,
/// and the app fills in their display address when it loads the library.
const INLINE_COVER_MAX_CHARS: usize = 5000;

/// The book record the app stores for an imported file (`importBooksIncremental`).
fn book_record_json(record: &crate::batch_ingest::NativeBookRecord) -> serde_json::Value {
    let mut book = serde_json::json!({
        "id": record.id,
        "title": record.title,
        "author": record.author,
        "filePath": record.file_path,
        "storagePath": record.storage_path,
        "format": record.format,
        "contentHash": record.content_hash,
        "coverExtractionDone": record.cover_extraction_done,
        "fileSize": record.file_size,
        "readingTime": 0,
        "addedAt": record.added_at,
        "progress": 0,
        "isFavorite": false,
        "tags": [],
    });
    let optional = [
        (
            "description",
            record.description.clone().map(serde_json::Value::from),
        ),
        (
            "publisher",
            record.publisher.clone().map(serde_json::Value::from),
        ),
        (
            "publishedDate",
            record.published_date.clone().map(serde_json::Value::from),
        ),
        (
            "language",
            record.language.clone().map(serde_json::Value::from),
        ),
        ("isbn", record.isbn.clone().map(serde_json::Value::from)),
        ("series", record.series.clone().map(serde_json::Value::from)),
        (
            "seriesIndex",
            record.series_index.map(serde_json::Value::from),
        ),
        (
            "coverPath",
            record
                .cover_path
                .clone()
                .filter(|url| url.len() < INLINE_COVER_MAX_CHARS)
                .map(serde_json::Value::from),
        ),
    ];
    if let Some(object) = book.as_object_mut() {
        for (key, value) in optional {
            if let Some(value) = value {
                object.insert(key.to_string(), value);
            }
        }
    }
    book
}

/// Register imported books exactly as the app does: the metadata row (which
/// also inserts the `books` row and the search entry), the materialized-file
/// row and the cover, all in one transaction.
fn register_books(
    ctx: &Ctx,
    records: &[&crate::batch_ingest::NativeBookRecord],
) -> Result<Vec<serde_json::Value>, String> {
    let books: Vec<serde_json::Value> = records.iter().map(|r| book_record_json(r)).collect();
    ctx.store.with_connection(|conn| {
        let tx =
            rusqlite::Transaction::new_unchecked(conn, rusqlite::TransactionBehavior::Immediate)?;
        for (record, book) in records.iter().zip(&books) {
            let json = book.to_string();
            crate::database::sqlite_save_book_metadata_inner(&tx, &record.id, &json)?;
            crate::database::sqlite_register_materialized_book_inner(&tx, &record.id)?;
            if let Some(cover) = &record.cover_path {
                crate::database::sqlite_save_cover_image_inner(&tx, &record.id, cover)?;
            }
        }
        tx.commit()
    })?;
    Ok(books)
}

pub(super) fn ingest_and_register(output: &Output, ctx: &Ctx, paths: &[String]) -> i32 {
    let known = match library_content_hashes(ctx) {
        Ok(known) => known,
        Err(e) => return output.error(&e),
    };
    let outcomes = ingest_files(ctx, paths, &known);

    let mut report = ImportReport::default();
    let mut seen: HashMap<String, (String, String)> = HashMap::new();
    let mut to_register = Vec::new();
    for (path, outcome) in &outcomes {
        match outcome {
            Ok(Ingested::Added(record)) => {
                let hash = record.content_hash.clone().unwrap_or_default();
                // The same content twice in one import: keep the first.
                if let Some((existing_id, title)) = seen.get(&hash) {
                    if let Some(storage) = &record.storage_path {
                        let _ = std::fs::remove_file(storage);
                    }
                    report.duplicates.push(ImportDuplicate {
                        path: path.clone(),
                        existing_id: existing_id.clone(),
                        title: title.clone(),
                    });
                    continue;
                }
                seen.insert(hash, (record.id.clone(), record.title.clone()));
                to_register.push(record.as_ref());
            }
            Ok(Ingested::Duplicate { existing_id, title }) => {
                report.duplicates.push(ImportDuplicate {
                    path: path.clone(),
                    existing_id: existing_id.clone(),
                    title: title.clone(),
                })
            }
            Err(error) => report.failed.push(ImportFailure {
                path: path.clone(),
                error: error.clone(),
            }),
        }
    }

    match register_books(ctx, &to_register) {
        Ok(books) => report.added = books,
        Err(e) => {
            // Nothing was registered: do not leave orphaned copies behind.
            for record in &to_register {
                if let Some(storage) = &record.storage_path {
                    let _ = std::fs::remove_file(storage);
                }
            }
            return output.error(&e);
        }
    }

    let code = if report.failed.is_empty() { 0 } else { 1 };
    if output.json {
        let printed = output.print_json(&report);
        return if printed != 0 { printed } else { code };
    }
    for book in &report.added {
        println!(
            "{} {}",
            output.green("added"),
            output.bold(&format!("{} — {}", book_title(book), book_author(book)))
        );
    }
    for duplicate in &report.duplicates {
        println!(
            "{} {} {}",
            output.dim("skipped"),
            duplicate.path,
            output.dim(&format!(
                "(already in the library as '{}', {})",
                duplicate.title, duplicate.existing_id
            ))
        );
    }
    for failure in &report.failed {
        eprintln!(
            "{} {}: {}",
            output.red("failed"),
            failure.path,
            failure.error
        );
    }
    output.note(&format!(
        "# {} imported, {} skipped (duplicates), {} failed",
        report.added.len(),
        report.duplicates.len(),
        report.failed.len()
    ));
    code
}
