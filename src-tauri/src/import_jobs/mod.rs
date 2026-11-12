//! Native import ownership, progress and durable recovery.
pub mod checkpoint;

use crate::batch_ingest::{ImportStage, IngestItem, KnownBook};
use crate::error::AppError;
use checkpoint::{Checkpoint, Outcome, Request};
use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, OnceLock,
};
use tauri::{AppHandle, Manager};

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Current {
    name: Box<str>,
    stage: Option<ImportStage>,
    completed_bytes: u64,
    total_bytes: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    id: Option<Box<str>>,
    active: bool,
    resumable: bool,
    total: usize,
    completed: usize,
    imported: usize,
    duplicates: usize,
    errors: Box<[Failure]>,
    current: Current,
}

#[derive(Serialize)]
pub struct Failure {
    source: Box<str>,
    message: Box<str>,
}

#[derive(Default)]
struct JobState {
    active: AtomicBool,
    cancel: Arc<AtomicBool>,
    current: Mutex<Current>,
    failure: Mutex<Option<Box<str>>>,
    job_id: Mutex<Option<Box<str>>>,
}

fn state() -> &'static JobState {
    static STATE: OnceLock<JobState> = OnceLock::new();
    STATE.get_or_init(JobState::default)
}

fn connection<T>(
    app: &AppHandle,
    operation: impl FnOnce(&Connection) -> Result<T, AppError>,
) -> Result<T, AppError> {
    crate::database::with_connection(app, |connection| Ok(operation(connection)))?
}

fn load(app: &AppHandle) -> Result<Option<Checkpoint>, AppError> {
    connection(app, Checkpoint::load)
}

/// Reports durable completion counts plus the current native stage.
pub fn snapshot(app: &AppHandle) -> Result<Snapshot, AppError> {
    let checkpoint = load(app)?;
    let active = state().active.load(Ordering::Acquire);
    let current = state()
        .current
        .lock()
        .map_err(|_| AppError::internal("Import state unavailable"))?
        .clone();
    let mut snapshot = Snapshot {
        id: None,
        active,
        resumable: false,
        total: 0,
        completed: 0,
        imported: 0,
        duplicates: 0,
        errors: Box::new([]),
        current,
    };
    let mut errors = Vec::new();
    if let Some(checkpoint) = checkpoint {
        snapshot.resumable = !active && checkpoint.next_pending().is_some();
        snapshot.total = checkpoint.entries.len();
        snapshot.id = Some(checkpoint.id);
        for entry in &checkpoint.entries {
            match &entry.outcome {
                Outcome::Saved {} => {
                    snapshot.completed += 1;
                    snapshot.imported += 1;
                }
                Outcome::Duplicate { .. } => {
                    snapshot.completed += 1;
                    snapshot.duplicates += 1;
                }
                Outcome::Failed { message } => {
                    snapshot.completed += 1;
                    errors.push(Failure {
                        source: entry.request.name.clone(),
                        message: message.clone(),
                    });
                }
                _ => {}
            }
        }
    }
    if let Some(message) = state()
        .failure
        .lock()
        .map_err(|_| AppError::internal("Import state unavailable"))?
        .clone()
    {
        errors.push(Failure {
            source: "Import".into(),
            message,
        });
    }
    snapshot.errors = errors.into_boxed_slice();
    Ok(snapshot)
}

/// Checkpoints a complete batch before starting its native worker.
pub fn start(app: AppHandle, requests: Vec<Request>) -> Result<Box<str>, AppError> {
    let checkpoint = Checkpoint::new(requests)?;
    launch(app, Some(checkpoint), None)
}

/// Restarts only the pending work of the explicitly selected job.
pub fn resume(app: AppHandle, job_id: &str) -> Result<Box<str>, AppError> {
    launch(app, None, Some(job_id))
}

/// Requests cancellation without affecting a newer job or saved results.
pub fn cancel(job_id: &str) -> Result<(), AppError> {
    let current = state()
        .job_id
        .lock()
        .map_err(|_| AppError::internal("Import state unavailable"))?;
    if current.as_deref() != Some(job_id) {
        return Err(AppError::invalid_input("The import job changed"));
    }
    state().cancel.store(true, Ordering::Release);
    Ok(())
}

