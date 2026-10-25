//! Storage statistics, orphan cleanup and clearing all data.

use super::*;

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

pub fn sqlite_get_storage_stats(app: AppHandle) -> Result<SqliteStorageStats, AppError> {
    get_storage_stats_in(&DataStore::for_app(&app)?)
}

pub fn get_storage_stats_in(store: &DataStore) -> Result<SqliteStorageStats, AppError> {
    let mut binaries_size = 0;

    if let Ok(entries) = std::fs::read_dir(store.dir().join(MATERIALIZED_BOOK_CACHE_DIR)) {
        for entry in entries.flatten() {
            if let Ok(metadata) = entry.metadata() {
                binaries_size += metadata.len();
            }
        }
    }

    store.with_connection(|connection| {
        let (total_books, legacy_binaries_size): (u64, u64) = connection.query_row(
            "SELECT COUNT(*) AS total_books, COALESCE(SUM(length(data)), 0) AS legacy_binaries_size FROM books WHERE id NOT LIKE 'rss:%'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;

        let covers_size: u64 = connection.query_row(
            "SELECT COALESCE(SUM(COALESCE(length(data), 0) + length(data_url)), 0) FROM covers",
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

pub fn sqlite_cleanup_orphaned_storage(
    app: AppHandle,
    existing_book_ids: Vec<String>,
) -> Result<SqliteCleanupResult, AppError> {
    cleanup_orphaned_storage_in(&DataStore::for_app(&app)?, existing_book_ids)
}

pub fn cleanup_orphaned_storage_in(
    store: &DataStore,
    existing_book_ids: Vec<String>,
) -> Result<SqliteCleanupResult, AppError> {
    store.with_connection(|connection| {
        let existing_ids: HashSet<String> = existing_book_ids.into_iter().collect();

        let mut removed_books = 0_u64;
        let mut removed_covers = 0_u64;

        let existing_rows: Vec<String> = {
            let mut statement = connection.prepare("SELECT id FROM books")?;
            let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
            rows.collect::<rusqlite::Result<Vec<String>>>()?
        };

        for id in existing_rows {
            // Deleting a `books` row cascades to its highlights: an RSS
            // article's anchor row is never an orphan.
            if !existing_ids.contains(&id) && !is_article_anchor(&id) {
                remove_materialized_cache_file_in(store.dir(), &id);
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
    let tx = connection.unchecked_transaction()?;
    tx.execute("DELETE FROM covers", [])?;
    tx.execute("DELETE FROM materialized_books", [])?;
    tx.execute("DELETE FROM book_metadata", [])?;
    tx.execute("DELETE FROM book_annotations", [])?;
    tx.execute("DELETE FROM books_fts", [])?;
    tx.execute("DELETE FROM books", [])?;
    tx.execute("DELETE FROM blob_store", [])?;
    tx.execute("DELETE FROM kv_store", [])?;
    tx.commit()
}

pub fn sqlite_clear_all_storage(app: AppHandle) -> Result<(), AppError> {
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

pub fn sqlite_shrink_memory(app: AppHandle) -> Result<(), AppError> {
    with_connection(&app, |connection| {
        connection.execute_batch("PRAGMA shrink_memory; PRAGMA wal_checkpoint(PASSIVE);")
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::test_support::*;

    /// Highlights made in an RSS article (book id `rss:<article id>`) have no
    /// book. With foreign keys on they used to be rejected; they are stored,
    /// and storage cleanup does not delete them as an orphaned book (deleting
    /// the `books` row would cascade to them).
    #[test]
    fn article_highlights_are_stored_and_survive_cleanup() {
        let dir = tempfile::tempdir().unwrap();
        run_schema_migrations_in(dir.path()).unwrap();
        let store = DataStore::open(dir.path()).unwrap();
        store
            .with_connection(|c| {
                sqlite_upsert_annotation_inner(c, "h1", "rss:art1", r#"{"id":"h1"}"#)?;
                sqlite_save_book_annotations_inner(c, "rss:art2", &[r#"{"id":"h2"}"#.to_string()])?;
                sqlite_save_book_metadata_inner(c, "b1", r#"{"id":"b1","title":"Kept"}"#)?;
                sqlite_register_materialized_book_inner(c, "orphan")
            })
            .unwrap();
        let result = cleanup_orphaned_storage_in(&store, vec!["b1".to_string()]).unwrap();
        assert_eq!(result.removed_books, 1, "only the orphaned book goes");
        let highlights = store
            .with_connection(sqlite_get_all_annotations_inner)
            .unwrap();
        assert_eq!(highlights.len(), 2);
        let stats = get_storage_stats_in(&store).unwrap();
        assert_eq!(stats.total_books, 1, "article anchors are not books");
        // Clearing a removed book's highlights does not recreate its row.
        store
            .with_connection(|c| sqlite_save_book_annotations_inner(c, "gone", &[]))
            .unwrap();
        let gone: i64 = store
            .with_connection(|c| {
                c.query_row("SELECT COUNT(*) FROM books WHERE id = 'gone'", [], |r| {
                    r.get(0)
                })
            })
            .unwrap();
        assert_eq!(gone, 0);
    }

    #[test]
    fn clear_all_storage_removes_library_tables() {
        let conn = setup_db();
        seed_book(&conn, "b1", "Book");
        sqlite_clear_all_storage_inner(&conn).unwrap();
        assert_eq!(rows_for_book(&conn, "b1"), []);
    }

    #[test]
    fn clear_all_storage_is_atomic() {
        let conn = setup_db();
        sqlite_set_kv_inner(&conn, "k1", "v1").unwrap();
        sqlite_save_cover_image_inner(&conn, "book1", "data:,").unwrap();
        conn.execute_batch(
            "CREATE TRIGGER fail_kv_delete BEFORE DELETE ON kv_store
             BEGIN SELECT RAISE(ABORT, 'boom'); END;",
        )
        .unwrap();
        assert!(sqlite_clear_all_storage_inner(&conn).is_err());
        assert!(sqlite_get_cover_image_inner(&conn, "book1")
            .unwrap()
            .is_some());
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
}
