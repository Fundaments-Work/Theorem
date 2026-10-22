use super::*;
use rusqlite::{params, Connection};
use std::path::{Path, PathBuf};

const COVER_PNG_URL: &str = "data:image/png;base64,iVBORw0KGgo=";

/// The current schema, created the way the app does at startup.
fn fresh_db(dir: &Path) -> (PathBuf, Connection) {
    let db_path = dir.join("theorem.db");
    crate::database::run_startup_migrations_at(&db_path).unwrap();
    let conn = Connection::open(&db_path).unwrap();
    (db_path, conn)
}

fn book_meta(id: &str, synced_without_file: bool) -> String {
    serde_json::json!({
        "id": id, "title": format!("Title {id}"), "author": "Someone",
        "syncedWithoutFile": synced_without_file,
    })
    .to_string()
}

/// Every legacy shape the deferred steps handle, one of each.
fn seed_legacy(conn: &Connection, dir: &Path) {
    conn.execute_batch("DELETE FROM books_fts;").unwrap();
    conn.execute(
        "INSERT INTO books (id, data) VALUES ('blob-book', ?1), ('plain', X''), ('healable', X'')",
        params![vec![7_u8; 4096]],
    )
    .unwrap();
    for (id, swf) in [("blob-book", false), ("plain", false), ("healable", true)] {
        conn.execute(
            "INSERT INTO book_metadata (book_id, metadata_json) VALUES (?1, ?2)",
            params![id, book_meta(id, swf)],
        )
        .unwrap();
    }
    conn.execute(
        "INSERT INTO covers (book_id, data_url) VALUES ('plain', ?1)",
        params![COVER_PNG_URL],
    )
    .unwrap();
    for (part, bytes) in [
        (
            "ifo",
            b"StarDict's dict ifo file\nversion=2.4.2\nwordcount=1\n".to_vec(),
        ),
        ("idx", vec![1_u8; 32]),
        ("dict", vec![2_u8; 64]),
    ] {
        conn.execute(
            "INSERT INTO blob_store (key, data) VALUES (?1, ?2)",
            params![format!("theorem-stardict:d1:{part}"), bytes],
        )
        .unwrap();
    }
    let cache = dir.join("book-cache");
    std::fs::create_dir_all(&cache).unwrap();
    std::fs::write(cache.join("healable.book"), b"PK").unwrap();
}

fn on(conn: &Connection) -> impl FnMut(&mut Step<'_>) -> Result<(), String> + '_ {
    move |f| f(conn)
}

fn count(conn: &Connection, sql: &str) -> i64 {
    conn.query_row(sql, [], |r| r.get(0)).unwrap()
}

#[test]
fn startup_path_leaves_the_deferred_work_alone() {
    let tmp = tempfile::tempdir().unwrap();
    let (db_path, conn) = fresh_db(tmp.path());
    seed_legacy(&conn, tmp.path());

    crate::database::run_startup_migrations_at(&db_path).unwrap();

    assert_eq!(
        count(&conn, "SELECT COUNT(*) FROM covers WHERE data IS NULL"),
        1
    );
    assert_eq!(
        count(&conn, "SELECT COUNT(*) FROM books WHERE length(data) > 0"),
        1
    );
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM blob_store"), 3);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM books_fts"), 0);
    // …while the versioned migrations the interface reads are done.
    for key in [
        "migration_v153_done",
        "migration_v154_done",
        "migration_v159_done",
    ] {
        assert_eq!(
            count(
                &conn,
                &format!("SELECT COUNT(*) FROM kv_store WHERE key = '{key}'")
            ),
            1,
            "{key}"
        );
    }
}

