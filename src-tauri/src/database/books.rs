//! Books: materialized book files, metadata, progress, the full-text index and the library window.

use super::*;

pub(crate) fn materialized_book_path_in_dir(app_data_dir: &Path, book_id: &str) -> PathBuf {
    app_data_dir
        .join(MATERIALIZED_BOOK_CACHE_DIR)
        .join(format!("{book_id}.book"))
}

pub(super) fn materialized_book_path_creating(
    app_data_dir: &Path,
    book_id: &str,
) -> Result<PathBuf, String> {
    let cache_dir = app_data_dir.join(MATERIALIZED_BOOK_CACHE_DIR);
    fs::create_dir_all(&cache_dir).map_err(|error| {
        format!("Failed to create materialized cache directory '{cache_dir:?}': {error}")
    })?;

    Ok(materialized_book_path_in_dir(app_data_dir, book_id))
}

pub(crate) fn materialized_book_path(app: &AppHandle, book_id: &str) -> Result<PathBuf, String> {
    materialized_book_path_creating(&app_data_dir_of(app)?, book_id)
}

pub(super) fn remove_materialized_cache_file_in(app_data_dir: &Path, book_id: &str) {
    let _ = fs::remove_file(materialized_book_path_in_dir(app_data_dir, book_id));
}

pub(crate) fn reconcile_synced_without_file_metadata(
    connection: &Connection,
    app_data_dir: &Path,
) -> Result<Vec<HealedBook>, String> {
    let table_exists: bool = connection
        .query_row(
            "SELECT COUNT(*) > 0 FROM sqlite_master WHERE type = 'table' AND name = 'book_metadata'",
            [],
            |row| row.get(0),
        )
        .unwrap_or(false);
    if !table_exists {
        return Ok(Vec::new());
    }

    let mut statement = connection
        .prepare("SELECT book_id, metadata_json FROM book_metadata WHERE metadata_json LIKE '%\"syncedWithoutFile\":true%'")
        .map_err(|e| format!("Failed to prepare syncedWithoutFile query: {e}"))?;

    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| format!("Failed to query book metadata: {e}"))?;

    let mut updates = Vec::new();
    for row in rows {
        let (book_id, json_str) = row.map_err(|e| e.to_string())?;
        let book_path = materialized_book_path_in_dir(app_data_dir, &book_id);
        let mut source_file = None;

        if book_path.is_file() {
            source_file = Some(book_path.clone());
        } else if let Ok(val) = serde_json::from_str::<serde_json::Value>(&json_str) {
            if let Some(file_path) = val.get("filePath").and_then(|v| v.as_str()) {
                let p = Path::new(file_path);
                if p.is_file() {
                    if let Some(cache_dir) = book_path.parent() {
                        let _ = fs::create_dir_all(cache_dir);
                    }
                    let _ = copy_file_if_absent(p, &book_path);
                    if book_path.is_file() {
                        source_file = Some(book_path.clone());
                    }
                }
            }
        }

        if source_file.is_some() {
            if let Ok(mut val) = serde_json::from_str::<serde_json::Value>(&json_str) {
                if val.get("syncedWithoutFile") == Some(&serde_json::Value::Bool(true)) {
                    val["syncedWithoutFile"] = serde_json::Value::Bool(false);
                    val["storagePath"] =
                        serde_json::Value::String(book_path.to_string_lossy().into_owned());
                    if let Ok(updated_json) = serde_json::to_string(&val) {
                        updates.push((book_id, json_str, updated_json));
                    }
                }
            }
        }
    }
    drop(statement);

    let mut healed = Vec::new();
    for chunk in updates.chunks(64) {
        let tx = connection
            .unchecked_transaction()
            .map_err(|e| format!("Failed to start heal transaction: {e}"))?;
        let mut written = Vec::new();
        for (book_id, read_json, updated_json) in chunk {
            if write_healed_metadata(&tx, book_id, read_json, updated_json).unwrap_or(false) {
                written.push(HealedBook {
                    id: book_id.clone(),
                    storage_path: materialized_book_path_in_dir(app_data_dir, book_id)
                        .to_string_lossy()
                        .into_owned(),
                });
            }
        }
        tx.commit()
            .map_err(|e| format!("Failed to commit healed metadata: {e}"))?;
        healed.extend(written);
    }
    Ok(healed)
}

/// A book whose `syncedWithoutFile` flag the heal pass cleared; sent to the
/// interface (`library-books-healed`), which loaded the library before.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HealedBook {
    pub id: String,
    pub storage_path: String,
}

