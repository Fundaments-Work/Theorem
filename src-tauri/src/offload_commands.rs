//! Async wrappers for blocking commands.
//!
//! A `#[tauri::command]` that is not `async` runs inline on the thread that
//! receives the IPC message, which on Linux (WebKitGTK) and Android is the UI
//! thread: every PDF/EPUB range read, SQLite query or blocking HTTP request
//! froze input and painting for its duration. Each wrapper here keeps the
//! command name (so JS call sites are unchanged) and runs the original,
//! still-synchronous function on the blocking thread pool. Rust callers
//! (CLI, sync) keep using the originals directly.
//!
//! Ordering: SQLite calls from JS are serialised by the FIFO queue in
//! `src/core/lib/sqlite-storage.ts`, preserving the in-order execution the
//! main thread used to give for free.
//!
//! Generated from the command signatures; when adding a blocking command,
//! add a wrapper here and register `offload_commands::<name>` in `lib.rs`.

#![allow(clippy::too_many_arguments)]

use std::collections::HashMap;
use tauri::ipc::Response;
use tauri::AppHandle;

async fn offload<T, F>(task: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|e| format!("Background task failed: {e}"))?
}

#[tauri::command]
pub async fn prefetch_pdf_structure(path: String) -> Result<crate::PdfStructure, String> {
    offload(move || crate::prefetch_pdf_structure(path)).await
}

#[tauri::command]
pub async fn read_file(path: String) -> Result<Response, String> {
    offload(move || crate::read_file(path)).await
}

#[tauri::command]
pub async fn read_cbr_as_cbz(path: String) -> Result<Response, String> {
    offload(move || crate::read_cbr_as_cbz(path)).await
}

#[tauri::command]
pub async fn read_pdf_file(path: String) -> Result<Response, String> {
    offload(move || crate::read_pdf_file(path)).await
}

#[tauri::command]
pub async fn read_pdf_file_size(path: String) -> Result<u64, String> {
    offload(move || crate::read_pdf_file_size(path)).await
}

#[tauri::command]
pub async fn read_pdf_range(path: String, offset: u64, length: u64) -> Result<Response, String> {
    offload(move || crate::read_pdf_range(path, offset, length)).await
}

#[tauri::command]
pub async fn get_pdf_metadata(path: String) -> Result<crate::PdfMetadata, String> {
    offload(move || crate::get_pdf_metadata(path)).await
}

#[tauri::command]
pub async fn fetch_rss_feed(url: String) -> Result<String, String> {
    offload(move || crate::fetch_rss_feed(url)).await
}

#[tauri::command]
pub async fn fetch_url_content(url: String) -> Result<String, String> {
    offload(move || crate::fetch_url_content(url)).await
}

#[tauri::command]
pub async fn fetch_binary_content(url: String) -> Result<Response, String> {
    offload(move || crate::fetch_binary_content(url)).await
}

#[tauri::command]
pub async fn scan_library_folder_desktop(folder_path: String) -> Result<Vec<String>, String> {
    offload(move || crate::scan_library_folder_desktop(folder_path)).await
}

#[tauri::command]
pub async fn sqlite_save_book_data(
    app: AppHandle,
    id: String,
    data: Vec<u8>,
) -> Result<String, String> {
    offload(move || crate::database::sqlite_save_book_data(app, id, data)).await
}

#[tauri::command]
pub async fn sqlite_register_materialized_book(app: AppHandle, id: String) -> Result<(), String> {
    offload(move || crate::database::sqlite_register_materialized_book(app, id)).await
}

#[tauri::command]
pub async fn sqlite_get_book_data(app: AppHandle, id: String) -> Result<Option<Vec<u8>>, String> {
    offload(move || crate::database::sqlite_get_book_data(app, id)).await
}

#[tauri::command]
pub async fn sqlite_delete_book_data(app: AppHandle, id: String) -> Result<(), String> {
    offload(move || crate::database::sqlite_delete_book_data(app, id)).await
}

#[tauri::command]
pub async fn sqlite_get_materialized_book_path(
    app: AppHandle,
    id: String,
) -> Result<Option<String>, String> {
    offload(move || crate::database::sqlite_get_materialized_book_path(app, id)).await
}

#[tauri::command]
pub async fn sqlite_save_cover_image(
    app: AppHandle,
    book_id: String,
    data_url: String,
) -> Result<(), String> {
    offload(move || crate::database::sqlite_save_cover_image(app, book_id, data_url)).await
}

#[tauri::command]
pub async fn sqlite_get_cover_image(
    app: AppHandle,
    book_id: String,
) -> Result<Option<String>, String> {
    offload(move || crate::database::sqlite_get_cover_image(app, book_id)).await
}