#[test]
fn maintenance_does_everything_the_old_startup_pass_did() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    let (_, conn) = fresh_db(dir);
    seed_legacy(&conn, dir);

    let report = run_maintenance(dir, on(&conn));
    assert_eq!(
        report,
        MaintenanceReport {
            covers_converted: 1,
            books_reclaimed: 1,
            dict_entries_reclaimed: 3,
            books_healed: 1,
            healed: vec![crate::database::HealedBook {
                id: "healable".into(),
                storage_path: dir
                    .join("book-cache/healable.book")
                    .to_string_lossy()
                    .into_owned(),
            }],
            fts_rows_changed: 3,
            vacuum_pending: true,
            failed_steps: vec![],
        }
    );

    // Cover as bytes.
    assert_eq!(
        count(&conn, "SELECT COUNT(*) FROM covers WHERE data IS NULL"),
        0
    );
    // Book BLOB moved to its cache file.
    assert_eq!(
        count(&conn, "SELECT COUNT(*) FROM books WHERE length(data) > 0"),
        0
    );
    assert_eq!(
        std::fs::read(dir.join("book-cache/blob-book.book")).unwrap(),
        vec![7_u8; 4096]
    );
    // Dictionary on disk, BLOBs gone (this step failed outright before:
    // it read a `value` column that `blob_store` does not have).
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM blob_store"), 0);
    assert!(crate::stardict::is_valid_stardict_dir(
        &dir.join("dictionaries/d1")
    ));
    // Healed.
    let healed: String = conn
        .query_row(
            "SELECT metadata_json FROM book_metadata WHERE book_id = 'healable'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(healed.contains("\"syncedWithoutFile\":false"), "{healed}");
    // Search index rebuilt.
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM books_fts"), 3);

    // Idempotent: a second start finds nothing to do but the pending VACUUM.
    let again = run_maintenance(dir, on(&conn));
    assert_eq!(
        again,
        MaintenanceReport {
            vacuum_pending: true,
            ..Default::default()
        }
    );
}

#[test]
fn vacuum_runs_once_and_clears_the_flag() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    let (db_path, conn) = fresh_db(dir);
    conn.execute(
        "INSERT INTO books (id, data) VALUES ('big', ?1)",
        params![vec![9_u8; 4 * 1024 * 1024]],
    )
    .unwrap();
    conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
        .unwrap();
    let before = std::fs::metadata(&db_path).unwrap().len();

    let report = run_maintenance(dir, on(&conn));
    assert!(report.vacuum_pending);
    vacuum_now(&conn).unwrap();
    assert!(!vacuum_pending(&conn).unwrap());
    let after = std::fs::metadata(&db_path).unwrap().len();
    assert!(after < before / 2, "{before} -> {after}");
    assert!(!run_maintenance(dir, on(&conn)).vacuum_pending);
}

#[test]
fn inline_maintenance_vacuums_at_once() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    let (_, conn) = fresh_db(dir);
    conn.execute(
        "INSERT INTO books (id, data) VALUES ('big', ?1)",
        params![vec![9_u8; 1024 * 1024]],
    )
    .unwrap();
    let report = run_maintenance_inline(dir, &conn);
    assert_eq!(report.books_reclaimed, 1);
    assert!(!vacuum_pending(&conn).unwrap());
}

#[test]
fn a_failing_step_is_skipped_and_the_rest_still_run() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    let (_, conn) = fresh_db(dir);
    seed_legacy(&conn, dir);
    // A broken search index must not stop the other repairs.
    conn.execute_batch("DROP TABLE books_fts;").unwrap();

    let report = run_maintenance(dir, on(&conn));
    assert_eq!(report.failed_steps, vec!["books_fts reconcile"]);
    assert_eq!(report.covers_converted, 1);
    assert_eq!(report.books_reclaimed, 1);
    assert_eq!(report.books_healed, 1);
}

#[test]
fn no_connection_means_every_step_is_reported_not_panicked() {
    let tmp = tempfile::tempdir().unwrap();
    let report = run_maintenance(tmp.path(), |_| Err("pool exhausted".to_string()));
    assert_eq!(report.failed_steps.len(), 6, "{report:?}");
    assert!(!report.vacuum_pending);
}

#[test]
fn an_empty_database_needs_nothing() {
    let tmp = tempfile::tempdir().unwrap();
    let (_, conn) = fresh_db(tmp.path());
    assert_eq!(
        run_maintenance(tmp.path(), on(&conn)),
        MaintenanceReport::default()
    );
}

