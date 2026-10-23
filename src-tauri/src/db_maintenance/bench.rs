//! Startup timing on a large, legacy-shaped library.
//!
//! `cargo test --release --lib db_maintenance::bench -- --ignored --nocapture --test-threads=1`
//!
//! The databases go under `$THEOREM_BENCH_DIR` (default `target/`), on disk:
//! a tmpfs `/tmp` counts against the memory limit of the build scope, and a
//! page-cache-only file would flatter the timings. "Cold" evicts the
//! database from the page cache first (Linux), like the first start after a
//! reboot.

use rusqlite::{params, Connection};
use std::path::{Path, PathBuf};
use std::time::Instant;

pub(super) const BOOKS: usize = 20_000;
pub(super) const ANNOTATIONS: usize = 50_000;
pub(super) const LEGACY_BLOB_BOOKS: usize = 200;
pub(super) const LEGACY_BLOB_SIZE: usize = 200 * 1024;
pub(super) const SYNCED_WITHOUT_FILE: usize = 2_000;
pub(super) const RSS_ARTICLES: usize = 2_000;
const COVER_BYTES: usize = 12 * 1024;
/// A StarDict dictionary still in `blob_store` (made 1.5.x startup fail).
const LEGACY_DICTIONARY: bool = true;

fn book_json(i: usize, synced_without_file: bool) -> String {
    serde_json::json!({
        "id": format!("book-{i:05}"),
        "title": format!("The Collected Works of Author {i}, Volume {}", i % 7),
        "author": format!("Author {}", i % 997),
        "description": "A long description of the book. ".repeat(12),
        "format": "epub",
        "filePath": format!("/home/reader/Books/book-{i:05}.epub"),
        "storagePath": "",
        "progress": (i % 100) as f64 / 100.0,
        "currentLocation": "epubcfi(/6/14!/4/2/10/2:118)",
        "addedAt": 1_700_000_000_000_i64 + i as i64,
        "lastReadAt": 1_710_000_000_000_i64 + i as i64,
        "tags": ["fiction", "classics"],
        "series": "Collected Works",
        "seriesIndex": (i % 7) as f64,
        "syncedWithoutFile": synced_without_file,
        "contentHash": format!("{i:064x}"),
    })
    .to_string()
}

fn annotation_json(i: usize, book: usize) -> String {
    serde_json::json!({
        "id": format!("anno-{i}"),
        "bookId": format!("book-{book:05}"),
        "type": "highlight",
        "location": "epubcfi(/6/14!/4/2/10/2:118,/1:0,/1:120)",
        "selectedText": "Some highlighted passage of moderate length that a reader cared about.",
        "color": "yellow",
        "createdAt": 1_710_000_000_000_i64 + i as i64,
    })
    .to_string()
}

fn legacy_rss_kv() -> String {
    let articles: Vec<_> = (0..RSS_ARTICLES)
        .map(|i| {
            serde_json::json!({
                "id": format!("art-{i}"),
                "feedId": format!("feed-{}", i % 20),
                "title": format!("Article {i}"),
                "url": format!("https://example.org/{i}"),
                "content": "<p>Paragraph of article text.</p>".repeat(100),
                "isRead": i % 3 == 0,
            })
        })
        .collect();
    let feeds: Vec<_> = (0..20)
        .map(|i| {
            serde_json::json!({
                "id": format!("feed-{i}"),
                "title": format!("Feed {i}"),
                "url": format!("https://example.org/feed{i}.xml"),
            })
        })
        .collect();
    serde_json::json!({ "state": { "feeds": feeds, "articles": articles } }).to_string()
}

