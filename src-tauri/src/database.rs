//! SQLite persistence. The pool, `with_connection` and `DataStore` live
//! here; each domain has its own module, re-exported so every
//! `crate::database::...` path stays the same.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tauri::{AppHandle, Manager};

use crate::error::pool_error_kind;
pub use crate::error::AppError;
use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;

mod annotations;
mod books;
mod covers;
mod files;
mod kv;
mod legacy;
mod reading;
mod rss;
mod schema;
mod storage;
mod sync_conflicts;
mod sync_merge;
#[cfg(test)]
mod test_support;
mod vocabulary;

pub use annotations::*;
pub use books::*;
pub use covers::*;
pub(crate) use files::*;
pub use kv::*;
pub(crate) use legacy::*;
pub use reading::*;
pub use rss::*;
pub use schema::*;
pub use storage::*;
pub use sync_conflicts::*;
pub use sync_merge::*;
pub use vocabulary::*;

type DbPool = Pool<SqliteConnectionManager>;

static DB_POOL: OnceLock<DbPool> = OnceLock::new();

const DB_FILE_NAME: &str = "theorem.db";
const MATERIALIZED_BOOK_CACHE_DIR: &str = "book-cache";

fn app_data_dir_of(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve app data directory: {error}"))
}

fn database_path_in(app_data_dir: &Path) -> Result<PathBuf, String> {
    fs::create_dir_all(app_data_dir).map_err(|error| {
        format!("Failed to create app data directory '{app_data_dir:?}': {error}")
    })?;
    Ok(app_data_dir.join(DB_FILE_NAME))
}

fn database_path(app: &AppHandle) -> Result<PathBuf, String> {
    database_path_in(&app_data_dir_of(app)?)
}

/// The database and the app data folder it lives in, without an `AppHandle`.
///
/// The app gets one from its handle (sharing the app's pool); the headless
/// CLI opens one from the folder alone, so it runs without a display. Every
/// function here that only needs the folder takes a `DataStore`, and the
/// app's commands are thin wrappers that build one from the `AppHandle`.
#[derive(Clone)]
pub struct DataStore {
    dir: PathBuf,
    pool: DbPool,
}

impl DataStore {
    /// Open the database in `app_data_dir` with a pool of its own (not the
    /// app's global pool), creating the folder when needed. Schema
    /// migrations are not run; see `run_schema_migrations_in`. Used by the
    /// CLI, which is not built for Android.
    #[cfg_attr(target_os = "android", allow(dead_code))]
    pub fn open(app_data_dir: &Path) -> Result<Self, String> {
        let db_path = database_path_in(app_data_dir)?;
        let pool = build_db_pool(&db_path, 2)?;
        Ok(Self {
            dir: app_data_dir.to_path_buf(),
            pool,
        })
    }