#[test]
fn cover_conversion_handles_many_rows_and_skips_bad_urls() {
    let tmp = tempfile::tempdir().unwrap();
    let (_, conn) = fresh_db(tmp.path());
    for i in 0..1000 {
        conn.execute(
            "INSERT INTO books (id, data) VALUES (?1, X'')",
            params![format!("b{i}")],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO covers (book_id, data_url, updated_at) VALUES (?1, ?2, 42)",
            params![
                format!("b{i}"),
                if i % 100 == 0 {
                    "not a data url"
                } else {
                    COVER_PNG_URL
                }
            ],
        )
        .unwrap();
    }
    assert_eq!(
        crate::database::migrate_cover_data_urls(&conn).unwrap(),
        990
    );
    assert_eq!(crate::database::migrate_cover_data_urls(&conn).unwrap(), 0);
    assert_eq!(
        count(&conn, "SELECT COUNT(*) FROM covers WHERE data IS NULL"),
        10
    );
    assert_eq!(
        count(&conn, "SELECT COUNT(*) FROM covers WHERE updated_at != 42"),
        0
    );
}

#[test]
fn cover_conversion_never_overwrites_a_cover_saved_meanwhile() {
    let tmp = tempfile::tempdir().unwrap();
    let (_, conn) = fresh_db(tmp.path());
    conn.execute("INSERT INTO books (id, data) VALUES ('b', X'')", [])
        .unwrap();
    conn.execute(
        "INSERT INTO covers (book_id, data_url) VALUES ('b', ?1)",
        params![COVER_PNG_URL],
    )
    .unwrap();
    // The app saves a new cover after the conversion read the old URL.
    crate::database::sqlite_save_cover_image_inner(&conn, "b", "data:image/jpeg;base64,/9j/4AAQ")
        .unwrap();
    let converted = crate::database::convert_cover_data_url(&conn, "b", COVER_PNG_URL).unwrap();
    assert!(!converted);
    let mime: String = conn
        .query_row("SELECT mime FROM covers WHERE book_id = 'b'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(mime, "image/jpeg");
}

#[test]
fn heal_never_overwrites_metadata_changed_meanwhile() {
    let tmp = tempfile::tempdir().unwrap();
    let (_, conn) = fresh_db(tmp.path());
    let stale = book_meta("b", true);
    conn.execute("INSERT INTO books (id, data) VALUES ('b', X'')", [])
        .unwrap();
    conn.execute(
        "INSERT INTO book_metadata (book_id, metadata_json) VALUES ('b', ?1)",
        params![book_meta("b", true).replace("Title b", "Renamed meanwhile")],
    )
    .unwrap();
    let written =
        crate::database::write_healed_metadata(&conn, "b", &stale, "{\"healed\":true}").unwrap();
    assert!(!written);
    let now: String = conn
        .query_row(
            "SELECT metadata_json FROM book_metadata WHERE book_id = 'b'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(now.contains("Renamed meanwhile"));
}

#[test]
fn legacy_book_reclaim_never_clobbers_a_file_written_meanwhile() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("book-cache").join("b.book");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    assert!(crate::database::create_file_if_absent(&path, b"old blob").unwrap());
    assert_eq!(std::fs::read(&path).unwrap(), b"old blob");
    std::fs::write(&path, b"new book").unwrap();
    assert!(!crate::database::create_file_if_absent(&path, b"old blob").unwrap());
    assert_eq!(std::fs::read(&path).unwrap(), b"new book");
    // No temporary files left behind.
    assert_eq!(
        std::fs::read_dir(path.parent().unwrap()).unwrap().count(),
        1
    );
}

#[test]
fn quiet_wait_returns_once_writes_stop() {
    let tmp = tempfile::tempdir().unwrap();
    let db = tmp.path().join("theorem.db");
    std::fs::write(&db, b"x").unwrap();
    let started = Instant::now();
    assert!(wait_until_quiet(
        &db,
        Duration::from_millis(150),
        Duration::from_millis(20),
        Duration::from_secs(5),
        std::thread::sleep,
    ));
    assert!(started.elapsed() >= Duration::from_millis(100));
}

#[test]
fn quiet_wait_gives_up_while_the_app_keeps_writing() {
    let tmp = tempfile::tempdir().unwrap();
    let db = tmp.path().join("theorem.db");
    let wal = tmp.path().join("theorem.db-wal");
    std::fs::write(&db, b"x").unwrap();
    let mut n = 0_u32;
    // Each poll sees a fresh write to the WAL.
    let quiet = wait_until_quiet(
        &db,
        Duration::from_secs(10),
        Duration::from_millis(10),
        Duration::from_millis(200),
        |d| {
            n += 1;
            std::fs::write(&wal, n.to_le_bytes()).unwrap();
            std::thread::sleep(d);
        },
    );
    assert!(!quiet);
}

#[test]
fn quiet_wait_with_no_database_file_is_quiet_only_after_waiting() {
    // A missing file counts as just written: never VACUUM something we
    // cannot see.
    let tmp = tempfile::tempdir().unwrap();
    assert!(!wait_until_quiet(
        &tmp.path().join("missing.db"),
        Duration::from_secs(10),
        Duration::from_millis(10),
        Duration::from_millis(50),
        std::thread::sleep,
    ));
}

// ─── Ordering: what `setup()` does before the window, and what waits ────────

fn setup_guard(db_path: &Path, dir: &Path) -> crate::db_backup::DbHealth {
    crate::db_backup::startup_guard_at(db_path, dir, "1.6.0-test", 1_800_000_000, || {
        crate::database::run_startup_migrations_at(db_path)
    })
}

#[test]
fn maintenance_waits_for_a_guard_that_passed() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    let (db_path, conn) = fresh_db(dir);
    seed_legacy(&conn, dir);
    drop(conn);

    let health = setup_guard(&db_path, dir);
    assert!(health.checked, "first start of a version checks");
    assert!(may_run_after(&health));
    // The guard ran the startup migrations, not the deferred work…
    let conn = Connection::open(&db_path).unwrap();
    assert_eq!(
        count(&conn, "SELECT COUNT(*) FROM covers WHERE data IS NULL"),
        1
    );
    // …which then finds the current schema in place.
    let report = run_maintenance(dir, on(&conn));
    assert!(report.failed_steps.is_empty(), "{report:?}");
    assert_eq!(report.covers_converted, 1);
}