/// Replace a book's metadata with its healed form, unless the app changed it
/// since `read_json` was read (the heal runs alongside the app).
pub(crate) fn write_healed_metadata(
    connection: &Connection,
    book_id: &str,
    read_json: &str,
    updated_json: &str,
) -> rusqlite::Result<bool> {
    let changed = connection.execute(
        "UPDATE book_metadata SET metadata_json = ?1 WHERE book_id = ?2 AND metadata_json = ?3",
        params![updated_json, book_id, read_json],
    )?;
    Ok(changed > 0)
}

pub fn sqlite_save_book_data(app: AppHandle, id: String, data: Vec<u8>) -> Result<String, String> {
    let materialized_path = materialized_book_path(&app, &id)?;
    fs::write(&materialized_path, &data).map_err(|error| {
        format!("Failed to write book data file '{materialized_path:?}': {error}")
    })?;

    with_connection(&app, |connection| {
        sqlite_register_materialized_book_inner(connection, &id)
    })?;

    Ok(format!("sqlite://{id}"))
}

pub fn sqlite_register_materialized_book_inner(
    connection: &Connection,
    id: &str,
) -> rusqlite::Result<()> {
    connection.execute(
        r#"
        INSERT INTO books (id, data, updated_at)
        VALUES (?1, X'', unixepoch())
        ON CONFLICT(id) DO UPDATE SET
            data = X'',
            updated_at = unixepoch()
        "#,
        params![id],
    )?;

    connection.execute(
        r#"
        INSERT INTO materialized_books (book_id, source_updated_at, materialized_at)
        VALUES (?1, (SELECT updated_at FROM books WHERE id = ?1), unixepoch())
        ON CONFLICT(book_id) DO UPDATE SET
            source_updated_at = (SELECT updated_at FROM books WHERE id = ?1),
            materialized_at = unixepoch()
        "#,
        params![id],
    )?;
    Ok(())
}

pub fn sqlite_register_materialized_book(app: AppHandle, id: String) -> Result<(), String> {
    with_connection(&app, |connection| {
        sqlite_register_materialized_book_inner(connection, &id)
    })
}

pub fn sqlite_get_book_data(app: AppHandle, id: String) -> Result<Option<Vec<u8>>, String> {
    if let Ok(Some(path)) = sqlite_get_materialized_book_path(app.clone(), id.clone()) {
        let content = fs::read(&path).map_err(|e| format!("Failed to read book file: {}", e))?;
        return Ok(Some(content));
    }

    with_connection(&app, |connection| {
        connection
            .query_row(
                "SELECT data FROM books WHERE id = ?1 AND length(data) > 0",
                params![id],
                |row| row.get::<_, Vec<u8>>(0),
            )
            .optional()
    })
}

pub fn sqlite_delete_book_data(app: AppHandle, id: String) -> Result<(), String> {
    delete_book_data_in(&DataStore::for_app(&app)?, &id)
}

/// Remove a book's cached file and every row stored for it.
pub fn delete_book_data_in(store: &DataStore, id: &str) -> Result<(), String> {
    // Close cached EPUB archives first: Windows cannot delete an open file.
    crate::epub_entries::clear_cache();
    remove_materialized_cache_file_in(store.dir(), id);

    store.with_connection(|connection| sqlite_delete_book_inner(connection, id))
}

/// Remove a book and everything stored for it, in one transaction.
pub fn sqlite_delete_book_inner(connection: &Connection, id: &str) -> rusqlite::Result<()> {
    let tx = connection.unchecked_transaction()?;
    delete_book_rows(&tx, id)?;
    tx.commit()
}

/// Delete every row that belongs to book `id`. Runs no transaction of its
/// own: callers wrap it in one (the sync merge runs it inside its own).
///
/// Foreign keys are ON (the bundled SQLite defaults them on), so the
/// `ON DELETE CASCADE` clauses would clear most of this when the `books` row
/// goes; each table is still cleared here explicitly, children first, so the
/// result does not depend on the schema's cascades. `books_fts` has no
/// foreign key at all. A synced book without its file still has a `books`
/// row (an empty one, inserted with its metadata), which is what lets its
/// metadata and annotations satisfy the foreign keys. Any new table keyed by
/// book id must be added here.
pub(crate) fn delete_book_rows(connection: &Connection, id: &str) -> rusqlite::Result<()> {
    for sql in [
        "DELETE FROM covers WHERE book_id = ?1",
        "DELETE FROM materialized_books WHERE book_id = ?1",
        "DELETE FROM book_metadata WHERE book_id = ?1",
        "DELETE FROM book_annotations WHERE book_id = ?1",
        // Deleted books must leave library search too.
        "DELETE FROM books_fts WHERE id = ?1",
        "DELETE FROM books WHERE id = ?1",
    ] {
        connection.execute(sql, params![id])?;
    }
    Ok(())
}

pub fn sqlite_get_materialized_book_path(
    app: AppHandle,
    id: String,
) -> Result<Option<String>, String> {
    get_materialized_book_path_in(&DataStore::for_app(&app)?, &id)
}

