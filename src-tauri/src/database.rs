use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tauri::{AppHandle, Manager};

use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;

type DbPool = Pool<SqliteConnectionManager>;

static DB_POOL: OnceLock<DbPool> = OnceLock::new();

const DB_FILE_NAME: &str = "theorem.db";
const MATERIALIZED_BOOK_CACHE_DIR: &str = "book-cache";

#[derive(Serialize)]
pub struct SqliteStorageStats {
    pub total_books: u64,
    pub total_size: u64,
    pub covers_size: u64,
    pub binaries_size: u64,
    pub blob_entries: u64,
    pub blob_size: u64,
    pub idb_books: u64,
    pub tauri_books: u64,
}

#[derive(Serialize)]
pub struct SqliteCleanupResult {
    pub removed_books: u64,
    pub removed_covers: u64,
    pub removed_metadata: u64,
}

#[derive(Serialize)]
pub struct SqliteBlobStats {
    pub count: u64,
    pub total_size: u64,
}

fn database_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve app data directory: {error}"))?;

    fs::create_dir_all(&app_data_dir).map_err(|error| {
        format!("Failed to create app data directory '{app_data_dir:?}': {error}")
    })?;

    Ok(app_data_dir.join(DB_FILE_NAME))
}

fn materialized_book_path_in_dir(app_data_dir: &Path, book_id: &str) -> PathBuf {
    app_data_dir
        .join(MATERIALIZED_BOOK_CACHE_DIR)
        .join(format!("{book_id}.book"))
}

pub(crate) fn materialized_book_path(app: &AppHandle, book_id: &str) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve app data directory: {error}"))?;
    let cache_dir = app_data_dir.join(MATERIALIZED_BOOK_CACHE_DIR);
    fs::create_dir_all(&cache_dir).map_err(|error| {
        format!("Failed to create materialized cache directory '{cache_dir:?}': {error}")
    })?;

    Ok(materialized_book_path_in_dir(&app_data_dir, book_id))
}

fn remove_materialized_cache_file(app: &AppHandle, book_id: &str) {
    if let Ok(path) = materialized_book_path(app, book_id) {
        let _ = fs::remove_file(path);
    }
}

pub fn run_schema_migrations(app: &AppHandle) -> Result<(), String> {
    let db_path = database_path(app)?;
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data directory: {e}"))?;

    let conn = Connection::open(&db_path)
        .map_err(|e| format!("Failed to open database for migration: {e}"))?;
    conn.execute_batch(DB_SCHEMA_PERSISTENT_PRAGMAS)
        .map_err(|e| format!("Failed to run schema migrations: {e}"))?;
    conn.execute_batch(DB_PER_CONNECTION_PRAGMAS)
        .map_err(|e| format!("Failed to set connection PRAGMAs: {e}"))?;

    let has_data: bool = conn
        .query_row(
            "SELECT COUNT(*) > 0 FROM pragma_table_info('covers') WHERE name = 'data'",
            [],
            |row| row.get(0),
        )
        .unwrap_or(false);
    if !has_data {
        conn.execute_batch("ALTER TABLE covers ADD COLUMN data BLOB;")
            .ok();
    }

    // The covers.data column is legacy: cover bytes were mirrored there as a
    // decoded copy of data_url, but nothing ever read it. Clear any leftover
    // values so the base64 data_url is the single cover store.
    if let Err(e) = conn.execute("UPDATE covers SET data = NULL WHERE data IS NOT NULL", []) {
        eprintln!("[database] Failed to clear legacy covers.data: {e}");
    }

    // Book bytes live in `book-cache/{id}.book`. Legacy installs also stored a
    // full copy in `books.data`; zero those out (re-materializing the cache file
    // first when needed) so each book is stored exactly once.
    let reclaimed_books = reclaim_legacy_book_blobs(&conn, &app_data_dir)?;
    if reclaimed_books > 0 {
        eprintln!("[database] Reclaimed legacy book BLOBs for {reclaimed_books} books");
    }

    // StarDict dictionaries are now loaded directly from disk files via mmap in stardict.rs.
    // Ensure any unmaterialized dictionary BLOBs are extracted to disk before reclaiming.
    let reclaimed_dicts = reclaim_legacy_stardict_blobs(&conn, &app_data_dir)?;
    if reclaimed_dicts > 0 {
        eprintln!("[database] Reclaimed legacy StarDict BLOBs ({reclaimed_dicts} entries)");
    }

    if reclaimed_books > 0 || reclaimed_dicts > 0 {
        if let Err(e) = conn.execute_batch("VACUUM") {
            eprintln!("[database] VACUUM after blob reclaim failed: {e}");
        }
    }

    run_v153_database_migrations(&conn)
        .map_err(|e| format!("Failed to run v1.5.3 migrations: {e}"))?;

    run_v154_database_migrations(&conn)
        .map_err(|e| format!("Failed to run v1.5.4 migrations: {e}"))?;

    Ok(())
}

fn reclaim_legacy_stardict_blobs(
    connection: &Connection,
    app_data_dir: &Path,
) -> Result<usize, String> {
    let ifo_keys: Vec<String> = {
        let mut statement = connection
            .prepare("SELECT key FROM blob_store WHERE key LIKE 'theorem-stardict:%:ifo'")
            .map_err(|e| format!("Failed to prepare stardict query: {e}"))?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| format!("Failed to query stardict keys: {e}"))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| format!("Failed to read stardict keys: {e}"))?
    };

    let mut reclaimed = 0;
    for ifo_key in ifo_keys {
        let parts: Vec<&str> = ifo_key.split(':').collect();
        if parts.len() != 3 {
            continue;
        }
        let dict_id = parts[1];
        let dict_dir = app_data_dir.join("dictionaries").join(dict_id);

        if !crate::stardict::is_valid_stardict_dir(&dict_dir) {
            let idx_key = format!("theorem-stardict:{dict_id}:idx");
            let dict_key = format!("theorem-stardict:{dict_id}:dict");
            let syn_key = format!("theorem-stardict:{dict_id}:syn");

            let ifo_blob: Option<Vec<u8>> = connection
                .query_row(
                    "SELECT value FROM blob_store WHERE key = ?1",
                    params![&ifo_key],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|e| format!("Failed to read ifo blob: {e}"))?;
            let idx_blob: Option<Vec<u8>> = connection
                .query_row(
                    "SELECT value FROM blob_store WHERE key = ?1",
                    params![&idx_key],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|e| format!("Failed to read idx blob: {e}"))?;
            let dict_blob: Option<Vec<u8>> = connection
                .query_row(
                    "SELECT value FROM blob_store WHERE key = ?1",
                    params![&dict_key],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|e| format!("Failed to read dict blob: {e}"))?;
            let syn_blob: Option<Vec<u8>> = connection
                .query_row(
                    "SELECT value FROM blob_store WHERE key = ?1",
                    params![&syn_key],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|e| format!("Failed to read syn blob: {e}"))?;

            let (Some(ifo), Some(idx), Some(dict)) = (ifo_blob, idx_blob, dict_blob) else {
                eprintln!("[database] StarDict dictionary {dict_id} has incomplete blobs, skipping reclaim");
                continue;
            };

            if let Err(e) = fs::create_dir_all(&dict_dir) {
                eprintln!("[database] Failed to create dictionary dir for {dict_id}: {e}");
                continue;
            }

            if let Err(e) = fs::write(dict_dir.join("dict.ifo"), &ifo) {
                eprintln!("[database] Failed to write dict.ifo for {dict_id}: {e}");
                continue;
            }
            if let Err(e) = fs::write(dict_dir.join("dict.idx"), &idx) {
                eprintln!("[database] Failed to write dict.idx for {dict_id}: {e}");
                continue;
            }
            if let Err(e) = fs::write(dict_dir.join("dict.dict.dz"), &dict) {
                eprintln!("[database] Failed to write dict.dict.dz for {dict_id}: {e}");
                continue;
            }
            if let Some(syn) = syn_blob {
                let _ = fs::write(dict_dir.join("dict.syn"), &syn);
            }
        }

        if crate::stardict::is_valid_stardict_dir(&dict_dir) {
            let deleted = connection
                .execute(
                    "DELETE FROM blob_store WHERE key LIKE ?1",
                    params![format!("theorem-stardict:{dict_id}:%")],
                )
                .map_err(|e| format!("Failed to delete blobs for {dict_id}: {e}"))?;
            reclaimed += deleted;
        }
    }

    Ok(reclaimed)
}

fn reclaim_legacy_book_blobs(
    connection: &Connection,
    app_data_dir: &Path,
) -> Result<usize, String> {
    // Collect only ids first so the BLOBs are read one at a time below; reading
    // every legacy book into memory at once could OOM large libraries.
    let legacy_ids: Vec<String> = {
        let mut statement = connection
            .prepare("SELECT id FROM books WHERE length(data) > 0")
            .map_err(|e| format!("Failed to prepare legacy blob query: {e}"))?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| format!("Failed to query legacy book blobs: {e}"))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| format!("Failed to read legacy book ids: {e}"))?
    };

    let mut reclaimed = 0;
    for id in legacy_ids {
        let blob_data: Vec<u8> = connection
            .query_row("SELECT data FROM books WHERE id = ?1", params![id], |row| {
                row.get(0)
            })
            .map_err(|e| format!("Failed to read legacy blob for {id}: {e}"))?;
        if blob_data.is_empty() {
            continue;
        }
        let cache_path = materialized_book_path_in_dir(app_data_dir, &id);
        if !cache_path.exists() {
            let cache_dir = cache_path.parent().unwrap_or(app_data_dir);
            if let Err(e) = fs::create_dir_all(cache_dir) {
                eprintln!("[database] Failed to create cache dir for {id}: {e}");
                continue;
            }
            if let Err(e) = fs::write(&cache_path, &blob_data) {
                eprintln!("[database] Failed to re-materialize cache file for {id}: {e}");
                continue;
            }
        }
        connection
            .execute("UPDATE books SET data = X'' WHERE id = ?1", params![id])
            .map_err(|e| format!("Failed to zero legacy blob for {id}: {e}"))?;
        reclaimed += 1;
    }

    Ok(reclaimed)
}

#[cfg(target_os = "android")]
const DB_POOL_MAX_SIZE: u32 = 2;
#[cfg(not(target_os = "android"))]
const DB_POOL_MAX_SIZE: u32 = 4;

fn init_db_pool(db_path: &Path) -> Result<&DbPool, String> {
    if let Some(pool) = DB_POOL.get() {
        return Ok(pool);
    }

    let manager = SqliteConnectionManager::file(db_path);
    let pool = Pool::builder()
        .max_size(DB_POOL_MAX_SIZE)
        .connection_customizer(Box::new(SqlitePerConnectionPragmas))
        .build(manager)
        .map_err(|error| format!("Failed to create SQLite connection pool: {error}"))?;

    DB_POOL.set(pool).ok();
    DB_POOL
        .get()
        .ok_or_else(|| "Failed to initialize database pool".into())
}