#[test]
fn no_maintenance_on_a_damaged_database() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    let db_path = dir.join("theorem.db");
    let garbage = vec![0x5A_u8; 64 * 1024];
    std::fs::write(&db_path, &garbage).unwrap();

    let health = setup_guard(&db_path, dir);
    assert_ne!(health.status, crate::db_backup::DbStatus::Ok);
    assert!(!may_run_after(&health));
    // Left exactly as found, for the restore screen.
    assert_eq!(std::fs::read(&db_path).unwrap(), garbage);
}

#[test]
fn no_maintenance_after_a_failed_migration() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    let (db_path, conn) = fresh_db(dir);
    drop(conn);
    let health = crate::db_backup::startup_guard_at(&db_path, dir, "1.6.0-test", 1, || {
        Err("migration step failed".to_string())
    });
    assert_eq!(health.status, crate::db_backup::DbStatus::MigrationFailed);
    assert!(!may_run_after(&health));
}

#[test]
fn startup_migrations_on_a_new_install_create_a_working_database() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    let db_path = dir.join("theorem.db");
    let health = setup_guard(&db_path, dir);
    assert!(may_run_after(&health));
    let conn = Connection::open(&db_path).unwrap();
    assert_eq!(
        run_maintenance(dir, on(&conn)),
        MaintenanceReport::default()
    );
}

// ─── Alongside the app ───────────────────────────────────────────────────

/// What the pool hands out: WAL, busy timeout.
fn app_connection(db_path: &Path) -> Connection {
    let conn = Connection::open(db_path).unwrap();
    conn.execute_batch("PRAGMA busy_timeout = 5000;").unwrap();
    conn
}