fn launch(
    app: AppHandle,
    new: Option<Checkpoint>,
    expected_id: Option<&str>,
) -> Result<Box<str>, AppError> {
    state()
        .active
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .map_err(|_| AppError::invalid_input("An import is already running"))?;
    #[cfg(target_os = "android")]
    let service_app = app.clone();
    let result = (|| {
        let previous = load(&app)?;
        if let Some(expected_id) = expected_id {
            if previous.as_ref().map(|checkpoint| &*checkpoint.id) != Some(expected_id) {
                return Err(AppError::invalid_input("The import job changed"));
            }
        }
        let checkpoint = match new {
            Some(checkpoint) => {
                if previous
                    .as_ref()
                    .is_some_and(|previous| previous.next_pending().is_some())
                {
                    return Err(AppError::invalid_input(
                        "Resume the pending import before starting another",
                    ));
                }
                connection(&app, |connection| checkpoint.save(connection))?;
                checkpoint
            }
            None => previous
                .filter(|previous| previous.next_pending().is_some())
                .ok_or_else(|| AppError::not_found("There is no pending import"))?,
        };
        *state()
            .job_id
            .lock()
            .map_err(|_| AppError::internal("Import state unavailable"))? =
            Some(checkpoint.id.clone());
        state().cancel.store(false, Ordering::Release);
        *state()
            .failure
            .lock()
            .map_err(|_| AppError::internal("Import state unavailable"))? = None;
        #[cfg(target_os = "android")]
        tauri_plugin_mobile_folder_scan::start_import_service(&app).map_err(AppError::io)?;
        sweep_abandoned_import_temp_files(&app);
        let job_id = checkpoint.id.clone();
        std::thread::Builder::new()
            .name("native-import".into())
            .spawn(move || {
                let _lease = WorkerLease { app: app.clone() };
                #[cfg(target_os = "android")]
                monitor_android_service(app.clone(), checkpoint.id.clone());
                if let Err(error) = run(&app, checkpoint) {
                    if let Ok(mut failure) = state().failure.lock() {
                        *failure = Some(error.to_string().into_boxed_str());
                    }
                }
            })
            .map_err(AppError::from)?;
        Ok(job_id)
    })();
    if result.is_err() {
        #[cfg(target_os = "android")]
        let _ = tauri_plugin_mobile_folder_scan::stop_import_service(&service_app);
        state().active.store(false, Ordering::Release);
    }
    result
}

struct WorkerLease {
    app: AppHandle,
}
impl Drop for WorkerLease {
    fn drop(&mut self) {
        #[cfg(target_os = "android")]
        let _ = tauri_plugin_mobile_folder_scan::stop_import_service(&self.app);
        #[cfg(not(target_os = "android"))]
        let _ = &self.app;
        if let Ok(mut current) = state().current.lock() {
            *current = Current::default();
        }
        state().active.store(false, Ordering::Release);
    }
}

fn run(app: &AppHandle, mut checkpoint: Checkpoint) -> Result<(), AppError> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| AppError::io(error.to_string()))?
        .join("book-cache");
    let mut known = load_known_books(app)?;
    while let Some(index) = checkpoint.next_pending() {
        if state().cancel.load(Ordering::Acquire) {
            break;
        }
        let entry = &mut checkpoint.entries[index];
        entry.outcome = Outcome::Running {};
        let request = entry.request.clone();
        let id = entry.book_id.clone();
        connection(app, |connection| checkpoint.save(connection))?;
        *state()
            .current
            .lock()
            .map_err(|_| AppError::internal("Import state unavailable"))? = Current {
            name: request.name.clone(),
            stage: Some(ImportStage::Copying),
            ..Current::default()
        };
        #[cfg(feature = "e2e")]
        crate::e2e_hooks::wait_for_import_gate(index, &state().cancel);
        if state().cancel.load(Ordering::Acquire) {
            checkpoint.entries[index].outcome = Outcome::Pending {};
            connection(app, |connection| checkpoint.save(connection))?;
            break;
        }
        let result = import_one(
            app,
            &directory,
            &request,
            &id,
            &mut checkpoint,
            index,
            &mut known,
        );
        #[cfg(target_os = "android")]
        if tauri_plugin_mobile_folder_scan::import_service_status(app)
            .map_or(true, |status| status.stopped)
        {
            state().cancel.store(true, Ordering::Release);
        }
        if state().cancel.load(Ordering::Acquire)
            && !matches!(
                checkpoint.entries[index].outcome,
                Outcome::Saved {} | Outcome::Duplicate { .. }
            )
        {
            checkpoint.entries[index].outcome = Outcome::Pending {};
            connection(app, |connection| checkpoint.save(connection))?;
            break;
        }
        match result {
            Ok(true) => {}
            Ok(false) => {
                checkpoint.entries[index].outcome = Outcome::Pending {};
                connection(app, |connection| checkpoint.save(connection))?;
                break;
            }
            Err(error) => {
                remove_uncommitted_files(app, &directory, &id)?;
                checkpoint.entries[index].outcome = Outcome::Failed {
                    message: error.to_string().into_boxed_str(),
                };
                connection(app, |connection| checkpoint.save(connection))?;
            }
        }
    }
    Ok(())
}

