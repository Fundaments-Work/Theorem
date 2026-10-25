//! Merging entries received from paired devices: the rules for each kind of item.

use super::*;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncMergeResult {
    pub domains_updated: Vec<String>,
    pub books_count: usize,
    pub annotations_count: usize,
    pub updated_books: Vec<String>,
    pub deleted_books: Vec<String>,
    pub updated_annotations: Vec<String>,
    pub deleted_annotations: Vec<String>,
    pub updated_vocabulary: Vec<String>,
    pub deleted_vocabulary: Vec<String>,
    pub updated_rss_articles: Vec<String>,
    pub deleted_rss_articles: Vec<String>,
    /// Conflicts found by this merge (see `sqlite_list_sync_conflicts`).
    pub conflicts: usize,
}

pub(super) fn parse_sync_date(val: Option<&serde_json::Value>) -> Option<i64> {
    match val {
        Some(serde_json::Value::Number(n)) => n.as_i64(),
        Some(serde_json::Value::String(s)) => {
            if let Ok(num) = s.parse::<i64>() {
                Some(num)
            } else if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(s) {
                Some(dt.timestamp_millis())
            } else if let Ok(naive) = chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S")
            {
                Some(naive.and_utc().timestamp_millis())
            } else {
                None
            }
        }
        _ => None,
    }
}

