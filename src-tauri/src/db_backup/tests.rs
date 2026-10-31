use super::*;
use std::io::{Seek, SeekFrom};

const VERSION: &str = "1.6.0";

fn options(include_dictionaries: bool) -> BackupOptions {
    BackupOptions {
        include_dictionaries,
        app_version: VERSION.into(),
        platform: "linux".into(),
        created_at: "2026-10-22T10:00:00+00:00".into(),
    }
}

fn no_progress() -> impl FnMut(BackupProgress) {
    |_| {}
}

const SCHEMA: &str = r#"
    PRAGMA journal_mode = WAL;
    CREATE TABLE books (id TEXT PRIMARY KEY, data BLOB NOT NULL);
    CREATE TABLE book_metadata (book_id TEXT PRIMARY KEY, metadata_json TEXT NOT NULL);
    CREATE TABLE book_annotations (id TEXT PRIMARY KEY, book_id TEXT NOT NULL, annotation_json TEXT NOT NULL);
    CREATE TABLE covers (book_id TEXT PRIMARY KEY, data_url TEXT NOT NULL, data BLOB, mime TEXT);
    CREATE TABLE kv_store (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE vocabulary (id TEXT PRIMARY KEY, term TEXT NOT NULL);
    CREATE TABLE rss_feeds (id TEXT PRIMARY KEY, title TEXT NOT NULL);
    CREATE TABLE rss_articles (id TEXT PRIMARY KEY, feed_id TEXT NOT NULL);
    CREATE TABLE reading_sessions (id TEXT PRIMARY KEY, minutes REAL NOT NULL);
"#;

fn settings_json(device_id: &str, ticket: &str) -> String {
    serde_json::json!({
        "state": {
            "settings": {
                "theme": "dark",
                "deviceSync": {
                    "deviceId": device_id,
                    "deviceName": format!("{device_id}-name"),
                    "pairedDevices": [{ "deviceId": "peer", "syncDocTicket": ticket }],
                    "syncOnConnect": true,
                    "autoSyncEnabled": false
                }
            }
        },
        "version": 13
    })
    .to_string()
}

fn opds_json(password: &str) -> String {
    serde_json::json!({
        "state": {
            "catalogs": [
                { "id": "cat-1", "title": "Mine", "auth": { "username": "me", "password": password } },
                { "id": "cat-2", "title": "Other" }
            ],
            "activeCatalogId": null
        },
        "version": 1
    })
    .to_string()
}

/// A device's app data dir with a library of `books` books.
fn make_device(dir: &Path, books: usize, device_id: &str, secret: &str) -> PathBuf {
    fs::create_dir_all(dir.join("book-cache")).unwrap();
    let db_path = dir.join("theorem.db");
    let conn = Connection::open(&db_path).unwrap();
    conn.execute_batch(SCHEMA).unwrap();
    for i in 0..books {
        let id = format!("{device_id}-book-{i}");
        conn.execute("INSERT INTO books (id, data) VALUES (?1, x'')", params![id])
            .unwrap();
        conn.execute(
            "INSERT INTO book_metadata (book_id, metadata_json) VALUES (?1, ?2)",
            params![id, format!("{{\"title\":\"Book {i}\"}}")],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO book_annotations (id, book_id, annotation_json) VALUES (?1, ?2, '{}')",
            params![format!("{id}-a"), id],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO covers (book_id, data_url, data, mime) VALUES (?1, '', ?2, 'image/png')",
            params![id, vec![i as u8; 2048]],
        )
        .unwrap();
        fs::write(
            dir.join("book-cache").join(format!("{id}.book")),
            format!("book bytes {id}").repeat(50),
        )
        .unwrap();
    }
    conn.execute(
        "INSERT INTO vocabulary (id, term) VALUES ('v1', 'word')",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO kv_store (key, value) VALUES (?1, ?2)",
        params![SETTINGS_KV_KEY, settings_json(device_id, secret)],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO kv_store (key, value) VALUES (?1, ?2)",
        params![OPDS_KV_KEY, opds_json(secret)],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO kv_store (key, value) VALUES (?1, 'true')",
        params![SYNC_PROVISIONED_KV_KEY],
    )
    .unwrap();
    // Device identity files that must never travel in a backup.
    fs::write(dir.join("iroh-key"), secret).unwrap();
    fs::write(dir.join("sync-identity.json"), secret).unwrap();
    fs::write(dir.join("sync-paired-devices.json"), secret).unwrap();
    db_path
}

fn titles(conn: &Connection) -> Vec<String> {
    let mut stmt = conn
        .prepare("SELECT metadata_json FROM book_metadata ORDER BY book_id")
        .unwrap();
    stmt.query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap()
}

fn kv(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row(
        "SELECT value FROM kv_store WHERE key = ?1",
        params![key],
        |row| row.get(0),
    )
    .optional()
    .unwrap()
}

fn archive_entries(path: &Path) -> Vec<String> {
    let mut archive = open_archive(path).unwrap();
    (0..archive.len())
        .map(|i| archive.by_index(i).unwrap().name().unwrap().to_string())
        .collect()
}

fn backup_of(device: &Path, out: &Path, include_dictionaries: bool) -> BackupManifest {
    let conn = Connection::open(device.join("theorem.db")).unwrap();
    write_backup(
        &conn,
        device,
        out,
        &options(include_dictionaries),
        &mut no_progress(),
    )
    .unwrap()
}

/// Copy `src` archive to `dst`, transforming entries.
fn rewrite_archive(
    src: &Path,
    dst: &Path,
    mut edit: impl FnMut(&str, Vec<u8>) -> Option<(String, Vec<u8>)>,
) {
    let mut archive = open_archive(src).unwrap();
    let mut writer = zip::ZipWriter::new(File::create(dst).unwrap());
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).unwrap();
        let name = entry.name().unwrap().to_string();
        let mut data = Vec::new();
        entry.read_to_end(&mut data).unwrap();
        if let Some((name, data)) = edit(&name, data) {
            writer
                .start_file(name, zip::write::SimpleFileOptions::default())
                .unwrap();
            writer.write_all(&data).unwrap();
        }
    }
    writer.finish().unwrap();
}