#[tauri::command]
pub async fn sqlite_delete_cover_image(app: AppHandle, book_id: String) -> Result<(), String> {
    offload(move || crate::database::sqlite_delete_cover_image(app, book_id)).await
}

#[tauri::command]
pub async fn sqlite_get_storage_stats(
    app: AppHandle,
) -> Result<crate::database::SqliteStorageStats, String> {
    offload(move || crate::database::sqlite_get_storage_stats(app)).await
}

#[tauri::command]
pub async fn sqlite_cleanup_orphaned_storage(
    app: AppHandle,
    existing_book_ids: Vec<String>,
) -> Result<crate::database::SqliteCleanupResult, String> {
    offload(move || crate::database::sqlite_cleanup_orphaned_storage(app, existing_book_ids)).await
}

#[tauri::command]
pub async fn sqlite_clear_all_storage(app: AppHandle) -> Result<(), String> {
    offload(move || crate::database::sqlite_clear_all_storage(app)).await
}

#[tauri::command]
pub async fn sqlite_get_kv(app: AppHandle, key: String) -> Result<Option<String>, String> {
    offload(move || crate::database::sqlite_get_kv(app, key)).await
}

#[tauri::command]
pub async fn sqlite_check_goal_reminder(
    app: AppHandle,
) -> Result<Option<crate::database::GoalReminderData>, String> {
    offload(move || crate::database::sqlite_check_goal_reminder(app)).await
}

#[tauri::command]
pub async fn sqlite_batch_get_kv(
    app: AppHandle,
    keys: Vec<String>,
) -> Result<Vec<(String, String)>, String> {
    offload(move || crate::database::sqlite_batch_get_kv(app, keys)).await
}

#[tauri::command]
pub async fn sqlite_set_kv(app: AppHandle, key: String, value: String) -> Result<(), String> {
    offload(move || crate::database::sqlite_set_kv(app, key, value)).await
}

#[tauri::command]
pub async fn sqlite_delete_kv(app: AppHandle, key: String) -> Result<(), String> {
    offload(move || crate::database::sqlite_delete_kv(app, key)).await
}

#[tauri::command]
pub async fn sqlite_count_kv_by_prefix(app: AppHandle, prefix: String) -> Result<u64, String> {
    offload(move || crate::database::sqlite_count_kv_by_prefix(app, prefix)).await
}

#[tauri::command]
pub async fn sqlite_delete_kv_by_prefix(app: AppHandle, prefix: String) -> Result<u64, String> {
    offload(move || crate::database::sqlite_delete_kv_by_prefix(app, prefix)).await
}

#[tauri::command]
pub async fn sqlite_set_blob(app: AppHandle, key: String, data: Vec<u8>) -> Result<(), String> {
    offload(move || crate::database::sqlite_set_blob(app, key, data)).await
}

#[tauri::command]
pub async fn sqlite_get_blob(app: AppHandle, key: String) -> Result<Option<Vec<u8>>, String> {
    offload(move || crate::database::sqlite_get_blob(app, key)).await
}

#[tauri::command]
pub async fn sqlite_delete_blob(app: AppHandle, key: String) -> Result<(), String> {
    offload(move || crate::database::sqlite_delete_blob(app, key)).await
}

#[tauri::command]
pub async fn sqlite_delete_blobs_by_prefix(app: AppHandle, prefix: String) -> Result<u64, String> {
    offload(move || crate::database::sqlite_delete_blobs_by_prefix(app, prefix)).await
}

#[tauri::command]
pub async fn sqlite_get_blob_stats(
    app: AppHandle,
    prefix: Option<String>,
) -> Result<crate::database::SqliteBlobStats, String> {
    offload(move || crate::database::sqlite_get_blob_stats(app, prefix)).await
}

#[tauri::command]
pub async fn sqlite_index_book_fts(
    app: AppHandle,
    book_id: String,
    title: String,
    author: String,
) -> Result<(), String> {
    offload(move || crate::database::sqlite_index_book_fts(app, book_id, title, author)).await
}

#[tauri::command]
pub async fn sqlite_index_books_fts_batch(
    app: AppHandle,
    entries: Vec<(String, String, String)>,
) -> Result<(), String> {
    offload(move || crate::database::sqlite_index_books_fts_batch(app, entries)).await
}

#[tauri::command]
pub async fn sqlite_search_books(
    app: AppHandle,
    query: String,
    limit: u32,
) -> Result<Vec<crate::database::SqliteBookSearchResult>, String> {
    offload(move || crate::database::sqlite_search_books(app, query, limit)).await
}

