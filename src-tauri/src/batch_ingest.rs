use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Manager};

mod metadata;
use metadata::parse_generic_native;
pub(crate) use metadata::{
    check_epub_readable, extract_xml_tag_text, parse_cbz_native, parse_epub_native, ParsedMetadata,
};
pub use metadata::{downsample_cover_to_data_url, parse_title_author_from_filename};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NativeBookRecord {
    pub id: Box<str>,
    pub title: Box<str>,
    pub author: Box<str>,
    #[serde(rename = "filePath")]
    pub file_path: Box<str>,
    #[serde(rename = "storagePath", skip_serializing_if = "Option::is_none")]
    pub storage_path: Option<Box<str>>,
    pub format: Box<str>,
    #[serde(rename = "contentHash", skip_serializing_if = "Option::is_none")]
    pub content_hash: Option<Box<str>>,
    #[serde(rename = "coverPath", skip_serializing_if = "Option::is_none")]
    pub cover_path: Option<Box<str>>,
    #[serde(rename = "coverExtractionDone")]
    pub cover_extraction_done: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<Box<str>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub publisher: Option<Box<str>>,
    #[serde(rename = "publishedDate", skip_serializing_if = "Option::is_none")]
    pub published_date: Option<Box<str>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<Box<str>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub isbn: Option<Box<str>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub series: Option<Box<str>>,
    #[serde(rename = "seriesIndex", skip_serializing_if = "Option::is_none")]
    pub series_index: Option<f64>,
    #[serde(rename = "fileSize")]
    pub file_size: u64,
    #[serde(rename = "addedAt")]
    pub added_at: Box<str>,
    pub progress: f64,
    #[serde(rename = "isFavorite")]
    pub is_favorite: bool,
    pub tags: Box<[Box<str>]>,
}

/// Compute SHA-256 hash of a file streaming in 64KB blocks
pub fn compute_file_sha256(path: &Path) -> Option<String> {
    let mut file = File::open(path).ok()?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 65536];

    // A read error must not yield the hash of half a file.
    loop {
        match file.read(&mut buffer) {
            Ok(0) => break,
            Ok(n) => hasher.update(&buffer[..n]),
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => return None,
        }
    }

    Some(hex::encode(hasher.finalize()))
}

// ─────────────────────────────────────────────────────────────────────────────
// BATCH INGEST
// ─────────────────────────────────────────────────────────────────────────────

/// Larger files are not books (a disk image or video given a book name).
pub const MAX_BOOK_BYTES: u64 = 8 * 1024 * 1024 * 1024;

/// Half-written copies older than this are left over from a crash.
const STALE_PART_AGE: std::time::Duration = std::time::Duration::from_secs(60 * 60);

/// A book already in the library, so a file with the same bytes is skipped
/// before anything is copied.
#[derive(Debug, Clone, Deserialize)]
pub struct KnownBook {
    pub size: u64,
    pub hash: Box<str>,
}

/// What happened to one file.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum IngestItem {
    Imported {
        path: Box<str>,
        book: Box<NativeBookRecord>,
    },
    Failed {
        path: Box<str>,
        reason: Box<str>,
    },
    /// The same bytes are already in the library or earlier in this batch.
    Duplicate {
        path: Box<str>,
        #[serde(rename = "contentHash")]
        content_hash: Box<str>,
    },
}