fn corrupt_middle(path: &Path) {
    let len = fs::metadata(path).unwrap().len();
    assert!(len > 4096 * 4, "database too small to corrupt");
    let mut file = fs::OpenOptions::new().write(true).open(path).unwrap();
    // Leave the header page alone so SQLite still opens the file.
    for offset in (4096..len).step_by(4096) {
        file.seek(SeekFrom::Start(offset + 8)).unwrap();
        file.write_all(&[0xA5; 64]).unwrap();
    }
    file.sync_all().unwrap();
}

// ─── Round trip ─────────────────────────────────────────────────────────

#[test]
fn backup_then_restore_reproduces_rows_and_files_on_another_device() {
    let tmp = tempfile::tempdir().unwrap();
    let a = tmp.path().join("device-a");
    let b = tmp.path().join("device-b");
    make_device(&a, 5, "aaa", "secret-a");
    fs::create_dir_all(a.join("audiobooks/nested")).unwrap();
    fs::write(a.join("audiobooks/nested/book.opus"), b"opus").unwrap();
    fs::create_dir_all(a.join("dictionaries/en")).unwrap();
    fs::write(a.join("dictionaries/en/dict.idx"), b"idx").unwrap();
    let live_b = make_device(&b, 2, "bbb", "secret-b");

    let out = tmp.path().join("out/backup.theorem-backup");
    let manifest = backup_of(&a, &out, true);
    assert_eq!(manifest.format, BACKUP_FORMAT);
    assert_eq!(manifest.counts.books, 5);
    assert_eq!(manifest.counts.annotations, 5);
    assert_eq!(manifest.counts.book_files, 5);
    assert_eq!(manifest.counts.audiobook_files, 1);
    assert_eq!(manifest.counts.dictionary_files, 1);
    assert_eq!(manifest.counts.vocabulary, 1);
    assert!(manifest
        .schema
        .tables
        .contains(&"book_metadata".to_string()));
    assert!(!sidecar(&out, ".partial").exists());
    assert!(
        !a.join(BACKUP_TMP_DIR).exists(),
        "temporary snapshot left behind"
    );

    let staged = stage_backup(&out, &b.join(STAGING_DIR), VERSION, &mut no_progress()).unwrap();
    assert_eq!(staged.manifest, manifest);
    let moved = install_staged_files(&staged.files_dir, &b).unwrap();
    assert_eq!(moved, 7);
    replace_live_database(&staged.db_path, &live_b, true, false).unwrap();

    let restored = Connection::open(&live_b).unwrap();
    let original = Connection::open(a.join("theorem.db")).unwrap();
    assert_eq!(titles(&restored), titles(&original));
    let cover: Vec<u8> = restored
        .query_row(
            "SELECT data FROM covers WHERE book_id = 'aaa-book-3'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(cover, vec![3u8; 2048]);
    for i in 0..5 {
        let name = format!("aaa-book-{i}.book");
        assert_eq!(
            fs::read(b.join("book-cache").join(&name)).unwrap(),
            fs::read(a.join("book-cache").join(&name)).unwrap()
        );
    }
    assert_eq!(
        fs::read(b.join("audiobooks/nested/book.opus")).unwrap(),
        b"opus"
    );
    assert_eq!(
        fs::read(b.join("dictionaries/en/dict.idx")).unwrap(),
        b"idx"
    );
    // Device B's own files are untouched and its old library is kept aside.
    assert!(b.join("book-cache/bbb-book-0.book").exists());
    let pre = Connection::open(pre_restore_path(&live_b)).unwrap();
    assert_eq!(titles(&pre).len(), 2);
}

#[test]
fn restore_keeps_this_devices_identity_and_catalog_sign_ins() {
    let tmp = tempfile::tempdir().unwrap();
    let a = tmp.path().join("a");
    let b = tmp.path().join("b");
    make_device(&a, 1, "aaa", "secret-a");
    let live_b = make_device(&b, 1, "bbb", "secret-b");
    let out = tmp.path().join("x.theorem-backup");
    backup_of(&a, &out, false);

    let staged = stage_backup(&out, &b.join(STAGING_DIR), VERSION, &mut no_progress()).unwrap();
    replace_live_database(&staged.db_path, &live_b, true, false).unwrap();

    let conn = Connection::open(&live_b).unwrap();
    let settings: serde_json::Value =
        serde_json::from_str(&kv(&conn, SETTINGS_KV_KEY).unwrap()).unwrap();
    assert_eq!(
        settings["state"]["settings"]["deviceSync"]["deviceId"],
        "bbb"
    );
    assert_eq!(
        settings["state"]["settings"]["deviceSync"]["pairedDevices"][0]["syncDocTicket"],
        "secret-b"
    );
    // Other settings come from the backup.
    assert_eq!(settings["state"]["settings"]["theme"], "dark");
    let opds: serde_json::Value = serde_json::from_str(&kv(&conn, OPDS_KV_KEY).unwrap()).unwrap();
    assert_eq!(opds["state"]["catalogs"][0]["auth"]["password"], "secret-b");
    assert!(opds["state"]["catalogs"][1].get("auth").is_none());
    assert_eq!(kv(&conn, SYNC_PROVISIONED_KV_KEY), None);
}

#[test]
fn restore_into_a_database_held_open_by_other_connections() {
    let tmp = tempfile::tempdir().unwrap();
    let a = tmp.path().join("a");
    let b = tmp.path().join("b");
    make_device(&a, 3, "aaa", "s");
    let live_b = make_device(&b, 1, "bbb", "s");
    let out = tmp.path().join("x.theorem-backup");
    backup_of(&a, &out, false);

    // Stands in for the app's pool.
    let pool_conn = Connection::open(&live_b).unwrap();
    assert_eq!(titles(&pool_conn).len(), 1);

    let staged = stage_backup(&out, &b.join(STAGING_DIR), VERSION, &mut no_progress()).unwrap();
    replace_live_database(&staged.db_path, &live_b, true, true).unwrap();
    assert_eq!(
        titles(&pool_conn).len(),
        3,
        "open connection sees the restored library"
    );
    quick_check(&pool_conn).unwrap();
}

#[test]
fn empty_library_round_trips() {
    let tmp = tempfile::tempdir().unwrap();
    let a = tmp.path().join("a");
    let b = tmp.path().join("b");
    make_device(&a, 0, "aaa", "s");
    let live_b = make_device(&b, 2, "bbb", "s");
    let out = tmp.path().join("x.theorem-backup");
    let manifest = backup_of(&a, &out, false);
    assert_eq!(manifest.counts.books, 0);
    assert_eq!(manifest.counts.book_files, 0);

    let staged = stage_backup(&out, &b.join(STAGING_DIR), VERSION, &mut no_progress()).unwrap();
    replace_live_database(&staged.db_path, &live_b, true, false).unwrap();
    assert!(titles(&Connection::open(&live_b).unwrap()).is_empty());
}

#[test]
fn missing_book_files_are_counted_not_fatal() {
    let tmp = tempfile::tempdir().unwrap();
    let a = tmp.path().join("a");
    make_device(&a, 3, "aaa", "s");
    fs::remove_file(a.join("book-cache/aaa-book-1.book")).unwrap();
    // A stray file that belongs to no book is not backed up.
    fs::write(a.join("book-cache/orphan.book"), b"x").unwrap();
    let out = tmp.path().join("x.theorem-backup");
    let manifest = backup_of(&a, &out, false);
    assert_eq!(manifest.counts.book_files, 2);
    assert_eq!(manifest.counts.missing_book_files, 1);
    assert!(!archive_entries(&out).iter().any(|e| e.contains("orphan")));
}

#[test]
fn dictionaries_only_when_asked() {
    let tmp = tempfile::tempdir().unwrap();
    let a = tmp.path().join("a");
    make_device(&a, 1, "aaa", "s");
    fs::create_dir_all(a.join("dictionaries/en")).unwrap();
    fs::write(a.join("dictionaries/en/dict.idx"), b"idx").unwrap();
    let out = tmp.path().join("x.theorem-backup");
    let manifest = backup_of(&a, &out, false);
    assert!(!manifest.includes_dictionaries);
    assert_eq!(manifest.counts.dictionary_files, 0);
    assert!(!archive_entries(&out)
        .iter()
        .any(|e| e.starts_with("dictionaries/")));
}

// ─── Identity ───────────────────────────────────────────────────────────

#[test]
fn backup_excludes_device_identity() {
    let tmp = tempfile::tempdir().unwrap();
    let a = tmp.path().join("a");
    make_device(&a, 2, "aaa", "TOP-SECRET-TICKET");
    {
        // An older settings row, since replaced, still sits in a free page.
        let conn = Connection::open(a.join("theorem.db")).unwrap();
        conn.execute_batch("PRAGMA secure_delete = OFF;").unwrap();
        conn.execute(
            "INSERT INTO kv_store (key, value) VALUES ('old', ?1)",
            params![format!("{}TOP-SECRET-TICKET", "x".repeat(8000))],
        )
        .unwrap();
        conn.execute("DELETE FROM kv_store WHERE key = 'old'", [])
            .unwrap();
    }
    let out = tmp.path().join("x.theorem-backup");
    backup_of(&a, &out, true);

    let entries = archive_entries(&out);
    assert_eq!(entries[0], MANIFEST_ENTRY, "manifest is the first entry");
    for forbidden in ["iroh-key", "sync-identity.json", "sync-paired-devices.json"] {
        assert!(
            !entries.iter().any(|e| e.contains(forbidden)),
            "{forbidden} leaked"
        );
    }
    assert!(entries
        .iter()
        .all(|e| e == MANIFEST_ENTRY || e == DB_ENTRY || restorable_entry_path(e).is_some()));

    // Nothing in the archive carries the secret, compressed or not.
    let staging = tmp.path().join("inspect");
    let staged = stage_backup(&out, &staging, VERSION, &mut no_progress()).unwrap();
    let raw = fs::read(&staged.db_path).unwrap();
    assert!(!raw.windows(17).any(|w| w == b"TOP-SECRET-TICKET"));
    let conn = Connection::open(&staged.db_path).unwrap();
    let settings: serde_json::Value =
        serde_json::from_str(&kv(&conn, SETTINGS_KV_KEY).unwrap()).unwrap();
    let sync = &settings["state"]["settings"]["deviceSync"];
    assert_eq!(sync["deviceId"], "");
    assert_eq!(sync["pairedDevices"], serde_json::json!([]));
    assert_eq!(sync["autoSyncEnabled"], false, "preferences survive");
    let opds: serde_json::Value = serde_json::from_str(&kv(&conn, OPDS_KV_KEY).unwrap()).unwrap();
    assert!(opds["state"]["catalogs"][0].get("auth").is_none());
    assert_eq!(kv(&conn, SYNC_PROVISIONED_KV_KEY), None);

    // The live database itself is untouched.
    let live = Connection::open(a.join("theorem.db")).unwrap();
    assert!(kv(&live, SETTINGS_KV_KEY)
        .unwrap()
        .contains("TOP-SECRET-TICKET"));
}

#[test]
fn strip_identity_tolerates_missing_and_malformed_values() {
    let conn = Connection::open_in_memory().unwrap();
    strip_device_identity(&conn).unwrap(); // no kv_store at all
    conn.execute_batch("CREATE TABLE kv_store (key TEXT PRIMARY KEY, value TEXT NOT NULL);")
        .unwrap();
    strip_device_identity(&conn).unwrap(); // no keys
    conn.execute(
        "INSERT INTO kv_store VALUES (?1, 'not json')",
        params![SETTINGS_KV_KEY],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO kv_store VALUES (?1, '{\"state\":{}}')",
        params![OPDS_KV_KEY],
    )
    .unwrap();
    strip_device_identity(&conn).unwrap();
    assert_eq!(kv(&conn, SETTINGS_KV_KEY).unwrap(), "not json");
}

// ─── Rejection ──────────────────────────────────────────────────────────

fn assert_rejected(path: &Path, staging: &Path, needle: &str) {
    let err = match stage_backup(path, staging, VERSION, &mut no_progress()) {
        Ok(_) => panic!("backup accepted, expected rejection containing {needle:?}"),
        Err(e) => e,
    };
    assert!(
        err.to_lowercase().contains(&needle.to_lowercase()),
        "error {err:?} does not mention {needle:?}"
    );
    assert!(!staging.exists(), "staging left behind after rejection");
}

#[test]
fn rejects_files_that_are_not_backups() {
    let tmp = tempfile::tempdir().unwrap();
    let staging = tmp.path().join("staging");
    let junk = tmp.path().join("junk.theorem-backup");
    fs::write(&junk, b"definitely not a zip").unwrap();
    assert_rejected(&junk, &staging, "not a theorem backup");

    let empty = tmp.path().join("empty.theorem-backup");
    fs::write(&empty, b"").unwrap();
    assert_rejected(&empty, &staging, "not a theorem backup");

    let no_manifest = tmp.path().join("nomanifest.theorem-backup");
    let mut writer = zip::ZipWriter::new(File::create(&no_manifest).unwrap());
    writer
        .start_file("theorem.db", zip::write::SimpleFileOptions::default())
        .unwrap();
    writer.write_all(b"x").unwrap();
    writer.finish().unwrap();
    assert_rejected(&no_manifest, &staging, "no manifest");
    assert!(inspect_backup(&no_manifest, VERSION).is_err());
}

#[test]
fn rejects_corrupt_or_foreign_manifests() {
    let tmp = tempfile::tempdir().unwrap();
    let a = tmp.path().join("a");
    make_device(&a, 2, "aaa", "s");
    let good = tmp.path().join("good.theorem-backup");
    backup_of(&a, &good, false);
    assert!(inspect_backup(&good, VERSION).is_ok());
    let staging = tmp.path().join("staging");

    type ManifestEdit = Box<dyn Fn(serde_json::Value) -> Vec<u8>>;
    let cases: Vec<(&str, ManifestEdit, &str)> = vec![
        (
            "garbage",
            Box::new(|_| b"{not json".to_vec()),
            "manifest is invalid",
        ),
        (
            "format",
            Box::new(|mut m| {
                m["format"] = "something-else".into();
                serde_json::to_vec(&m).unwrap()
            }),
            "not a theorem backup",
        ),
        (
            "format-version",
            Box::new(|mut m| {
                m["formatVersion"] = 99.into();
                serde_json::to_vec(&m).unwrap()
            }),
            "newer format",
        ),
        (
            "format-version-zero",
            Box::new(|mut m| {
                m["formatVersion"] = 0.into();
                serde_json::to_vec(&m).unwrap()
            }),
            "format",
        ),
        (
            "newer-app",
            Box::new(|mut m| {
                m["appVersion"] = "1.7.0".into();
                serde_json::to_vec(&m).unwrap()
            }),
            "update theorem",
        ),
        (
            "missing-field",
            Box::new(|mut m| {
                m.as_object_mut().unwrap().remove("counts");
                serde_json::to_vec(&m).unwrap()
            }),
            "manifest is invalid",
        ),
        (
            "count-mismatch",
            Box::new(|mut m| {
                m["counts"]["books"] = 7.into();
                serde_json::to_vec(&m).unwrap()
            }),
            "does not match",
        ),
        (
            "file-count-mismatch",
            Box::new(|mut m| {
                m["counts"]["bookFiles"] = 3.into();
                serde_json::to_vec(&m).unwrap()
            }),
            "book files",
        ),
    ];
    for (label, edit, needle) in cases {
        let bad = tmp.path().join(format!("{label}.theorem-backup"));
        rewrite_archive(&good, &bad, |name, data| {
            if name == MANIFEST_ENTRY {
                let value: serde_json::Value = serde_json::from_slice(&data).unwrap();
                Some((name.to_string(), edit(value)))
            } else {
                Some((name.to_string(), data))
            }
        });
        assert_rejected(&bad, &staging, needle);
    }

    // Older backups restore.
    let older = tmp.path().join("older.theorem-backup");
    rewrite_archive(&good, &older, |name, data| {
        if name == MANIFEST_ENTRY {
            let mut m: serde_json::Value = serde_json::from_slice(&data).unwrap();
            m["appVersion"] = "1.5.9".into();
            Some((name.to_string(), serde_json::to_vec(&m).unwrap()))
        } else {
            Some((name.to_string(), data))
        }
    });
    stage_backup(&older, &staging, VERSION, &mut no_progress()).unwrap();
}

#[test]
fn rejects_a_damaged_database_inside_the_backup() {
    let tmp = tempfile::tempdir().unwrap();
    let a = tmp.path().join("a");
    make_device(&a, 40, "aaa", "s");
    let good = tmp.path().join("good.theorem-backup");
    backup_of(&a, &good, false);
    let staging = tmp.path().join("staging");

    let damaged = tmp.path().join("damaged.theorem-backup");
    rewrite_archive(&good, &damaged, |name, mut data| {
        if name == DB_ENTRY {
            for offset in (4096..data.len()).step_by(4096) {
                for byte in data.iter_mut().skip(offset + 8).take(64) {
                    *byte = 0xA5;
                }
            }
        }
        Some((name.to_string(), data))
    });
    assert_rejected(&damaged, &staging, "damaged");

    let truncated_db = tmp.path().join("truncated.theorem-backup");
    rewrite_archive(&good, &truncated_db, |name, data| {
        if name == DB_ENTRY {
            Some((name.to_string(), data[..100].to_vec()))
        } else {
            Some((name.to_string(), data))
        }
    });
    assert!(stage_backup(&truncated_db, &staging, VERSION, &mut no_progress()).is_err());

    let no_db = tmp.path().join("nodb.theorem-backup");
    rewrite_archive(&good, &no_db, |name, data| {
        (name != DB_ENTRY).then(|| (name.to_string(), data))
    });
    assert_rejected(&no_db, &staging, "no library database");

    let foreign_db = tmp.path().join("foreign.theorem-backup");
    let other = tmp.path().join("other.db");
    {
        let conn = Connection::open(&other).unwrap();
        conn.execute_batch("CREATE TABLE t (x); INSERT INTO t VALUES (1);")
            .unwrap();
    }
    let other_bytes = fs::read(&other).unwrap();
    rewrite_archive(&good, &foreign_db, |name, data| {
        if name == DB_ENTRY {
            Some((name.to_string(), other_bytes.clone()))
        } else {
            Some((name.to_string(), data))
        }
    });
    assert_rejected(&foreign_db, &staging, "not a theorem library");
}

#[test]
fn rejects_a_truncated_archive() {
    let tmp = tempfile::tempdir().unwrap();
    let a = tmp.path().join("a");
    make_device(&a, 3, "aaa", "s");
    let good = tmp.path().join("good.theorem-backup");
    backup_of(&a, &good, false);
    let bytes = fs::read(&good).unwrap();
    let cut = tmp.path().join("cut.theorem-backup");
    fs::write(&cut, &bytes[..bytes.len() / 2]).unwrap();
    assert!(stage_backup(
        &cut,
        &tmp.path().join("staging"),
        VERSION,
        &mut no_progress()
    )
    .is_err());
}

#[test]
fn ignores_entries_outside_the_restorable_folders() {
    let tmp = tempfile::tempdir().unwrap();
    let a = tmp.path().join("a");
    make_device(&a, 1, "aaa", "s");
    let good = tmp.path().join("good.theorem-backup");
    backup_of(&a, &good, false);
    let evil = tmp.path().join("evil.theorem-backup");
    rewrite_archive(&good, &evil, |name, data| Some((name.to_string(), data)));
    // Append hostile entries.
    {
        let file = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&evil)
            .unwrap();
        let mut writer = zip::ZipWriter::new_append(file).unwrap();
        for name in [
            "../escape.txt",
            "iroh-key",
            "book-cache/../../escape.book",
            "audiobooks/../../escape.opus",
            "dictionaries/a/../../../escape",
            "book-cache/nested/x.book",
        ] {
            writer
                .start_file(name, zip::write::SimpleFileOptions::default())
                .unwrap();
            writer.write_all(b"pwned").unwrap();
        }
        writer.finish().unwrap();
    }
    let staging = tmp.path().join("deep/staging");
    let staged = stage_backup(&evil, &staging, VERSION, &mut no_progress()).unwrap();
    let target = tmp.path().join("deep");
    install_staged_files(&staged.files_dir, &target).unwrap();
    for escaped in [
        "escape.txt",
        "escape.book",
        "escape.opus",
        "escape",
        "deep/iroh-key",
    ] {
        assert!(!tmp.path().join(escaped).exists(), "{escaped} escaped");
    }
    assert!(target.join("book-cache/aaa-book-0.book").exists());
}