/// A 20k-book library as an upgrade from an old version would leave it:
/// covers as data URLs, some books still stored in `books.data`, a StarDict
/// dictionary in `blob_store`, books flagged `syncedWithoutFile` (half of
/// them with the file on disk), an empty search index, and the v1.5.3/v1.5.4
/// relational migrations still to do.
pub(super) fn build_legacy_library(dir: &Path) -> PathBuf {
    use base64::Engine;
    let db_path = dir.join("theorem.db");
    // Current schema first, then roll the one-shot markers back.
    crate::database::run_schema_migrations_at(&db_path, dir).unwrap();
    let conn = Connection::open(&db_path).unwrap();
    conn.execute_batch(
        "DELETE FROM kv_store WHERE key LIKE 'migration_v15%_done';
         DELETE FROM books_fts;",
    )
    .unwrap();

    let cover_url = format!(
        "data:image/jpeg;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(vec![0xAB_u8; COVER_BYTES])
    );
    let cache_dir = dir.join("book-cache");
    std::fs::create_dir_all(&cache_dir).unwrap();
    let tx = conn.unchecked_transaction().unwrap();
    {
        let mut book = tx
            .prepare("INSERT INTO books (id, data) VALUES (?1, ?2)")
            .unwrap();
        let mut meta = tx
            .prepare("INSERT INTO book_metadata (book_id, metadata_json) VALUES (?1, ?2)")
            .unwrap();
        let mut cover = tx
            .prepare("INSERT INTO covers (book_id, data_url) VALUES (?1, ?2)")
            .unwrap();
        let legacy_blob = vec![0x50_u8; LEGACY_BLOB_SIZE];
        for i in 0..BOOKS {
            let id = format!("book-{i:05}");
            let data: &[u8] = if i < LEGACY_BLOB_BOOKS {
                &legacy_blob
            } else {
                &[]
            };
            book.execute(params![id, data]).unwrap();
            let synced_without_file = i >= BOOKS - SYNCED_WITHOUT_FILE;
            meta.execute(params![id, book_json(i, synced_without_file)])
                .unwrap();
            if synced_without_file && i % 2 == 0 {
                std::fs::write(cache_dir.join(format!("{id}.book")), b"PK").unwrap();
            }
            cover.execute(params![id, cover_url]).unwrap();
        }
        let mut anno = tx
            .prepare(
                "INSERT INTO book_annotations (id, book_id, annotation_json) VALUES (?1, ?2, ?3)",
            )
            .unwrap();
        for i in 0..ANNOTATIONS {
            let b = i % BOOKS;
            anno.execute(params![
                format!("anno-{i}"),
                format!("book-{b:05}"),
                annotation_json(i, b)
            ])
            .unwrap();
        }
        let dict = vec![0x11_u8; 512 * 1024];
        let parts = if LEGACY_DICTIONARY {
            vec![
                ("ifo", b"StarDict's dict ifo file\nversion=2.4.2\n".to_vec()),
                ("idx", vec![0x22_u8; 128 * 1024]),
                ("dict", dict),
            ]
        } else {
            Vec::new()
        };
        for (part, bytes) in parts {
            tx.execute(
                "INSERT INTO blob_store (key, data) VALUES (?1, ?2)",
                params![format!("theorem-stardict:dict-1:{part}"), bytes],
            )
            .unwrap();
        }
        tx.execute(
            "INSERT INTO kv_store (key, value) VALUES ('zustand:theorem-rss', ?1)",
            params![legacy_rss_kv()],
        )
        .unwrap();
    }
    tx.commit().unwrap();
    conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
        .unwrap();
    db_path
}

pub(super) fn bench_dir() -> tempfile::TempDir {
    let base = std::env::var_os("THEOREM_BENCH_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("target"));
    std::fs::create_dir_all(&base).unwrap();
    tempfile::tempdir_in(base).unwrap()
}

pub(super) fn timed<T>(label: &str, f: impl FnOnce() -> T) -> T {
    let started = Instant::now();
    let out = f();
    eprintln!(
        "  {label:<44} {:>9.1} ms",
        started.elapsed().as_secs_f64() * 1e3
    );
    out
}

fn db_size(db_path: &Path) -> u64 {
    std::fs::metadata(db_path).map(|m| m.len()).unwrap_or(0)
}

/// Drop every file under `dir` from the page cache.
fn evict(dir: &Path) {
    #[cfg(target_os = "linux")]
    for entry in walk(dir) {
        use std::os::fd::AsRawFd;
        if let Ok(f) = std::fs::File::open(&entry) {
            let _ = f.sync_all();
            // SAFETY: a valid open descriptor; advice only.
            unsafe {
                libc::posix_fadvise(f.as_raw_fd(), 0, 0, libc::POSIX_FADV_DONTNEED);
            }
        }
    }
    #[cfg(not(target_os = "linux"))]
    let _ = dir;
}

fn walk(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                out.extend(walk(&p));
            } else {
                out.push(p);
            }
        }
    }
    out
}

fn copy_dir(from: &Path, to: &Path) {
    for file in walk(from) {
        let rel = file.strip_prefix(from).unwrap();
        let dest = to.join(rel);
        std::fs::create_dir_all(dest.parent().unwrap()).unwrap();
        std::fs::copy(&file, &dest).unwrap();
    }
}

#[derive(Clone, Copy)]
enum Variant {
    /// 1.5.x / before this change: every pass inline in `setup()`.
    Before,
    /// Now: the startup migrations only; the rest on a background thread.
    After,
}

fn setup_db_work(
    which: Variant,
    db_path: &Path,
    dir: &Path,
    now: i64,
) -> crate::db_backup::DbHealth {
    crate::db_backup::startup_guard_at(db_path, dir, "1.6.0-bench", now, || match which {
        Variant::Before => crate::database::run_schema_migrations_at(db_path, dir),
        Variant::After => crate::database::run_startup_migrations_at(db_path),
    })
}

