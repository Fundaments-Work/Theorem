//! Fixtures shared by the database tests.

use super::*;

pub(super) fn setup_db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        r#"
        PRAGMA journal_mode = MEMORY;
        PRAGMA synchronous = OFF;
        -- As in production: the bundled SQLite defaults foreign keys on.
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
            mime TEXT,
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
            is_saved INTEGER NOT NULL DEFAULT 0,
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
    conn.execute_batch(SYNC_CONFLICTS_SCHEMA).unwrap();
    conn
}

pub(super) fn seed_book(conn: &Connection, id: &str, title: &str) {
    sqlite_register_materialized_book_inner(conn, id).unwrap();
    sqlite_save_book_metadata_inner(conn, id, &format!(r#"{{"id":"{id}","title":"{title}"}}"#))
        .unwrap();
    sqlite_save_cover_image_inner(conn, id, "data:image/png;base64,AAAA").unwrap();
    sqlite_upsert_annotation_inner(conn, &format!("{id}-ann"), id, r#"{"text":"t"}"#).unwrap();
}

pub(super) fn rows_for_book(conn: &Connection, id: &str) -> Vec<(&'static str, i64)> {
    [
        ("books", "SELECT COUNT(*) FROM books WHERE id = ?1"),
        ("covers", "SELECT COUNT(*) FROM covers WHERE book_id = ?1"),
        (
            "materialized_books",
            "SELECT COUNT(*) FROM materialized_books WHERE book_id = ?1",
        ),
        (
            "book_metadata",
            "SELECT COUNT(*) FROM book_metadata WHERE book_id = ?1",
        ),
        (
            "book_annotations",
            "SELECT COUNT(*) FROM book_annotations WHERE book_id = ?1",
        ),
        ("books_fts", "SELECT COUNT(*) FROM books_fts WHERE id = ?1"),
    ]
    .into_iter()
    .map(|(table, sql)| {
        (
            table,
            conn.query_row(sql, params![id], |r| r.get(0)).unwrap(),
        )
    })
    .filter(|(_, n)| *n > 0)
    .collect()
}

pub(super) fn book_data_len(conn: &Connection, id: &str) -> i64 {
    conn.query_row(
        "SELECT length(data) FROM books WHERE id = ?1",
        params![id],
        |row| row.get(0),
    )
    .unwrap()
}

pub(super) fn stored_book(conn: &Connection, id: &str) -> serde_json::Value {
    serde_json::from_str(&sqlite_get_book_metadata_inner(conn, id).unwrap().unwrap()).unwrap()
}

pub(super) fn merge_one(conn: &Connection, key: &str, json: &str) -> SyncMergeResult {
    let mut entries = std::collections::HashMap::new();
    entries.insert(key.to_string(), json.to_string());
    sqlite_merge_sync_entries_inner(conn, entries).unwrap()
}

/// The feed the `rss_article` fixtures belong to. The app saves a feed
/// before its articles, and foreign keys are on, so articles need it.
pub(super) fn seed_feed(conn: &Connection, id: &str) {
    sqlite_save_rss_feed_inner(
        conn,
        &RssFeedDto {
            id: id.into(),
            title: "Feed".into(),
            url: format!("https://example.com/{id}.xml").into(),
            site_url: None,
            description: None,
            icon_url: None,
            last_fetched: None,
            added_at: Some(1),
            error_message: None,
            unread_count: 0,
        },
    )
    .unwrap();
}

// ---- Prefix range scans, the books window, the annotations index ----

pub(super) fn migrated_store() -> (tempfile::TempDir, DataStore) {
    let dir = tempfile::tempdir().unwrap();
    run_schema_migrations_in(dir.path()).unwrap();
    let store = DataStore::open(dir.path()).unwrap();
    (dir, store)
}