#[test]
fn restorable_entry_paths() {
    assert_eq!(
        restorable_entry_path("book-cache/abc-1.book"),
        Some(PathBuf::from("book-cache/abc-1.book"))
    );
    assert_eq!(
        restorable_entry_path("audiobooks/id/book.opus"),
        Some(PathBuf::from("audiobooks/id/book.opus"))
    );
    for bad in [
        "",
        "book-cache/",
        "book-cache/x.epub",
        "book-cache/a/b.book",
        "book-cache/..book",
        "book-cache/a b.book",
        "audiobooks",
        "audiobooks/",
        "audiobooks/../x",
        "audiobooks/./x",
        "audiobooks/a\\..\\x",
        "audiobooks/C:/x",
        "/etc/passwd",
        "theorem.db-wal",
        "iroh-docs/docs.redb",
        "models/x",
    ] {
        assert_eq!(restorable_entry_path(bad), None, "{bad:?} accepted");
    }
}

#[test]
fn version_comparison() {
    assert!(validate_manifest(&manifest_with_version("1.6.0"), "1.6.0").is_ok());
    assert!(validate_manifest(&manifest_with_version("1.5.12"), "1.6.0").is_ok());
    assert!(validate_manifest(&manifest_with_version("v1.6.0-beta.1"), "1.6.0").is_ok());
    assert!(validate_manifest(&manifest_with_version("1.6.1"), "1.6.0").is_err());
    assert!(validate_manifest(&manifest_with_version("2.0.0"), "1.6.0").is_err());
    assert!(validate_manifest(&manifest_with_version(""), "1.6.0").is_ok());
}

