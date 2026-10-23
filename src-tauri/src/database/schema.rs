//! Schema, PRAGMAs and the versioned migrations run at startup.

use super::*;

/// Everything: the startup migrations, then the maintenance `setup()` leaves
/// to a background thread, inline (`VACUUM` included). For the CLI and for
/// restore, which have no window to keep responsive.
pub fn run_schema_migrations(app: &AppHandle) -> Result<(), String> {
    run_schema_migrations_in(&app_data_dir_of(app)?)
}

/// Create or upgrade the schema of the database in `app_data_dir`, with all
/// maintenance inline (the CLI and restore: no window to keep responsive).
pub fn run_schema_migrations_in(app_data_dir: &Path) -> Result<(), String> {
    let db_path = database_path_in(app_data_dir)?;
    run_schema_migrations_at(&db_path, app_data_dir)
}

pub(crate) fn run_schema_migrations_at(db_path: &Path, app_data_dir: &Path) -> Result<(), String> {
    let conn = open_migration_connection(db_path)?;
    apply_startup_migrations(&conn)?;
    crate::db_maintenance::run_maintenance_inline(app_data_dir, &conn);
    Ok(())
}

/// What `setup()` runs before the first paint: the schema and the versioned
/// migrations whose results the interface reads at startup. The rest
/// (`db_maintenance`) runs on a background thread afterwards.
pub fn run_startup_migrations(app: &AppHandle) -> Result<(), String> {
    run_startup_migrations_at(&database_path(app)?)
}

/// The startup migrations only, for the database in `app_data_dir`. The CLI
/// uses this: the app runs the slower maintenance (and `VACUUM`) itself, so a
/// command never pays for it.
#[cfg_attr(target_os = "android", allow(dead_code))]
pub fn run_startup_migrations_in(app_data_dir: &Path) -> Result<(), String> {
    run_startup_migrations_at(&database_path_in(app_data_dir)?)
}

pub(crate) fn run_startup_migrations_at(db_path: &Path) -> Result<(), String> {
    let started = std::time::Instant::now();
    let conn = open_migration_connection(db_path)?;
    apply_startup_migrations(&conn)?;
    log::info!(
        "[database] Startup migrations took {} ms",
        started.elapsed().as_millis()
    );
    Ok(())
}

fn open_migration_connection(db_path: &Path) -> Result<Connection, String> {
    let conn = Connection::open(db_path)
        .map_err(|e| format!("Failed to open database for migration: {e}"))?;
    conn.execute_batch(DB_SCHEMA_PERSISTENT_PRAGMAS)
        .map_err(|e| format!("Failed to run schema migrations: {e}"))?;
    conn.execute_batch(SYNC_CONFLICTS_SCHEMA)
        .map_err(|e| format!("Failed to run schema migrations: {e}"))?;
    conn.execute_batch(DB_PER_CONNECTION_PRAGMAS)
        .map_err(|e| format!("Failed to set connection PRAGMAs: {e}"))?;
    Ok(conn)
}

fn apply_startup_migrations(conn: &Connection) -> Result<(), String> {
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

    let has_mime: bool = conn
        .query_row(
            "SELECT COUNT(*) > 0 FROM pragma_table_info('covers') WHERE name = 'mime'",
            [],
            |row| row.get(0),
        )
        .unwrap_or(false);
    if !has_mime {
        conn.execute_batch("ALTER TABLE covers ADD COLUMN mime TEXT;")
            .ok();
    }

    run_v153_database_migrations(conn)
        .map_err(|e| format!("Failed to run v1.5.3 migrations: {e}"))?;

    run_v154_database_migrations(conn)
        .map_err(|e| format!("Failed to run v1.5.4 migrations: {e}"))?;

    run_v159_database_migrations(conn)
        .map_err(|e| format!("Failed to run v1.5.9 migrations: {e}"))?;

    match normalize_rss_timestamp_units(conn) {
        Ok(0) => {}
        Ok(n) => log::info!("[database] Converted {n} RSS timestamps from seconds to ms"),
        Err(e) => log::warn!("[database] RSS timestamp repair failed: {e}"),
    }

    Ok(())
}

const DB_SCHEMA_PERSISTENT_PRAGMAS: &str = r#"
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    -- Foreign keys are ON on every connection, pooled ones included: the
    -- bundled SQLite is compiled with SQLITE_DEFAULT_FOREIGN_KEYS=1. So a
    -- row that references a book needs the `books` row first (metadata saves
    -- insert it), and deleting a `books` row cascades. Deletes still clear
    -- related rows explicitly (see `delete_book_rows`).
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
    -- A book's annotations are read in edit order (`ORDER BY updated_at`).
    CREATE INDEX IF NOT EXISTS idx_book_annotations_book_updated
        ON book_annotations(book_id, updated_at);

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
    CREATE INDEX IF NOT EXISTS idx_rss_articles_feed_id ON rss_articles(feed_id);
    CREATE INDEX IF NOT EXISTS idx_rss_articles_published_at ON rss_articles(published_at);
    CREATE INDEX IF NOT EXISTS idx_rss_articles_feed_fetched ON rss_articles(feed_id, fetched_at DESC);
    CREATE INDEX IF NOT EXISTS idx_rss_articles_fetched_at ON rss_articles(fetched_at DESC);

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
    CREATE INDEX IF NOT EXISTS idx_reading_sessions_date_created ON reading_sessions(session_date DESC, created_at DESC);

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

/// Edits two devices made to the same item without seeing each other's
/// (see `record_sync_conflict`).
pub(super) const SYNC_CONFLICTS_SCHEMA: &str = r#"
    CREATE TABLE IF NOT EXISTS sync_conflicts (
        id TEXT PRIMARY KEY,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        label TEXT NOT NULL,
        winner TEXT NOT NULL,
        kept_json TEXT NOT NULL,
        discarded_json TEXT NOT NULL,
        kept_at INTEGER NOT NULL,
        discarded_at INTEGER NOT NULL,
        detected_at INTEGER NOT NULL,
        dismissed INTEGER NOT NULL DEFAULT 0
    );
"#;

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
                            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, unixepoch() * 1000, unixepoch())
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
                            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, unixepoch() * 1000, unixepoch())
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
    log::info!("[database] Completed Theorem v1.5.3 relational migrations successfully");
    Ok(())
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
    log::info!("[database] Completed Theorem v1.5.4 relational migrations successfully");
    Ok(())
}

pub fn run_v159_database_migrations(connection: &Connection) -> rusqlite::Result<()> {
    let is_done: bool = connection
        .query_row(
            "SELECT COUNT(*) > 0 FROM kv_store WHERE key = 'migration_v159_done'",
            [],
            |row| row.get(0),
        )
        .unwrap_or(false);

    if is_done {
        return Ok(());
    }

    // Add is_saved column to rss_articles (idempotent: ignore error if column already exists)
    let has_is_saved: bool = connection
        .query_row(
            "SELECT COUNT(*) > 0 FROM pragma_table_info('rss_articles') WHERE name = 'is_saved'",
            [],
            |row| row.get(0),
        )
        .unwrap_or(false);
    if !has_is_saved {
        connection
            .execute_batch(
                "ALTER TABLE rss_articles ADD COLUMN is_saved INTEGER NOT NULL DEFAULT 0;",
            )
            .ok();
    }

    connection.execute(
        "INSERT INTO kv_store (key, value, updated_at) VALUES ('migration_v159_done', '1', unixepoch())",
        [],
    )?;

    log::info!("[database] Completed Theorem v1.5.9 migrations (rss_articles.is_saved)");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::test_support::*;

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
}