#[tauri::command]
pub async fn sqlite_save_book_metadata(
    app: AppHandle,
    book_id: String,
    metadata_json: String,
) -> Result<(), String> {
    offload(move || crate::database::sqlite_save_book_metadata(app, book_id, metadata_json)).await
}

#[tauri::command]
pub async fn sqlite_get_book_metadata(
    app: AppHandle,
    book_id: String,
) -> Result<Option<String>, String> {
    offload(move || crate::database::sqlite_get_book_metadata(app, book_id)).await
}

#[tauri::command]
pub async fn sqlite_save_book_annotations(
    app: AppHandle,
    book_id: String,
    annotations_json: Vec<String>,
) -> Result<(), String> {
    offload(move || crate::database::sqlite_save_book_annotations(app, book_id, annotations_json))
        .await
}

#[tauri::command]
pub async fn sqlite_get_book_annotations(
    app: AppHandle,
    book_id: String,
) -> Result<Vec<String>, String> {
    offload(move || crate::database::sqlite_get_book_annotations(app, book_id)).await
}

#[tauri::command]
pub async fn sqlite_merge_sync_entries(
    app: AppHandle,
    entries: HashMap<String, String>,
) -> Result<crate::database::SyncMergeResult, String> {
    offload(move || crate::database::sqlite_merge_sync_entries(app, entries)).await
}

#[tauri::command]
pub async fn sqlite_shrink_memory(app: AppHandle) -> Result<(), String> {
    offload(move || crate::database::sqlite_shrink_memory(app)).await
}

#[tauri::command]
pub async fn sqlite_query_books_window(
    app: AppHandle,
    limit: u32,
    offset: u32,
) -> Result<crate::database::BookWindowResult, String> {
    offload(move || crate::database::sqlite_query_books_window(app, limit, offset)).await
}

#[tauri::command]
pub async fn sqlite_get_rss_feeds(
    app: AppHandle,
) -> Result<Vec<crate::database::RssFeedDto>, String> {
    offload(move || crate::database::sqlite_get_rss_feeds(app)).await
}

#[tauri::command]
pub async fn sqlite_save_rss_feed(
    app: AppHandle,
    feed: crate::database::RssFeedDto,
) -> Result<(), String> {
    offload(move || crate::database::sqlite_save_rss_feed(app, feed)).await
}

#[tauri::command]
pub async fn sqlite_delete_rss_feed(app: AppHandle, feed_id: String) -> Result<(), String> {
    offload(move || crate::database::sqlite_delete_rss_feed(app, feed_id)).await
}

#[tauri::command]
pub async fn sqlite_get_rss_articles(
    app: AppHandle,
    feed_id: Option<String>,
    limit: Option<u32>,
    offset: Option<u32>,
) -> Result<Vec<crate::database::RssArticleDto>, String> {
    offload(move || crate::database::sqlite_get_rss_articles(app, feed_id, limit, offset)).await
}

#[tauri::command]
pub async fn sqlite_get_rss_article_content(
    app: AppHandle,
    article_id: String,
) -> Result<Option<crate::database::RssArticleContentDto>, String> {
    offload(move || crate::database::sqlite_get_rss_article_content(app, article_id)).await
}

#[tauri::command]
pub async fn sqlite_save_rss_article(
    app: AppHandle,
    article: crate::database::RssArticleDto,
    content: Option<String>,
    full_content: Option<String>,
) -> Result<(), String> {
    offload(move || crate::database::sqlite_save_rss_article(app, article, content, full_content))
        .await
}

#[tauri::command]
pub async fn sqlite_mark_article_read(
    app: AppHandle,
    article_id: String,
    is_read: bool,
) -> Result<(), String> {
    offload(move || crate::database::sqlite_mark_article_read(app, article_id, is_read)).await
}

#[tauri::command]
pub async fn sqlite_mark_article_favorite(
    app: AppHandle,
    article_id: String,
    is_favorite: bool,
) -> Result<(), String> {
    offload(move || crate::database::sqlite_mark_article_favorite(app, article_id, is_favorite))
        .await
}

#[tauri::command]
pub async fn sqlite_delete_rss_article(app: AppHandle, article_id: String) -> Result<(), String> {
    offload(move || crate::database::sqlite_delete_rss_article(app, article_id)).await
}

#[tauri::command]
pub async fn sqlite_record_reading_session(
    app: AppHandle,
    session_id: String,
    date: String,
    minutes: f64,
    book_id: Option<String>,
    books_read_json: Option<String>,
) -> Result<(), String> {
    offload(move || {
        crate::database::sqlite_record_reading_session(
            app,
            session_id,
            date,
            minutes,
            book_id,
            books_read_json,
        )
    })
    .await
}