fn manifest_with_version(version: &str) -> BackupManifest {
    BackupManifest {
        format: BACKUP_FORMAT.into(),
        format_version: 1,
        app_version: version.into(),
        created_at: String::new(),
        platform: String::new(),
        schema: SchemaInfo::default(),
        counts: BackupCounts::default(),
        includes_dictionaries: false,
        total_bytes: 0,
    }
}

// ─── Snapshots and the startup guard ────────────────────────────────────

#[test]
fn snapshots_rotate_keeping_the_newest_two() {
    let tmp = tempfile::tempdir().unwrap();
    let db = make_device(tmp.path(), 2, "aaa", "s");
    let conn = Connection::open(&db).unwrap();
    for (i, ts) in [1_000, 3_000, 2_000, 4_000].iter().enumerate() {
        take_snapshot(&conn, tmp.path(), &format!("1.{i}.0"), *ts).unwrap();
    }
    let snapshots = list_snapshots(tmp.path());
    assert_eq!(snapshots.len(), SNAPSHOT_KEEP);
    assert_eq!(snapshots[0].created_at, 4_000);
    assert_eq!(snapshots[0].app_version, "1.3.0");
    assert_eq!(snapshots[1].created_at, 3_000);
    assert!(snapshots.iter().all(|s| s.size > 0));
    // Each snapshot is a complete, single-file database.
    let path = snapshot_path(tmp.path(), &snapshots[0].name).unwrap();
    assert!(!sidecar(&path, "-wal").exists());
    let copy = Connection::open(&path).unwrap();
    quick_check(&copy).unwrap();
    assert_eq!(titles(&copy).len(), 2);
    // Nothing else in the folder.
    assert_eq!(fs::read_dir(snapshot_dir(tmp.path())).unwrap().count(), 2);
}