/// The book's file in `book-cache/`, moving a legacy in-database copy out
/// first when that is where the book still lives.
pub fn get_materialized_book_path_in(
    store: &DataStore,
    id: &str,
) -> Result<Option<String>, String> {
    let materialized_path = store.materialized_book_path(id)?;

    if materialized_path.exists() {
        return Ok(Some(materialized_path.to_string_lossy().into_owned()));
    }

    let data = store.with_connection(|connection| {
        connection
            .query_row("SELECT data FROM books WHERE id = ?1", params![id], |row| {
                row.get::<_, Vec<u8>>(0)
            })
            .optional()
    })?;

    if let Some(blob_data) = data {
        if !blob_data.is_empty() {
            fs::write(&materialized_path, &blob_data).map_err(|error| {
                format!("Failed to write migrated book file '{materialized_path:?}': {error}")
            })?;

            let _ = store.with_connection(|connection| {
                connection.execute("UPDATE books SET data = X'' WHERE id = ?1", params![id])
            });

            return Ok(Some(materialized_path.to_string_lossy().into_owned()));
        }
    }

    Ok(None)
}

/// Make sure book `id` has a `books` row. Foreign keys are on, so covers,
/// metadata and annotations need one; a synced book without its file, and an
/// RSS article's highlights (book id `rss:<article id>`), get an empty row,
/// as metadata saves and the sync merge already do.
pub(super) fn ensure_book_row(connection: &Connection, id: &str) -> rusqlite::Result<()> {
    connection.execute(
        "INSERT OR IGNORE INTO books(id, data, updated_at) VALUES(?1, X'', unixepoch())",
        params![id],
    )?;
    Ok(())
}

/// Ids of `books` rows that anchor an RSS article's highlights, not books.
pub(super) fn is_article_anchor(id: &str) -> bool {
    id.starts_with("rss:")
}

#[derive(Serialize)]
pub struct SqliteBookSearchResult {
    pub book_id: String,
    pub title: String,
}

pub fn sqlite_index_book_fts_inner(
    connection: &Connection,
    book_id: &str,
    title: &str,
    author: &str,
) -> rusqlite::Result<()> {
    connection.execute("DELETE FROM books_fts WHERE id = ?1", params![book_id])?;
    connection.execute(
        "INSERT INTO books_fts(id, title, author) VALUES(?1, ?2, ?3)",
        params![book_id, title, author],
    )?;
    Ok(())
}

pub fn sqlite_index_book_fts(
    app: AppHandle,
    book_id: String,
    title: String,
    author: String,
) -> Result<(), String> {
    with_connection(&app, |connection| {
        sqlite_index_book_fts_inner(connection, &book_id, &title, &author)
    })
}

pub fn sqlite_index_books_fts_batch_inner(
    connection: &Connection,
    entries: &[(String, String, String)],
) -> rusqlite::Result<()> {
    let tx = connection.unchecked_transaction()?;
    for (id, title, author) in entries {
        tx.execute("DELETE FROM books_fts WHERE id = ?1", params![id])?;
        tx.execute(
            "INSERT INTO books_fts(id, title, author) VALUES(?1, ?2, ?3)",
            params![id, title, author],
        )?;
    }
    tx.commit()?;
    Ok(())
}

pub fn sqlite_index_books_fts_batch(
    app: AppHandle,
    entries: Vec<(String, String, String)>,
) -> Result<(), String> {
    with_connection(&app, |connection| {
        sqlite_index_books_fts_batch_inner(connection, &entries)
    })
}

pub fn sqlite_search_books_inner(
    connection: &Connection,
    query: &str,
    limit: u32,
) -> rusqlite::Result<Vec<SqliteBookSearchResult>> {
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }
    let mut stmt = connection.prepare(
        "SELECT id, title FROM books_fts WHERE books_fts MATCH ?1 ORDER BY rank LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![query, limit], |row| {
        Ok(SqliteBookSearchResult {
            book_id: row.get(0)?,
            title: row.get(1)?,
        })
    })?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
}

pub fn sqlite_search_books(
    app: AppHandle,
    query: String,
    limit: u32,
) -> Result<Vec<SqliteBookSearchResult>, String> {
    with_connection(&app, |connection| {
        sqlite_search_books_inner(connection, &query, limit)
    })
}