const DB_SCHEMA_PERSISTENT_PRAGMAS: &str = r#"
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS books (
        id TEXT PRIMARY KEY,
        data BLOB NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS covers (
        book_id TEXT PRIMARY KEY,
        data_url TEXT NOT NULL,
        data BLOB,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        FOREIGN KEY(book_id) REFERENCES books(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS kv_store (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS blob_store (
        key TEXT PRIMARY KEY,
        data BLOB NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS materialized_books (
        book_id TEXT PRIMARY KEY,
        source_updated_at INTEGER NOT NULL,
        materialized_at INTEGER NOT NULL DEFAULT (unixepoch()),
        FOREIGN KEY(book_id) REFERENCES books(id) ON DELETE CASCADE
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS books_fts USING fts5(
        id UNINDEXED,
        title,
        author
    );

    -- Indexes for query performance
    CREATE INDEX IF NOT EXISTS idx_covers_book_id ON covers(book_id);

    CREATE TABLE IF NOT EXISTS book_metadata (
        book_id TEXT PRIMARY KEY,
        metadata_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        FOREIGN KEY(book_id) REFERENCES books(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS book_annotations (
        id TEXT PRIMARY KEY,
        book_id TEXT NOT NULL,
        annotation_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        FOREIGN KEY(book_id) REFERENCES books(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_book_annotations_book_id
        ON book_annotations(book_id);

    CREATE TABLE IF NOT EXISTS rss_feeds (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        site_url TEXT,
        description TEXT,
        icon_url TEXT,
        last_fetched INTEGER,
        added_at INTEGER NOT NULL,
        error_message TEXT,
        unread_count INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS rss_articles (
        id TEXT PRIMARY KEY,
        feed_id TEXT NOT NULL,
        title TEXT NOT NULL,
        author TEXT,
        url TEXT NOT NULL,
        summary TEXT,
        content_source TEXT,
        image_url TEXT,
        published_at INTEGER,
        fetched_at INTEGER NOT NULL,
        is_read INTEGER NOT NULL DEFAULT 0,
        is_favorite INTEGER NOT NULL DEFAULT 0,
        progress REAL,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        FOREIGN KEY(feed_id) REFERENCES rss_feeds(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_rss_articles_feed_id ON rss_articles(feed_id);
    CREATE INDEX IF NOT EXISTS idx_rss_articles_published_at ON rss_articles(published_at);

    CREATE TABLE IF NOT EXISTS rss_article_content (
        article_id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        full_content TEXT,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        FOREIGN KEY(article_id) REFERENCES rss_articles(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS reading_sessions (
        id TEXT PRIMARY KEY,
        book_id TEXT,
        session_date TEXT NOT NULL,
        minutes REAL NOT NULL,
        books_read_json TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_reading_sessions_date ON reading_sessions(session_date);
    CREATE INDEX IF NOT EXISTS idx_reading_sessions_book_id ON reading_sessions(book_id);

    CREATE TABLE IF NOT EXISTS vocabulary (
        id TEXT PRIMARY KEY,
        term TEXT NOT NULL,
        normalized_term TEXT NOT NULL,
        language TEXT NOT NULL,
        phonetic TEXT,
        audio_url TEXT,
        meanings_json TEXT NOT NULL,
        provider_history_json TEXT NOT NULL,
        source_book_id TEXT,
        context_sentence TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_vocabulary_term ON vocabulary(normalized_term, language);
    CREATE INDEX IF NOT EXISTS idx_vocabulary_created_at ON vocabulary(created_at DESC);
"#;

#[cfg(target_os = "android")]
const DB_PER_CONNECTION_PRAGMAS: &str = r#"
    PRAGMA busy_timeout = 5000;
    PRAGMA cache_size = -2000;
    PRAGMA mmap_size = 33554432;
    PRAGMA temp_store = MEMORY;
    PRAGMA journal_size_limit = 16777216;
"#;

#[cfg(not(target_os = "android"))]
const DB_PER_CONNECTION_PRAGMAS: &str = r#"
    PRAGMA busy_timeout = 5000;
    PRAGMA cache_size = -8000;
    PRAGMA mmap_size = 268435456;
    PRAGMA temp_store = MEMORY;
    PRAGMA journal_size_limit = 67108864;
"#;

#[derive(Debug)]
struct SqlitePerConnectionPragmas;

impl r2d2::CustomizeConnection<Connection, rusqlite::Error> for SqlitePerConnectionPragmas {
    fn on_acquire(&self, conn: &mut Connection) -> Result<(), rusqlite::Error> {
        conn.execute_batch(DB_PER_CONNECTION_PRAGMAS)
    }
}

pub fn with_connection<T, F>(app: &AppHandle, operation: F) -> Result<T, String>
where
    F: FnOnce(&Connection) -> rusqlite::Result<T>,
{
    let db_path = database_path(app)?;
    let pool = init_db_pool(&db_path)?;
    let connection = pool
        .get()
        .map_err(|error| format!("Failed to acquire SQLite connection from pool: {error}"))?;

    operation(&connection).map_err(|error| format!("SQLite operation failed: {error}"))
}

#[tauri::command]
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

#[tauri::command]
pub fn sqlite_register_materialized_book(app: AppHandle, id: String) -> Result<(), String> {
    with_connection(&app, |connection| {
        sqlite_register_materialized_book_inner(connection, &id)
    })
}

#[tauri::command]
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

#[tauri::command]
pub fn sqlite_delete_book_data(app: AppHandle, id: String) -> Result<(), String> {
    remove_materialized_cache_file(&app, &id);

    with_connection(&app, |connection| {
        connection.execute(
            "DELETE FROM materialized_books WHERE book_id = ?1",
            params![id],
        )?;
        connection.execute("DELETE FROM books WHERE id = ?1", params![id])?;
        Ok(())
    })
}

#[tauri::command]
pub fn sqlite_get_materialized_book_path(
    app: AppHandle,
    id: String,
) -> Result<Option<String>, String> {
    let materialized_path = materialized_book_path(&app, &id)?;

    if materialized_path.exists() {
        return Ok(Some(materialized_path.to_string_lossy().into_owned()));
    }

    let data = with_connection(&app, |connection| {
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

            let _ = with_connection(&app, |connection| {
                connection.execute("UPDATE books SET data = X'' WHERE id = ?1", params![id])
            });

            return Ok(Some(materialized_path.to_string_lossy().into_owned()));
        }
    }

    Ok(None)
}

pub fn sqlite_save_cover_image_inner(
    connection: &Connection,
    book_id: &str,
    data_url: &str,
) -> rusqlite::Result<()> {
    connection.execute(
        r#"
        INSERT INTO covers (book_id, data_url, data, updated_at)
        VALUES (?1, ?2, NULL, unixepoch())
        ON CONFLICT(book_id) DO UPDATE SET
            data_url = excluded.data_url,
            data = NULL,
            updated_at = unixepoch()
        "#,
        params![book_id, data_url],
    )?;
    Ok(())
}

#[tauri::command]
pub fn sqlite_save_cover_image(
    app: AppHandle,
    book_id: String,
    data_url: String,
) -> Result<(), String> {
    with_connection(&app, |connection| {
        sqlite_save_cover_image_inner(connection, &book_id, &data_url)
    })
}

pub fn sqlite_get_cover_image_inner(
    connection: &Connection,
    book_id: &str,
) -> rusqlite::Result<Option<String>> {
    connection
        .query_row(
            "SELECT data_url FROM covers WHERE book_id = ?1",
            params![book_id],
            |row| row.get(0),
        )
        .optional()
}

#[tauri::command]
pub fn sqlite_get_cover_image(app: AppHandle, book_id: String) -> Result<Option<String>, String> {
    with_connection(&app, |connection| {
        sqlite_get_cover_image_inner(connection, &book_id)
    })
}

pub fn sqlite_delete_cover_image_inner(
    connection: &Connection,
    book_id: &str,
) -> rusqlite::Result<()> {
    connection.execute("DELETE FROM covers WHERE book_id = ?1", params![book_id])?;
    Ok(())
}

#[tauri::command]
pub fn sqlite_delete_cover_image(app: AppHandle, book_id: String) -> Result<(), String> {
    with_connection(&app, |connection| {
        sqlite_delete_cover_image_inner(connection, &book_id)
    })
}

#[tauri::command]
pub fn sqlite_get_storage_stats(app: AppHandle) -> Result<SqliteStorageStats, String> {
    let mut binaries_size = 0;

    let cache_dir = app
        .path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join(MATERIALIZED_BOOK_CACHE_DIR));

    if let Some(path) = cache_dir {
        if let Ok(entries) = std::fs::read_dir(path) {
            for entry in entries.flatten() {
                if let Ok(metadata) = entry.metadata() {
                    binaries_size += metadata.len();
                }
            }
        }
    }

    with_connection(&app, |connection| {
        let (total_books, legacy_binaries_size): (u64, u64) = connection.query_row(
            "SELECT COUNT(*) AS total_books, COALESCE(SUM(length(data)), 0) AS legacy_binaries_size FROM books",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;

        let covers_size: u64 = connection.query_row(
            "SELECT COALESCE(SUM(length(data_url)), 0) FROM covers",
            [],
            |row| row.get(0),
        )?;

        let (blob_entries, blob_size): (u64, u64) = connection.query_row(
            "SELECT COUNT(*) AS blob_entries, COALESCE(SUM(length(data)), 0) AS blob_size FROM blob_store",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;

        let total_binaries_size = binaries_size + legacy_binaries_size;

        Ok(SqliteStorageStats {
            total_books,
            total_size: total_binaries_size
                .saturating_add(covers_size)
                .saturating_add(blob_size),
            covers_size,
            binaries_size: total_binaries_size,
            blob_entries,
            blob_size,
            idb_books: 0,
            tauri_books: total_books,
        })
    })
}

#[tauri::command]
pub fn sqlite_cleanup_orphaned_storage(
    app: AppHandle,
    existing_book_ids: Vec<String>,
) -> Result<SqliteCleanupResult, String> {
    with_connection(&app, |connection| {
        let existing_ids: HashSet<String> = existing_book_ids.into_iter().collect();

        let mut removed_books = 0_u64;
        let mut removed_covers = 0_u64;

        let existing_rows: Vec<String> = {
            let mut statement = connection.prepare("SELECT id FROM books")?;
            let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
            rows.collect::<rusqlite::Result<Vec<String>>>()?
        };

        for id in existing_rows {
            if !existing_ids.contains(&id) {
                remove_materialized_cache_file(&app, &id);
                let affected =
                    connection.execute("DELETE FROM books WHERE id = ?1", params![id])?;
                removed_books = removed_books.saturating_add(affected as u64);
            }
        }

        let existing_cover_rows: Vec<String> = {
            let mut statement = connection.prepare("SELECT book_id FROM covers")?;
            let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
            rows.collect::<rusqlite::Result<Vec<String>>>()?
        };

        for id in existing_cover_rows {
            if !existing_ids.contains(&id) {
                let affected =
                    connection.execute("DELETE FROM covers WHERE book_id = ?1", params![id])?;
                removed_covers = removed_covers.saturating_add(affected as u64);
            }
        }

        Ok(SqliteCleanupResult {
            removed_books,
            removed_covers,
            removed_metadata: 0,
        })
    })
}

pub fn sqlite_clear_all_storage_inner(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute("DELETE FROM covers", [])?;
    connection.execute("DELETE FROM materialized_books", [])?;
    connection.execute("DELETE FROM books", [])?;
    connection.execute("DELETE FROM blob_store", [])?;
    connection.execute("DELETE FROM kv_store", [])?;
    Ok(())
}

#[tauri::command]
pub fn sqlite_clear_all_storage(app: AppHandle) -> Result<(), String> {
    let cache_dir = app
        .path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join(MATERIALIZED_BOOK_CACHE_DIR));

    if let Some(path) = cache_dir {
        let _ = fs::remove_dir_all(path);
    }

    with_connection(&app, |connection| {
        sqlite_clear_all_storage_inner(connection)
    })
}

pub fn sqlite_get_kv_inner(connection: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    connection
        .query_row(
            "SELECT value FROM kv_store WHERE key = ?1",
            params![key],
            |row| row.get(0),
        )
        .optional()
}

#[tauri::command]
pub fn sqlite_get_kv(app: AppHandle, key: String) -> Result<Option<String>, String> {
    with_connection(&app, |connection| sqlite_get_kv_inner(connection, &key))
}

#[derive(Serialize)]
pub struct GoalReminderData {
    pub today_minutes: u64,
    pub daily_goal: u64,
}

pub fn check_goal_reminder_inner(
    connection: &Connection,
) -> rusqlite::Result<Option<GoalReminderData>> {
    fn parse_error(msg: impl std::fmt::Display) -> rusqlite::Error {
        rusqlite::Error::InvalidParameterName(msg.to_string())
    }

    let json_str = match sqlite_get_kv_inner(connection, "zustand:theorem-settings")? {
        Some(s) => s,
        None => return Ok(None),
    };

    let parsed: serde_json::Value = serde_json::from_str(&json_str)
        .map_err(|e| parse_error(format!("Failed to parse settings JSON: {e}")))?;

    let stats = &parsed["state"]["stats"];
    let daily_goal = stats["dailyGoal"].as_u64().unwrap_or(30);

    let today = {
        let duration = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap();
        let secs = duration.as_secs();
        let days = secs / 86400;
        let z = days + 719468;
        let era = z / 146097;
        let doe = z - era * 146097;
        let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
        let y = yoe + era * 400;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let d = doy - (153 * mp + 2) / 5 + 1;
        let m = if mp < 10 { mp + 3 } else { mp - 9 };
        let y = if m <= 2 { y + 1 } else { y };
        format!("{:04}-{:02}-{:02}", y, m, d)
    };

    let today_session_minutes: Option<f64> = connection
        .query_row(
            "SELECT SUM(minutes) FROM reading_sessions WHERE session_date = ?1",
            params![today],
            |row| row.get::<_, Option<f64>>(0),
        )
        .optional()
        .unwrap_or(None)
        .flatten();

    let today_minutes = if let Some(min) = today_session_minutes {
        min as u64
    } else {
        stats["dailyActivity"]
            .as_array()
            .and_then(|arr| arr.iter().find(|a| a["date"].as_str() == Some(&today)))
            .map(|a| a["minutes"].as_u64().unwrap_or(0))
            .unwrap_or(0)
    };

    Ok(Some(GoalReminderData {
        today_minutes,
        daily_goal,
    }))
}

#[tauri::command]
pub fn sqlite_check_goal_reminder(app: AppHandle) -> Result<Option<GoalReminderData>, String> {
    with_connection(&app, check_goal_reminder_inner)
}

pub fn sqlite_batch_get_kv_inner(
    connection: &Connection,
    keys: &[String],
) -> rusqlite::Result<Vec<(String, String)>> {
    if keys.is_empty() {
        return Ok(Vec::new());
    }

    let placeholders: Vec<String> = keys
        .iter()
        .enumerate()
        .map(|(i, _)| format!("?{}", i + 1))
        .collect();
    let sql = format!(
        "SELECT key, value FROM kv_store WHERE key IN ({})",
        placeholders.join(", ")
    );

    let mut stmt = connection.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(keys.iter()), |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;

    rows.collect::<rusqlite::Result<Vec<(String, String)>>>()
}

#[tauri::command]
pub fn sqlite_batch_get_kv(
    app: AppHandle,
    keys: Vec<String>,
) -> Result<Vec<(String, String)>, String> {
    with_connection(&app, |connection| {
        sqlite_batch_get_kv_inner(connection, &keys)
    })
}

pub fn sqlite_set_kv_inner(
    connection: &Connection,
    key: &str,
    value: &str,
) -> rusqlite::Result<()> {
    connection.execute(
        r#"
        INSERT INTO kv_store (key, value, updated_at)
        VALUES (?1, ?2, unixepoch())
        ON CONFLICT(key) DO UPDATE SET
            value = excluded.value,
            updated_at = unixepoch()
        "#,
        params![key, value],
    )?;
    Ok(())
}

#[tauri::command]
pub fn sqlite_set_kv(app: AppHandle, key: String, value: String) -> Result<(), String> {
    with_connection(&app, |connection| {
        sqlite_set_kv_inner(connection, &key, &value)
    })
}

pub fn sqlite_delete_kv_inner(connection: &Connection, key: &str) -> rusqlite::Result<()> {
    connection.execute("DELETE FROM kv_store WHERE key = ?1", params![key])?;
    Ok(())
}

#[tauri::command]
pub fn sqlite_delete_kv(app: AppHandle, key: String) -> Result<(), String> {
    with_connection(&app, |connection| sqlite_delete_kv_inner(connection, &key))
}

pub fn sqlite_count_kv_by_prefix_inner(
    connection: &Connection,
    prefix: &str,
) -> rusqlite::Result<u64> {
    connection.query_row(
        "SELECT COUNT(*) FROM kv_store WHERE key LIKE ?1 || '%'",
        params![prefix],
        |row| row.get(0),
    )
}

#[tauri::command]
pub fn sqlite_count_kv_by_prefix(app: AppHandle, prefix: String) -> Result<u64, String> {
    with_connection(&app, |connection| {
        sqlite_count_kv_by_prefix_inner(connection, &prefix)
    })
}

pub fn sqlite_delete_kv_by_prefix_inner(
    connection: &Connection,
    prefix: &str,
) -> rusqlite::Result<u64> {
    let affected = connection.execute(
        "DELETE FROM kv_store WHERE key LIKE ?1 || '%'",
        params![prefix],
    )?;
    Ok(affected as u64)
}

#[tauri::command]
pub fn sqlite_delete_kv_by_prefix(app: AppHandle, prefix: String) -> Result<u64, String> {
    with_connection(&app, |connection| {
        sqlite_delete_kv_by_prefix_inner(connection, &prefix)
    })
}

pub fn sqlite_set_blob_inner(
    connection: &Connection,
    key: &str,
    data: &[u8],
) -> rusqlite::Result<()> {
    connection.execute(
        r#"
        INSERT INTO blob_store (key, data, updated_at)
        VALUES (?1, ?2, unixepoch())
        ON CONFLICT(key) DO UPDATE SET
            data = excluded.data,
            updated_at = unixepoch()
        "#,
        params![key, data],
    )?;
    Ok(())
}

#[tauri::command]
pub fn sqlite_set_blob(app: AppHandle, key: String, data: Vec<u8>) -> Result<(), String> {
    with_connection(&app, |connection| {
        sqlite_set_blob_inner(connection, &key, &data)
    })
}

pub fn sqlite_get_blob_inner(
    connection: &Connection,
    key: &str,
) -> rusqlite::Result<Option<Vec<u8>>> {
    connection
        .query_row(
            "SELECT data FROM blob_store WHERE key = ?1",
            params![key],
            |row| row.get(0),
        )
        .optional()
}

#[tauri::command]
pub fn sqlite_get_blob(app: AppHandle, key: String) -> Result<Option<Vec<u8>>, String> {
    with_connection(&app, |connection| sqlite_get_blob_inner(connection, &key))
}

pub fn sqlite_delete_blob_inner(connection: &Connection, key: &str) -> rusqlite::Result<()> {
    connection.execute("DELETE FROM blob_store WHERE key = ?1", params![key])?;
    Ok(())
}

#[tauri::command]
pub fn sqlite_delete_blob(app: AppHandle, key: String) -> Result<(), String> {
    with_connection(&app, |connection| {
        sqlite_delete_blob_inner(connection, &key)
    })
}

pub fn sqlite_delete_blobs_by_prefix_inner(
    connection: &Connection,
    prefix: &str,
) -> rusqlite::Result<u64> {
    let affected = connection.execute(
        "DELETE FROM blob_store WHERE key LIKE ?1 || '%'",
        params![prefix],
    )?;
    Ok(affected as u64)
}

#[tauri::command]
pub fn sqlite_delete_blobs_by_prefix(app: AppHandle, prefix: String) -> Result<u64, String> {
    with_connection(&app, |connection| {
        sqlite_delete_blobs_by_prefix_inner(connection, &prefix)
    })
}

pub fn sqlite_get_blob_stats_inner(
    connection: &Connection,
    prefix: Option<String>,
) -> rusqlite::Result<SqliteBlobStats> {
    let (count, total_size): (u64, u64) = if let Some(prefix) = prefix {
        connection.query_row(
            "SELECT COUNT(*), COALESCE(SUM(length(data)), 0) FROM blob_store WHERE key LIKE ?1 || '%'",
            params![prefix],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?
    } else {
        connection.query_row(
            "SELECT COUNT(*), COALESCE(SUM(length(data)), 0) FROM blob_store",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?
    };

    Ok(SqliteBlobStats { count, total_size })
}

#[tauri::command]
pub fn sqlite_get_blob_stats(
    app: AppHandle,
    prefix: Option<String>,
) -> Result<SqliteBlobStats, String> {
    with_connection(&app, |connection| {
        sqlite_get_blob_stats_inner(connection, prefix)
    })
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

#[tauri::command]
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

#[tauri::command]
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

#[tauri::command]
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
        "INSERT INTO book_metadata(book_id, metadata_json, updated_at) VALUES(?1, ?2, unixepoch())
         ON CONFLICT(book_id) DO UPDATE SET metadata_json = ?2, updated_at = unixepoch()",
        params![book_id, metadata_json],
    )?;
    Ok(())
}

#[tauri::command]
pub fn sqlite_save_book_metadata(
    app: AppHandle,
    book_id: String,
    metadata_json: String,
) -> Result<(), String> {
    with_connection(&app, |connection| {
        sqlite_save_book_metadata_inner(connection, &book_id, &metadata_json)
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

#[tauri::command]
pub fn sqlite_get_book_metadata(app: AppHandle, book_id: String) -> Result<Option<String>, String> {
    with_connection(&app, |connection| {
        sqlite_get_book_metadata_inner(connection, &book_id)
    })
}

pub fn sqlite_save_book_annotations_inner(
    connection: &Connection,
    book_id: &str,
    annotations_json: &[String],
) -> rusqlite::Result<()> {
    connection.execute(
        "DELETE FROM book_annotations WHERE book_id = ?1",
        params![book_id],
    )?;
    for (i, ann_json) in annotations_json.iter().enumerate() {
        let id: String = serde_json::from_str::<serde_json::Value>(ann_json)
            .ok()
            .and_then(|v| {
                v.get("id")
                    .and_then(|id_val| id_val.as_str())
                    .map(String::from)
            })
            .unwrap_or_else(|| format!("auto:{}:{}", book_id, i));
        connection.execute(
            "INSERT INTO book_annotations(id, book_id, annotation_json, updated_at) VALUES(?1, ?2, ?3, unixepoch())",
            params![id, book_id, ann_json],
        )?;
    }
    Ok(())
}

#[tauri::command]
pub fn sqlite_save_book_annotations(
    app: AppHandle,
    book_id: String,
    annotations_json: Vec<String>,
) -> Result<(), String> {
    with_connection(&app, |connection| {
        sqlite_save_book_annotations_inner(connection, &book_id, &annotations_json)
    })
}

pub fn sqlite_get_book_annotations_inner(
    connection: &Connection,
    book_id: &str,
) -> rusqlite::Result<Vec<String>> {
    let mut stmt = connection.prepare(
        "SELECT annotation_json FROM book_annotations WHERE book_id = ?1 ORDER BY updated_at",
    )?;
    let rows = stmt.query_map(params![book_id], |row| row.get::<_, String>(0))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
}

#[tauri::command]
pub fn sqlite_get_book_annotations(app: AppHandle, book_id: String) -> Result<Vec<String>, String> {
    with_connection(&app, |connection| {
        sqlite_get_book_annotations_inner(connection, &book_id)
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncMergeResult {
    pub domains_updated: Vec<String>,
    pub books_count: usize,
    pub annotations_count: usize,
}

pub fn sqlite_merge_sync_entries_inner(
    connection: &Connection,
    entries: std::collections::HashMap<String, String>,
) -> rusqlite::Result<SyncMergeResult> {
    let mut domains_updated: Vec<String> = Vec::new();
    let mut books_count = 0usize;
    let mut annotations_count = 0usize;

    // 1. Process tombstones first if present
    if let Some(tombstones_json) = entries.get("deletion_tombstones") {
        if let Ok(tombstones) = serde_json::from_str::<Vec<serde_json::Value>>(tombstones_json) {
            for ts in &tombstones {
                let id = ts.get("id").and_then(|v| v.as_str()).unwrap_or("");
                let entity_type = ts.get("entityType").and_then(|v| v.as_str()).unwrap_or("");
                if id.is_empty() {
                    continue;
                }
                match entity_type {
                    "book" => {
                        let _ = connection.execute("DELETE FROM books WHERE id = ?1", params![id]);
                        let _ = connection
                            .execute("DELETE FROM book_metadata WHERE book_id = ?1", params![id]);
                        let _ =
                            connection.execute("DELETE FROM books_fts WHERE id = ?1", params![id]);
                        let _ = connection.execute(
                            "DELETE FROM book_annotations WHERE book_id = ?1",
                            params![id],
                        );
                    }
                    "annotation" => {
                        let _ = connection
                            .execute("DELETE FROM book_annotations WHERE id = ?1", params![id]);
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
            if let Ok(book_val) = serde_json::from_str::<serde_json::Value>(value) {
                let title = book_val.get("title").and_then(|v| v.as_str()).unwrap_or("");
                let author = book_val.get("author").and_then(|v| v.as_str());

                connection.execute(
                    "INSERT OR IGNORE INTO books(id, data, updated_at) VALUES(?1, X'', unixepoch())",
                    params![book_id],
                )?;

                connection.execute(
                    "INSERT INTO book_metadata(book_id, metadata_json, updated_at) VALUES(?1, ?2, unixepoch()) ON CONFLICT(book_id) DO UPDATE SET metadata_json = excluded.metadata_json, updated_at = unixepoch()",
                    params![book_id, value],
                )?;

                let _ = connection.execute("DELETE FROM books_fts WHERE id = ?1", params![book_id]);
                let _ = connection.execute(
                    "INSERT INTO books_fts(id, title, author) VALUES(?1, ?2, ?3)",
                    params![book_id, title, author],
                );

                books_count += 1;
                record_domain("books");
            }
        } else if key == "books" {
            if let Ok(books_vec) = serde_json::from_str::<Vec<serde_json::Value>>(value) {
                for b in &books_vec {
                    if let Some(book_id) = b.get("id").and_then(|v| v.as_str()) {
                        let title = b.get("title").and_then(|v| v.as_str()).unwrap_or("");
                        let author = b.get("author").and_then(|v| v.as_str());
                        let meta_json = serde_json::to_string(b).unwrap_or_default();

                        connection.execute(
                            "INSERT OR IGNORE INTO books(id, data, updated_at) VALUES(?1, X'', unixepoch())",
                            params![book_id],
                        )?;

                        connection.execute(
                            "INSERT INTO book_metadata(book_id, metadata_json, updated_at) VALUES(?1, ?2, unixepoch()) ON CONFLICT(book_id) DO UPDATE SET metadata_json = excluded.metadata_json, updated_at = unixepoch()",
                            params![book_id, meta_json],
                        )?;

                        let _ = connection
                            .execute("DELETE FROM books_fts WHERE id = ?1", params![book_id]);
                        let _ = connection.execute(
                            "INSERT INTO books_fts(id, title, author) VALUES(?1, ?2, ?3)",
                            params![book_id, title, author],
                        );
                        books_count += 1;
                    }
                }
                if !books_vec.is_empty() {
                    record_domain("books");
                }
            }
        } else if key.starts_with("anno:") || key.starts_with("annotation:") {
            if let Ok(ann_val) = serde_json::from_str::<serde_json::Value>(value) {
                let id = ann_val
                    .get("id")
                    .and_then(|v| v.as_str())
                    .map(String::from)
                    .unwrap_or_else(|| key.clone());
                let book_id = ann_val
                    .get("bookId")
                    .or_else(|| ann_val.get("book_id"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");

                if !book_id.is_empty() {
                    connection.execute(
                        "INSERT OR IGNORE INTO books(id, data, updated_at) VALUES(?1, X'', unixepoch())",
                        params![book_id],
                    )?;

                    connection.execute(
                        "INSERT INTO book_annotations(id, book_id, annotation_json, updated_at) VALUES(?1, ?2, ?3, unixepoch()) ON CONFLICT(id) DO UPDATE SET annotation_json = excluded.annotation_json, updated_at = unixepoch()",
                        params![id, book_id, value],
                    )?;
                    annotations_count += 1;
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
                        if !book_id.is_empty() {
                            let ann_json = serde_json::to_string(a).unwrap_or_default();
                            connection.execute(
                                "INSERT OR IGNORE INTO books(id, data, updated_at) VALUES(?1, X'', unixepoch())",
                                params![book_id],
                            )?;
                            connection.execute(
                                "INSERT INTO book_annotations(id, book_id, annotation_json, updated_at) VALUES(?1, ?2, ?3, unixepoch()) ON CONFLICT(id) DO UPDATE SET annotation_json = excluded.annotation_json, updated_at = unixepoch()",
                                params![id, book_id, ann_json],
                            )?;
                            annotations_count += 1;
                        }
                    }
                }
                if !anns_vec.is_empty() {
                    record_domain("annotations");
                }
            }
        } else {
            connection.execute(
                "INSERT INTO kv_store(key, value, updated_at) VALUES(?1, ?2, unixepoch()) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()",
                params![key, value],
            )?;
            record_domain(key);
        }
    }

    Ok(SyncMergeResult {
        domains_updated,
        books_count,
        annotations_count,
    })
}

#[tauri::command]
pub fn sqlite_merge_sync_entries(
    app: AppHandle,
    entries: std::collections::HashMap<String, String>,
) -> Result<SyncMergeResult, String> {
    with_connection(&app, |connection| {
        sqlite_merge_sync_entries_inner(connection, entries)
    })
}

#[tauri::command]
pub fn sqlite_shrink_memory(app: AppHandle) -> Result<(), String> {
    with_connection(&app, |connection| {
        connection.execute_batch("PRAGMA shrink_memory;")
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookWindowResult {
    pub book_ids: Vec<String>,
    pub total_count: u32,
}

pub fn sqlite_query_books_window_inner(
    connection: &Connection,
    limit: u32,
    offset: u32,
) -> rusqlite::Result<BookWindowResult> {
    let total_count: u32 = connection
        .query_row("SELECT COUNT(*) FROM books_fts", [], |row| row.get(0))
        .unwrap_or(0);

    let mut stmt = connection.prepare("SELECT id FROM books_fts LIMIT ?1 OFFSET ?2")?;
    let rows = stmt.query_map(params![limit, offset], |row| row.get::<_, String>(0))?;

    let book_ids = rows.collect::<rusqlite::Result<Vec<String>>>()?;
    Ok(BookWindowResult {
        book_ids,
        total_count,
    })
}

#[tauri::command]
pub fn sqlite_query_books_window(
    app: AppHandle,
    limit: u32,
    offset: u32,
) -> Result<BookWindowResult, String> {
    with_connection(&app, |connection| {
        sqlite_query_books_window_inner(connection, limit, offset)
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RssFeedDto {
    pub id: Box<str>,
    pub title: Box<str>,
    pub url: Box<str>,
    pub site_url: Option<Box<str>>,
    pub description: Option<Box<str>>,
    pub icon_url: Option<Box<str>>,
    pub last_fetched: Option<i64>,
    pub added_at: Option<i64>,
    pub error_message: Option<Box<str>>,
    pub unread_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RssArticleDto {
    pub id: Box<str>,
    pub feed_id: Box<str>,
    pub title: Box<str>,
    pub author: Option<Box<str>>,
    pub url: Box<str>,
    pub summary: Option<Box<str>>,
    pub content_source: Option<Box<str>>,
    pub image_url: Option<Box<str>>,
    pub published_at: Option<i64>,
    pub fetched_at: Option<i64>,
    pub is_read: bool,
    pub is_favorite: bool,
    pub progress: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RssArticleContentDto {
    pub article_id: Box<str>,
    pub content: Box<str>,
    pub full_content: Option<Box<str>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadingSessionDto {
    pub id: Box<str>,
    pub book_id: Option<Box<str>>,
    pub session_date: Box<str>,
    pub minutes: f64,
    pub books_read_json: Option<Box<str>>,
    pub created_at: i64,
}

pub fn sqlite_get_rss_feeds_inner(connection: &Connection) -> rusqlite::Result<Vec<RssFeedDto>> {
    let mut stmt = connection.prepare(
        "SELECT id, title, url, site_url, description, icon_url, last_fetched, added_at, error_message, unread_count
         FROM rss_feeds ORDER BY added_at DESC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(RssFeedDto {
            id: row.get::<_, String>(0)?.into_boxed_str(),
            title: row.get::<_, String>(1)?.into_boxed_str(),
            url: row.get::<_, String>(2)?.into_boxed_str(),
            site_url: row.get::<_, Option<String>>(3)?.map(|s| s.into_boxed_str()),
            description: row.get::<_, Option<String>>(4)?.map(|s| s.into_boxed_str()),
            icon_url: row.get::<_, Option<String>>(5)?.map(|s| s.into_boxed_str()),
            last_fetched: row.get(6)?,
            added_at: row.get(7)?,
            error_message: row.get::<_, Option<String>>(8)?.map(|s| s.into_boxed_str()),
            unread_count: row.get(9)?,
        })
    })?;
    rows.collect()
}

#[tauri::command]
pub fn sqlite_get_rss_feeds(app: AppHandle) -> Result<Vec<RssFeedDto>, String> {
    with_connection(&app, sqlite_get_rss_feeds_inner)
}

pub fn sqlite_save_rss_feed_inner(
    connection: &Connection,
    feed: &RssFeedDto,
) -> rusqlite::Result<()> {
    connection.execute(
        r#"
        INSERT INTO rss_feeds (
            id, title, url, site_url, description, icon_url,
            last_fetched, added_at, error_message, unread_count, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, COALESCE(?8, unixepoch()), ?9, ?10, unixepoch())
        ON CONFLICT(id) DO UPDATE SET
            title = excluded.title,
            url = excluded.url,
            site_url = excluded.site_url,
            description = excluded.description,
            icon_url = excluded.icon_url,
            last_fetched = excluded.last_fetched,
            error_message = excluded.error_message,
            unread_count = excluded.unread_count,
            updated_at = unixepoch()
        "#,
        params![
            &feed.id,
            &feed.title,
            &feed.url,
            &feed.site_url,
            &feed.description,
            &feed.icon_url,
            feed.last_fetched,
            feed.added_at,
            &feed.error_message,
            feed.unread_count,
        ],
    )?;
    Ok(())
}

#[tauri::command]
pub fn sqlite_save_rss_feed(app: AppHandle, feed: RssFeedDto) -> Result<(), String> {
    with_connection(&app, |conn| sqlite_save_rss_feed_inner(conn, &feed))
}

pub fn sqlite_delete_rss_feed_inner(
    connection: &Connection,
    feed_id: &str,
) -> rusqlite::Result<()> {
    connection.execute(
        "DELETE FROM rss_article_content WHERE article_id IN (SELECT id FROM rss_articles WHERE feed_id = ?1)",
        params![feed_id],
    )?;
    connection.execute(
        "DELETE FROM rss_articles WHERE feed_id = ?1",
        params![feed_id],
    )?;
    connection.execute("DELETE FROM rss_feeds WHERE id = ?1", params![feed_id])?;
    Ok(())
}

#[tauri::command]
pub fn sqlite_delete_rss_feed(app: AppHandle, feed_id: String) -> Result<(), String> {
    with_connection(&app, |conn| sqlite_delete_rss_feed_inner(conn, &feed_id))
}

fn map_rss_article_row(row: &rusqlite::Row) -> rusqlite::Result<RssArticleDto> {
    let is_read_int: i32 = row.get(10)?;
    let is_fav_int: i32 = row.get(11)?;
    Ok(RssArticleDto {
        id: row.get::<_, String>(0)?.into_boxed_str(),
        feed_id: row.get::<_, String>(1)?.into_boxed_str(),
        title: row.get::<_, String>(2)?.into_boxed_str(),
        author: row.get::<_, Option<String>>(3)?.map(|s| s.into_boxed_str()),
        url: row.get::<_, String>(4)?.into_boxed_str(),
        summary: row.get::<_, Option<String>>(5)?.map(|s| s.into_boxed_str()),
        content_source: row.get::<_, Option<String>>(6)?.map(|s| s.into_boxed_str()),
        image_url: row.get::<_, Option<String>>(7)?.map(|s| s.into_boxed_str()),
        published_at: row.get(8)?,
        fetched_at: row.get(9)?,
        is_read: is_read_int != 0,
        is_favorite: is_fav_int != 0,
        progress: row.get(12)?,
    })
}

pub fn sqlite_get_rss_articles_inner(
    connection: &Connection,
    feed_id: Option<&str>,
    limit: Option<u32>,
    offset: Option<u32>,
) -> rusqlite::Result<Vec<RssArticleDto>> {
    let limit_val = limit.unwrap_or(100);
    let offset_val = offset.unwrap_or(0);

    let sql = if feed_id.is_some() {
        "SELECT id, feed_id, title, author, url, summary, content_source, image_url,
                published_at, fetched_at, is_read, is_favorite, progress
         FROM rss_articles
         WHERE feed_id = ?1
         ORDER BY fetched_at DESC LIMIT ?2 OFFSET ?3"
    } else {
        "SELECT id, feed_id, title, author, url, summary, content_source, image_url,
                published_at, fetched_at, is_read, is_favorite, progress
         FROM rss_articles
         ORDER BY fetched_at DESC LIMIT ?1 OFFSET ?2"
    };

    let mut stmt = connection.prepare(sql)?;
    let rows = if let Some(fid) = feed_id {
        stmt.query_map(params![fid, limit_val, offset_val], map_rss_article_row)?
    } else {
        stmt.query_map(params![limit_val, offset_val], map_rss_article_row)?
    };

    rows.collect()
}

#[tauri::command]
pub fn sqlite_get_rss_articles(
    app: AppHandle,
    feed_id: Option<String>,
    limit: Option<u32>,
    offset: Option<u32>,
) -> Result<Vec<RssArticleDto>, String> {
    with_connection(&app, |conn| {
        sqlite_get_rss_articles_inner(conn, feed_id.as_deref(), limit, offset)
    })
}

pub fn sqlite_get_rss_article_content_inner(
    connection: &Connection,
    article_id: &str,
) -> rusqlite::Result<Option<RssArticleContentDto>> {
    let mut stmt = connection.prepare(
        "SELECT article_id, content, full_content FROM rss_article_content WHERE article_id = ?1",
    )?;
    stmt.query_row(params![article_id], |row| {
        Ok(RssArticleContentDto {
            article_id: row.get::<_, String>(0)?.into_boxed_str(),
            content: row.get::<_, String>(1)?.into_boxed_str(),
            full_content: row.get::<_, Option<String>>(2)?.map(|s| s.into_boxed_str()),
        })
    })
    .optional()
}

#[tauri::command]
pub fn sqlite_get_rss_article_content(
    app: AppHandle,
    article_id: String,
) -> Result<Option<RssArticleContentDto>, String> {
    with_connection(&app, |conn| {
        sqlite_get_rss_article_content_inner(conn, &article_id)
    })
}

pub fn sqlite_save_rss_article_inner(
    connection: &Connection,
    article: &RssArticleDto,
    content: Option<&str>,
    full_content: Option<&str>,
) -> rusqlite::Result<()> {
    connection.execute(
        r#"
        INSERT INTO rss_articles (
            id, feed_id, title, author, url, summary,
            content_source, image_url, published_at, fetched_at,
            is_read, is_favorite, progress, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, COALESCE(?10, unixepoch()), ?11, ?12, ?13, unixepoch())
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
            is_read = excluded.is_read,
            is_favorite = excluded.is_favorite,
            progress = excluded.progress,
            updated_at = unixepoch()
        "#,
        params![
            &article.id,
            &article.feed_id,
            &article.title,
            &article.author,
            &article.url,
            &article.summary,
            &article.content_source,
            &article.image_url,
            article.published_at,
            article.fetched_at,
            if article.is_read { 1 } else { 0 },
            if article.is_favorite { 1 } else { 0 },
            article.progress,
        ],
    )?;

    if let Some(c) = content {
        connection.execute(
            r#"
            INSERT INTO rss_article_content (article_id, content, full_content, updated_at)
            VALUES (?1, ?2, ?3, unixepoch())
            ON CONFLICT(article_id) DO UPDATE SET
                content = excluded.content,
                full_content = excluded.full_content,
                updated_at = unixepoch()
            "#,
            params![&article.id, c, full_content],
        )?;
    }

    Ok(())
}

#[tauri::command]
pub fn sqlite_save_rss_article(
    app: AppHandle,
    article: RssArticleDto,
    content: Option<String>,
    full_content: Option<String>,
) -> Result<(), String> {
    with_connection(&app, |conn| {
        sqlite_save_rss_article_inner(conn, &article, content.as_deref(), full_content.as_deref())
    })
}

pub fn sqlite_mark_article_read_inner(
    connection: &Connection,
    article_id: &str,
    is_read: bool,
) -> rusqlite::Result<()> {
    connection.execute(
        "UPDATE rss_articles SET is_read = ?1, updated_at = unixepoch() WHERE id = ?2",
        params![if is_read { 1 } else { 0 }, article_id],
    )?;
    Ok(())
}

#[tauri::command]
pub fn sqlite_mark_article_read(
    app: AppHandle,
    article_id: String,
    is_read: bool,
) -> Result<(), String> {
    with_connection(&app, |conn| {
        sqlite_mark_article_read_inner(conn, &article_id, is_read)
    })
}

pub fn sqlite_mark_article_favorite_inner(
    connection: &Connection,
    article_id: &str,
    is_favorite: bool,
) -> rusqlite::Result<()> {
    connection.execute(
        "UPDATE rss_articles SET is_favorite = ?1, updated_at = unixepoch() WHERE id = ?2",
        params![if is_favorite { 1 } else { 0 }, article_id],
    )?;
    Ok(())
}

#[tauri::command]
pub fn sqlite_mark_article_favorite(
    app: AppHandle,
    article_id: String,
    is_favorite: bool,
) -> Result<(), String> {
    with_connection(&app, |conn| {
        sqlite_mark_article_favorite_inner(conn, &article_id, is_favorite)
    })
}

pub fn sqlite_delete_rss_article_inner(
    connection: &Connection,
    article_id: &str,
) -> rusqlite::Result<()> {
    connection.execute(
        "DELETE FROM rss_article_content WHERE article_id = ?1",
        params![article_id],
    )?;
    connection.execute(
        "DELETE FROM rss_articles WHERE id = ?1",
        params![article_id],
    )?;
    Ok(())
}

#[tauri::command]
pub fn sqlite_delete_rss_article(app: AppHandle, article_id: String) -> Result<(), String> {
    with_connection(&app, |conn| {
        sqlite_delete_rss_article_inner(conn, &article_id)
    })
}

pub fn sqlite_record_reading_session_inner(
    connection: &Connection,
    session_id: &str,
    date: &str,
    minutes: f64,
    book_id: Option<&str>,
    books_read_json: Option<&str>,
) -> rusqlite::Result<()> {
    connection.execute(
        r#"
        INSERT INTO reading_sessions (id, book_id, session_date, minutes, books_read_json, created_at)
        VALUES (?1, ?2, ?3, ?4, ?5, unixepoch())
        ON CONFLICT(id) DO UPDATE SET
            minutes = reading_sessions.minutes + excluded.minutes,
            book_id = COALESCE(excluded.book_id, reading_sessions.book_id),
            books_read_json = COALESCE(excluded.books_read_json, reading_sessions.books_read_json)
        "#,
        params![session_id, book_id, date, minutes, books_read_json],
    )?;
    Ok(())
}

#[tauri::command]
pub fn sqlite_record_reading_session(
    app: AppHandle,
    session_id: String,
    date: String,
    minutes: f64,
    book_id: Option<String>,
    books_read_json: Option<String>,
) -> Result<(), String> {
    with_connection(&app, |conn| {
        sqlite_record_reading_session_inner(
            conn,
            &session_id,
            &date,
            minutes,
            book_id.as_deref(),
            books_read_json.as_deref(),
        )
    })
}

fn map_reading_session_row(row: &rusqlite::Row) -> rusqlite::Result<ReadingSessionDto> {
    Ok(ReadingSessionDto {
        id: row.get::<_, String>(0)?.into_boxed_str(),
        book_id: row.get::<_, Option<String>>(1)?.map(|s| s.into_boxed_str()),
        session_date: row.get::<_, String>(2)?.into_boxed_str(),
        minutes: row.get(3)?,
        books_read_json: row.get::<_, Option<String>>(4)?.map(|s| s.into_boxed_str()),
        created_at: row.get(5)?,
    })
}

pub fn sqlite_get_reading_sessions_inner(
    connection: &Connection,
    start_date: Option<&str>,
    end_date: Option<&str>,
) -> rusqlite::Result<Vec<ReadingSessionDto>> {
    let mut query = String::from(
        "SELECT id, book_id, session_date, minutes, books_read_json, created_at FROM reading_sessions",
    );
    let mut clauses = Vec::new();
    if start_date.is_some() {
        clauses.push("session_date >= ?1");
    }
    if end_date.is_some() {
        if start_date.is_some() {
            clauses.push("session_date <= ?2");
        } else {
            clauses.push("session_date <= ?1");
        }
    }
    if !clauses.is_empty() {
        query.push_str(" WHERE ");
        query.push_str(&clauses.join(" AND "));
    }
    query.push_str(" ORDER BY session_date DESC, created_at DESC");

    let mut stmt = connection.prepare(&query)?;
    let rows = match (start_date, end_date) {
        (Some(start), Some(end)) => stmt.query_map(params![start, end], map_reading_session_row)?,
        (Some(start), None) => stmt.query_map(params![start], map_reading_session_row)?,
        (None, Some(end)) => stmt.query_map(params![end], map_reading_session_row)?,
        (None, None) => stmt.query_map([], map_reading_session_row)?,
    };

    rows.collect()
}

#[tauri::command]
pub fn sqlite_get_reading_sessions(
    app: AppHandle,
    start_date: Option<String>,
    end_date: Option<String>,
) -> Result<Vec<ReadingSessionDto>, String> {
    with_connection(&app, |conn| {
        sqlite_get_reading_sessions_inner(conn, start_date.as_deref(), end_date.as_deref())
    })
}

pub fn run_v153_database_migrations(connection: &Connection) -> rusqlite::Result<()> {
    let is_done: bool = connection
        .query_row(
            "SELECT COUNT(*) > 0 FROM kv_store WHERE key = 'migration_v153_done'",
            [],
            |row| row.get(0),
        )
        .unwrap_or(false);

    if is_done {
        return Ok(());
    }

    let tx = connection.unchecked_transaction()?;

    // 1. Migrate RSS Feeds & Articles from zustand:theorem-rss
    if let Ok(Some(rss_json)) = tx
        .query_row(
            "SELECT value FROM kv_store WHERE key = 'zustand:theorem-rss'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
    {
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&rss_json) {
            if let Some(feeds) = parsed["state"]["feeds"].as_array() {
                for feed in feeds {
                    let id = feed["id"].as_str().unwrap_or("");
                    let title = feed["title"].as_str().unwrap_or("");
                    let url = feed["url"].as_str().unwrap_or("");
                    let site_url = feed["siteUrl"].as_str();
                    let description = feed["description"].as_str();
                    let icon_url = feed["iconUrl"].as_str();
                    let unread_count = feed["unreadCount"].as_i64().unwrap_or(0);
                    let error_message = feed["errorMessage"].as_str();

                    if !id.is_empty() && !title.is_empty() {
                        let _ = tx.execute(
                            r#"
                            INSERT OR IGNORE INTO rss_feeds (
                                id, title, url, site_url, description, icon_url,
                                unread_count, error_message, added_at, updated_at
                            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, unixepoch(), unixepoch())
                            "#,
                            params![
                                id,
                                title,
                                url,
                                site_url,
                                description,
                                icon_url,
                                unread_count,
                                error_message
                            ],
                        );
                    }
                }
            }

            if let Some(articles) = parsed["state"]["articles"].as_array() {
                for article in articles {
                    let id = article["id"].as_str().unwrap_or("");
                    let feed_id = article["feedId"].as_str().unwrap_or("");
                    let title = article["title"].as_str().unwrap_or("");
                    let author = article["author"].as_str();
                    let url = article["url"].as_str().unwrap_or("");
                    let summary = article["summary"].as_str();
                    let content = article["content"].as_str().unwrap_or("");
                    let full_content = article["fullContent"].as_str();
                    let content_source = article["contentSource"].as_str();
                    let image_url = article["imageUrl"].as_str();
                    let is_read = if article["isRead"].as_bool().unwrap_or(false) {
                        1
                    } else {
                        0
                    };
                    let is_favorite = if article["isFavorite"].as_bool().unwrap_or(false) {
                        1
                    } else {
                        0
                    };
                    let progress = article["progress"].as_f64();

                    if !id.is_empty() && !feed_id.is_empty() {
                        let _ = tx.execute(
                            r#"
                            INSERT OR IGNORE INTO rss_articles (
                                id, feed_id, title, author, url, summary,
                                content_source, image_url, is_read, is_favorite,
                                progress, fetched_at, updated_at
                            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, unixepoch(), unixepoch())
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
                                is_read,
                                is_favorite,
                                progress
                            ],
                        );

                        let _ = tx.execute(
                            r#"
                            INSERT OR IGNORE INTO rss_article_content (
                                article_id, content, full_content, updated_at
                            ) VALUES (?1, ?2, ?3, unixepoch())
                            "#,
                            params![id, content, full_content],
                        );
                    }
                }
            }
        }
    }

    // 2. Migrate Reading Sessions from zustand:theorem-settings (dailyActivity)
    if let Ok(Some(settings_json)) = tx
        .query_row(
            "SELECT value FROM kv_store WHERE key = 'zustand:theorem-settings'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
    {
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&settings_json) {
            if let Some(activities) = parsed["state"]["stats"]["dailyActivity"].as_array() {
                for act in activities {
                    let date = act["date"].as_str().unwrap_or("");
                    let minutes = act["minutes"].as_f64().unwrap_or(0.0);
                    let books_read_json = act["booksRead"].to_string();
                    if !date.is_empty() {
                        let session_id = format!("session:{}", date);
                        let _ = tx.execute(
                            r#"
                            INSERT OR IGNORE INTO reading_sessions (
                                id, session_date, minutes, books_read_json, created_at
                            ) VALUES (?1, ?2, ?3, ?4, unixepoch())
                            "#,
                            params![session_id, date, minutes, books_read_json],
                        );
                    }
                }
            }
        }
    }

    // 3. Ensure any books in zustand:theorem-library are indexed into books_fts
    if let Ok(Some(lib_json)) = tx
        .query_row(
            "SELECT value FROM kv_store WHERE key = 'zustand:theorem-library'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
    {
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&lib_json) {
            if let Some(books) = parsed["state"]["books"].as_array() {
                for b in books {
                    let id = b["id"].as_str().unwrap_or("");
                    let title = b["title"].as_str().unwrap_or("");
                    let author = b["author"].as_str().unwrap_or("");
                    if !id.is_empty() && !title.is_empty() {
                        let _ = tx.execute(
                            "INSERT OR IGNORE INTO books_fts (id, title, author) VALUES (?1, ?2, ?3)",
                            params![id, title, author],
                        );
                    }
                }
            }
        }
    }

    // Mark migration completed with timestamp
    tx.execute(
        "INSERT INTO kv_store (key, value, updated_at) VALUES ('migration_v153_done', '1', unixepoch())",
        [],
    )?;

    tx.commit()?;
    eprintln!("[database] Completed Theorem v1.5.3 relational migrations successfully");
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqliteVocabularyTerm {
    pub id: Box<str>,
    pub term: Box<str>,
    pub normalized_term: Box<str>,
    pub language: Box<str>,
    pub phonetic: Option<Box<str>>,
    pub audio_url: Option<Box<str>>,
    pub meanings_json: Box<str>,
    pub provider_history_json: Box<str>,
    pub source_book_id: Option<Box<str>>,
    pub context_sentence: Option<Box<str>>,
    pub created_at: i64,
    pub updated_at: Option<i64>,
}

fn map_vocabulary_row(row: &rusqlite::Row) -> rusqlite::Result<SqliteVocabularyTerm> {
    Ok(SqliteVocabularyTerm {
        id: row.get::<_, String>(0)?.into_boxed_str(),
        term: row.get::<_, String>(1)?.into_boxed_str(),
        normalized_term: row.get::<_, String>(2)?.into_boxed_str(),
        language: row.get::<_, String>(3)?.into_boxed_str(),
        phonetic: row.get::<_, Option<String>>(4)?.map(|s| s.into_boxed_str()),
        audio_url: row.get::<_, Option<String>>(5)?.map(|s| s.into_boxed_str()),
        meanings_json: row.get::<_, String>(6)?.into_boxed_str(),
        provider_history_json: row.get::<_, String>(7)?.into_boxed_str(),
        source_book_id: row.get::<_, Option<String>>(8)?.map(|s| s.into_boxed_str()),
        context_sentence: row.get::<_, Option<String>>(9)?.map(|s| s.into_boxed_str()),
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
    })
}

pub fn sqlite_get_vocabulary_terms_inner(
    connection: &Connection,
) -> rusqlite::Result<Vec<SqliteVocabularyTerm>> {
    let mut stmt = connection.prepare(
        r#"
        SELECT id, term, normalized_term, language, phonetic, audio_url,
               meanings_json, provider_history_json, source_book_id,
               context_sentence, created_at, updated_at
        FROM vocabulary
        ORDER BY created_at DESC
        "#,
    )?;

    let rows = stmt.query_map([], map_vocabulary_row)?;
    let mut terms = Vec::new();
    for row in rows {
        terms.push(row?);
    }
    Ok(terms)
}

pub fn sqlite_save_vocabulary_term_inner(
    connection: &Connection,
    term: &SqliteVocabularyTerm,
) -> rusqlite::Result<()> {
    connection.execute(
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
            created_at = excluded.created_at,
            updated_at = excluded.updated_at
        "#,
        params![
            &term.id[..],
            &term.term[..],
            &term.normalized_term[..],
            &term.language[..],
            term.phonetic.as_deref(),
            term.audio_url.as_deref(),
            &term.meanings_json[..],
            &term.provider_history_json[..],
            term.source_book_id.as_deref(),
            term.context_sentence.as_deref(),
            term.created_at,
            term.updated_at
        ],
    )?;
    Ok(())
}

pub fn sqlite_delete_vocabulary_term_inner(
    connection: &Connection,
    term_id: &str,
) -> rusqlite::Result<()> {
    connection.execute("DELETE FROM vocabulary WHERE id = ?1", params![term_id])?;
    Ok(())
}

#[tauri::command]
pub fn sqlite_get_vocabulary_terms(app: AppHandle) -> Result<Vec<SqliteVocabularyTerm>, String> {
    with_connection(&app, sqlite_get_vocabulary_terms_inner)
}

#[tauri::command]
pub fn sqlite_save_vocabulary_term(
    app: AppHandle,
    term: SqliteVocabularyTerm,
) -> Result<(), String> {
    with_connection(&app, |conn| sqlite_save_vocabulary_term_inner(conn, &term))
}

#[tauri::command]
pub fn sqlite_delete_vocabulary_term(app: AppHandle, term_id: String) -> Result<(), String> {
    with_connection(&app, |conn| {
        sqlite_delete_vocabulary_term_inner(conn, &term_id)
    })
}

pub fn run_v154_database_migrations(connection: &Connection) -> rusqlite::Result<()> {
    let is_done: bool = connection
        .query_row(
            "SELECT COUNT(*) > 0 FROM kv_store WHERE key = 'migration_v154_done'",
            [],
            |row| row.get(0),
        )
        .unwrap_or(false);

    if is_done {
        return Ok(());
    }

    let tx = connection.unchecked_transaction()?;

    // Create vocabulary table if it doesn't exist
    tx.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS vocabulary (
            id TEXT PRIMARY KEY,
            term TEXT NOT NULL,
            normalized_term TEXT NOT NULL,
            language TEXT NOT NULL,
            phonetic TEXT,
            audio_url TEXT,
            meanings_json TEXT NOT NULL,
            provider_history_json TEXT NOT NULL,
            source_book_id TEXT,
            context_sentence TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_vocabulary_term ON vocabulary(normalized_term, language);
        CREATE INDEX IF NOT EXISTS idx_vocabulary_created_at ON vocabulary(created_at DESC);
        "#,
    )?;

    // Migrate Vocabulary from zustand:theorem-vocabulary
    if let Ok(Some(vocab_json)) = tx
        .query_row(
            "SELECT value FROM kv_store WHERE key = 'zustand:theorem-vocabulary'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
    {
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&vocab_json) {
            if let Some(terms) = parsed["state"]["vocabularyTerms"].as_array() {
                for term in terms {
                    let id = term["id"].as_str().unwrap_or("");
                    let word = term["term"].as_str().unwrap_or("");
                    let normalized_term = term["normalizedTerm"].as_str().unwrap_or(word);
                    let language = term["language"].as_str().unwrap_or("en");
                    let phonetic = term["phonetic"].as_str();
                    let audio_url = term["audioUrl"].as_str();
                    let meanings_json = term["meanings"].to_string();
                    let provider_history_json = term["providerHistory"].to_string();
                    let source_book_id = term["sourceBookId"].as_str();
                    let context_sentence = term["contextSentence"].as_str();
                    let created_at = term["createdAt"]
                        .as_i64()
                        .or_else(|| {
                            term["createdAt"].as_str().and_then(|s| {
                                chrono::DateTime::parse_from_rfc3339(s)
                                    .ok()
                                    .map(|dt| dt.timestamp_millis())
                            })
                        })
                        .unwrap_or_else(|| {
                            std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .unwrap_or_default()
                                .as_millis() as i64
                        });
                    let updated_at = term["updatedAt"].as_i64().or_else(|| {
                        term["updatedAt"].as_str().and_then(|s| {
                            chrono::DateTime::parse_from_rfc3339(s)
                                .ok()
                                .map(|dt| dt.timestamp_millis())
                        })
                    });

                    if !id.is_empty() && !word.is_empty() {
                        let _ = tx.execute(
                            r#"
                            INSERT OR IGNORE INTO vocabulary (
                                id, term, normalized_term, language, phonetic, audio_url,
                                meanings_json, provider_history_json, source_book_id,
                                context_sentence, created_at, updated_at
                            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
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
                                updated_at
                            ],
                        );
                    }
                }
            }
        }
    }

    tx.execute(
        "INSERT INTO kv_store (key, value, updated_at) VALUES ('migration_v154_done', '1', unixepoch())",
        [],
    )?;

    tx.commit()?;
    eprintln!("[database] Completed Theorem v1.5.4 relational migrations successfully");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"
            PRAGMA journal_mode = MEMORY;
            PRAGMA synchronous = OFF;
            PRAGMA foreign_keys = OFF;

            CREATE TABLE IF NOT EXISTS books (
                id TEXT PRIMARY KEY,
                data BLOB NOT NULL,
                updated_at INTEGER NOT NULL DEFAULT (unixepoch())
            );

            CREATE TABLE IF NOT EXISTS covers (
                book_id TEXT PRIMARY KEY,
                data_url TEXT NOT NULL,
                data BLOB,
                updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
                FOREIGN KEY(book_id) REFERENCES books(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS kv_store (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at INTEGER NOT NULL DEFAULT (unixepoch())
            );

            CREATE TABLE IF NOT EXISTS blob_store (
                key TEXT PRIMARY KEY,
                data BLOB NOT NULL,
                updated_at INTEGER NOT NULL DEFAULT (unixepoch())
            );

            CREATE TABLE IF NOT EXISTS materialized_books (
                book_id TEXT PRIMARY KEY,
                source_updated_at INTEGER NOT NULL,
                materialized_at INTEGER NOT NULL DEFAULT (unixepoch()),
                FOREIGN KEY(book_id) REFERENCES books(id) ON DELETE CASCADE
            );

            CREATE VIRTUAL TABLE IF NOT EXISTS books_fts USING fts5(
                id UNINDEXED,
                title,
                author
            );

            CREATE TABLE IF NOT EXISTS book_metadata (
                book_id TEXT PRIMARY KEY,
                metadata_json TEXT NOT NULL,
                updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
                FOREIGN KEY(book_id) REFERENCES books(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS book_annotations (
                id TEXT PRIMARY KEY,
                book_id TEXT NOT NULL,
                annotation_json TEXT NOT NULL,
                updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
                FOREIGN KEY(book_id) REFERENCES books(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS rss_feeds (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                url TEXT NOT NULL,
                site_url TEXT,
                description TEXT,
                icon_url TEXT,
                last_fetched INTEGER,
                added_at INTEGER NOT NULL,
                error_message TEXT,
                unread_count INTEGER NOT NULL DEFAULT 0,
                updated_at INTEGER NOT NULL DEFAULT (unixepoch())
            );

            CREATE TABLE IF NOT EXISTS rss_articles (
                id TEXT PRIMARY KEY,
                feed_id TEXT NOT NULL,
                title TEXT NOT NULL,
                author TEXT,
                url TEXT NOT NULL,
                summary TEXT,
                content_source TEXT,
                image_url TEXT,
                published_at INTEGER,
                fetched_at INTEGER NOT NULL,
                is_read INTEGER NOT NULL DEFAULT 0,
                is_favorite INTEGER NOT NULL DEFAULT 0,
                progress REAL,
                updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
                FOREIGN KEY(feed_id) REFERENCES rss_feeds(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS rss_article_content (
                article_id TEXT PRIMARY KEY,
                content TEXT NOT NULL,
                full_content TEXT,
                updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
                FOREIGN KEY(article_id) REFERENCES rss_articles(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS reading_sessions (
                id TEXT PRIMARY KEY,
                book_id TEXT,
                session_date TEXT NOT NULL,
                minutes REAL NOT NULL,
                books_read_json TEXT,
                created_at INTEGER NOT NULL DEFAULT (unixepoch())
            );

            CREATE TABLE IF NOT EXISTS vocabulary (
                id TEXT PRIMARY KEY,
                term TEXT NOT NULL,
                normalized_term TEXT NOT NULL,
                language TEXT NOT NULL,
                phonetic TEXT,
                audio_url TEXT,
                meanings_json TEXT NOT NULL,
                provider_history_json TEXT NOT NULL,
                source_book_id TEXT,
                context_sentence TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER
            );
            "#,
        )
        .unwrap();
        conn
    }

    #[test]
    fn test_v153_database_migrations_preserves_kv_and_migrates() {
        let conn = setup_db();

        let rss_sample = r#"{
            "state": {
                "feeds": [{
                    "id": "feed1",
                    "title": "Rust Blog",
                    "url": "https://blog.rust-lang.org/feed.xml",
                    "unreadCount": 3
                }],
                "articles": [{
                    "id": "art1",
                    "feedId": "feed1",
                    "title": "Announcing Rust 1.85",
                    "url": "https://blog.rust-lang.org/2025/02/20/Rust-1.85.0.html",
                    "content": "<p>Rust 1.85 is out!</p>",
                    "fullContent": "Full content text here",
                    "isRead": true,
                    "isFavorite": false
                }]
            }
        }"#;

        let settings_sample = r#"{
            "state": {
                "stats": {
                    "dailyActivity": [
                        { "date": "2026-09-13", "minutes": 42.5, "booksRead": ["book1", "book2"] }
                    ]
                }
            }
        }"#;

        let lib_sample = r#"{
            "state": {
                "books": [
                    { "id": "book1", "title": "Dune", "author": "Frank Herbert" }
                ]
            }
        }"#;

        sqlite_set_kv_inner(&conn, "zustand:theorem-rss", rss_sample).unwrap();
        sqlite_set_kv_inner(&conn, "zustand:theorem-settings", settings_sample).unwrap();
        sqlite_set_kv_inner(&conn, "zustand:theorem-library", lib_sample).unwrap();

        // Run migrations
        run_v153_database_migrations(&conn).unwrap();

        // Verify migration marker
        let marker = sqlite_get_kv_inner(&conn, "migration_v153_done").unwrap();
        assert_eq!(marker, Some("1".to_string()));

        // Verify immutable backup: original kv values are completely unchanged!
        assert_eq!(
            sqlite_get_kv_inner(&conn, "zustand:theorem-rss").unwrap(),
            Some(rss_sample.to_string())
        );
        assert_eq!(
            sqlite_get_kv_inner(&conn, "zustand:theorem-settings").unwrap(),
            Some(settings_sample.to_string())
        );

        // Verify relational table contents
        let feed_title: String = conn
            .query_row("SELECT title FROM rss_feeds WHERE id = 'feed1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(feed_title, "Rust Blog");

        let article_title: String = conn
            .query_row(
                "SELECT title FROM rss_articles WHERE id = 'art1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(article_title, "Announcing Rust 1.85");

        let content: String = conn
            .query_row(
                "SELECT content FROM rss_article_content WHERE article_id = 'art1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(content, "<p>Rust 1.85 is out!</p>");

        let minutes: f64 = conn
            .query_row(
                "SELECT minutes FROM reading_sessions WHERE session_date = '2026-09-13'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(minutes, 42.5);

        // Verify book was indexed into books_fts
        let fts_title: String = conn
            .query_row("SELECT title FROM books_fts WHERE id = 'book1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(fts_title, "Dune");

        // Verify idempotency: running a 2nd time does nothing and does not fail
        run_v153_database_migrations(&conn).unwrap();
    }

    #[test]
    fn test_kv_roundtrip() {
        let conn = setup_db();
        sqlite_set_kv_inner(&conn, "key1", "value1").unwrap();
        let result = sqlite_get_kv_inner(&conn, "key1").unwrap();
        assert_eq!(result, Some("value1".to_string()));
    }

    #[test]
    fn test_kv_get_nonexistent() {
        let conn = setup_db();
        let result = sqlite_get_kv_inner(&conn, "nonexistent").unwrap();
        assert_eq!(result, None);
    }

    #[test]
    fn test_kv_overwrite() {
        let conn = setup_db();
        sqlite_set_kv_inner(&conn, "key1", "value1").unwrap();
        sqlite_set_kv_inner(&conn, "key1", "value2").unwrap();
        let result = sqlite_get_kv_inner(&conn, "key1").unwrap();
        assert_eq!(result, Some("value2".to_string()));
    }

    #[test]
    fn test_kv_delete() {
        let conn = setup_db();
        sqlite_set_kv_inner(&conn, "key1", "value1").unwrap();
        sqlite_delete_kv_inner(&conn, "key1").unwrap();
        let result = sqlite_get_kv_inner(&conn, "key1").unwrap();
        assert_eq!(result, None);
    }

    #[test]
    fn test_batch_get_kv() {
        let conn = setup_db();
        sqlite_set_kv_inner(&conn, "a", "1").unwrap();
        sqlite_set_kv_inner(&conn, "b", "2").unwrap();
        sqlite_set_kv_inner(&conn, "c", "3").unwrap();
        let results =
            sqlite_batch_get_kv_inner(&conn, &["a".to_string(), "c".to_string()]).unwrap();
        assert_eq!(results.len(), 2);
        assert!(results.contains(&("a".to_string(), "1".to_string())));
        assert!(results.contains(&("c".to_string(), "3".to_string())));
    }

    #[test]
    fn test_batch_get_kv_empty() {
        let conn = setup_db();
        let results = sqlite_batch_get_kv_inner(&conn, &[]).unwrap();
        assert!(results.is_empty());
    }

    #[test]
    fn test_kv_prefix_count() {
        let conn = setup_db();
        sqlite_set_kv_inner(&conn, "prefix:a", "1").unwrap();
        sqlite_set_kv_inner(&conn, "prefix:b", "2").unwrap();
        sqlite_set_kv_inner(&conn, "other:c", "3").unwrap();
        let count = sqlite_count_kv_by_prefix_inner(&conn, "prefix:").unwrap();
        assert_eq!(count, 2);
    }

    #[test]
    fn test_kv_prefix_delete() {
        let conn = setup_db();
        sqlite_set_kv_inner(&conn, "prefix:a", "1").unwrap();
        sqlite_set_kv_inner(&conn, "prefix:b", "2").unwrap();
        sqlite_set_kv_inner(&conn, "other:c", "3").unwrap();
        let deleted = sqlite_delete_kv_by_prefix_inner(&conn, "prefix:").unwrap();
        assert_eq!(deleted, 2);
        assert_eq!(sqlite_get_kv_inner(&conn, "prefix:a").unwrap(), None);
        assert_eq!(
            sqlite_get_kv_inner(&conn, "other:c").unwrap(),
            Some("3".to_string())
        );
    }

    #[test]
    fn test_blob_roundtrip() {
        let conn = setup_db();
        let data = vec![1, 2, 3, 4, 5];
        sqlite_set_blob_inner(&conn, "blob1", &data).unwrap();
        let result = sqlite_get_blob_inner(&conn, "blob1").unwrap();
        assert_eq!(result, Some(data));
    }

    #[test]
    fn test_blob_get_nonexistent() {
        let conn = setup_db();
        let result = sqlite_get_blob_inner(&conn, "nonexistent").unwrap();
        assert_eq!(result, None);
    }

    #[test]
    fn test_blob_delete() {
        let conn = setup_db();
        sqlite_set_blob_inner(&conn, "blob1", &[1, 2, 3]).unwrap();
        sqlite_delete_blob_inner(&conn, "blob1").unwrap();
        let result = sqlite_get_blob_inner(&conn, "blob1").unwrap();
        assert_eq!(result, None);
    }

    #[test]
    fn test_blob_prefix_delete() {
        let conn = setup_db();
        sqlite_set_blob_inner(&conn, "pfx:a", &[1]).unwrap();
        sqlite_set_blob_inner(&conn, "pfx:b", &[2]).unwrap();
        sqlite_set_blob_inner(&conn, "other:c", &[3]).unwrap();
        let deleted = sqlite_delete_blobs_by_prefix_inner(&conn, "pfx:").unwrap();
        assert_eq!(deleted, 2);
        assert_eq!(sqlite_get_blob_inner(&conn, "pfx:a").unwrap(), None);
        assert_eq!(
            sqlite_get_blob_inner(&conn, "other:c").unwrap(),
            Some(vec![3])
        );
    }

    #[test]
    fn test_cover_image_roundtrip() {
        let conn = setup_db();
        sqlite_save_cover_image_inner(&conn, "book1", "data:image/png;base64,abc").unwrap();
        let result = sqlite_get_cover_image_inner(&conn, "book1").unwrap();
        assert_eq!(result, Some("data:image/png;base64,abc".to_string()));
    }

    #[test]
    fn test_cover_image_delete() {
        let conn = setup_db();
        sqlite_save_cover_image_inner(&conn, "book1", "data:image/png;base64,abc").unwrap();
        sqlite_delete_cover_image_inner(&conn, "book1").unwrap();
        let result = sqlite_get_cover_image_inner(&conn, "book1").unwrap();
        assert_eq!(result, None);
    }

    #[test]
    fn test_cover_image_does_not_populate_legacy_data_column() {
        let conn = setup_db();
        sqlite_save_cover_image_inner(&conn, "book1", "data:image/png;base64,aGVsbG8=").unwrap();
        let data: Option<Vec<u8>> = conn
            .query_row(
                "SELECT data FROM covers WHERE book_id = ?1",
                params!["book1"],
                |row| row.get(0),
            )
            .unwrap();
        assert!(data.is_none());
    }

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
    fn test_book_annotations_roundtrip() {
        let conn = setup_db();
        let anns = vec![
            r#"{"id":"ann1","type":"highlight","text":"hello"}"#.to_string(),
            r#"{"id":"ann2","type":"note","text":"world"}"#.to_string(),
        ];
        sqlite_save_book_annotations_inner(&conn, "book1", &anns).unwrap();
        let result = sqlite_get_book_annotations_inner(&conn, "book1").unwrap();
        assert_eq!(result.len(), 2);
        assert!(result[0].contains("ann1") || result[1].contains("ann1"));
    }

    #[test]
    fn test_book_annotations_replace() {
        let conn = setup_db();
        let anns1 = vec![r#"{"id":"ann1","text":"first"}"#.to_string()];
        let anns2 = vec![r#"{"id":"ann2","text":"second"}"#.to_string()];
        sqlite_save_book_annotations_inner(&conn, "book1", &anns1).unwrap();
        sqlite_save_book_annotations_inner(&conn, "book1", &anns2).unwrap();
        let result = sqlite_get_book_annotations_inner(&conn, "book1").unwrap();
        assert_eq!(result.len(), 1);
        assert!(result[0].contains("ann2"));
    }

    #[test]
    fn test_clear_all_storage() {
        let conn = setup_db();
        sqlite_set_kv_inner(&conn, "k1", "v1").unwrap();
        sqlite_set_blob_inner(&conn, "b1", &[1]).unwrap();
        sqlite_save_cover_image_inner(&conn, "book1", "data:,").unwrap();
        sqlite_clear_all_storage_inner(&conn).unwrap();
        assert_eq!(sqlite_get_kv_inner(&conn, "k1").unwrap(), None);
        assert_eq!(sqlite_get_blob_inner(&conn, "b1").unwrap(), None);
        assert_eq!(sqlite_get_cover_image_inner(&conn, "book1").unwrap(), None);
    }

    #[test]
    fn test_blob_stats() {
        let conn = setup_db();
        let stats = sqlite_get_blob_stats_inner(&conn, None::<String>).unwrap();
        assert_eq!(stats.count, 0);
        assert_eq!(stats.total_size, 0);

        sqlite_set_blob_inner(&conn, "a", &[1, 2, 3]).unwrap();
        sqlite_set_blob_inner(&conn, "b", &[4, 5]).unwrap();
        let stats = sqlite_get_blob_stats_inner(&conn, None::<String>).unwrap();
        assert_eq!(stats.count, 2);
        assert_eq!(stats.total_size, 5);
    }

    #[test]
    fn test_blob_stats_with_prefix() {
        let conn = setup_db();
        sqlite_set_blob_inner(&conn, "pfx:a", &[1, 2, 3]).unwrap();
        sqlite_set_blob_inner(&conn, "pfx:b", &[4, 5]).unwrap();
        sqlite_set_blob_inner(&conn, "other:c", &[6]).unwrap();
        let stats = sqlite_get_blob_stats_inner(&conn, Some("pfx:".to_string())).unwrap();
        assert_eq!(stats.count, 2);
        assert_eq!(stats.total_size, 5);
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

    fn temp_test_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "theorem-test-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn book_data_len(conn: &Connection, id: &str) -> i64 {
        conn.query_row(
            "SELECT length(data) FROM books WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .unwrap()
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

    #[test]
    fn test_reclaim_legacy_book_blobs_materializes_missing_file() {
        let conn = setup_db();
        conn.execute(
            "INSERT INTO books (id, data) VALUES ('book1', X'deadbeef')",
            [],
        )
        .unwrap();

        let dir = temp_test_dir("reclaim");
        let reclaimed = reclaim_legacy_book_blobs(&conn, &dir).unwrap();
        assert_eq!(reclaimed, 1);

        assert_eq!(book_data_len(&conn, "book1"), 0);
        let cache_path = materialized_book_path_in_dir(&dir, "book1");
        assert_eq!(
            std::fs::read(&cache_path).unwrap(),
            vec![0xde, 0xad, 0xbe, 0xef]
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_reclaim_legacy_book_blobs_keeps_existing_file() {
        let conn = setup_db();
        conn.execute(
            "INSERT INTO books (id, data) VALUES ('book1', X'deadbeef')",
            [],
        )
        .unwrap();

        let dir = temp_test_dir("reclaim-existing");
        let cache_path = materialized_book_path_in_dir(&dir, "book1");
        std::fs::create_dir_all(cache_path.parent().unwrap()).unwrap();
        std::fs::write(&cache_path, b"already-materialized").unwrap();

        let reclaimed = reclaim_legacy_book_blobs(&conn, &dir).unwrap();
        assert_eq!(reclaimed, 1);

        assert_eq!(book_data_len(&conn, "book1"), 0);
        assert_eq!(std::fs::read(&cache_path).unwrap(), b"already-materialized");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_reclaim_legacy_book_blobs_noop_when_empty() {
        let conn = setup_db();
        conn.execute("INSERT INTO books (id, data) VALUES ('book1', X'')", [])
            .unwrap();

        let dir = temp_test_dir("reclaim-noop");
        let reclaimed = reclaim_legacy_book_blobs(&conn, &dir).unwrap();
        assert_eq!(reclaimed, 0);
        assert_eq!(book_data_len(&conn, "book1"), 0);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_relational_crud_operations() {
        let conn = setup_db();

        // 1. Test RSS Feed CRUD
        let feed = RssFeedDto {
            id: "f1".into(),
            title: "Tech News".into(),
            url: "https://example.com/feed.xml".into(),
            site_url: Some("https://example.com".into()),
            description: Some("Tech news feed".into()),
            icon_url: None,
            last_fetched: Some(1000),
            added_at: Some(900),
            error_message: None,
            unread_count: 5,
        };
        sqlite_save_rss_feed_inner(&conn, &feed).unwrap();

        let feeds = sqlite_get_rss_feeds_inner(&conn).unwrap();
        assert_eq!(feeds.len(), 1);
        assert_eq!(&*feeds[0].title, "Tech News");
        assert_eq!(feeds[0].unread_count, 5);

        // 2. Test RSS Article & Content CRUD
        let article = RssArticleDto {
            id: "a1".into(),
            feed_id: "f1".into(),
            title: "Article 1".into(),
            author: Some("Author 1".into()),
            url: "https://example.com/a1".into(),
            summary: Some("Summary 1".into()),
            content_source: Some("feed".into()),
            image_url: None,
            published_at: Some(1050),
            fetched_at: Some(1060),
            is_read: false,
            is_favorite: false,
            progress: Some(0.25),
        };
        sqlite_save_rss_article_inner(
            &conn,
            &article,
            Some("<p>Body 1</p>"),
            Some("<p>Full body 1</p>"),
        )
        .unwrap();

        let articles = sqlite_get_rss_articles_inner(&conn, Some("f1"), None, None).unwrap();
        assert_eq!(articles.len(), 1);
        assert_eq!(&*articles[0].title, "Article 1");
        assert!(!articles[0].is_read);

        let content = sqlite_get_rss_article_content_inner(&conn, "a1")
            .unwrap()
            .unwrap();
        assert_eq!(&*content.content, "<p>Body 1</p>");
        assert_eq!(content.full_content.as_deref(), Some("<p>Full body 1</p>"));

        // 3. Mark read and favorite
        sqlite_mark_article_read_inner(&conn, "a1", true).unwrap();
        sqlite_mark_article_favorite_inner(&conn, "a1", true).unwrap();
        let updated_articles = sqlite_get_rss_articles_inner(&conn, None, None, None).unwrap();
        assert!(updated_articles[0].is_read);
        assert!(updated_articles[0].is_favorite);

        // 4. Test Reading Sessions
        sqlite_record_reading_session_inner(
            &conn,
            "session:2026-09-13",
            "2026-09-13",
            25.0,
            Some("book1"),
            Some("[\"book1\"]"),
        )
        .unwrap();

        // Increment session
        sqlite_record_reading_session_inner(
            &conn,
            "session:2026-09-13",
            "2026-09-13",
            15.0,
            Some("book1"),
            None,
        )
        .unwrap();

        let sessions = sqlite_get_reading_sessions_inner(&conn, Some("2026-09-01"), None).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].minutes, 40.0);

        // 5. Test Delete Article & Feed Cascade
        sqlite_delete_rss_article_inner(&conn, "a1").unwrap();
        assert!(sqlite_get_rss_articles_inner(&conn, None, None, None)
            .unwrap()
            .is_empty());
        assert!(sqlite_get_rss_article_content_inner(&conn, "a1")
            .unwrap()
            .is_none());

        sqlite_delete_rss_feed_inner(&conn, "f1").unwrap();
        assert!(sqlite_get_rss_feeds_inner(&conn).unwrap().is_empty());
    }

    #[test]
    fn test_sqlite_merge_sync_entries() {
        let conn = setup_db();
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

        let res = sqlite_merge_sync_entries_inner(&conn, entries).unwrap();
        assert!(res.domains_updated.contains(&"books".to_string()));
        assert!(res.domains_updated.contains(&"annotations".to_string()));
        assert!(res.domains_updated.contains(&"settings".to_string()));
        assert_eq!(res.books_count, 1);
        assert_eq!(res.annotations_count, 1);

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
            r#"[{"id":"b1","entityType":"book","deletedAt":1000}]"#.to_string(),
        );
        let del_res = sqlite_merge_sync_entries_inner(&conn, tombstone_entries).unwrap();
        assert!(del_res
            .domains_updated
            .contains(&"deletion_tombstones".to_string()));

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
    }
}