#[test]
fn snapshot_names_are_validated() {
    let tmp = tempfile::tempdir().unwrap();
    for bad in [
        "../theorem.db",
        "theorem.db",
        "theorem-x-v1.db",
        "theorem-1-v1/../x.db",
    ] {
        assert!(snapshot_path(tmp.path(), bad).is_err(), "{bad} accepted");
    }
    assert!(
        snapshot_path(tmp.path(), "theorem-5-v1.6.0.db").is_err(),
        "missing file"
    );
}

#[test]
fn check_is_due_daily_and_on_version_change() {
    let day = CHECK_INTERVAL_SECS;
    assert!(check_due(0, "", "1.6.0", 10), "first run");
    assert!(!check_due(100, "1.6.0", "1.6.0", 100 + day - 1));
    assert!(check_due(100, "1.6.0", "1.6.0", 100 + day));
    assert!(check_due(100, "1.5.9", "1.6.0", 101), "upgrade");
    assert!(check_due(100, "1.6.0", "1.6.0", 50), "clock moved back");
}

#[test]
fn guard_checks_snapshots_then_migrates_a_healthy_database() {
    let tmp = tempfile::tempdir().unwrap();
    let db = make_device(tmp.path(), 3, "aaa", "s");
    let mut migrated = false;
    let health = startup_guard_at(&db, tmp.path(), VERSION, 10_000, || {
        migrated = true;
        // The snapshot exists before migrations run.
        assert_eq!(list_snapshots(tmp.path()).len(), 1);
        Ok(())
    });
    assert!(migrated);
    assert_eq!(health.status, DbStatus::Ok);
    assert!(health.checked);

    // Same version, an hour later: no check, no new snapshot.
    let mut migrated = false;
    let health = startup_guard_at(&db, tmp.path(), VERSION, 13_600, || {
        migrated = true;
        Ok(())
    });
    assert!(migrated, "migrations always run");
    assert!(!health.checked);
    assert_eq!(list_snapshots(tmp.path()).len(), 1);

    // Upgrade: checked and snapshotted again before the new migrations.
    let health = startup_guard_at(&db, tmp.path(), "1.6.1", 13_700, || Ok(()));
    assert!(health.checked);
    let snapshots = list_snapshots(tmp.path());
    assert_eq!(snapshots.len(), 2);
    assert_eq!(snapshots[0].app_version, "1.6.1");
}