#[tauri::command]
pub async fn sqlite_get_reading_sessions(
    app: AppHandle,
    start_date: Option<String>,
    end_date: Option<String>,
) -> Result<Vec<crate::database::ReadingSessionDto>, String> {
    offload(move || crate::database::sqlite_get_reading_sessions(app, start_date, end_date)).await
}

#[tauri::command]
pub async fn sqlite_get_vocabulary_terms(
    app: AppHandle,
) -> Result<Vec<crate::database::SqliteVocabularyTerm>, String> {
    offload(move || crate::database::sqlite_get_vocabulary_terms(app)).await
}

#[tauri::command]
pub async fn sqlite_save_vocabulary_term(
    app: AppHandle,
    term: crate::database::SqliteVocabularyTerm,
) -> Result<(), String> {
    offload(move || crate::database::sqlite_save_vocabulary_term(app, term)).await
}

#[tauri::command]
pub async fn sqlite_delete_vocabulary_term(app: AppHandle, term_id: String) -> Result<(), String> {
    offload(move || crate::database::sqlite_delete_vocabulary_term(app, term_id)).await
}

#[tauri::command]
pub async fn sqlite_list_cover_versions(
    app: AppHandle,
) -> Result<Vec<crate::cover_protocol::CoverVersion>, String> {
    offload(move || crate::cover_protocol::sqlite_list_cover_versions(app)).await
}

#[tauri::command]
pub async fn extract_article_from_html_native(
    html: String,
    base_url: Option<String>,
) -> Result<crate::article_extractor::NativeExtractedArticle, String> {
    offload(move || crate::article_extractor::extract_article_from_html_native(html, base_url))
        .await
}

#[tauri::command]
pub async fn decompress_palmdoc_record(record_bytes: Vec<u8>) -> Result<String, String> {
    offload(move || crate::mobi_parser::decompress_palmdoc_record(record_bytes)).await
}

#[tauri::command]
pub async fn get_mobi_metadata(path: String) -> Result<crate::mobi_parser::MobiMetadata, String> {
    offload(move || crate::mobi_parser::get_mobi_metadata(path)).await
}

#[tauri::command]
pub async fn extract_audiobook_metadata(
    path: String,
) -> Result<crate::audiobook::AudiobookMetadata, String> {
    offload(move || crate::audiobook::extract_audiobook_metadata(path)).await
}

#[tauri::command]
pub async fn rewrite_epub_metadata(
    app: AppHandle,
    book_id: String,
    metadata: Option<crate::epub_rewriter::EpubMetadataEdit>,
    cover: Option<Vec<u8>>,
) -> Result<crate::epub_rewriter::RewriteResult, String> {
    offload(move || crate::epub_rewriter::rewrite_epub_metadata(app, book_id, metadata, cover))
        .await
}

// Formerly synchronous commands that can block for long enough to matter:
// malloc_trim over the whole heap, ONNX session teardown, spawning
// `spd-say -L`, file-system scans, sentence chunking of whole books.

#[tauri::command]
pub async fn trim_memory(app: AppHandle) -> Result<(), String> {
    offload(move || {
        crate::trim_memory(app);
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn tts_engine_unload() -> Result<(), String> {
    offload(crate::supertonic::tts_engine_unload).await
}

#[tauri::command]
pub async fn tts_get_voices(app: AppHandle) -> Result<Vec<serde_json::Value>, String> {
    offload(move || crate::tts_get_voices(app)).await
}

#[tauri::command]
pub async fn tts_neural_status(app: AppHandle) -> Result<serde_json::Value, String> {
    offload(move || crate::supertonic::tts_neural_status(app)).await
}

#[tauri::command]
pub async fn tts_model_status(app: AppHandle) -> Result<crate::tts_model::TtsModelStatus, String> {
    offload(move || crate::tts_model::tts_model_status(app)).await
}

#[tauri::command]
pub async fn tts_model_remove(app: AppHandle) -> Result<u64, String> {
    offload(move || crate::tts_model::tts_model_remove(app)).await
}

#[tauri::command]
pub async fn tts_text_chunks(text: String, lang: String) -> Result<Vec<String>, String> {
    offload(move || crate::supertonic::tts_text_chunks(text, lang)).await
}

#[tauri::command]
pub async fn cli_setup_status() -> Result<crate::CliSetupStatus, String> {
    offload(crate::cli_setup_status).await
}