/// `setup()`'s database work before and after, for three kinds of start,
/// each cold and warm.
#[test]
#[ignore = "benchmark: builds a 20k-book database"]
fn startup_timing_large_library() {
    let tmp = bench_dir();
    let base = tmp.path().join("legacy");
    std::fs::create_dir_all(&base).unwrap();
    let db_path = timed("build legacy library", || build_legacy_library(&base));
    eprintln!("  database size: {} MB", db_size(&db_path) / (1024 * 1024));
    let now = 1_800_000_000;

    for (which, name) in [(Variant::Before, "BEFORE"), (Variant::After, "AFTER")] {
        for cold in [true, false] {
            let dir = tmp.path().join(format!("{name}-{cold}"));
            copy_dir(&base, &dir);
            let db = dir.join("theorem.db");
            eprintln!(
                "{name} ({}):",
                if cold {
                    "cold page cache"
                } else {
                    "warm page cache"
                }
            );
            let prime = |dir: &Path| {
                if cold {
                    evict(dir);
                } else {
                    for f in walk(dir) {
                        let _ = std::fs::read(f);
                    }
                }
            };
            prime(&dir);
            let health = timed("first start after upgrade (check due)", || {
                setup_db_work(which, &db, &dir, now)
            });
            assert_eq!(health.status, crate::db_backup::DbStatus::Ok, "{health:?}");
            if let Variant::After = which {
                let conn = Connection::open(&db).unwrap();
                let report = timed("  background maintenance (off the path)", || {
                    super::run_maintenance(&dir, |f| f(&conn))
                });
                if report.vacuum_pending {
                    timed("  background VACUUM (when idle)", || {
                        super::vacuum_now(&conn).unwrap()
                    });
                }
                assert!(report.failed_steps.is_empty(), "{report:?}");
            }
            std::fs::remove_file(dir.join("db-health.json")).ok();
            prime(&dir);
            timed("next start, new version (check due)", || {
                setup_db_work(which, &db, &dir, now + 10)
            });
            prime(&dir);
            timed("everyday start (check not due)", || {
                setup_db_work(which, &db, &dir, now + 20)
            });
            // The daily check of a same-version start: only `quick_check`
            // before the window; the snapshot is left to the maintenance thread.
            let daily = now + 30 + crate::db_backup::CHECK_INTERVAL_SECS;
            prime(&dir);
            let health = timed("daily check, same version", || {
                setup_db_work(which, &db, &dir, daily)
            });
            if health.snapshot_deferred {
                timed("  deferred snapshot (off the path)", || {
                    crate::db_backup::take_deferred_snapshot_at(&db, &dir, "1.6.0-bench", daily + 3)
                        .unwrap()
                });
            }
            std::fs::remove_dir_all(&dir).ok();
        }
    }
}

/// Each step of the old migration pass on its own, in the order it ran.
#[test]
#[ignore = "benchmark: builds a 20k-book database"]
fn startup_step_timing_large_library() {
    use crate::database as db;
    let tmp = bench_dir();
    let dir = tmp.path();
    let db_path = build_legacy_library(dir);
    let conn = Connection::open(&db_path).unwrap();
    for pass in ["first start after upgrade", "next start"] {
        eprintln!("{pass}:");
        timed("quick_check", || {
            crate::db_backup::quick_check(&conn).unwrap()
        });
        timed("snapshot", || {
            crate::db_backup::take_snapshot(&conn, dir, "bench", 1_800_000_000).unwrap()
        });
        timed("cover data URLs -> bytes", || {
            db::migrate_cover_data_urls(&conn).unwrap()
        });
        let books = timed("legacy book BLOB reclaim", || {
            db::reclaim_legacy_book_blobs(&conn, dir).unwrap()
        });
        let dicts = timed("legacy StarDict BLOB reclaim", || {
            db::reclaim_legacy_stardict_blobs(&conn, dir).unwrap()
        });
        timed("syncedWithoutFile heal", || {
            db::reconcile_synced_without_file_metadata(&conn, dir).unwrap()
        });
        timed("legacy directory cleanup", || {
            db::cleanup_legacy_directories(dir)
        });
        if books > 0 || dicts > 0 {
            timed("VACUUM", || conn.execute_batch("VACUUM").unwrap());
        }
        timed("v1.5.3 migration", || {
            db::run_v153_database_migrations(&conn).unwrap()
        });
        timed("v1.5.4 migration", || {
            db::run_v154_database_migrations(&conn).unwrap()
        });
        timed("v1.5.9 migration", || {
            db::run_v159_database_migrations(&conn).unwrap()
        });
        timed("RSS timestamp units", || {
            db::normalize_rss_timestamp_units(&conn).unwrap()
        });
        timed("books_fts reconcile", || {
            db::reconcile_books_fts(&conn).unwrap()
        });
    }
}