impl IngestItem {
    fn failed(path: &str, reason: impl Into<String>) -> Self {
        IngestItem::Failed {
            path: path.into(),
            reason: reason.into().into_boxed_str(),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IngestSummary {
    pub total: usize,
    pub imported: usize,
    pub failed: usize,
    pub duplicates: usize,
    /// Stopped before every file was handled; unhandled files are untouched.
    pub cancelled: bool,
}

/// Messages on the progress channel. Items arrive in batches so a large
/// import does not flood the webview; `done` is always the last message.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum IngestMessage {
    Progress {
        completed: usize,
        total: usize,
        items: Box<[IngestItem]>,
    },
    Done {
        summary: IngestSummary,
    },
}

enum FileError {
    Cancelled,
    Failed(String),
}

impl From<String> for FileError {
    fn from(reason: String) -> Self {
        FileError::Failed(reason)
    }
}

fn describe_io(error: &std::io::Error) -> String {
    crate::folder_walk::describe_io_error(error)
}

/// Copy `source` to `dest`, returning its SHA-256 (computed first, unless
/// `known_hash` already has it). The copy itself is done by the kernel
/// (`copy_file_range`/reflink where available), which is much faster than
/// copying through a buffer.
fn copy_with_hash(
    source: &Path,
    dest: &Path,
    known_hash: Option<&str>,
    cancel: &AtomicBool,
) -> Result<String, FileError> {
    let hash = match known_hash {
        Some(hash) => hash.to_string(),
        None => hash_file(source, cancel)?,
    };
    if cancel.load(Ordering::Relaxed) {
        return Err(FileError::Cancelled);
    }
    std::fs::copy(source, dest).map_err(|e| {
        // The source vanishing (drive unplugged) reads differently from a
        // failed write into the library.
        if source.exists() {
            format!("Could not save the book: {}", describe_io(&e))
        } else {
            describe_io(&e)
        }
    })?;
    Ok(hash)
}

/// SHA-256 of a file, checking `cancel` between blocks.
fn hash_file(path: &Path, cancel: &AtomicBool) -> Result<String, FileError> {
    let mut input = File::open(path).map_err(|e| describe_io(&e))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 256 * 1024];
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(FileError::Cancelled);
        }
        match input.read(&mut buffer) {
            Ok(0) => break,
            Ok(n) => hasher.update(&buffer[..n]),
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(format!("Reading stopped: {}", describe_io(&e)).into()),
        }
    }
    Ok(hex::encode(hasher.finalize()))
}

/// Remove `*.part` files a crashed import left behind. Recent ones may belong
/// to an import that is still running, so they stay.
fn sweep_stale_parts(cache_dir: &Path) {
    let Ok(entries) = std::fs::read_dir(cache_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().is_some_and(|e| e == "part") {
            let stale = entry
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.elapsed().ok())
                .is_some_and(|age| age > STALE_PART_AGE);
            if stale {
                let _ = std::fs::remove_file(path);
            }
        }
    }
}

struct Batch<'a> {
    known_hashes: std::collections::HashSet<&'a str>,
    /// Sizes that occur more than once across the library and this batch:
    /// only these files need hashing before they are copied.
    shared_sizes: std::collections::HashSet<u64>,
    /// Hashes claimed by files of this batch, so the second copy of the same
    /// book is reported as a duplicate instead of imported twice.
    claimed: std::sync::Mutex<std::collections::HashSet<String>>,
    cache_dir: &'a Path,
    cancel: &'a AtomicBool,
}

/// Measurable byte stages and indeterminate metadata/archive work.
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ImportStage {
    Checking,
    Copying,
    Preparing,
    Metadata,
    Saving,
}

type ImportReporter<'a> = dyn Fn(ImportStage, u64, Option<u64>) + Sync + 'a;

fn hash_with_progress(
    path: &Path,
    cancel: &AtomicBool,
    report: &ImportReporter<'_>,
) -> Result<String, FileError> {
    let mut input = File::open(path).map_err(|error| describe_io(&error))?;
    let total = input.metadata().ok().map(|metadata| metadata.len());
    let mut buffer = vec![0; 256 * 1024];
    let mut hasher = Sha256::new();
    let mut completed = 0u64;
    report(ImportStage::Checking, completed, total);
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(FileError::Cancelled);
        }
        let length = match input.read(&mut buffer) {
            Ok(0) => break,
            Ok(length) => length,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(describe_io(&error).into()),
        };
        hasher.update(&buffer[..length]);
        completed += length as u64;
        report(ImportStage::Checking, completed, total);
    }
    Ok(hex::encode(hasher.finalize()))
}