#[test]
fn same_version_daily_check_defers_the_snapshot_until_after_the_window() {
    let tmp = tempfile::tempdir().unwrap();
    let db = make_device(tmp.path(), 3, "aaa", "s");
    // Day 1, first start of this version: snapshot before migrations.
    let health = startup_guard_at(&db, tmp.path(), VERSION, 10_000, || Ok(()));
    assert!(health.checked);
    assert!(!health.snapshot_deferred);
    assert_eq!(list_snapshots(tmp.path()).len(), 1);

    // Day 2, same version: quick_check runs before the window, but nothing
    // is copied there; migrations run without waiting for a snapshot.
    let day2 = 10_000 + CHECK_INTERVAL_SECS;
    let mut migrated = false;
    let health = startup_guard_at(&db, tmp.path(), VERSION, day2, || {
        migrated = true;
        assert_eq!(
            list_snapshots(tmp.path()).len(),
            1,
            "no snapshot before the window"
        );
        Ok(())
    });
    assert!(migrated);
    assert_eq!(health.status, DbStatus::Ok);
    assert!(
        health.checked,
        "the integrity check still runs before the window"
    );
    assert!(health.snapshot_deferred);
    assert!(crate::db_maintenance::may_run_after(&health));

    // The background maintenance then takes it and records the check.
    take_deferred_snapshot_at(&db, tmp.path(), VERSION, day2 + 3).unwrap();
    let snapshots = list_snapshots(tmp.path());
    assert_eq!(snapshots.len(), 2);
    quick_check_file(&snapshot_path(tmp.path(), &snapshots[0].name).unwrap()).unwrap();
    let health = startup_guard_at(&db, tmp.path(), VERSION, day2 + 60, || Ok(()));
    assert!(!health.checked, "checked once today");
    assert!(!health.snapshot_deferred);
}