#[test]
fn maintenance_alongside_app_writes_loses_none_of_them() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().to_path_buf();
    let (db_path, conn) = fresh_db(&dir);
    const N: usize = 400;
    for i in 0..N {
        let id = format!("b{i}");
        conn.execute(
            "INSERT INTO books (id, data) VALUES (?1, ?2)",
            params![
                id,
                if i % 4 == 0 {
                    vec![1_u8; 2048]
                } else {
                    Vec::new()
                }
            ],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO book_metadata (book_id, metadata_json) VALUES (?1, ?2)",
            params![id, book_meta(&id, i % 2 == 0)],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO covers (book_id, data_url) VALUES (?1, ?2)",
            params![id, COVER_PNG_URL],
        )
        .unwrap();
    }
    std::fs::create_dir_all(dir.join("book-cache")).unwrap();
    for i in (0..N).step_by(2) {
        std::fs::write(dir.join(format!("book-cache/b{i}.book")), b"PK").unwrap();
    }
    drop(conn);

    let worker = {
        let (db_path, dir) = (db_path.clone(), dir.clone());
        std::thread::spawn(move || {
            let conn = app_connection(&db_path);
            run_maintenance(&dir, on(&conn))
        })
    };
    // The app, meanwhile: renames books, saves new covers, adds books.
    let app = app_connection(&db_path);
    for i in (0..N).step_by(3) {
        let id = format!("b{i}");
        crate::database::sqlite_save_book_metadata_inner(
            &app,
            &id,
            &book_meta(&id, i % 2 == 0).replace(&format!("Title {id}\""), "Renamed\""),
        )
        .unwrap();
        crate::database::sqlite_save_cover_image_inner(
            &app,
            &id,
            "data:image/jpeg;base64,/9j/4AAQ",
        )
        .unwrap();
    }
    for i in 0..20 {
        let id = format!("new{i}");
        crate::database::sqlite_save_book_metadata_inner(&app, &id, &book_meta(&id, false))
            .unwrap();
    }
    let report = worker.join().unwrap();
    assert!(report.failed_steps.is_empty(), "{report:?}");

    // Every app write survived.
    assert_eq!(
        count(
            &app,
            "SELECT COUNT(*) FROM book_metadata WHERE metadata_json LIKE '%Renamed%'"
        ),
        (0..N).step_by(3).count() as i64
    );
    assert_eq!(
        count(
            &app,
            "SELECT COUNT(*) FROM covers WHERE mime = 'image/jpeg'"
        ),
        (0..N).step_by(3).count() as i64
    );
    // And the maintenance finished what the app did not touch.
    assert_eq!(
        count(&app, "SELECT COUNT(*) FROM covers WHERE data IS NULL"),
        0
    );
    assert_eq!(
        count(&app, "SELECT COUNT(*) FROM books WHERE length(data) > 0"),
        0
    );

    // A second pass (the next start) heals anything a rename raced, and the
    // search index matches the library.
    let app_dir = dir.clone();
    let again = run_maintenance(&app_dir, on(&app));
    assert!(again.failed_steps.is_empty());
    assert_eq!(
        count(&app, "SELECT COUNT(*) FROM book_metadata WHERE metadata_json LIKE '%\"syncedWithoutFile\":true%'"),
        0
    );
    assert_eq!(
        count(&app, "SELECT COUNT(*) FROM books_fts"),
        count(&app, "SELECT COUNT(*) FROM book_metadata")
    );
}

#[test]
fn fts_reconcile_reads_under_the_write_lock() {
    // A stale read could drop a book added meanwhile from the index, or put
    // back one deleted meanwhile. The reconcile takes the write lock before
    // it reads, so while the app writes it waits (here: no busy timeout, so
    // it fails and is retried next start) instead of reading stale rows.
    let tmp = tempfile::tempdir().unwrap();
    let (db_path, conn) = fresh_db(tmp.path());
    crate::database::sqlite_save_book_metadata_inner(&conn, "a", &book_meta("a", false)).unwrap();
    let app = app_connection(&db_path);
    // The app is adding a book (its own index write comes later).
    app.execute_batch(
        "BEGIN IMMEDIATE;
         INSERT INTO books (id, data) VALUES ('b', X'');
         INSERT INTO book_metadata (book_id, metadata_json)
             VALUES ('b', '{\"title\":\"B\",\"author\":\"Z\"}');",
    )
    .unwrap();
    conn.execute_batch("PRAGMA busy_timeout = 0;").unwrap();
    assert!(crate::database::reconcile_books_fts(&conn).is_err());
    app.execute_batch("COMMIT;").unwrap();
    // Afterwards it sees the new book, and keeps the old one.
    assert_eq!(crate::database::reconcile_books_fts(&conn).unwrap(), 1);
    assert_eq!(
        count(
            &conn,
            "SELECT COUNT(*) FROM books_fts WHERE id IN ('a', 'b')"
        ),
        2
    );
}