fn copy_with_progress(
    source: &Path,
    dest: &Path,
    known_hash: Option<&str>,
    cancel: &AtomicBool,
    report: &ImportReporter<'_>,
) -> Result<String, FileError> {
    let hash = match known_hash {
        Some(hash) => hash.to_owned(),
        None => hash_with_progress(source, cancel, report)?,
    };
    let mut input = File::open(source).map_err(|error| describe_io(&error))?;
    let total = input.metadata().ok().map(|metadata| metadata.len());
    let mut output = File::create(dest).map_err(|error| describe_io(&error))?;
    let mut buffer = vec![0; 256 * 1024];
    let mut completed = 0u64;
    report(ImportStage::Copying, completed, total);
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(FileError::Cancelled);
        }
        let length = match input.read(&mut buffer) {
            Ok(0) => break,
            Ok(length) => length,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(describe_io(&error).into()),
        };
        output
            .write_all(&buffer[..length])
            .map_err(|error| describe_io(&error))?;
        completed += length as u64;
        report(ImportStage::Copying, completed, total);
    }
    output.sync_all().map_err(|error| describe_io(&error))?;
    Ok(hash)
}

/// A durable job supplies its checkpointed identity; regular batch imports retain
/// their existing kernel-copy path. `move_source` is reserved for copies created
/// and owned by this job's document materializer. No archive bytes cross JSON IPC.
pub fn ingest_job_file(
    raw_path: &str,
    cache_dir: &Path,
    book_id: &str,
    known: &[KnownBook],
    move_source: bool,
    cancel: &Arc<AtomicBool>,
    report: &ImportReporter<'_>,
) -> Result<Option<IngestItem>, crate::error::AppError> {
    ingest_job_file_with_hint(
        raw_path,
        cache_dir,
        book_id,
        known,
        move_source,
        None,
        cancel,
        report,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn ingest_job_file_with_hint(
    raw_path: &str,
    cache_dir: &Path,
    book_id: &str,
    known: &[KnownBook],
    move_source: bool,
    format_hint: Option<&str>,
    cancel: &Arc<AtomicBool>,
    report: &ImportReporter<'_>,
) -> Result<Option<IngestItem>, crate::error::AppError> {
    uuid::Uuid::parse_str(book_id)
        .map_err(|_| crate::error::AppError::invalid_input("Invalid import book identity"))?;
    std::fs::create_dir_all(cache_dir)?;
    let size = std::fs::metadata(raw_path)?.len();
    let batch = Batch {
        known_hashes: known.iter().map(|book| &*book.hash).collect(),
        shared_sizes: known.iter().map(|book| book.size).collect(),
        claimed: Default::default(),
        cache_dir,
        cancel,
    };
    match ingest_one_with_id(
        raw_path,
        size,
        &batch,
        book_id,
        Some(report),
        Some(cancel.clone()),
        move_source,
        format_hint,
    ) {
        Ok(item) => Ok(Some(item)),
        Err(FileError::Cancelled) => Ok(None),
        Err(FileError::Failed(message)) => Err(crate::error::AppError::io(message)),
    }
}

fn move_or_copy_with_rename<F>(source: &Path, dest: &Path, rename: F) -> std::io::Result<()>
where
    F: FnOnce(&Path, &Path) -> std::io::Result<()>,
{
    match rename(source, dest) {
        Ok(()) => Ok(()),
        Err(err)
            if err.kind() == std::io::ErrorKind::CrossesDevices
                || err.raw_os_error() == Some(18) =>
        {
            std::fs::copy(source, dest)?;
            if let Err(rm_err) = std::fs::remove_file(source) {
                log::warn!(
                    "[batch_ingest] Failed to remove source '{}' after cross-device copy: {rm_err}",
                    source.display()
                );
            }
            Ok(())
        }
        Err(err) => Err(err),
    }
}

fn ingest_one(raw_path: &str, size: u64, batch: &Batch) -> Result<IngestItem, FileError> {
    ingest_one_with_id(
        raw_path,
        size,
        batch,
        &uuid::Uuid::new_v4().to_string(),
        None,
        None,
        false,
        None,
    )
}

#[allow(clippy::too_many_arguments)]
fn ingest_one_with_id(
    raw_path: &str,
    size: u64,
    batch: &Batch,
    book_id: &str,
    reporter: Option<&ImportReporter<'_>>,
    conversion_cancel: Option<Arc<AtomicBool>>,
    move_source: bool,
    format_hint: Option<&str>,
) -> Result<IngestItem, FileError> {
    let hash = |path: &Path| match reporter {
        Some(report) => hash_with_progress(path, batch.cancel, report),
        None => hash_file(path, batch.cancel),
    };
    let copy = |source: &Path, dest: &Path, known: Option<&str>| {
        if move_source {
            let content_hash = match known {
                Some(value) => value.to_owned(),
                None => hash(source)?,
            };
            if batch.cancel.load(Ordering::Relaxed) {
                return Err(FileError::Cancelled);
            }
            move_or_copy_with_rename(source, dest, |s, d| std::fs::rename(s, d))
                .map_err(|error| describe_io(&error))?;
            return Ok(content_hash);
        }
        match reporter {
            Some(report) => copy_with_progress(source, dest, known, batch.cancel, report),
            None => copy_with_hash(source, dest, known, batch.cancel),
        }
    };
    let path = Path::new(raw_path);
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy())
        .unwrap_or_default();
    let Some(format) = crate::folder_walk::book_format_for_name_or_mime(&name, format_hint) else {
        return Err("This kind of file is not supported".to_string().into());
    };
    if size == 0 {
        return Err("The file is empty".to_string().into());
    }
    if size > MAX_BOOK_BYTES {
        return Err(format!(
            "The file is too large to be a book ({} GB)",
            size / (1024 * 1024 * 1024)
        )
        .into());
    }

    // Duplicates are found before anything is copied. Only a file whose size
    // matches another book can have the same bytes, so only those are hashed.
    let mut content_hash = None;
    if batch.shared_sizes.contains(&size) {
        let hash = hash(path)?;
        if batch.known_hashes.contains(hash.as_str()) {
            return Ok(IngestItem::Duplicate {
                path: raw_path.into(),
                content_hash: hash.into_boxed_str(),
            });
        }
        let first = batch
            .claimed
            .lock()
            .map_err(|_| "Import state was lost".to_string())?
            .insert(hash.clone());
        if !first {
            return Ok(IngestItem::Duplicate {
                path: raw_path.into(),
                content_hash: hash.into_boxed_str(),
            });
        }
        content_hash = Some(hash);
    }

    if batch.cancel.load(Ordering::Relaxed) {
        return Err(FileError::Cancelled);
    }
    if let Some(report) = reporter {
        report(ImportStage::Metadata, 0, None);
    }
    let metadata = match format {
        "epub" => parse_epub_native(path),
        "cbz" => parse_cbz_native(path),
        "cbr" => crate::cbr::parse_cbr_native(path),
        _ => parse_generic_native(path),
    }
    .map_err(|e| format!("Could not read this book: {e}"))?;

    let id = book_id.to_owned();
    let part = batch.cache_dir.join(format!("{id}.part"));
    let dest = batch.cache_dir.join(format!("{id}.book"));
    let written = (|| -> Result<(String, String), FileError> {
        let final_format = if format == "cbr" {
            if batch.cancel.load(Ordering::Relaxed) {
                return Err(FileError::Cancelled);
            }
            if let Some(report) = reporter {
                report(ImportStage::Preparing, 0, None);
            }
            match crate::cbr::convert_cbr_to_cbz_file_cancellable(
                path,
                &part,
                conversion_cancel.clone(),
            ) {
                Ok(()) => {
                    if content_hash.is_none() {
                        content_hash = Some(hash(path)?);
                    }
                    "cbz"
                }
                Err(error) => {
                    if batch.cancel.load(Ordering::Relaxed) {
                        return Err(FileError::Cancelled);
                    }
                    log::warn!("[batch_ingest] CBR to CBZ failed for '{raw_path}': {error}");
                    content_hash = Some(copy(path, &part, content_hash.as_deref())?);
                    "cbr"
                }
            }
        } else {
            content_hash = Some(copy(path, &part, content_hash.as_deref())?);
            format
        };
        if let Some(report) = reporter {
            report(ImportStage::Saving, 0, None);
        }
        std::fs::rename(&part, &dest)
            .map_err(|e| format!("Could not save the book: {}", describe_io(&e)))?;
        Ok((
            content_hash.clone().unwrap_or_default(),
            final_format.to_string(),
        ))
    })();
    let (content_hash, final_format) = match written {
        Ok(done) => done,
        Err(error) => {
            let _ = std::fs::remove_file(&part);
            let _ = std::fs::remove_file(&dest);
            return Err(error);
        }
    };

    let cover_extraction_done = metadata.cover_data_url.is_some();
    Ok(IngestItem::Imported {
        path: raw_path.into(),
        book: Box::new(NativeBookRecord {
            id: id.into_boxed_str(),
            title: metadata.title.into_boxed_str(),
            author: metadata.author.into_boxed_str(),
            file_path: raw_path.into(),
            storage_path: Some(dest.to_string_lossy().into_owned().into_boxed_str()),
            format: final_format.into_boxed_str(),
            content_hash: Some(content_hash.into_boxed_str()),
            cover_path: metadata.cover_data_url.map(String::into_boxed_str),
            cover_extraction_done,
            description: metadata.description.map(String::into_boxed_str),
            publisher: metadata.publisher.map(String::into_boxed_str),
            published_date: metadata.published_date.map(String::into_boxed_str),
            language: metadata.language.map(String::into_boxed_str),
            isbn: metadata.isbn.map(String::into_boxed_str),
            series: metadata.series.map(String::into_boxed_str),
            series_index: metadata.series_index,
            file_size: size,
            added_at: chrono::Utc::now().to_rfc3339().into_boxed_str(),
            progress: 0.0,
            is_favorite: false,
            tags: Box::default(),
        }),
    })
}

/// Import `paths` into `cache_dir` (`book-cache`) in parallel.
///
/// Every path is reported to `sink` exactly once, as imported, failed with a
/// reason, or a duplicate, unless the import is cancelled first. A failed or
/// cancelled file leaves nothing behind in `cache_dir`.
pub fn ingest_files(
    paths: &[String],
    cache_dir: &Path,
    known: &[KnownBook],
    cancel: &AtomicBool,
    sink: &(dyn Fn(IngestItem) + Sync),
) -> IngestSummary {
    let mut summary = IngestSummary {
        total: paths.len(),
        ..IngestSummary::default()
    };
    if let Err(error) = std::fs::create_dir_all(cache_dir) {
        let reason = format!("Could not save the book: {}", describe_io(&error));
        for path in paths {
            sink(IngestItem::failed(path, reason.clone()));
        }
        summary.failed = paths.len();
        return summary;
    }
    sweep_stale_parts(cache_dir);

    // One stat per file up front: sizes decide which files need hashing.
    let mut seen_paths = std::collections::HashSet::new();
    let mut sized = Vec::with_capacity(paths.len());
    for path in paths {
        if !seen_paths.insert(path.as_str()) {
            continue;
        }
        match std::fs::metadata(path) {
            Ok(m) if m.is_file() => sized.push((path, m.len())),
            Ok(_) => sink(IngestItem::failed(path, "Not a file")),
            Err(e) => sink(IngestItem::failed(path, describe_io(&e))),
        }
    }
    let unreadable = seen_paths.len() - sized.len();
    summary.total = seen_paths.len();

    let mut size_counts: HashMap<u64, usize> = HashMap::new();
    for book in known {
        *size_counts.entry(book.size).or_default() += 1;
    }
    for (_, size) in &sized {
        *size_counts.entry(*size).or_default() += 1;
    }
    let batch = Batch {
        known_hashes: known.iter().map(|b| &*b.hash).collect(),
        shared_sizes: size_counts
            .into_iter()
            .filter(|(_, n)| *n > 1)
            .map(|(size, _)| size)
            .collect(),
        claimed: Default::default(),
        cache_dir,
        cancel,
    };

    let imported = AtomicUsize::new(0);
    let failed = AtomicUsize::new(unreadable);
    let duplicates = AtomicUsize::new(0);
    sized.par_iter().for_each(|(path, size)| {
        if cancel.load(Ordering::Relaxed) {
            return;
        }
        let item = match ingest_one(path, *size, &batch) {
            Ok(item) => item,
            Err(FileError::Cancelled) => return,
            Err(FileError::Failed(reason)) => IngestItem::failed(path, reason),
        };
        match &item {
            IngestItem::Imported { .. } => &imported,
            IngestItem::Failed { .. } => &failed,
            IngestItem::Duplicate { .. } => &duplicates,
        }
        .fetch_add(1, Ordering::Relaxed);
        sink(item);
    });

    summary.imported = imported.into_inner();
    summary.failed = failed.into_inner();
    summary.duplicates = duplicates.into_inner();
    summary.cancelled = summary.imported + summary.failed + summary.duplicates < summary.total;
    summary
}

/// Collects items and sends them in batches: at most every `interval`, or as
/// soon as `max_items` are waiting.
pub struct ProgressBatcher<F: Fn(IngestMessage)> {
    send: F,
    total: usize,
    max_items: usize,
    interval: std::time::Duration,
    state: std::sync::Mutex<(Vec<IngestItem>, usize, std::time::Instant)>,
}

impl<F: Fn(IngestMessage)> ProgressBatcher<F> {
    pub fn new(total: usize, max_items: usize, interval: std::time::Duration, send: F) -> Self {
        Self {
            send,
            total,
            max_items,
            interval,
            state: std::sync::Mutex::new((Vec::new(), 0, std::time::Instant::now())),
        }
    }

    pub fn push(&self, item: IngestItem) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        state.0.push(item);
        state.1 += 1;
        if state.0.len() >= self.max_items || state.2.elapsed() >= self.interval {
            self.flush_locked(&mut state);
        }
    }

    fn flush_locked(&self, state: &mut (Vec<IngestItem>, usize, std::time::Instant)) {
        state.2 = std::time::Instant::now();
        if state.0.is_empty() {
            return;
        }
        (self.send)(IngestMessage::Progress {
            completed: state.1,
            total: self.total,
            items: std::mem::take(&mut state.0).into_boxed_slice(),
        });
    }

    /// Send whatever is waiting, then `done`.
    pub fn finish(&self, summary: IngestSummary) {
        if let Ok(mut state) = self.state.lock() {
            self.flush_locked(&mut state);
        }
        (self.send)(IngestMessage::Done { summary });
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// TAURI COMMANDS
// ─────────────────────────────────────────────────────────────────────────────

/// Multi-threaded batch ingestion. Results stream over `on_progress`; the
/// returned summary is the same as the final `done` message. `job_id` lets
/// `cancel_import_job` stop it; `known` lists the library's books so
/// duplicates are skipped before copying.
#[tauri::command]
pub async fn ingest_books_native(
    app: AppHandle,
    file_paths: Vec<String>,
    job_id: Option<String>,
    known: Option<Vec<KnownBook>>,
    on_progress: tauri::ipc::Channel<IngestMessage>,
) -> Result<IngestSummary, String> {
    let cache_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data directory: {e}"))?
        .join("book-cache");
    let job = crate::folder_walk::register_job(job_id);

    tokio::task::spawn_blocking(move || {
        let batcher = ProgressBatcher::new(
            file_paths.len(),
            64,
            std::time::Duration::from_millis(150),
            |message| {
                let _ = on_progress.send(message);
            },
        );
        let summary = ingest_files(
            &file_paths,
            &cache_dir,
            known.as_deref().unwrap_or_default(),
            &job.flag,
            &|item| batcher.push(item),
        );
        batcher.finish(summary.clone());
        summary
    })
    .await
    .map_err(|e| format!("Batch ingestion worker failed: {e}"))
}

#[cfg(test)]
mod tests;