/// Stores a synced annotation unless this device holds a newer edit of it
/// (by `updatedAt`). Returns whether it was stored.
fn upsert_synced_annotation(
    connection: &Connection,
    id: &str,
    book_id: &str,
    incoming: &serde_json::Value,
    incoming_json: &str,
    conflicts: &mut usize,
) -> rusqlite::Result<bool> {
    let existing: Option<String> = connection
        .query_row(
            "SELECT annotation_json FROM book_annotations WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .optional()?;
    if existing.as_deref() == Some(incoming_json) {
        // The same record (a book's annotations arrive together when one of
        // them changed): nothing to store or report.
        return Ok(false);
    }
    if let Some(existing) = existing {
        let existing_val = serde_json::from_str::<serde_json::Value>(&existing).ok();
        if let Some(found) = existing_val.as_ref().and_then(|local| {
            concurrent_edit(
                local,
                incoming,
                "updatedAt",
                "baseUpdatedAt",
                ANNOTATION_EDITABLE_FIELDS,
            )
        }) {
            let label = existing_val
                .as_ref()
                .and_then(|v| v.get("selectedText").or_else(|| v.get("noteContent")))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .chars()
                .take(80)
                .collect::<String>();
            if record_sync_conflict(connection, "annotation", id, &label, &found) {
                *conflicts += 1;
            }
        }
        let local_at = existing_val
            .as_ref()
            .and_then(|v| parse_sync_date(v.get("updatedAt")));
        let incoming_at = parse_sync_date(incoming.get("updatedAt"));
        if let (Some(local_at), Some(incoming_at)) = (local_at, incoming_at) {
            if local_at > incoming_at {
                return Ok(false);
            }
        }
    }
    connection.execute(
        "INSERT OR IGNORE INTO books(id, data, updated_at) VALUES(?1, X'', unixepoch())",
        params![book_id],
    )?;
    connection.execute(
        "INSERT INTO book_annotations(id, book_id, annotation_json, updated_at) VALUES(?1, ?2, ?3, unixepoch()) ON CONFLICT(id) DO UPDATE SET annotation_json = excluded.annotation_json, updated_at = unixepoch()",
        params![id, book_id, incoming_json],
    )?;
    Ok(true)
}

fn upsert_sync_vocabulary_term(
    connection: &Connection,
    term: &serde_json::Value,
) -> rusqlite::Result<Option<String>> {
    let id = term.get("id").and_then(|v| v.as_str()).unwrap_or("");
    let word = term.get("term").and_then(|v| v.as_str()).unwrap_or("");
    if id.is_empty() || word.is_empty() {
        return Ok(None);
    }
    let normalized_term = term
        .get("normalizedTerm")
        .and_then(|v| v.as_str())
        .unwrap_or(word);
    let language = term
        .get("language")
        .and_then(|v| v.as_str())
        .unwrap_or("en");
    let phonetic = term.get("phonetic").and_then(|v| v.as_str());
    let audio_url = term.get("audioUrl").and_then(|v| v.as_str());
    let meanings_json = term
        .get("meanings")
        .map(|v| v.to_string())
        .unwrap_or_else(|| "[]".to_string());
    let provider_history_json = term
        .get("providerHistory")
        .map(|v| v.to_string())
        .unwrap_or_else(|| "[]".to_string());
    let source_book_id = term.get("sourceBookId").and_then(|v| v.as_str());
    let context_sentence = term.get("contextSentence").and_then(|v| v.as_str());
    let created_at = parse_sync_date(term.get("createdAt")).unwrap_or_else(|| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64
    });
    let updated_at = parse_sync_date(term.get("updatedAt"));

    let changed = connection.execute(
        r#"
        INSERT INTO vocabulary (
            id, term, normalized_term, language, phonetic, audio_url,
            meanings_json, provider_history_json, source_book_id,
            context_sentence, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
        ON CONFLICT(id) DO UPDATE SET
            term = excluded.term,
            normalized_term = excluded.normalized_term,
            language = excluded.language,
            phonetic = excluded.phonetic,
            audio_url = excluded.audio_url,
            meanings_json = excluded.meanings_json,
            provider_history_json = excluded.provider_history_json,
            source_book_id = excluded.source_book_id,
            context_sentence = excluded.context_sentence,
            created_at = MIN(vocabulary.created_at, excluded.created_at),
            updated_at = excluded.updated_at
        WHERE excluded.updated_at IS NULL
            OR vocabulary.updated_at IS NULL
            OR excluded.updated_at >= vocabulary.updated_at
        "#,
        params![
            id,
            word,
            normalized_term,
            language,
            phonetic,
            audio_url,
            meanings_json,
            provider_history_json,
            source_book_id,
            context_sentence,
            created_at,
            updated_at,
        ],
    )?;
    // An older copy of a term this device already has is not applied.
    Ok((changed > 0).then(|| id.to_string()))
}

fn upsert_sync_rss_article(
    connection: &Connection,
    article: &serde_json::Value,
) -> rusqlite::Result<Option<String>> {
    let id = article.get("id").and_then(|v| v.as_str()).unwrap_or("");
    let feed_id = article
        .get("feedId")
        .or_else(|| article.get("feed_id"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let title = article.get("title").and_then(|v| v.as_str()).unwrap_or("");
    if id.is_empty() || feed_id.is_empty() {
        return Ok(None);
    }
    let author = article.get("author").and_then(|v| v.as_str());
    let url = article.get("url").and_then(|v| v.as_str()).unwrap_or("");
    let summary = article.get("summary").and_then(|v| v.as_str());
    let content_source = article
        .get("contentSource")
        .or_else(|| article.get("content_source"))
        .and_then(|v| v.as_str());
    let image_url = article
        .get("imageUrl")
        .or_else(|| article.get("image_url"))
        .and_then(|v| v.as_str());
    let published_at = parse_sync_date(
        article
            .get("publishedAt")
            .or_else(|| article.get("published_at")),
    )
    .unwrap_or(0);
    let fetched_at = parse_sync_date(
        article
            .get("fetchedAt")
            .or_else(|| article.get("fetched_at")),
    );
    let is_read = article
        .get("isRead")
        .or_else(|| article.get("is_read"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let is_favorite = article
        .get("isFavorite")
        .or_else(|| article.get("is_favorite"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let progress = article
        .get("progress")
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0);

    connection.execute(
        r#"
        INSERT INTO rss_articles (
            id, feed_id, title, author, url, summary,
            content_source, image_url, published_at, fetched_at,
            is_read, is_favorite, progress, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, COALESCE(?10, unixepoch() * 1000), ?11, ?12, ?13, unixepoch())
        ON CONFLICT(id) DO UPDATE SET
            feed_id = excluded.feed_id,
            title = excluded.title,
            author = excluded.author,
            url = excluded.url,
            summary = excluded.summary,
            content_source = excluded.content_source,
            image_url = excluded.image_url,
            published_at = excluded.published_at,
            fetched_at = excluded.fetched_at,
            is_read = MAX(rss_articles.is_read, excluded.is_read),
            is_favorite = MAX(rss_articles.is_favorite, excluded.is_favorite),
            progress = MAX(rss_articles.progress, excluded.progress),
            updated_at = unixepoch()
        "#,
        params![
            id,
            feed_id,
            title,
            author,
            url,
            summary,
            content_source,
            image_url,
            published_at,
            fetched_at,
            if is_read { 1 } else { 0 },
            if is_favorite { 1 } else { 0 },
            progress,
        ],
    )?;

    if let Some(content) = article.get("content").and_then(|v| v.as_str()) {
        let full_content = article
            .get("fullContent")
            .or_else(|| article.get("full_content"))
            .and_then(|v| v.as_str());
        connection.execute(
            r#"
            INSERT INTO rss_article_content (article_id, content, full_content, updated_at)
            VALUES (?1, ?2, ?3, unixepoch())
            ON CONFLICT(article_id) DO UPDATE SET
                content = excluded.content,
                full_content = excluded.full_content,
                updated_at = unixepoch()
            "#,
            params![id, content, full_content],
        )?;
    }

    Ok(Some(id.to_string()))
}

/// Fields of a synced book that describe this device's copy, not the book.
/// Peers never send them (provisioning strips them), so an incoming value is
/// at best stale and at worst an attempt to point us, and then the book server,
/// at an arbitrary local file.
const DEVICE_LOCAL_BOOK_FIELDS: &[&str] = &[
    "filePath",
    "file_path",
    "storagePath",
    "storage_path",
    "syncedWithoutFile",
];

/// The book as a peer may describe it: device-local fields removed, and a
/// cover only as an inline image.
fn sanitize_incoming_book(incoming: &serde_json::Value) -> serde_json::Value {
    let mut book = incoming.clone();
    if let Some(obj) = book.as_object_mut() {
        for field in DEVICE_LOCAL_BOOK_FIELDS {
            obj.remove(*field);
        }
        let inline_cover = obj
            .get("coverPath")
            .and_then(|v| v.as_str())
            .is_some_and(|s| s.starts_with("data:image/"));
        if !inline_cover {
            obj.remove("coverPath");
        }
    }
    book
}

/// The book details a user edits (mirrors `BOOK_EDITABLE_FIELDS` in
/// book-edit-stamp.ts): the side with the newer `metadataUpdatedAt` wins them.
pub(super) const BOOK_EDITABLE_FIELDS: &[&str] = &[
    "title",
    "author",
    "description",
    "publisher",
    "language",
    "isbn",
    "publishedDate",
    "category",
    "isFavorite",
    "tags",
    "rating",
    "completedAt",
    "manualCompletionState",
    "progressBeforeFinish",
    "series",
    "seriesIndex",
    "metadataUpdatedAt",
    "metadataBaseAt",
];

/// What a user edits on an annotation (the newer `updatedAt` wins them).
const ANNOTATION_EDITABLE_FIELDS: &[&str] = &["noteContent", "textNoteContent", "color", "type"];

/// Where the reader is: the side with the newer `lastReadAt` wins them.
const BOOK_READING_FIELDS: &[&str] = &[
    "progress",
    "currentLocation",
    "lastReadAt",
    "lastClickFraction",
    "pageProgress",
    "pdfViewState",
];

/// Removes from `incoming` the groups of fields where `existing` is newer, so
/// an older peer copy cannot undo a newer local edit or reading position.
fn drop_older_fields(existing: &serde_json::Value, incoming: &mut serde_json::Value) {
    let newer_here = |stamp: &str| match (
        parse_sync_date(existing.get(stamp)),
        parse_sync_date(incoming.get(stamp)),
    ) {
        (Some(local), Some(remote)) => local > remote,
        (Some(_), None) => true,
        _ => false,
    };
    let drop_edits = newer_here("metadataUpdatedAt");
    let drop_reading = newer_here("lastReadAt");
    if let Some(obj) = incoming.as_object_mut() {
        if drop_edits {
            for field in BOOK_EDITABLE_FIELDS {
                obj.remove(*field);
            }
        }
        if drop_reading {
            for field in BOOK_READING_FIELDS {
                obj.remove(*field);
            }
        }
    }
}

/// Keys a peer may store as-is in `kv_store`. Anything else (persisted app
/// state, preferences that are not synced) is never written from sync.
fn is_syncable_kv_key(key: &str) -> bool {
    matches!(
        key,
        "settings" | "reading_stats" | "collections" | "rss_feeds"
    ) || key.starts_with("collection:")
        || key.starts_with("cover:")
}

fn merge_book_metadata_json(
    existing_json: Option<&str>,
    incoming: &serde_json::Value,
    cache_file_exists: bool,
    cache_path: Option<&str>,
) -> String {
    let mut incoming = sanitize_incoming_book(incoming);
    if let Some(existing) = existing_json.and_then(|ex| serde_json::from_str(ex).ok()) {
        drop_older_fields(&existing, &mut incoming);
    }
    let incoming = &incoming;
    let mut merged = if let Some(ex) = existing_json {
        serde_json::from_str::<serde_json::Value>(ex).unwrap_or_else(|_| incoming.clone())
    } else {
        incoming.clone()
    };

    if let (Some(merged_obj), Some(inc_obj)) = (merged.as_object_mut(), incoming.as_object()) {
        for (k, v) in inc_obj {
            // Never overwrite local storage/file paths with null/missing/empty from sync
            if existing_json.is_some() {
                if (k == "filePath" || k == "storagePath" || k == "coverPath")
                    && (v.is_null() || v.as_str().is_some_and(|s| s.is_empty()))
                {
                    continue;
                }
                if k == "syncedWithoutFile" {
                    continue;
                }
            }
            merged_obj.insert(k.clone(), v.clone());
        }

        if cache_file_exists {
            merged_obj.insert(
                "syncedWithoutFile".to_string(),
                serde_json::Value::Bool(false),
            );
            if let Some(path) = cache_path {
                if merged_obj
                    .get("storagePath")
                    .and_then(|v| v.as_str())
                    .is_none_or(|s| s.is_empty())
                {
                    merged_obj.insert(
                        "storagePath".to_string(),
                        serde_json::Value::String(path.to_string()),
                    );
                }
                if merged_obj
                    .get("filePath")
                    .and_then(|v| v.as_str())
                    .is_none_or(|s| s.is_empty())
                {
                    merged_obj.insert(
                        "filePath".to_string(),
                        serde_json::Value::String(path.to_string()),
                    );
                }
            }
        } else if let Some(ex) = existing_json {
            if let Ok(ex_val) = serde_json::from_str::<serde_json::Value>(ex) {
                if let Some(existing_synced) = ex_val.get("syncedWithoutFile") {
                    merged_obj.insert("syncedWithoutFile".to_string(), existing_synced.clone());
                }
            }
        } else {
            // New book from peer sync without local cache file: mark as syncedWithoutFile: true
            merged_obj.insert(
                "syncedWithoutFile".to_string(),
                serde_json::Value::Bool(true),
            );
        }

        serde_json::to_string(&merged).unwrap_or_else(|_| incoming.to_string())
    } else {
        incoming.to_string()
    }
}

/// Stores one synced book's metadata (and its search entry) under `book_id`.
/// Returns false, writing nothing, when the result equals what is stored:
/// most books in a sync round have not changed.
fn merge_synced_book(
    connection: &Connection,
    book_id: &str,
    book_val: &serde_json::Value,
    app_data_dir: Option<&Path>,
    conflicts: &mut usize,
) -> rusqlite::Result<bool> {
    let title = book_val.get("title").and_then(|v| v.as_str()).unwrap_or("");
    let author = book_val.get("author").and_then(|v| v.as_str());

    connection.execute(
        "INSERT OR IGNORE INTO books(id, data, updated_at) VALUES(?1, X'', unixepoch())",
        params![book_id],
    )?;

    let existing_meta: Option<String> = connection
        .query_row(
            "SELECT metadata_json FROM book_metadata WHERE book_id = ?1",
            params![book_id],
            |row| row.get(0),
        )
        .optional()
        .unwrap_or(None);

    if let Some(local) = existing_meta
        .as_deref()
        .and_then(|ex| serde_json::from_str::<serde_json::Value>(ex).ok())
    {
        if let Some(found) = concurrent_edit(
            &local,
            book_val,
            "metadataUpdatedAt",
            "metadataBaseAt",
            BOOK_EDITABLE_FIELDS,
        ) {
            let label = local
                .get("title")
                .and_then(|v| v.as_str())
                .filter(|t| !t.is_empty())
                .unwrap_or(title);
            if record_sync_conflict(connection, "book", book_id, label, &found) {
                *conflicts += 1;
            }
        }
    }

    let cache_path = app_data_dir.map(|dir| materialized_book_path_in_dir(dir, book_id));
    let cache_file_exists = cache_path.as_ref().is_some_and(|p| p.is_file());
    let cache_path = cache_path.map(|p| p.to_string_lossy().into_owned());

    let final_json = merge_book_metadata_json(
        existing_meta.as_deref(),
        book_val,
        cache_file_exists,
        cache_path.as_deref(),
    );
    if existing_meta.as_deref() == Some(final_json.as_str()) {
        return Ok(false);
    }

    connection.execute(
        "INSERT INTO book_metadata(book_id, metadata_json, updated_at) VALUES(?1, ?2, unixepoch()) ON CONFLICT(book_id) DO UPDATE SET metadata_json = excluded.metadata_json, updated_at = unixepoch()",
        params![book_id, final_json],
    )?;

    let _ = connection.execute("DELETE FROM books_fts WHERE id = ?1", params![book_id]);
    let _ = connection.execute(
        "INSERT INTO books_fts(id, title, author) VALUES(?1, ?2, ?3)",
        params![book_id, title, author],
    );
    Ok(true)
}

#[allow(dead_code)]
pub fn sqlite_merge_sync_entries_inner(
    connection: &Connection,
    entries: std::collections::HashMap<String, String>,
) -> rusqlite::Result<SyncMergeResult> {
    sqlite_merge_sync_entries_with_dir(connection, entries, None)
}

/// Merge a batch of sync entries in one transaction: if any write fails the
/// whole batch rolls back (it is retried on the next sync) instead of
/// leaving, say, a book half-deleted. Cached files of books deleted by a
/// tombstone are removed after the commit.
pub fn sqlite_merge_sync_entries_with_dir(
    connection: &Connection,
    entries: std::collections::HashMap<String, String>,
    app_data_dir: Option<&Path>,
) -> rusqlite::Result<SyncMergeResult> {
    let tx = connection.unchecked_transaction()?;
    let result = merge_sync_entries_rows(&tx, entries, app_data_dir)?;
    tx.commit()?;

    if let Some(dir) = app_data_dir {
        if !result.deleted_books.is_empty() {
            // Close cached EPUB archives first: Windows cannot delete an open file.
            crate::epub_entries::clear_cache();
            for id in &result.deleted_books {
                let _ = fs::remove_file(materialized_book_path_in_dir(dir, id));
            }
        }
    }
    Ok(result)
}

fn merge_sync_entries_rows(
    connection: &Connection,
    entries: std::collections::HashMap<String, String>,
    app_data_dir: Option<&Path>,
) -> rusqlite::Result<SyncMergeResult> {
    let mut domains_updated: Vec<String> = Vec::new();
    let mut books_count = 0usize;
    let mut annotations_count = 0usize;
    let mut updated_books: Vec<String> = Vec::new();
    let mut deleted_books: Vec<String> = Vec::new();
    let mut updated_annotations: Vec<String> = Vec::new();
    let mut deleted_annotations: Vec<String> = Vec::new();
    let mut updated_vocabulary: Vec<String> = Vec::new();
    let mut deleted_vocabulary: Vec<String> = Vec::new();
    let mut updated_rss_articles: Vec<String> = Vec::new();
    let mut deleted_rss_articles: Vec<String> = Vec::new();
    let mut conflicts = 0usize;

    // Tombstoned ids: entries for these must never be (re-)inserted below.
    // Per-entity doc keys (`anno:*`, `book:*`) outlive the deletion, so the
    // same batch routinely carries both the tombstone and the stale entry.
    let mut tombstoned_books: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut tombstoned_annotations: std::collections::HashSet<String> =
        std::collections::HashSet::new();

    // 1. Process tombstones first if present
    if let Some(tombstones_json) = entries.get("deletion_tombstones") {
        if let Ok(tombstones) = serde_json::from_str::<Vec<serde_json::Value>>(tombstones_json) {
            for ts in &tombstones {
                let id = ts
                    .get("entityId")
                    .or_else(|| ts.get("id"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let entity_type = ts.get("entityType").and_then(|v| v.as_str()).unwrap_or("");
                if id.is_empty() {
                    continue;
                }
                match entity_type {
                    "book" => {
                        tombstoned_books.insert(id.to_string());
                        // Errors propagate so the merge transaction rolls back.
                        delete_book_rows(connection, id)?;
                        deleted_books.push(id.to_string());
                    }
                    "annotation" => {
                        tombstoned_annotations.insert(id.to_string());
                        connection
                            .execute("DELETE FROM book_annotations WHERE id = ?1", params![id])?;
                        deleted_annotations.push(id.to_string());
                    }
                    "vocabulary" => {
                        connection.execute("DELETE FROM vocabulary WHERE id = ?1", params![id])?;
                        deleted_vocabulary.push(id.to_string());
                    }
                    "rss_article" => {
                        connection.execute(
                            "DELETE FROM rss_article_content WHERE article_id = ?1",
                            params![id],
                        )?;
                        connection
                            .execute("DELETE FROM rss_articles WHERE id = ?1", params![id])?;
                        deleted_rss_articles.push(id.to_string());
                    }
                    _ => {}
                }
            }
        }
    }

    let mut record_domain = |d: &str| {
        if !domains_updated.iter().any(|existing| existing == d) {
            domains_updated.push(d.to_string());
        }
    };

    // 2. Process all entries
    for (key, value) in &entries {
        if key == "deletion_tombstones" {
            connection.execute(
                "INSERT INTO kv_store(key, value, updated_at) VALUES(?1, ?2, unixepoch()) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()",
                params![key, value],
            )?;
            record_domain("deletion_tombstones");
        } else if let Some(book_id) = key.strip_prefix("book:") {
            // The ID becomes a file name in book-cache.
            if tombstoned_books.contains(book_id) || !crate::sync_access::is_valid_book_id(book_id)
            {
                continue;
            }
            let Ok(book_val) = serde_json::from_str::<serde_json::Value>(value) else {
                continue;
            };
            if merge_synced_book(connection, book_id, &book_val, app_data_dir, &mut conflicts)? {
                books_count += 1;
                updated_books.push(book_id.to_string());
                record_domain("books");
            }
        } else if key == "books" {
            if let Ok(books_vec) = serde_json::from_str::<Vec<serde_json::Value>>(value) {
                for b in &books_vec {
                    if let Some(book_id) = b.get("id").and_then(|v| v.as_str()) {
                        if tombstoned_books.contains(book_id)
                            || !crate::sync_access::is_valid_book_id(book_id)
                        {
                            continue;
                        }
                        if merge_synced_book(connection, book_id, b, app_data_dir, &mut conflicts)?
                        {
                            books_count += 1;
                            updated_books.push(book_id.to_string());
                        }
                    }
                }
                if !books_vec.is_empty() {
                    record_domain("books");
                }
            }
        } else if key.starts_with("anno:") || key.starts_with("annotation:") {
            if let Ok(ann_val) = serde_json::from_str::<serde_json::Value>(value) {
                // An annotation carries its own ID. One without cannot be
                // stored as itself (the app would load it back ID-less).
                let Some(id) = ann_val
                    .get("id")
                    .and_then(|v| v.as_str())
                    .filter(|id| !id.is_empty())
                    .map(String::from)
                else {
                    continue;
                };
                let book_id = ann_val
                    .get("bookId")
                    .or_else(|| ann_val.get("book_id"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");

                if !book_id.is_empty()
                    && !tombstoned_annotations.contains(&id)
                    && !tombstoned_books.contains(book_id)
                    && upsert_synced_annotation(
                        connection,
                        &id,
                        book_id,
                        &ann_val,
                        value,
                        &mut conflicts,
                    )?
                {
                    annotations_count += 1;
                    updated_annotations.push(id);
                    record_domain("annotations");
                }
            }
        } else if key == "annotations" {
            if let Ok(anns_vec) = serde_json::from_str::<Vec<serde_json::Value>>(value) {
                for a in &anns_vec {
                    if let Some(id) = a.get("id").and_then(|v| v.as_str()) {
                        let book_id = a
                            .get("bookId")
                            .or_else(|| a.get("book_id"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("");
                        if !book_id.is_empty()
                            && !tombstoned_annotations.contains(id)
                            && !tombstoned_books.contains(book_id)
                        {
                            let ann_json = serde_json::to_string(a).unwrap_or_default();
                            if upsert_synced_annotation(
                                connection,
                                id,
                                book_id,
                                a,
                                &ann_json,
                                &mut conflicts,
                            )? {
                                annotations_count += 1;
                                updated_annotations.push(id.to_string());
                            }
                        }
                    }
                }
                if !anns_vec.is_empty() {
                    record_domain("annotations");
                }
            }
        } else if key.starts_with("vocab:") || key.starts_with("vocabulary:") {
            if let Ok(term_val) = serde_json::from_str::<serde_json::Value>(value) {
                if let Ok(Some(id)) = upsert_sync_vocabulary_term(connection, &term_val) {
                    updated_vocabulary.push(id);
                    record_domain("vocabulary");
                }
            }
        } else if key == "vocabulary" {
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(value) {
                if let Some(terms_vec) = parsed.as_array() {
                    for t in terms_vec {
                        if let Ok(Some(id)) = upsert_sync_vocabulary_term(connection, t) {
                            updated_vocabulary.push(id);
                        }
                    }
                    if !terms_vec.is_empty() {
                        record_domain("vocabulary");
                    }
                } else if let Ok(Some(id)) = upsert_sync_vocabulary_term(connection, &parsed) {
                    updated_vocabulary.push(id);
                    record_domain("vocabulary");
                }
            }
        } else if let Some(article_id) = key.strip_prefix("rss_article:") {
            if let Ok(art_val) = serde_json::from_str::<serde_json::Value>(value) {
                if let Ok(Some(id)) = upsert_sync_rss_article(connection, &art_val) {
                    updated_rss_articles.push(id);
                    record_domain("rss_articles");
                } else {
                    updated_rss_articles.push(article_id.to_string());
                }
            }
        } else if key == "rss_articles" {
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(value) {
                if let Some(arts_vec) = parsed.as_array() {
                    for a in arts_vec {
                        if let Ok(Some(id)) = upsert_sync_rss_article(connection, a) {
                            updated_rss_articles.push(id);
                        }
                    }
                    if !arts_vec.is_empty() {
                        record_domain("rss_articles");
                    }
                }
            }
        } else if is_syncable_kv_key(key) {
            connection.execute(
                "INSERT INTO kv_store(key, value, updated_at) VALUES(?1, ?2, unixepoch()) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()",
                params![key, value],
            )?;
            record_domain(key);
        }
    }

    fn dedup(v: &mut Vec<String>) {
        let mut seen = std::collections::HashSet::new();
        v.retain(|item| seen.insert(item.clone()));
    }
    dedup(&mut updated_books);
    dedup(&mut deleted_books);
    dedup(&mut updated_annotations);
    dedup(&mut deleted_annotations);
    dedup(&mut updated_vocabulary);
    dedup(&mut deleted_vocabulary);
    dedup(&mut updated_rss_articles);
    dedup(&mut deleted_rss_articles);

    Ok(SyncMergeResult {
        domains_updated,
        books_count,
        annotations_count,
        updated_books,
        deleted_books,
        updated_annotations,
        deleted_annotations,
        updated_vocabulary,
        deleted_vocabulary,
        updated_rss_articles,
        deleted_rss_articles,
        conflicts,
    })
}

pub fn sqlite_merge_sync_entries(
    app: AppHandle,
    entries: std::collections::HashMap<String, String>,
) -> Result<SyncMergeResult, AppError> {
    let app_data_dir = app.path().app_data_dir().ok();
    with_connection(&app, |connection| {
        sqlite_merge_sync_entries_with_dir(connection, entries, app_data_dir.as_deref())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::test_support::*;

    fn book_tombstone(id: &str) -> std::collections::HashMap<String, String> {
        std::collections::HashMap::from([(
            "deletion_tombstones".to_string(),
            format!(
                r#"[{{"entityId":"{id}","entityType":"book","deletedAt":"2026-10-01T00:00:00Z"}}]"#
            ),
        )])
    }

    #[test]
    fn sync_book_tombstone_removes_every_related_row_and_cache_file() {
        let conn = setup_db();
        let dir = tempfile::tempdir().unwrap();
        seed_book(&conn, "gone", "Gone");
        seed_book(&conn, "kept", "Kept");
        let cache = materialized_book_path_in_dir(dir.path(), "gone");
        fs::create_dir_all(cache.parent().unwrap()).unwrap();
        fs::write(&cache, b"epub").unwrap();

        let result =
            sqlite_merge_sync_entries_with_dir(&conn, book_tombstone("gone"), Some(dir.path()))
                .unwrap();

        assert_eq!(result.deleted_books, ["gone"]);
        assert_eq!(rows_for_book(&conn, "gone"), []);
        assert_eq!(rows_for_book(&conn, "kept").len(), 6);
        assert!(!cache.exists());
    }

    /// Tombstone deletes ignored their errors (`let _ =`), so a failure left
    /// the book half-deleted while the merge reported success.
    #[test]
    fn sync_tombstone_failure_rolls_back_the_merge() {
        let conn = setup_db();
        seed_book(&conn, "b1", "Book");
        conn.execute_batch(
            "CREATE TRIGGER fail_meta_delete BEFORE DELETE ON book_metadata
             BEGIN SELECT RAISE(ABORT, 'boom'); END;",
        )
        .unwrap();
        let mut entries = book_tombstone("b1");
        entries.insert("vocab:v1".into(), r#"{"id":"v1","term":"word"}"#.into());

        assert!(sqlite_merge_sync_entries_with_dir(&conn, entries, None).is_err());
        assert_eq!(rows_for_book(&conn, "b1").len(), 6);
        let kv_tombstones: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM kv_store WHERE key = 'deletion_tombstones'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(kv_tombstones, 0, "nothing of the failed merge is kept");
    }

    fn kv_value(conn: &Connection, key: &str) -> Option<String> {
        conn.query_row(
            "SELECT value FROM kv_store WHERE key = ?1",
            params![key],
            |r| r.get(0),
        )
        .optional()
        .unwrap()
    }

    #[test]
    fn an_older_synced_note_does_not_replace_a_newer_local_edit() {
        let conn = setup_db();
        let mut entries = std::collections::HashMap::new();
        entries.insert(
            "anno:b1:a1".to_string(),
            r#"{"id":"a1","bookId":"b1","note":"new","updatedAt":2000}"#.to_string(),
        );
        sqlite_merge_sync_entries_inner(&conn, entries).unwrap();

        let mut entries = std::collections::HashMap::new();
        entries.insert(
            "anno:b1:a1".to_string(),
            r#"{"id":"a1","bookId":"b1","note":"old","updatedAt":1000}"#.to_string(),
        );
        let res = sqlite_merge_sync_entries_inner(&conn, entries).unwrap();
        assert!(res.updated_annotations.is_empty());
        let anns = sqlite_get_book_annotations_inner(&conn, "b1").unwrap();
        assert!(anns[0].contains("\"new\""), "{anns:?}");

        // A newer one does, in the bulk form too.
        let mut entries = std::collections::HashMap::new();
        entries.insert(
            "annotations".to_string(),
            r#"[{"id":"a1","bookId":"b1","note":"newest","updatedAt":"2030-01-01T00:00:00Z"}]"#
                .to_string(),
        );
        let res = sqlite_merge_sync_entries_inner(&conn, entries).unwrap();
        assert_eq!(res.updated_annotations, vec!["a1".to_string()]);
        let anns = sqlite_get_book_annotations_inner(&conn, "b1").unwrap();
        assert!(anns[0].contains("newest"), "{anns:?}");
    }

    #[test]
    fn an_older_synced_word_does_not_replace_a_newer_one() {
        let conn = setup_db();
        let term = |meaning: &str, created: i64, updated: i64| {
            format!(
                r#"{{"id":"v1","term":"ephemeral","language":"en","meanings":["{meaning}"],"createdAt":{created},"updatedAt":{updated}}}"#
            )
        };
        let mut entries = std::collections::HashMap::new();
        entries.insert("vocab:v1".to_string(), term("new", 500, 2000));
        sqlite_merge_sync_entries_inner(&conn, entries).unwrap();

        let mut entries = std::collections::HashMap::new();
        entries.insert("vocab:v1".to_string(), term("old", 100, 1000));
        let res = sqlite_merge_sync_entries_inner(&conn, entries).unwrap();
        assert!(res.updated_vocabulary.is_empty());
        let (meanings, created): (String, i64) = conn
            .query_row(
                "SELECT meanings_json, created_at FROM vocabulary WHERE id = 'v1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert!(meanings.contains("new"));
        assert_eq!(created, 500);

        // Newer wins, and the earliest creation date is kept.
        let mut entries = std::collections::HashMap::new();
        entries.insert("vocab:v1".to_string(), term("newest", 900, 3000));
        sqlite_merge_sync_entries_inner(&conn, entries).unwrap();
        let (meanings, created): (String, i64) = conn
            .query_row(
                "SELECT meanings_json, created_at FROM vocabulary WHERE id = 'v1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert!(meanings.contains("newest"));
        assert_eq!(created, 500);
    }

    #[test]
    fn synced_articles_keep_read_favorite_and_furthest_progress() {
        let conn = setup_db();
        seed_feed(&conn, "f1");
        let article = |read: bool, fav: bool, progress: f64| {
            format!(
                r#"{{"id":"art1","feedId":"f1","title":"T","url":"https://e.x/1","isRead":{read},"isFavorite":{fav},"progress":{progress}}}"#
            )
        };
        let mut entries = std::collections::HashMap::new();
        entries.insert("rss_article:art1".to_string(), article(true, true, 0.8));
        sqlite_merge_sync_entries_inner(&conn, entries).unwrap();
        let mut entries = std::collections::HashMap::new();
        entries.insert("rss_article:art1".to_string(), article(false, false, 0.2));
        sqlite_merge_sync_entries_inner(&conn, entries).unwrap();
        let (read, fav, progress): (bool, bool, f64) = conn
            .query_row(
                "SELECT is_read, is_favorite, progress FROM rss_articles WHERE id = 'art1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert!(read && fav);
        assert_eq!(progress, 0.8);
    }

    #[test]
    fn a_merge_that_fails_halfway_changes_nothing() {
        let conn = setup_db();
        // The eleventh new kv_store row fails, so ten are written first.
        conn.execute_batch(
            "CREATE TRIGGER fail_eleventh BEFORE INSERT ON kv_store
             WHEN (SELECT COUNT(*) FROM kv_store) >= 10
             BEGIN SELECT RAISE(ABORT, 'disk full'); END;",
        )
        .unwrap();
        let mut entries = std::collections::HashMap::new();
        entries.insert(
            "books".to_string(),
            r#"[{"id":"b1","title":"Dune"}]"#.to_string(),
        );
        for i in 0..30 {
            entries.insert(format!("collection:c{i}"), r#"{"ok":true}"#.to_string());
        }
        assert!(sqlite_merge_sync_entries_inner(&conn, entries).is_err());
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM kv_store", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 0);
        assert!(sqlite_get_book_metadata_inner(&conn, "b1")
            .unwrap()
            .is_none());
    }

    #[test]
    fn a_peer_cannot_plant_file_paths_in_a_synced_book() {
        let conn = setup_db();
        let mut entries = std::collections::HashMap::new();
        entries.insert(
            "book:b1".to_string(),
            r#"{"id":"b1","title":"Dune","filePath":"/home/me/.ssh/id_ed25519","storagePath":"../theorem.db","file_path":"x","syncedWithoutFile":false,"coverPath":"file:///etc/passwd"}"#.to_string(),
        );
        sqlite_merge_sync_entries_inner(&conn, entries).unwrap();
        let meta: serde_json::Value = serde_json::from_str(
            &sqlite_get_book_metadata_inner(&conn, "b1")
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        for field in ["filePath", "storagePath", "file_path", "coverPath"] {
            assert!(
                meta.get(field).is_none(),
                "{field} came from the peer: {meta}"
            );
        }
        assert_eq!(meta["title"], "Dune");
        // A new book from a peer has no local file yet.
        assert_eq!(meta["syncedWithoutFile"], true);

        // An existing local path survives a peer's attempt to replace it, and
        // an inline cover image is still accepted.
        conn.execute(
            "UPDATE book_metadata SET metadata_json = ?1 WHERE book_id = 'b1'",
            params![r#"{"id":"b1","title":"Dune","filePath":"/books/dune.epub"}"#],
        )
        .unwrap();
        let mut entries = std::collections::HashMap::new();
        entries.insert(
            "book:b1".to_string(),
            r#"{"id":"b1","title":"Dune Messiah","filePath":"/etc/shadow","coverPath":"data:image/webp;base64,AAAA"}"#.to_string(),
        );
        sqlite_merge_sync_entries_inner(&conn, entries).unwrap();
        let meta: serde_json::Value = serde_json::from_str(
            &sqlite_get_book_metadata_inner(&conn, "b1")
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(meta["filePath"], "/books/dune.epub");
        assert_eq!(meta["title"], "Dune Messiah");
        assert_eq!(meta["coverPath"], "data:image/webp;base64,AAAA");
    }

    #[test]
    fn the_newer_edit_and_the_newer_read_win_in_the_database() {
        let conn = setup_db();
        let merge = |json: &str| {
            let mut entries = std::collections::HashMap::new();
            entries.insert("book:b1".to_string(), json.to_string());
            sqlite_merge_sync_entries_inner(&conn, entries).unwrap();
        };
        merge(
            r#"{"id":"b1","title":"Dune","isFavorite":false,"tags":[],"metadataUpdatedAt":"2026-05-02T00:00:00Z","progress":0.1,"lastReadAt":"2026-05-03T00:00:00Z"}"#,
        );
        // An older copy: favourite and tag it had, and further progress read earlier.
        merge(
            r#"{"id":"b1","title":"Dune (old)","isFavorite":true,"tags":["sf"],"metadataUpdatedAt":"2026-05-01T00:00:00Z","progress":0.9,"lastReadAt":"2026-05-01T00:00:00Z"}"#,
        );
        let book = stored_book(&conn, "b1");
        assert_eq!(book["title"], "Dune");
        assert_eq!(book["isFavorite"], false);
        assert_eq!(book["tags"], serde_json::json!([]));
        assert_eq!(book["progress"], 0.1);

        // A copy without stamps (an older app) does not override stamped edits.
        merge(r#"{"id":"b1","title":"Legacy","isFavorite":true,"progress":0.5}"#);
        let book = stored_book(&conn, "b1");
        assert_eq!(book["title"], "Dune");
        assert_eq!(book["isFavorite"], false);
        assert_eq!(book["progress"], 0.1);

        // A newer edit and a newer read win, removals included.
        merge(
            r#"{"id":"b1","title":"Dune Messiah","isFavorite":false,"tags":["classic"],"metadataUpdatedAt":"2026-06-01T00:00:00Z","progress":0.4,"lastReadAt":"2026-06-01T00:00:00Z"}"#,
        );
        let book = stored_book(&conn, "b1");
        assert_eq!(book["title"], "Dune Messiah");
        assert_eq!(book["tags"], serde_json::json!(["classic"]));
        assert_eq!(book["progress"], 0.4);
    }

    #[test]
    fn an_annotation_entry_without_its_id_is_not_stored() {
        let conn = setup_db();
        let result = merge_one(
            &conn,
            "anno:b1:undefined",
            r#"{"bookId":"b1","type":"highlight","location":"x","selectedText":"no id"}"#,
        );
        assert!(result.updated_annotations.is_empty());
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM book_annotations", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 0);
    }

    #[test]
    fn an_annotation_received_again_unchanged_is_not_rewritten() {
        let conn = setup_db();
        let record = r#"{"id":"a1","bookId":"b1","note":"n","updatedAt":5}"#;
        let first = merge_one(&conn, "anno:b1:a1", record);
        assert_eq!(first.updated_annotations, vec!["a1".to_string()]);
        let stamp = |c: &Connection| -> i64 {
            c.query_row(
                "SELECT updated_at FROM book_annotations WHERE id = 'a1'",
                [],
                |r| r.get(0),
            )
            .unwrap()
        };
        conn.execute("UPDATE book_annotations SET updated_at = 1", [])
            .unwrap();
        // The same record again (its book's other annotation changed).
        let again = merge_one(&conn, "anno:b1:a1", record);
        assert!(again.updated_annotations.is_empty());
        assert!(!again.domains_updated.contains(&"annotations".to_string()));
        assert_eq!(stamp(&conn), 1, "not written again");
        // A changed one still is.
        let edited = r#"{"id":"a1","bookId":"b1","note":"n2","updatedAt":6}"#;
        let changed = merge_one(&conn, "anno:b1:a1", edited);
        assert_eq!(changed.updated_annotations, vec!["a1".to_string()]);
    }

    #[test]
    fn an_unchanged_synced_book_is_not_rewritten() {
        let conn = setup_db();
        let entry = || {
            let mut entries = std::collections::HashMap::new();
            entries.insert(
                "book:b1".to_string(),
                r#"{"id":"b1","title":"Dune"}"#.to_string(),
            );
            entries
        };
        let first = sqlite_merge_sync_entries_inner(&conn, entry()).unwrap();
        assert_eq!(first.updated_books, vec!["b1".to_string()]);
        conn.execute(
            "UPDATE book_metadata SET updated_at = 1 WHERE book_id = 'b1'",
            [],
        )
        .unwrap();
        let again = sqlite_merge_sync_entries_inner(&conn, entry()).unwrap();
        assert!(again.updated_books.is_empty());
        assert_eq!(again.books_count, 0);
        let stamp: i64 = conn
            .query_row(
                "SELECT updated_at FROM book_metadata WHERE book_id = 'b1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(stamp, 1, "the row was rewritten");
        assert_eq!(
            sqlite_search_books_inner(&conn, "Dune", 10).unwrap().len(),
            1
        );
    }

    #[test]
    fn book_ids_that_name_paths_are_not_merged() {
        let conn = setup_db();
        let mut entries = std::collections::HashMap::new();
        entries.insert(
            "book:../../evil".to_string(),
            r#"{"title":"x"}"#.to_string(),
        );
        entries.insert(
            "books".to_string(),
            r#"[{"id":"/etc/passwd","title":"y"},{"id":"ok-1","title":"z"}]"#.to_string(),
        );
        let res = sqlite_merge_sync_entries_inner(&conn, entries).unwrap();
        assert_eq!(res.updated_books, vec!["ok-1".to_string()]);
        assert!(sqlite_get_book_metadata_inner(&conn, "../../evil")
            .unwrap()
            .is_none());
        assert!(sqlite_get_book_metadata_inner(&conn, "/etc/passwd")
            .unwrap()
            .is_none());
    }

    #[test]
    fn a_peer_can_write_only_synced_keys() {
        let conn = setup_db();
        let mut entries = std::collections::HashMap::new();
        for key in [
            "settings",
            "reading_stats",
            "collections",
            "rss_feeds",
            "collection:c1",
            "cover:b1",
        ] {
            entries.insert(key.to_string(), r#"{"ok":true}"#.to_string());
        }
        for key in [
            "zustand:theorem-library",
            "persist:theorem-settings",
            "theorem-opds",
            "anything-else",
        ] {
            entries.insert(key.to_string(), r#"{"planted":true}"#.to_string());
        }
        let res = sqlite_merge_sync_entries_inner(&conn, entries).unwrap();
        for key in [
            "settings",
            "reading_stats",
            "collections",
            "rss_feeds",
            "collection:c1",
            "cover:b1",
        ] {
            assert!(kv_value(&conn, key).is_some(), "{key} should sync");
        }
        for key in [
            "zustand:theorem-library",
            "persist:theorem-settings",
            "theorem-opds",
            "anything-else",
        ] {
            assert!(
                kv_value(&conn, key).is_none(),
                "{key} must not be written by a peer"
            );
            assert!(!res.domains_updated.contains(&key.to_string()));
        }
    }

    #[test]
    fn test_sqlite_merge_sync_entries() {
        let conn = setup_db();
        seed_feed(&conn, "f1");
        let mut entries = std::collections::HashMap::new();

        entries.insert(
            "book:b1".to_string(),
            r#"{"id":"b1","title":"Dune","author":"Frank Herbert"}"#.to_string(),
        );
        entries.insert(
            "anno:b1:a1".to_string(),
            r#"{"id":"a1","bookId":"b1","text":"Fear is the mind-killer"}"#.to_string(),
        );
        entries.insert(
            "settings".to_string(),
            r#"{"fontSize":18,"theme":"sepia"}"#.to_string(),
        );

        entries.insert(
            "vocabulary".to_string(),
            r#"[{"id":"v1","term":"ephemeral","language":"en","meanings":[{"partOfSpeech":"adjective","definitions":[{"definition":"lasting a short time"}]}]}]"#.to_string(),
        );
        entries.insert(
            "rss_article:art1".to_string(),
            r#"{"id":"art1","feedId":"f1","title":"Test Article","url":"https://example.com/1","content":"Hello world"}"#.to_string(),
        );

        let res = sqlite_merge_sync_entries_inner(&conn, entries).unwrap();
        assert!(res.domains_updated.contains(&"books".to_string()));
        assert!(res.domains_updated.contains(&"annotations".to_string()));
        assert!(res.domains_updated.contains(&"settings".to_string()));
        assert!(res.domains_updated.contains(&"vocabulary".to_string()));
        assert!(res.domains_updated.contains(&"rss_articles".to_string()));
        assert_eq!(res.books_count, 1);
        assert_eq!(res.annotations_count, 1);
        assert_eq!(res.updated_books, vec!["b1".to_string()]);
        assert_eq!(res.updated_annotations, vec!["a1".to_string()]);
        assert_eq!(res.updated_vocabulary, vec!["v1".to_string()]);
        assert_eq!(res.updated_rss_articles, vec!["art1".to_string()]);

        // Verify book metadata and FTS
        let meta = sqlite_get_book_metadata_inner(&conn, "b1").unwrap();
        assert!(meta.is_some());
        assert!(meta.unwrap().contains("Frank Herbert"));

        let fts = sqlite_search_books_inner(&conn, "Dune", 10).unwrap();
        assert_eq!(fts.len(), 1);
        assert_eq!(fts[0].book_id, "b1");

        // Verify annotation
        let anns = sqlite_get_book_annotations_inner(&conn, "b1").unwrap();
        assert_eq!(anns.len(), 1);
        assert!(anns[0].contains("mind-killer"));

        // Verify vocabulary
        let vocab = sqlite_get_vocabulary_terms_inner(&conn).unwrap();
        assert_eq!(vocab.len(), 1);
        assert_eq!(&*vocab[0].term, "ephemeral");

        // Verify RSS article
        let arts = sqlite_get_rss_articles_inner(&conn, None, None, None).unwrap();
        assert_eq!(arts.len(), 1);
        assert_eq!(&*arts[0].title, "Test Article");

        // Verify settings in kv_store
        let settings = sqlite_get_kv_inner(&conn, "settings").unwrap();
        assert_eq!(
            settings,
            Some(r#"{"fontSize":18,"theme":"sepia"}"#.to_string())
        );

        // Test tombstone deletion
        let mut tombstone_entries = std::collections::HashMap::new();
        tombstone_entries.insert(
            "deletion_tombstones".to_string(),
            r#"[
                {"id":"b1","entityType":"book","deletedAt":1000},
                {"id":"a1","entityType":"annotation","deletedAt":1001},
                {"id":"v1","entityType":"vocabulary","deletedAt":1002},
                {"id":"art1","entityType":"rss_article","deletedAt":1003}
            ]"#
            .to_string(),
        );
        let del_res = sqlite_merge_sync_entries_inner(&conn, tombstone_entries).unwrap();
        assert!(del_res
            .domains_updated
            .contains(&"deletion_tombstones".to_string()));
        assert_eq!(del_res.deleted_books, vec!["b1".to_string()]);
        assert_eq!(del_res.deleted_annotations, vec!["a1".to_string()]);
        assert_eq!(del_res.deleted_vocabulary, vec!["v1".to_string()]);
        assert_eq!(del_res.deleted_rss_articles, vec!["art1".to_string()]);

        assert_eq!(sqlite_get_book_metadata_inner(&conn, "b1").unwrap(), None);
        assert_eq!(
            sqlite_get_book_annotations_inner(&conn, "b1")
                .unwrap()
                .len(),
            0
        );
        assert_eq!(
            sqlite_search_books_inner(&conn, "Dune", 10).unwrap().len(),
            0
        );
        assert_eq!(sqlite_get_vocabulary_terms_inner(&conn).unwrap().len(), 0);
        assert_eq!(
            sqlite_get_rss_articles_inner(&conn, None, None, None)
                .unwrap()
                .len(),
            0
        );
    }

    #[test]
    fn merge_sync_entries_never_resurrects_tombstoned_entities() {
        let conn = setup_db();
        sqlite_upsert_annotation_inner(&conn, "keep", "b1", r#"{"id":"keep","bookId":"b1"}"#)
            .unwrap();
        sqlite_upsert_annotation_inner(&conn, "a1", "b1", r#"{"id":"a1","bookId":"b1"}"#).unwrap();

        // The doc still carries the deleted annotation's per-entity key, the
        // full-list key and a book whose tombstone arrives in the same batch.
        let mut entries = std::collections::HashMap::new();
        entries.insert(
            "deletion_tombstones".to_string(),
            r#"[{"entityId":"a1","entityType":"annotation","deletedAt":"2026-09-26T00:00:00Z"},
                {"entityId":"b2","entityType":"book","deletedAt":"2026-09-26T00:00:00Z"}]"#
                .to_string(),
        );
        entries.insert(
            "anno:b1:a1".to_string(),
            r#"{"id":"a1","bookId":"b1"}"#.to_string(),
        );
        entries.insert(
            "annotations".to_string(),
            r#"[{"id":"a1","bookId":"b1"},{"id":"a2","bookId":"b2"},{"id":"keep","bookId":"b1"}]"#
                .to_string(),
        );
        entries.insert(
            "anno:b2:a3".to_string(),
            r#"{"id":"a3","bookId":"b2"}"#.to_string(),
        );
        entries.insert(
            "book:b2".to_string(),
            r#"{"id":"b2","title":"Gone"}"#.to_string(),
        );
        entries.insert(
            "books".to_string(),
            r#"[{"id":"b2","title":"Gone"}]"#.to_string(),
        );

        let res = sqlite_merge_sync_entries_inner(&conn, entries).unwrap();
        assert_eq!(res.deleted_annotations, vec!["a1".to_string()]);
        assert_eq!(res.updated_annotations, vec!["keep".to_string()]);
        assert!(res.updated_books.is_empty());

        let all = sqlite_get_all_annotations_inner(&conn).unwrap();
        assert_eq!(all.len(), 1);
        assert!(all[0].contains("keep"));
        assert!(sqlite_get_book_annotations_inner(&conn, "b2")
            .unwrap()
            .is_empty());
        assert_eq!(sqlite_get_book_metadata_inner(&conn, "b2").unwrap(), None);
        assert!(sqlite_search_books_inner(&conn, "Gone", 10)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn test_sqlite_merge_sync_entries_preserves_local_paths() {
        let conn = setup_db();
        let temp_dir = tempfile::tempdir().unwrap();
        let book_cache_dir = temp_dir.path().join("book-cache");
        fs::create_dir_all(&book_cache_dir).unwrap();

        // 1. Existing local book with local paths
        sqlite_save_book_metadata_inner(
            &conn,
            "b1",
            r#"{"id":"b1","title":"Local Dune","author":"Frank Herbert","filePath":"/home/user/books/dune.epub","storagePath":"/app_data/book-cache/b1.book","syncedWithoutFile":false}"#,
        )
        .unwrap();

        // Also prepare b2 materialized in book_cache
        fs::write(book_cache_dir.join("b2.book"), b"dummy content").unwrap();

        // 2. Incoming sync entries
        let mut entries = std::collections::HashMap::new();
        // b1 has updated progress, but NO filePath, NO storagePath
        entries.insert(
            "book:b1".to_string(),
            r#"{"id":"b1","title":"Local Dune (Read)","author":"Frank Herbert","progress":0.75}"#
                .to_string(),
        );
        // b2 is new from peer, but already materialized on disk
        entries.insert(
            "book:b2".to_string(),
            r#"{"id":"b2","title":"Second Book","author":"Author Two"}"#.to_string(),
        );
        // b3 is new from peer and NOT on disk
        entries.insert(
            "book:b3".to_string(),
            r#"{"id":"b3","title":"Third Book","author":"Author Three"}"#.to_string(),
        );

        let res =
            sqlite_merge_sync_entries_with_dir(&conn, entries, Some(temp_dir.path())).unwrap();
        assert_eq!(res.books_count, 3);

        // Check b1: local paths preserved and syncedWithoutFile remains false
        let meta_b1: serde_json::Value = serde_json::from_str(
            &sqlite_get_book_metadata_inner(&conn, "b1")
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(meta_b1["title"], "Local Dune (Read)");
        assert_eq!(meta_b1["progress"], 0.75);
        assert_eq!(meta_b1["filePath"], "/home/user/books/dune.epub");
        assert_eq!(meta_b1["storagePath"], "/app_data/book-cache/b1.book");
        assert_eq!(meta_b1["syncedWithoutFile"], false);

        // Check b2: materialized file detected, syncedWithoutFile is false, storagePath populated
        let meta_b2: serde_json::Value = serde_json::from_str(
            &sqlite_get_book_metadata_inner(&conn, "b2")
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(meta_b2["title"], "Second Book");
        assert_eq!(meta_b2["syncedWithoutFile"], false);
        assert!(meta_b2["storagePath"]
            .as_str()
            .unwrap()
            .ends_with("b2.book"));

        // Check b3: not materialized, syncedWithoutFile is true
        let meta_b3: serde_json::Value = serde_json::from_str(
            &sqlite_get_book_metadata_inner(&conn, "b3")
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(meta_b3["title"], "Third Book");
        assert_eq!(meta_b3["syncedWithoutFile"], true);
    }
}