pub fn sqlite_save_book_metadata_inner(
    connection: &Connection,
    book_id: &str,
    metadata_json: &str,
) -> rusqlite::Result<()> {
    connection.execute(
        "INSERT OR IGNORE INTO books(id, data, updated_at) VALUES(?1, X'', unixepoch())",
        params![book_id],
    )?;
    connection.execute(
        "INSERT INTO book_metadata(book_id, metadata_json, updated_at) VALUES(?1, ?2, unixepoch())
         ON CONFLICT(book_id) DO UPDATE SET metadata_json = ?2, updated_at = unixepoch()",
        params![book_id, metadata_json],
    )?;
    if let Ok(val) = serde_json::from_str::<serde_json::Value>(metadata_json) {
        let title = val.get("title").and_then(|v| v.as_str()).unwrap_or("");
        let author = val.get("author").and_then(|v| v.as_str());
        let _ = connection.execute("DELETE FROM books_fts WHERE id = ?1", params![book_id]);
        let _ = connection.execute(
            "INSERT INTO books_fts(id, title, author) VALUES(?1, ?2, ?3)",
            params![book_id, title, author],
        );
    }
    Ok(())
}

pub fn sqlite_save_book_metadata(
    app: AppHandle,
    book_id: String,
    metadata_json: String,
) -> Result<(), String> {
    with_connection(&app, |connection| {
        sqlite_save_book_metadata_inner(connection, &book_id, &metadata_json)
    })
}

pub fn sqlite_delete_book_metadata_inner(
    connection: &Connection,
    book_id: &str,
) -> rusqlite::Result<()> {
    connection.execute(
        "DELETE FROM book_metadata WHERE book_id = ?1",
        params![book_id],
    )?;
    connection.execute("DELETE FROM books_fts WHERE id = ?1", params![book_id])?;
    Ok(())
}

pub fn sqlite_delete_book_metadata(app: AppHandle, book_id: String) -> Result<(), String> {
    with_connection(&app, |connection| {
        sqlite_delete_book_metadata_inner(connection, &book_id)
    })
}

pub fn sqlite_load_all_books_inner(connection: &Connection) -> rusqlite::Result<Vec<String>> {
    let mut stmt =
        connection.prepare("SELECT metadata_json FROM book_metadata ORDER BY updated_at DESC")?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
}