#[test]
fn a_deferred_snapshot_that_never_ran_is_due_again_next_start() {
    let tmp = tempfile::tempdir().unwrap();
    let db = make_device(tmp.path(), 3, "aaa", "s");
    startup_guard_at(&db, tmp.path(), VERSION, 10_000, || Ok(()));
    let day2 = 10_000 + CHECK_INTERVAL_SECS;
    let health = startup_guard_at(&db, tmp.path(), VERSION, day2, || Ok(()));
    assert!(health.snapshot_deferred);
    // The app quit before the maintenance thread got to it.
    let health = startup_guard_at(&db, tmp.path(), VERSION, day2 + 30, || Ok(()));
    assert!(health.checked);
    assert!(health.snapshot_deferred);
}

#[test]
fn version_change_keeps_the_snapshot_before_migrations() {
    let tmp = tempfile::tempdir().unwrap();
    let db = make_device(tmp.path(), 3, "aaa", "s");
    startup_guard_at(&db, tmp.path(), VERSION, 10_000, || Ok(()));
    // An upgrade an hour later, well inside the daily interval.
    let mut migrated = false;
    let health = startup_guard_at(&db, tmp.path(), "1.6.1", 13_600, || {
        migrated = true;
        let snapshots = list_snapshots(tmp.path());
        assert_eq!(
            snapshots.len(),
            2,
            "rollback point exists before migrations"
        );
        assert_eq!(snapshots[0].app_version, "1.6.1");
        Ok(())
    });
    assert!(migrated);
    assert!(health.checked);
    assert!(!health.snapshot_deferred, "nothing left for the background");
}

#[test]
fn a_corrupt_database_on_a_same_version_start_defers_nothing() {
    let tmp = tempfile::tempdir().unwrap();
    let db = make_device(tmp.path(), 40, "aaa", "s");
    startup_guard_at(&db, tmp.path(), VERSION, 1_000, || Ok(()));
    {
        let conn = Connection::open(&db).unwrap();
        conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
            .unwrap();
    }
    corrupt_middle(&db);
    let health = startup_guard_at(
        &db,
        tmp.path(),
        VERSION,
        1_000 + CHECK_INTERVAL_SECS,
        || Ok(()),
    );
    assert_eq!(health.status, DbStatus::Corrupt);
    assert!(!health.snapshot_deferred);
    assert_eq!(
        list_snapshots(tmp.path()).len(),
        1,
        "the good snapshot is kept"
    );
}

#[test]
fn guard_on_a_fresh_install_just_migrates() {
    let tmp = tempfile::tempdir().unwrap();
    let db = tmp.path().join("theorem.db");
    let mut migrated = false;
    let health = startup_guard_at(&db, tmp.path(), VERSION, 1, || {
        migrated = true;
        Ok(())
    });
    assert!(migrated);
    assert_eq!(health.status, DbStatus::Ok);
    assert!(list_snapshots(tmp.path()).is_empty());
}