fn load_known_books(app: &AppHandle) -> Result<Vec<KnownBook>, AppError> {
    crate::database::with_connection(app, |connection| {
        let mut statement = connection.prepare("SELECT COALESCE(json_extract(metadata_json,'$.fileSize'),0), json_extract(metadata_json,'$.contentHash') FROM book_metadata WHERE json_extract(metadata_json,'$.contentHash') IS NOT NULL")?;
        let known = statement
            .query_map([], |row| {
                Ok(KnownBook {
                    size: row.get(0)?,
                    hash: row.get::<_, String>(1)?.into_boxed_str(),
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>();
        known
    })
}

fn import_one(
    app: &AppHandle,
    directory: &std::path::Path,
    request: &Request,
    id: &str,
    checkpoint: &mut Checkpoint,
    index: usize,
    known: &mut Vec<KnownBook>,
) -> Result<bool, AppError> {
    if let Some(metadata) = connection(app, |connection| {
        checkpoint.existing_metadata(connection, index)
    })? {
        connection(app, |connection| {
            if request.source_folder.is_some() {
                checkpoint.acknowledge_duplicate(connection, index, id)
            } else {
                checkpoint.acknowledge(connection, index, &metadata)
            }
        })?;
        return Ok(true);
    }
    #[cfg(target_os = "android")]
    let mut temporary = TemporarySource(None);
    #[cfg(not(target_os = "android"))]
    let temporary = TemporarySource(None);
    let source = if request.source.starts_with("content://") {
        #[cfg(target_os = "android")]
        {
            let path = tauri_plugin_mobile_folder_scan::materialize_import_document(
                app,
                &request.source,
                &request.name,
            )
            .map_err(AppError::io)?;
            temporary.0 = Some(std::path::PathBuf::from(&path));
            path
        }
        #[cfg(not(target_os = "android"))]
        return Err(AppError::invalid_input(
            "This document provider is only available on Android",
        ));
    } else {
        request.source.to_string()
    };
    let result = crate::batch_ingest::ingest_job_file_with_hint(
        &source,
        directory,
        id,
        known,
        temporary.0.is_some(),
        Some(&request.format),
        &state().cancel,
        &|stage, completed_bytes, total_bytes| {
            if let Ok(mut current) = state().current.lock() {
                current.stage = Some(stage);
                current.completed_bytes = completed_bytes;
                current.total_bytes = total_bytes;
            }
        },
    );
    drop(temporary);
    match result? {
        None => Ok(false),
        Some(IngestItem::Imported { mut book, .. }) => {
            if source != *request.source {
                restore_display_name(&mut book, std::path::Path::new(&source), request);
            }
            book.file_path = request.source.clone();
            let newly_known = book
                .content_hash
                .as_deref()
                .map(|hash| (book.file_size, hash.to_string().into_boxed_str()));
            let mut metadata = serde_json::to_value(book)
                .map_err(|error| AppError::internal(error.to_string()))?;
            metadata["readingTime"] = 0.into();
            if let Some(folder) = &request.source_folder {
                metadata["sourceFolders"] = serde_json::json!([{ "root": folder.root, "name": folder.root_name, "relativePath": folder.relative_path }]);
            }
            let metadata = serde_json::to_string(&metadata)
                .map_err(|error| AppError::internal(error.to_string()))?;
            connection(app, |connection| {
                checkpoint.acknowledge(connection, index, &metadata)
            })?;
            if let Some((size, hash)) = newly_known {
                known.push(KnownBook { size, hash });
            }
            Ok(true)
        }
        Some(IngestItem::Duplicate { content_hash, .. }) => {
            let book_id: Option<String> = crate::database::with_connection(app, |connection| {
                connection.query_row("SELECT book_id FROM book_metadata WHERE json_extract(metadata_json,'$.contentHash') = ?1 LIMIT 1", [&*content_hash], |row| row.get(0)).optional()
            })?;
            let book_id = book_id.ok_or_else(|| {
                AppError::not_found("The matching book was removed during import; retry this file")
            })?;
            remove_uncommitted_files(app, directory, id)?;
            connection(app, |connection| {
                checkpoint.acknowledge_duplicate(connection, index, &book_id)
            })?;
            Ok(true)
        }
        Some(IngestItem::Failed { reason, .. }) => Err(AppError::io(reason.to_string())),
    }
}

#[cfg(target_os = "android")]
fn monitor_android_service(app: AppHandle, job_id: Box<str>) {
    std::thread::spawn(move || {
        while state().active.load(Ordering::Acquire) {
            let response = tauri_plugin_mobile_folder_scan::import_service_status(&app);
            let Ok(current_job) = state().job_id.lock() else {
                break;
            };
            if current_job.as_deref() != Some(&*job_id) {
                break;
            }
            match response {
                Ok(status) => {
                    if status.stopped {
                        state().cancel.store(true, Ordering::Release);
                        break;
                    }
                    if status.copying {
                        if let Ok(mut current) = state().current.lock() {
                            current.stage = Some(ImportStage::Copying);
                            current.completed_bytes = status.completed_bytes;
                            current.total_bytes = status.total_bytes;
                        }
                    }
                }
                Err(_) => {
                    state().cancel.store(true, Ordering::Release);
                    break;
                }
            }
            drop(current_job);
            std::thread::sleep(std::time::Duration::from_millis(250));
        }
    });
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultPage {
    next: usize,
    items: Box<[ResultItem]>,
}

#[derive(Serialize)]
pub struct ResultItem {
    source: Box<str>,
    outcome: &'static str,
    book: Option<Box<serde_json::Value>>,
    message: Option<Box<str>>,
}

/// Reads a bounded page of acknowledged results from current metadata.
pub fn results(
    app: &AppHandle,
    job_id: &str,
    offset: usize,
    limit: usize,
) -> Result<ResultPage, AppError> {
    if limit == 0 || limit > 200 {
        return Err(AppError::invalid_input("Invalid import result page size"));
    }
    let checkpoint =
        load(app)?.ok_or_else(|| AppError::not_found("Import results are no longer available"))?;
    if &*checkpoint.id != job_id {
        return Err(AppError::invalid_input("The import job changed"));
    }
    if offset > checkpoint.entries.len() {
        return Err(AppError::invalid_input("Invalid import result offset"));
    }
    let mut items = Vec::new();
    for entry in checkpoint.entries.iter().skip(offset).take(limit) {
        let (outcome, id, message) = match &entry.outcome {
            Outcome::Saved {} => ("saved", Some(&*entry.book_id), None),
            Outcome::Duplicate { book_id } => ("duplicate", Some(&**book_id), None),
            Outcome::Failed { message } => ("failed", None, Some(message.clone())),
            _ => break,
        };
        let book = if let Some(id) = id {
            let json: Option<String> = crate::database::with_connection(app, |connection| {
                connection
                    .query_row(
                        "SELECT metadata_json FROM book_metadata WHERE book_id=?1",
                        [id],
                        |row| row.get(0),
                    )
                    .optional()
            })?;
            json.map(|json| serde_json::from_str::<serde_json::Value>(&json).map(Box::new))
                .transpose()
                .map_err(|error| AppError::internal(error.to_string()))?
        } else {
            None
        };
        items.push(ResultItem {
            source: entry.request.source.clone(),
            outcome,
            book,
            message,
        });
    }
    Ok(ResultPage {
        next: offset + items.len(),
        items: items.into_boxed_slice(),
    })
}

/// Discards an inactive, valid journal and its uncommitted cache files.
pub fn discard(app: &AppHandle, job_id: &str) -> Result<(), AppError> {
    state()
        .active
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .map_err(|_| AppError::invalid_input("Stop the import before discarding pending work"))?;
    let result = (|| {
        let checkpoint = load(app)?;
        if let Some(checkpoint) = checkpoint {
            if &*checkpoint.id != job_id {
                return Err(AppError::invalid_input("The import job changed"));
            }
            let directory = app
                .path()
                .app_data_dir()
                .map_err(|error| AppError::io(error.to_string()))?
                .join("book-cache");
            for entry in &checkpoint.entries {
                if !matches!(
                    entry.outcome,
                    Outcome::Pending {} | Outcome::Running {} | Outcome::Failed { .. }
                ) {
                    continue;
                }
                remove_uncommitted_files(app, &directory, &entry.book_id)?;
            }
            crate::database::with_connection(app, |connection| {
                crate::database::sqlite_delete_kv_inner(connection, checkpoint::KEY)
            })?;
        }
        sweep_abandoned_import_temp_files(app);
        *state()
            .failure
            .lock()
            .map_err(|_| AppError::internal("Import state unavailable"))? = None;
        Ok(())
    })();
    state().active.store(false, Ordering::Release);
    result
}

fn sweep_temp_dir(dir: &std::path::Path) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                let _ = std::fs::remove_file(path);
            }
        }
    }
}

fn sweep_abandoned_import_temp_files(app: &AppHandle) {
    for base in [
        app.path().app_data_dir().ok(),
        app.path().app_local_data_dir().ok(),
    ]
    .into_iter()
    .flatten()
    {
        sweep_temp_dir(&base.join("theorem_import"));
    }
}

fn remove_uncommitted_files(
    app: &AppHandle,
    directory: &std::path::Path,
    book_id: &str,
) -> Result<(), AppError> {
    let saved = crate::database::with_connection(app, |connection| {
        connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM book_metadata WHERE book_id=?1)",
            [book_id],
            |row| row.get::<_, bool>(0),
        )
    })?;
    if !saved {
        for extension in ["part", "book"] {
            match std::fs::remove_file(directory.join(format!("{book_id}.{extension}"))) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(AppError::io(error.to_string())),
            }
        }
    }
    Ok(())
}