pub fn sqlite_load_all_books(app: AppHandle) -> Result<Vec<String>, String> {
    with_connection(&app, sqlite_load_all_books_inner)
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookProgressUpdate {
    pub progress: f64,
    pub current_location: Option<String>,
    pub last_read_at: String,
    pub last_click_fraction: Option<f64>,
    pub page_progress_json: Option<String>,
    pub pdf_view_state_json: Option<String>,
}

pub fn sqlite_update_book_progress_inner(
    connection: &Connection,
    book_id: &str,
    update: &BookProgressUpdate,
) -> rusqlite::Result<()> {
    if let Some(existing_json) = sqlite_get_book_metadata_inner(connection, book_id)? {
        if let Ok(mut val) = serde_json::from_str::<serde_json::Value>(&existing_json) {
            val["progress"] = serde_json::json!(update.progress);
            if let Some(ref loc) = update.current_location {
                val["currentLocation"] = serde_json::json!(loc);
            }
            val["lastReadAt"] = serde_json::json!(update.last_read_at);
            if let Some(lcf) = update.last_click_fraction {
                val["lastClickFraction"] = serde_json::json!(lcf);
            }
            if let Some(ref pp) = update.page_progress_json {
                if let Ok(pp_val) = serde_json::from_str::<serde_json::Value>(pp) {
                    val["pageProgress"] = pp_val;
                }
            }
            if let Some(ref pdf) = update.pdf_view_state_json {
                if let Ok(pdf_val) = serde_json::from_str::<serde_json::Value>(pdf) {
                    val["pdfViewState"] = pdf_val;
                }
            }
            let updated_json = serde_json::to_string(&val).unwrap_or(existing_json);
            connection.execute(
                "INSERT INTO book_metadata(book_id, metadata_json, updated_at) VALUES(?1, ?2, unixepoch())
                 ON CONFLICT(book_id) DO UPDATE SET metadata_json = ?2, updated_at = unixepoch()",
                params![book_id, updated_json],
            )?;
        }
    }
    Ok(())
}

pub fn sqlite_update_book_progress(
    app: AppHandle,
    book_id: String,
    update: BookProgressUpdate,
) -> Result<(), String> {
    with_connection(&app, |conn| {
        sqlite_update_book_progress_inner(conn, &book_id, &update)
    })
}

pub fn sqlite_get_book_metadata_inner(
    connection: &Connection,
    book_id: &str,
) -> rusqlite::Result<Option<String>> {
    connection
        .query_row(
            "SELECT metadata_json FROM book_metadata WHERE book_id = ?1",
            params![book_id],
            |row| row.get(0),
        )
        .optional()
}

pub fn sqlite_get_book_metadata(app: AppHandle, book_id: String) -> Result<Option<String>, String> {
    with_connection(&app, |connection| {
        sqlite_get_book_metadata_inner(connection, &book_id)
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookWindowResult {
    pub book_ids: Vec<String>,
    pub total_count: u32,
}

/// The number of books in `books_fts`. FTS5 keeps one `books_fts_docsize`
/// row per document in an ordinary table, which SQLite counts from its
/// b-tree; `COUNT(*)` on the virtual table reads every document instead.
fn count_indexed_books(connection: &Connection) -> rusqlite::Result<u32> {
    connection
        .query_row("SELECT COUNT(*) FROM books_fts_docsize", [], |row| {
            row.get(0)
        })
        .or_else(|_| connection.query_row("SELECT COUNT(*) FROM books_fts", [], |row| row.get(0)))
}

/// One page of the indexed books, in index order (FTS rowid: the order the
/// scan reads anyway, so no sort; a re-indexed book moves to the end), with
/// the total. Without an ORDER BY, pages could overlap or skip books.
pub fn sqlite_query_books_window_inner(
    connection: &Connection,
    limit: u32,
    offset: u32,
) -> rusqlite::Result<BookWindowResult> {
    let mut stmt =
        connection.prepare_cached("SELECT id FROM books_fts ORDER BY rowid LIMIT ?1 OFFSET ?2")?;
    let rows = stmt.query_map(params![limit, offset], |row| row.get::<_, String>(0))?;
    let book_ids = rows.collect::<rusqlite::Result<Vec<String>>>()?;

    // A short, non-empty page (or a short first page) ends the list, so the
    // total is known without counting.
    let fetched = book_ids.len() as u32;
    let total_count = if fetched < limit && (fetched > 0 || offset == 0) {
        offset + fetched
    } else {
        count_indexed_books(connection)?
    };
    Ok(BookWindowResult {
        book_ids,
        total_count,
    })
}

pub fn sqlite_query_books_window(
    app: AppHandle,
    limit: u32,
    offset: u32,
) -> Result<BookWindowResult, String> {
    with_connection(&app, |connection| {
        sqlite_query_books_window_inner(connection, limit, offset)
    })
}

/// KV key where the frontend records the hash of the book list it last
/// indexed (`FTS_HASH_KV_KEY` in `libraryStore.ts`). Cleared whenever the
/// index is repaired here, so the frontend re-indexes instead of trusting it.
const FTS_HASH_KV_KEY: &str = "fts:booksHash";

/// Bring `books_fts` in line with the library: index missing books, refresh
/// renamed ones, drop deleted ones. Only differing rows are written. Returns
/// the number of rows changed.
///
/// The source of truth is `book_metadata` (what `sqlite_load_all_books`
/// returns), never the `zustand:theorem-library` KV blob: on Tauri that blob
/// has persisted `state.books` as an empty array since library store v8, and
/// reconciling against it wiped the whole index at every startup.
///
/// Runs in the background alongside the app, so it reads and writes in one
/// `IMMEDIATE` transaction: a book added or deleted meanwhile can never be
/// dropped from, or resurrected in, the index from a stale read.
pub(crate) fn reconcile_books_fts(connection: &Connection) -> rusqlite::Result<usize> {
    let tx =
        rusqlite::Transaction::new_unchecked(connection, rusqlite::TransactionBehavior::Immediate)?;
    let rows: Vec<(String, String)> = {
        let mut stmt = tx.prepare("SELECT book_id, metadata_json FROM book_metadata")?;
        let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    // An empty library is never a reason to clear the index: the delete paths
    // remove their own rows, and an empty source more likely means a library
    // that has not been migrated yet.
    if rows.is_empty() {
        return Ok(0);
    }

    // Books whose metadata cannot be parsed keep whatever row they have.
    let mut unparsable: HashSet<String> = HashSet::new();
    let mut wanted: HashMap<String, (String, String)> = HashMap::with_capacity(rows.len());
    for (id, json) in rows {
        if id.is_empty() {
            continue;
        }
        match serde_json::from_str::<serde_json::Value>(&json) {
            Ok(value) => {
                let title = value["title"].as_str().unwrap_or("").to_string();
                let author = value["author"].as_str().unwrap_or("").to_string();
                wanted.insert(id, (title, author));
            }
            Err(_) => {
                unparsable.insert(id);
            }
        }
    }

    let mut existing: HashMap<String, (String, String)> = HashMap::new();
    {
        let mut stmt = tx.prepare("SELECT id, title, author FROM books_fts")?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                (
                    row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                    row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                ),
            ))
        })?;
        for row in rows {
            let (id, fields) = row?;
            existing.insert(id, fields);
        }
    }

    let mut changed = 0;
    for id in existing.keys() {
        if !wanted.contains_key(id) && !unparsable.contains(id) {
            tx.execute("DELETE FROM books_fts WHERE id = ?1", params![id])?;
            changed += 1;
        }
    }
    for (id, (title, author)) in &wanted {
        let current = existing.get(id);
        if current.is_some_and(|(t, a)| t == title && a == author) {
            continue;
        }
        if current.is_some() {
            tx.execute("DELETE FROM books_fts WHERE id = ?1", params![id])?;
        }
        tx.execute(
            "INSERT INTO books_fts(id, title, author) VALUES(?1, ?2, ?3)",
            params![id, title, author],
        )?;
        changed += 1;
    }
    if changed > 0 {
        tx.execute(
            "DELETE FROM kv_store WHERE key = ?1",
            params![FTS_HASH_KV_KEY],
        )?;
    }
    tx.commit()?;
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::test_support::*;

    #[test]
    fn test_fts_index_and_search() {
        let conn = setup_db();
        sqlite_index_book_fts_inner(&conn, "id1", "The Great Gatsby", "F. Scott Fitzgerald")
            .unwrap();
        sqlite_index_book_fts_inner(&conn, "id2", "Gatsby Returns", "Some Author").unwrap();
        sqlite_index_book_fts_inner(&conn, "id3", "Moby Dick", "Herman Melville").unwrap();
        let results = sqlite_search_books_inner(&conn, "Gatsby", 10).unwrap();
        assert_eq!(results.len(), 2);
        assert!(results.iter().any(|r| r.book_id == "id1"));
        assert!(results.iter().any(|r| r.book_id == "id2"));
    }

    #[test]
    fn test_fts_search_empty_query() {
        let conn = setup_db();
        let results = sqlite_search_books_inner(&conn, "", 10).unwrap();
        assert!(results.is_empty());
    }

    #[test]
    fn test_book_metadata_roundtrip() {
        let conn = setup_db();
        let meta = r#"{"title":"Test Book","author":"Test Author"}"#;
        sqlite_save_book_metadata_inner(&conn, "book1", meta).unwrap();
        let result = sqlite_get_book_metadata_inner(&conn, "book1").unwrap();
        assert_eq!(result, Some(meta.to_string()));
    }

    #[test]
    fn test_book_metadata_overwrite() {
        let conn = setup_db();
        sqlite_save_book_metadata_inner(&conn, "book1", r#"{"v":1}"#).unwrap();
        sqlite_save_book_metadata_inner(&conn, "book1", r#"{"v":2}"#).unwrap();
        let result = sqlite_get_book_metadata_inner(&conn, "book1").unwrap();
        assert_eq!(result, Some(r#"{"v":2}"#.to_string()));
    }

    #[test]
    fn test_book_metadata_get_nonexistent() {
        let conn = setup_db();
        let result = sqlite_get_book_metadata_inner(&conn, "nonexistent").unwrap();
        assert_eq!(result, None);
    }

    #[test]
    fn test_load_all_books_and_update_progress() {
        let conn = setup_db();
        let b1 = r#"{"id":"b1","title":"Book One","author":"Author 1","progress":0.1}"#;
        let b2 = r#"{"id":"b2","title":"Book Two","author":"Author 2","progress":0.0}"#;
        sqlite_save_book_metadata_inner(&conn, "b1", b1).unwrap();
        sqlite_save_book_metadata_inner(&conn, "b2", b2).unwrap();

        let all = sqlite_load_all_books_inner(&conn).unwrap();
        assert_eq!(all.len(), 2);

        let update = BookProgressUpdate {
            progress: 0.75,
            current_location: Some("cfi-123".to_string()),
            last_read_at: "2026-09-24T12:00:00Z".to_string(),
            last_click_fraction: Some(0.42),
            page_progress_json: Some(
                r#"{"currentPage":5,"totalPages":10,"range":"5"}"#.to_string(),
            ),
            pdf_view_state_json: None,
        };
        sqlite_update_book_progress_inner(&conn, "b1", &update).unwrap();
        let updated = sqlite_get_book_metadata_inner(&conn, "b1")
            .unwrap()
            .unwrap();
        assert!(updated.contains("\"progress\":0.75"));
        assert!(updated.contains("\"currentLocation\":\"cfi-123\""));
        assert!(updated.contains("\"lastReadAt\":\"2026-09-24T12:00:00Z\""));
        assert!(updated.contains("\"lastClickFraction\":0.42"));
        assert!(updated.contains("\"currentPage\":5"));

        sqlite_delete_book_metadata_inner(&conn, "b2").unwrap();
        let after_del = sqlite_load_all_books_inner(&conn).unwrap();
        assert_eq!(after_del.len(), 1);
        assert_eq!(sqlite_get_book_metadata_inner(&conn, "b2").unwrap(), None);
    }

    /// Deleting a book clears every table explicitly; it must not rely on
    /// ON DELETE CASCADE (an RSS article's highlights are kept).
    #[test]
    fn delete_book_removes_every_related_row() {
        let conn = setup_db();
        seed_book(&conn, "gone", "Gone");
        seed_book(&conn, "kept", "Kept");
        sqlite_upsert_annotation_inner(&conn, "rss-ann", "rss:gone", "{}").unwrap();

        sqlite_delete_book_inner(&conn, "gone").unwrap();

        assert_eq!(rows_for_book(&conn, "gone"), []);
        assert_eq!(rows_for_book(&conn, "kept").len(), 6);
        assert_eq!(
            sqlite_get_book_annotations_inner(&conn, "rss:gone")
                .unwrap()
                .len(),
            1
        );
        // Deleting a book that is not there is fine.
        sqlite_delete_book_inner(&conn, "missing").unwrap();
    }

    #[test]
    fn delete_book_is_atomic() {
        let conn = setup_db();
        seed_book(&conn, "b1", "Book");
        conn.execute_batch(
            "CREATE TRIGGER fail_books_delete BEFORE DELETE ON books
             BEGIN SELECT RAISE(ABORT, 'boom'); END;",
        )
        .unwrap();
        assert!(sqlite_delete_book_inner(&conn, "b1").is_err());
        assert_eq!(rows_for_book(&conn, "b1").len(), 6);
    }

    #[test]
    fn test_fts_batch_index() {
        let conn = setup_db();
        let entries = vec![
            (
                "id1".to_string(),
                "Book One".to_string(),
                "Author A".to_string(),
            ),
            (
                "id2".to_string(),
                "Book Two".to_string(),
                "Author B".to_string(),
            ),
        ];
        sqlite_index_books_fts_batch_inner(&conn, &entries).unwrap();
        let results = sqlite_search_books_inner(&conn, "Book", 10).unwrap();
        assert_eq!(results.len(), 2);
    }

    #[test]
    fn test_register_materialized_book_upserts_empty_blob() {
        let conn = setup_db();
        sqlite_register_materialized_book_inner(&conn, "book1").unwrap();

        assert_eq!(book_data_len(&conn, "book1"), 0);
        let materialized: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM materialized_books WHERE book_id = ?1",
                params!["book1"],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(materialized, 1);
    }

    #[test]
    fn test_register_materialized_book_is_idempotent() {
        let conn = setup_db();
        sqlite_register_materialized_book_inner(&conn, "book1").unwrap();
        sqlite_register_materialized_book_inner(&conn, "book1").unwrap();

        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM books", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1);
        assert_eq!(book_data_len(&conn, "book1"), 0);
    }

    #[test]
    fn test_empty_blob_is_treated_as_absent() {
        let conn = setup_db();
        sqlite_register_materialized_book_inner(&conn, "book1").unwrap();

        // sqlite_get_book_data and file_transfer read_book_data both guard with
        // `length(data) > 0` so a registered book with no materialized file is
        // reported as missing (None) instead of serving empty bytes.
        let data: Option<Vec<u8>> = conn
            .query_row(
                "SELECT data FROM books WHERE id = ?1 AND length(data) > 0",
                params!["book1"],
                |row| row.get(0),
            )
            .optional()
            .unwrap();
        assert!(data.is_none());
    }

    /// Since library store v8 the Tauri build persists `state.books` as an
    /// empty array; the books live in `book_metadata`. Reconciling against the
    /// KV list wiped the whole search index at every startup.
    #[test]
    fn reconcile_books_fts_keeps_index_when_kv_library_is_empty() {
        let conn = setup_db();
        sqlite_set_kv_inner(
            &conn,
            "zustand:theorem-library",
            r#"{"state":{"books":[],"collections":[],"annotations":[]},"version":8}"#,
        )
        .unwrap();
        sqlite_save_book_metadata_inner(
            &conn,
            "a",
            r#"{"id":"a","title":"Dune","author":"Herbert"}"#,
        )
        .unwrap();
        sqlite_save_book_metadata_inner(
            &conn,
            "b",
            r#"{"id":"b","title":"Emma","author":"Austen"}"#,
        )
        .unwrap();
        sqlite_set_kv_inner(&conn, "fts:booksHash", "123").unwrap();

        reconcile_books_fts(&conn).unwrap();
        assert_eq!(
            sqlite_search_books_inner(&conn, "Dune", 10).unwrap().len(),
            1
        );
        assert_eq!(
            sqlite_search_books_inner(&conn, "Austen", 10)
                .unwrap()
                .len(),
            1
        );

        // A book missing from the index is restored, and the frontend's
        // "already indexed" hash is invalidated so it re-indexes too.
        conn.execute("DELETE FROM books_fts WHERE id = 'b'", [])
            .unwrap();
        assert_eq!(reconcile_books_fts(&conn).unwrap(), 1);
        assert_eq!(
            sqlite_search_books_inner(&conn, "Emma", 10).unwrap().len(),
            1
        );
        assert_eq!(sqlite_get_kv_inner(&conn, "fts:booksHash").unwrap(), None);
    }

    #[test]
    fn reconcile_books_fts_adds_renames_and_prunes() {
        // The library lives in `book_metadata`. Written raw (not via
        // `sqlite_save_book_metadata_inner`) so the index starts out of date.
        let conn = setup_db();
        let set_meta = |id: &str, json: &str| {
            // A metadata row always has its `books` row (foreign keys are on).
            ensure_book_row(&conn, id).unwrap();
            conn.execute(
                "INSERT OR REPLACE INTO book_metadata (book_id, metadata_json) VALUES (?1, ?2)",
                params![id, json],
            )
            .unwrap();
        };
        let rows = || -> Vec<(String, String)> {
            let mut stmt = conn
                .prepare("SELECT id, title FROM books_fts ORDER BY id")
                .unwrap();
            stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
                .unwrap()
                .map(Result::unwrap)
                .collect()
        };

        // No library yet: nothing to do.
        assert_eq!(reconcile_books_fts(&conn).unwrap(), 0);

        // Nor when there is no library at all, even with stray index rows.
        conn.execute(
            "INSERT INTO books_fts(id, title, author) VALUES ('stray', 'Kept', '')",
            [],
        )
        .unwrap();
        assert_eq!(reconcile_books_fts(&conn).unwrap(), 0);
        conn.execute("DELETE FROM books_fts", []).unwrap();

        set_meta("a", r#"{"id":"a","title":"Dune","author":"Herbert"}"#);
        set_meta("b", r#"{"id":"b","title":"Emma","author":"Austen"}"#);
        set_meta("", r#"{"id":"","title":"x"}"#);
        conn.execute(
            "INSERT INTO books_fts(id, title, author) VALUES ('gone', 'Deleted Book', '')",
            [],
        )
        .unwrap();
        assert_eq!(reconcile_books_fts(&conn).unwrap(), 3); // add a, add b, prune gone
        assert_eq!(
            rows(),
            [("a".into(), "Dune".into()), ("b".into(), "Emma".into())]
        );

        // Already in sync: no writes.
        assert_eq!(reconcile_books_fts(&conn).unwrap(), 0);

        // Rename one, delete the other.
        set_meta(
            "a",
            r#"{"id":"a","title":"Dune Messiah","author":"Herbert"}"#,
        );
        conn.execute("DELETE FROM book_metadata WHERE book_id = 'b'", [])
            .unwrap();
        assert_eq!(reconcile_books_fts(&conn).unwrap(), 2);
        assert_eq!(rows(), [("a".into(), "Dune Messiah".into())]);

        // Corrupt metadata is ignored: its index row is neither changed nor pruned.
        set_meta("a", "{not json");
        assert_eq!(reconcile_books_fts(&conn).unwrap(), 0);
        assert_eq!(rows().len(), 1);
    }

    #[test]
    fn books_window_pages_in_a_stable_order_with_the_total() {
        let (_dir, store) = migrated_store();
        let ids: Vec<String> = (0..25)
            .map(|i| format!("book-{:02}", (i * 7) % 25))
            .collect();
        store
            .with_connection(|c| {
                for id in &ids {
                    c.execute(
                        "INSERT INTO books_fts(id, title, author) VALUES(?1, 'T', 'A')",
                        params![id],
                    )?;
                }
                // Re-indexing a book (an edit) moves it to the end.
                c.execute("DELETE FROM books_fts WHERE id = 'book-00'", [])?;
                c.execute(
                    "INSERT INTO books_fts(id, title, author) VALUES('book-00', 'T2', 'A')",
                    [],
                )?;
                Ok(())
            })
            .unwrap();
        let mut expected: Vec<String> = ids.iter().filter(|id| *id != "book-00").cloned().collect();
        expected.push("book-00".into());
        let mut seen = Vec::new();
        for offset in (0..30).step_by(10) {
            let page = store
                .with_connection(|c| sqlite_query_books_window_inner(c, 10, offset))
                .unwrap();
            assert_eq!(page.total_count, 25, "offset {offset}");
            seen.extend(page.book_ids);
        }
        // Every book once, in index order: pages neither overlap nor skip.
        assert_eq!(seen, expected);
        let past_end = store
            .with_connection(|c| sqlite_query_books_window_inner(c, 10, 100))
            .unwrap();
        assert!(past_end.book_ids.is_empty());
        assert_eq!(past_end.total_count, 25);
        let none = store
            .with_connection(|c| sqlite_query_books_window_inner(c, 0, 0))
            .unwrap();
        assert!(none.book_ids.is_empty());
        assert_eq!(none.total_count, 25);
    }
}