    /// The app's own store: its data folder and the shared pool.
    pub fn for_app(app: &AppHandle) -> Result<Self, String> {
        let dir = app_data_dir_of(app)?;
        let pool = init_db_pool(&database_path_in(&dir)?)?.clone();
        Ok(Self { dir, pool })
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn with_connection<T, F>(&self, operation: F) -> Result<T, AppError>
    where
        F: FnOnce(&Connection) -> rusqlite::Result<T>,
    {
        run_on_pool(&self.pool, operation)
    }

    /// `book-cache/{id}.book`, creating the cache folder when needed.
    pub fn materialized_book_path(&self, book_id: &str) -> Result<PathBuf, AppError> {
        materialized_book_path_creating(&self.dir, book_id)
    }
}

#[cfg(target_os = "android")]
const DB_POOL_MAX_SIZE: u32 = 2;
#[cfg(not(target_os = "android"))]
const DB_POOL_MAX_SIZE: u32 = 4;

fn build_db_pool(db_path: &Path, max_size: u32) -> Result<DbPool, AppError> {
    let manager = SqliteConnectionManager::file(db_path);
    Pool::builder()
        .max_size(max_size)
        .connection_customizer(Box::new(SqlitePerConnectionPragmas))
        .build(manager)
        .map_err(|error| {
            AppError::new(
                pool_error_kind(&error),
                format!("Failed to create SQLite connection pool: {error}"),
            )
        })
}

fn init_db_pool(db_path: &Path) -> Result<&DbPool, AppError> {
    if let Some(pool) = DB_POOL.get() {
        return Ok(pool);
    }

    let pool = build_db_pool(db_path, DB_POOL_MAX_SIZE)?;

    DB_POOL.set(pool).ok();
    DB_POOL
        .get()
        .ok_or_else(|| "Failed to initialize database pool".into())
}

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

/// Whether the shared pool has opened the database file (see `db_backup`).
pub(crate) fn db_pool_initialized() -> bool {
    DB_POOL.get().is_some()
}

pub fn with_connection<T, F>(app: &AppHandle, operation: F) -> Result<T, AppError>
where
    F: FnOnce(&Connection) -> rusqlite::Result<T>,
{
    let db_path = database_path(app)?;
    let pool = init_db_pool(&db_path)?;
    run_on_pool(pool, operation)
}

/// Run `operation` on a pooled connection. Errors keep the messages they
/// always had ("SQLite operation failed: …") and gain a kind: busy, corrupt,
/// constraint, not found (see `crate::error`).
fn run_on_pool<T, F>(pool: &DbPool, operation: F) -> Result<T, AppError>
where
    F: FnOnce(&Connection) -> rusqlite::Result<T>,
{
    let connection = pool.get().map_err(|error| {
        AppError::new(
            pool_error_kind(&error),
            format!("Failed to acquire SQLite connection from pool: {error}"),
        )
    })?;
    operation(&connection).map_err(|error| AppError::from_sqlite("SQLite operation failed", &error))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::test_support::*;

    /// Production connections enforce foreign keys: the bundled SQLite is
    /// built with SQLITE_DEFAULT_FOREIGN_KEYS=1 and nothing turns them off.
    /// `setup_db` below matches this.
    #[test]
    fn pooled_connections_enforce_foreign_keys() {
        let dir = tempfile::tempdir().unwrap();
        run_schema_migrations_in(dir.path()).unwrap();
        let store = DataStore::open(dir.path()).unwrap();
        let on: i64 = store
            .with_connection(|c| c.query_row("PRAGMA foreign_keys", [], |r| r.get(0)))
            .unwrap();
        assert_eq!(on, 1);
        let orphan = store.with_connection(|c| {
            c.execute(
                "INSERT INTO book_annotations(id, book_id, annotation_json) VALUES('a', 'missing', '{}')",
                [],
            )
        });
        assert!(
            orphan.is_err(),
            "an annotation of a missing book must be rejected"
        );
        // A metadata save creates the `books` row the annotation needs.
        store
            .with_connection(|c| {
                sqlite_save_book_metadata_inner(c, "b1", r#"{"id":"b1","title":"T"}"#)?;
                sqlite_upsert_annotation_inner(c, "a1", "b1", r#"{"id":"a1"}"#)
            })
            .unwrap();
    }

    /// `with_connection` keeps its "SQLite operation failed: …" text and
    /// adds the kind.
    #[test]
    fn with_connection_errors_carry_a_kind() {
        use crate::error::ErrorKind;
        let (_dir, store) = migrated_store();
        let duplicate = store
            .with_connection(|c| {
                sqlite_set_kv_inner(c, "k", "v")?;
                c.execute(
                    "INSERT INTO kv_store(key, value, updated_at) VALUES('k', 'v', 0)",
                    [],
                )
            })
            .unwrap_err();
        assert_eq!(duplicate.kind(), ErrorKind::Constraint);
        assert!(duplicate
            .message()
            .starts_with("SQLite operation failed: UNIQUE constraint failed"));
        let missing = store
            .with_connection(|c| c.query_row("SELECT 1 WHERE 0", [], |r| r.get::<_, i64>(0)))
            .unwrap_err();
        assert_eq!(missing.kind(), ErrorKind::NotFound);

        // A damaged file fails while the pool prepares a connection (the
        // per-connection pragmas read the header); the kind survives r2d2.
        let garbage = tempfile::tempdir().unwrap();
        let path = garbage.path().join(DB_FILE_NAME);
        std::fs::write(&path, vec![0x5au8; 8192]).unwrap();
        let pool = Pool::builder()
            .min_idle(Some(0))
            .connection_timeout(std::time::Duration::from_millis(300))
            .connection_customizer(Box::new(SqlitePerConnectionPragmas))
            .build_unchecked(SqliteConnectionManager::file(&path));
        let error = run_on_pool(&pool, |c| {
            c.query_row("SELECT COUNT(*) FROM sqlite_master", [], |r| {
                r.get::<_, i64>(0)
            })
        })
        .unwrap_err();
        assert_eq!(error.kind(), ErrorKind::Corrupt, "{error}");
    }

    /// `cargo test --release --lib db_query_bench -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn db_query_bench() {
        use std::time::Instant;
        let (_dir, store) = migrated_store();
        store
            .with_connection(|c| {
                c.execute_batch("BEGIN")?;
                for i in 0..20_000 {
                    let id = format!("book-{i:05}");
                    sqlite_save_book_metadata_inner(c, &id, &format!(r#"{{"id":"{id}"}}"#))?;
                    c.execute(
                        "INSERT INTO books_fts(id, title, author) VALUES(?1, ?2, 'Author')",
                        params![id, format!("Title {i}")],
                    )?;
                }
                for i in 0..50_000 {
                    c.execute(
                        "INSERT INTO book_annotations(id, book_id, annotation_json, updated_at) VALUES(?1, ?2, '{}', ?3)",
                        params![format!("a{i}"), format!("book-{:05}", i % 20_000), (i * 7919) % 100_000],
                    )?;
                }
                for i in 0..5_000 {
                    let prefix = ["theorem-stardict:", "zustand:", "theorem-rss-", "reader:"][i % 4];
                    sqlite_set_kv_inner(c, &format!("{prefix}{i}"), "v")?;
                    sqlite_set_blob_inner(c, &format!("{prefix}{i}"), b"data")?;
                }
                c.execute_batch("COMMIT")
            })
            .unwrap();
        let time = |label: &str, runs: u32, f: &dyn Fn(&Connection)| {
            store
                .with_connection(|c| {
                    f(c);
                    let start = Instant::now();
                    for _ in 0..runs {
                        f(c);
                    }
                    let per = start.elapsed().as_secs_f64() * 1e6 / runs as f64;
                    println!("{label:<40} {per:>10.1} us/call");
                    Ok(())
                })
                .unwrap();
        };
        time("kv count by prefix", 200, &|c| {
            sqlite_count_kv_by_prefix_inner(c, "theorem-stardict:").unwrap();
        });
        time("blob stats by prefix", 200, &|c| {
            sqlite_get_blob_stats_inner(c, Some("theorem-stardict:".into())).unwrap();
        });
        time("books window first page (50)", 100, &|c| {
            sqlite_query_books_window_inner(c, 50, 0).unwrap();
        });
        time("books window mid page (50 @ 10k)", 100, &|c| {
            sqlite_query_books_window_inner(c, 50, 10_000).unwrap();
        });
        time("books window last page (50 @ 19980)", 100, &|c| {
            sqlite_query_books_window_inner(c, 50, 19_980).unwrap();
        });
        time("annotations of one book", 1000, &|c| {
            sqlite_get_book_annotations_inner(c, "book-01234").unwrap();
        });
    }
}