struct TemporarySource(Option<std::path::PathBuf>);
impl Drop for TemporarySource {
    fn drop(&mut self) {
        if let Some(path) = &self.0 {
            let _ = std::fs::remove_file(path);
        }
    }
}

fn restore_display_name(
    book: &mut crate::batch_ingest::NativeBookRecord,
    materialized: &std::path::Path,
    request: &Request,
) {
    let (temporary_title, temporary_author) =
        crate::batch_ingest::parse_title_author_from_filename(materialized);
    let (title, author) =
        crate::batch_ingest::parse_title_author_from_filename(std::path::Path::new(&*request.name));
    if *book.title == *temporary_title {
        book.title = title.into();
    }
    if *book.author == *temporary_author {
        book.author = author.into();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn materialized_names_do_not_replace_document_names_or_embedded_metadata() {
        let request = Request {
            source: "content://provider/123".into(),
            name: "Author - Book.pdf".into(),
            format: "pdf".into(),
            source_folder: None,
        };
        let materialized = std::path::Path::new("/app/theorem_import/123-Author_-_Book.pdf");
        let (title, author) = crate::batch_ingest::parse_title_author_from_filename(materialized);
        let mut book: crate::batch_ingest::NativeBookRecord = serde_json::from_value(serde_json::json!({ "id": "id", "title": title, "author": author, "filePath": "temporary", "format": "pdf", "fileSize":1, "addedAt":"2026-11-10T00:00:00Z", "progress":0, "isFavorite":false, "tags":[], "coverExtractionDone":false })).unwrap();
        restore_display_name(&mut book, materialized, &request);
        assert_eq!(&*book.title, "Book");
        assert_eq!(&*book.author, "Author");
        book.title = "Embedded title".into();
        book.author = "Embedded author".into();
        restore_display_name(&mut book, materialized, &request);
        assert_eq!(&*book.title, "Embedded title");
        assert_eq!(&*book.author, "Embedded author");
    }

    #[test]
    fn materialized_copy_is_removed_on_early_error_and_not_when_absent() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("copy.epub");
        std::fs::write(&path, b"book").unwrap();
        {
            let _source = TemporarySource(Some(path.clone()));
        }
        assert!(!path.exists());
        drop(TemporarySource(None));
    }

    #[test]
    fn sweep_temp_dir_removes_abandoned_files() {
        let directory = tempfile::tempdir().unwrap();
        let temp_dir = directory.path().join("theorem_import");
        std::fs::create_dir_all(&temp_dir).unwrap();
        let orphaned = temp_dir.join("uuid-abandoned.epub");
        let nested = temp_dir.join("sub");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(&orphaned, b"stale").unwrap();
        sweep_temp_dir(&temp_dir);
        assert!(
            !orphaned.exists(),
            "abandoned import temp file must be removed"
        );
        assert!(nested.is_dir(), "subdirectories should remain untouched");
    }

    #[test]
    fn current_preserves_64bit_byte_counts_above_u32_max() {
        let large_completed = u64::from(u32::MAX) + 123_456_789;
        let large_total = u64::from(u32::MAX) + 987_654_321;
        let current = Current {
            name: "multi-volume-archive.cbz".into(),
            stage: Some(ImportStage::Copying),
            completed_bytes: large_completed,
            total_bytes: Some(large_total),
        };
        let value = serde_json::to_value(&current).unwrap();
        assert_eq!(value["completedBytes"].as_u64(), Some(large_completed));
        assert_eq!(value["totalBytes"].as_u64(), Some(large_total));
    }
}