#[test]
fn guard_reports_a_corrupt_database_and_does_not_migrate_it() {
    let tmp = tempfile::tempdir().unwrap();
    let db = make_device(tmp.path(), 40, "aaa", "s");
    // A good snapshot from yesterday.
    startup_guard_at(&db, tmp.path(), VERSION, 1_000, || Ok(()));
    {
        let conn = Connection::open(&db).unwrap();
        conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
            .unwrap();
    }
    corrupt_middle(&db);

    let mut migrated = false;
    let health = startup_guard_at(
        &db,
        tmp.path(),
        VERSION,
        1_000 + CHECK_INTERVAL_SECS,
        || {
            migrated = true;
            Ok(())
        },
    );
    assert!(!migrated, "a damaged database must not be migrated");
    assert_eq!(health.status, DbStatus::Corrupt);
    assert!(health.message.unwrap().contains("damaged"));
    assert_eq!(health.snapshots.len(), 1, "the good snapshot is offered");
    // The bad database did not displace the good snapshot.
    let good = snapshot_path(tmp.path(), &health.snapshots[0].name).unwrap();
    quick_check_file(&good).unwrap();

    // Still reported on the next start.
    let health = startup_guard_at(
        &db,
        tmp.path(),
        VERSION,
        1_001 + CHECK_INTERVAL_SECS,
        || Ok(()),
    );
    assert_eq!(health.status, DbStatus::Corrupt);

    // Recovery: the snapshot replaces the damaged file (pool not open yet).
    replace_live_database(&good, &db, true, false).unwrap();
    let conn = Connection::open(&db).unwrap();
    quick_check(&conn).unwrap();
    assert_eq!(titles(&conn).len(), 40);
    assert!(
        pre_restore_path(&db).exists(),
        "damaged file kept for forensics"
    );
}

#[test]
fn guard_reports_a_failed_migration() {
    let tmp = tempfile::tempdir().unwrap();
    let db = make_device(tmp.path(), 1, "aaa", "s");
    let health = startup_guard_at(&db, tmp.path(), VERSION, 5, || {
        Err("Failed to run v1.6.0 migrations: no such column".into())
    });
    assert_eq!(health.status, DbStatus::MigrationFailed);
    assert!(health.message.unwrap().contains("no such column"));
    assert_eq!(health.snapshots.len(), 1, "pre-migration snapshot offered");

    let health = startup_guard_at(&db, tmp.path(), VERSION, 6, || {
        Err("database disk image is malformed".into())
    });
    assert_eq!(health.status, DbStatus::Corrupt);
}

#[test]
fn replace_refuses_a_damaged_source_and_leaves_the_live_database_alone() {
    let tmp = tempfile::tempdir().unwrap();
    let a = tmp.path().join("a");
    let b = tmp.path().join("b");
    let src = make_device(&a, 40, "aaa", "s");
    {
        let conn = Connection::open(&src).unwrap();
        conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
            .unwrap();
    }
    corrupt_middle(&src);
    let live = make_device(&b, 2, "bbb", "s");
    assert!(replace_live_database(&src, &live, true, true).is_err());
    assert_eq!(titles(&Connection::open(&live).unwrap()).len(), 2);
}

#[test]
fn restore_repairs_a_damaged_database_that_the_pool_holds_open() {
    let tmp = tempfile::tempdir().unwrap();
    let db = make_device(tmp.path(), 40, "aaa", "s");
    startup_guard_at(&db, tmp.path(), VERSION, 1_000, || Ok(()));
    {
        let conn = Connection::open(&db).unwrap();
        conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
            .unwrap();
    }
    corrupt_middle(&db);
    let pool_conn = Connection::open(&db).unwrap();
    assert!(quick_check(&pool_conn).is_err());

    let snapshot = list_snapshots(tmp.path()).remove(0);
    let copy = tmp.path().join("copy.db");
    fs::copy(snapshot_path(tmp.path(), &snapshot.name).unwrap(), &copy).unwrap();
    replace_live_database(&copy, &db, true, true).unwrap();
    quick_check(&pool_conn).unwrap();
    assert_eq!(titles(&pool_conn).len(), 40);
}

#[test]
fn reading_rhythm_and_pending_chunks_survive_repeated_backup_restore() {
    let tmp = tempfile::tempdir().unwrap();
    let a = tmp.path().join("a");
    let live_a = make_device(&a, 0, "a", "");
    let state = theorem_core::reading_rhythm::evaluate(
        serde_json::from_value(serde_json::json!({
            "today":"2026-10-31", "reading":{"date":"2026-10-31","source":"reader","seconds":300}
        }))
        .unwrap(),
    )
    .unwrap()
    .state;
    let saved = serde_json::json!({"version":14,"state":{
        "settings":{},"readingSetupStep":2,
        "rhythmOutbox":{"2026-10-31:pending":{"date":"2026-10-31","source":"pending","seconds":150}},
        "readingOutbox":{"chunk:pending":{"date":"2026-10-31","minutes":0.5,"bookId":"book"}},
        "stats":{"rhythm":state}
    }});
    let conn = Connection::open(live_a).unwrap();
    conn.execute(
        "UPDATE kv_store SET value=?1 WHERE key=?2",
        params![saved.to_string(), SETTINGS_KV_KEY],
    )
    .unwrap();
    drop(conn);
    let out = tmp.path().join("reading.theorem-backup");
    backup_of(&a, &out, false);
    let b = tmp.path().join("b");
    let live_b = make_device(&b, 0, "b", "");
    for _ in 0..2 {
        let staged = stage_backup(&out, &b.join(STAGING_DIR), VERSION, &mut no_progress()).unwrap();
        replace_live_database(&staged.db_path, &live_b, true, false).unwrap();
        let conn = Connection::open(&live_b).unwrap();
        let restored: serde_json::Value =
            serde_json::from_str(&kv(&conn, SETTINGS_KV_KEY).unwrap()).unwrap();
        assert_eq!(restored["state"]["stats"], saved["state"]["stats"]);
        assert_eq!(
            restored["state"]["readingOutbox"],
            saved["state"]["readingOutbox"]
        );
        assert_eq!(
            restored["state"]["rhythmOutbox"],
            saved["state"]["rhythmOutbox"]
        );
        assert_eq!(restored["state"]["readingSetupStep"], 2);
    }
}