#[test]
fn heal_copies_the_original_file_when_the_cache_copy_is_missing() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    let (_, conn) = fresh_db(dir);
    let original = dir.join("Books/original.epub");
    std::fs::create_dir_all(original.parent().unwrap()).unwrap();
    std::fs::write(&original, b"PK original").unwrap();
    let meta = serde_json::json!({
        "id": "c", "title": "C", "author": "A", "syncedWithoutFile": true,
        "filePath": original.to_string_lossy(),
    })
    .to_string();
    conn.execute(
        "INSERT INTO books (id, data) VALUES ('c', X''), ('gone', X'')",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO book_metadata (book_id, metadata_json) VALUES ('c', ?1)",
        params![meta],
    )
    .unwrap();
    let healed = crate::database::reconcile_synced_without_file_metadata(&conn, dir).unwrap();
    assert_eq!(healed.len(), 1);
    let cached = dir.join("book-cache/c.book");
    assert_eq!(std::fs::read(&cached).unwrap(), b"PK original");
    assert_eq!(healed[0].storage_path, cached.to_string_lossy());
    // Sent to the interface as `{ id, storagePath }`.
    let json = serde_json::to_value(&healed).unwrap();
    assert_eq!(json[0]["id"], "c");
    assert!(json[0]["storagePath"].is_string());
    // No temporary file left in the cache.
    assert_eq!(
        std::fs::read_dir(dir.join("book-cache")).unwrap().count(),
        1
    );
    // A book whose original is gone stays flagged.
    conn.execute(
        "INSERT INTO book_metadata (book_id, metadata_json) VALUES ('gone', ?1)",
        params![meta
            .replace("original.epub", "missing.epub")
            .replace("\"c\"", "\"gone\"")],
    )
    .unwrap();
    assert!(
        crate::database::reconcile_synced_without_file_metadata(&conn, dir)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn dictionary_reclaim_writes_whole_files_and_ifo_last() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    let (_, conn) = fresh_db(dir);
    seed_legacy(&conn, dir);
    // A half-written directory from an interrupted earlier attempt.
    let dict_dir = dir.join("dictionaries/d1");
    std::fs::create_dir_all(&dict_dir).unwrap();
    std::fs::write(dict_dir.join("dict.idx"), b"trunc").unwrap();
    assert!(!crate::stardict::is_valid_stardict_dir(&dict_dir));

    assert_eq!(
        crate::database::reclaim_legacy_stardict_blobs(&conn, dir).unwrap(),
        3
    );
    assert!(crate::stardict::is_valid_stardict_dir(&dict_dir));
    assert_eq!(
        std::fs::read(dict_dir.join("dict.idx")).unwrap(),
        vec![1_u8; 32]
    );
    let names: Vec<String> = std::fs::read_dir(&dict_dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert!(names.iter().all(|n| !n.contains(".tmp-")), "{names:?}");
}

#[test]
fn replace_file_atomically_overwrites_and_leaves_nothing_behind() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("f.bin");
    std::fs::write(&path, b"old").unwrap();
    crate::database::replace_file_atomically(&path, b"new").unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), b"new");
    assert_eq!(std::fs::read_dir(tmp.path()).unwrap().count(), 1);
    // A missing directory is an error, not a panic, and leaves no file.
    assert!(crate::database::replace_file_atomically(&tmp.path().join("no/f"), b"x").is_err());
}
