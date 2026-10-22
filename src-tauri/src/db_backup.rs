//! Database safety: streaming `.theorem-backup` archives, restore, rolling
//! automatic snapshots and the startup integrity guard.
//!
//! A backup is a zip written straight to disk, entry by entry:
//!
//! ```text
//! manifest.json          format, app version, schema, counts, created_at
//! theorem.db             consistent SQLite snapshot (online backup API)
//! book-cache/<id>.book   book files, stored (already compressed formats)
//! audiobooks/...         generated companion audiobooks
//! dictionaries/...       offline dictionaries, only when asked for
//! ```
//!
//! Nothing is held in memory beyond one copy buffer. The snapshot inside the
//! archive has this device's sync identity removed (device id, paired
//! devices with their doc tickets, the provisioned flag) and OPDS catalog
//! credentials stripped, so restoring it elsewhere never clones a device. The
//! iroh secret key and the paired-device files live outside the database and
//! are never read.
//!
//! Restore validates the manifest, runs `PRAGMA quick_check` on the contained
//! database, stages everything under `restore-staging/`, keeps the current
//! database as `theorem.db.pre-restore`, then copies the staged database into
//! the live one with the online backup API. That works while the connection
//! pool is open (no process restart, which Tauri cannot do on Android); the
//! frontend reloads its webview afterwards.
//!
//! Startup guard (see `startup_guard_at`): at most once a day, and always
//! when the app version changed (the only time migrations have work to do),
//! the database is checked with `PRAGMA quick_check` and, when healthy,
//! copied to `db-snapshots/` (two kept) before migrations run. A corrupt
//! database or a failed migration is recorded as the database health that the
//! frontend reads before it renders, instead of starting with an empty
//! library.

use rusqlite::backup::{Backup, StepResult};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::{self, BufReader, BufWriter, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

pub const BACKUP_FORMAT: &str = "theorem-backup";
pub const BACKUP_FORMAT_VERSION: u32 = 1;
pub const BACKUP_EXTENSION: &str = "theorem-backup";
pub const PROGRESS_EVENT: &str = "db-backup-progress";

const DB_FILE_NAME: &str = "theorem.db";
const MANIFEST_ENTRY: &str = "manifest.json";
const DB_ENTRY: &str = "theorem.db";
const BOOK_CACHE_DIR: &str = "book-cache";
const AUDIOBOOKS_DIR: &str = "audiobooks";
const DICTIONARIES_DIR: &str = "dictionaries";
const SNAPSHOT_DIR: &str = "db-snapshots";
const SNAPSHOT_PREFIX: &str = "theorem-";
const SNAPSHOT_SUFFIX: &str = ".db";
pub const SNAPSHOT_KEEP: usize = 2;
const HEALTH_FILE: &str = "db-health.json";
pub const CHECK_INTERVAL_SECS: i64 = 24 * 60 * 60;
const PRE_RESTORE_SUFFIX: &str = ".pre-restore";
const STAGING_DIR: &str = "restore-staging";
const BACKUP_TMP_DIR: &str = "backup-tmp";
const MANIFEST_MAX_BYTES: u64 = 1024 * 1024;

const SETTINGS_KV_KEY: &str = "zustand:theorem-settings";
const OPDS_KV_KEY: &str = "zustand:theorem-opds";
const SYNC_PROVISIONED_KV_KEY: &str = "theorem_sync_provisioned";

// ─── Manifest ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct BackupCounts {
    pub books: u64,
    pub annotations: u64,
    pub vocabulary: u64,
    pub rss_feeds: u64,
    pub rss_articles: u64,
    pub reading_sessions: u64,
    pub book_files: u64,
    pub missing_book_files: u64,
    pub audiobook_files: u64,
    pub dictionary_files: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct SchemaInfo {
    pub user_version: i64,
    pub tables: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BackupManifest {
    pub format: String,
    pub format_version: u32,
    pub app_version: String,
    pub created_at: String,
    pub platform: String,
    pub schema: SchemaInfo,
    pub counts: BackupCounts,
    pub includes_dictionaries: bool,
    /// Uncompressed bytes of everything in the archive.
    pub total_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupProgress {
    pub operation: &'static str,
    pub phase: &'static str,
    pub current: u64,
    pub total: u64,
}

pub struct BackupOptions {
    pub include_dictionaries: bool,
    pub app_version: String,
    pub platform: String,
    pub created_at: String,
}

// ─── SQLite helpers ─────────────────────────────────────────────────────

/// `PRAGMA quick_check`: verifies every page and b-tree structure, skipping
/// the index-vs-table cross check that makes `integrity_check` slower.
pub fn quick_check(conn: &Connection) -> Result<(), String> {
    let mut stmt = conn
        .prepare("PRAGMA quick_check")
        .map_err(|e| format!("Integrity check could not run: {e}"))?;
    let rows: Vec<String> = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| format!("Integrity check could not run: {e}"))?
        .collect::<rusqlite::Result<_>>()
        .map_err(|e| format!("Integrity check could not run: {e}"))?;
    if rows.len() == 1 && rows[0] == "ok" {
        Ok(())
    } else {
        let detail: Vec<&str> = rows.iter().take(3).map(String::as_str).collect();
        Err(format!("Database is damaged: {}", detail.join("; ")))
    }
}

fn quick_check_file(path: &Path) -> Result<(), String> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| format!("Cannot open database: {e}"))?;
    quick_check(&conn)
}

/// Run an online backup until done, waiting out writers holding a lock.
fn run_backup(src: &Connection, dst: &mut Connection) -> Result<(), String> {
    let backup = Backup::new(src, dst).map_err(|e| format!("Backup could not start: {e}"))?;
    let mut busy_retries = 0;
    loop {
        match backup
            .step(1024)
            .map_err(|e| format!("Backup failed: {e}"))?
        {
            StepResult::Done => return Ok(()),
            StepResult::Busy | StepResult::Locked => {
                busy_retries += 1;
                if busy_retries > 100 {
                    return Err("Backup failed: the database stayed busy".into());
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            // `More` (the enum is non-exhaustive): keep stepping.
            _ => {}
        }
    }
}

/// Copy a live connection to a standalone single-file database at `dst_path`.
pub fn snapshot_connection(src: &Connection, dst_path: &Path) -> Result<(), String> {
    remove_db_files(dst_path);
    if let Some(parent) = dst_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Cannot create {parent:?}: {e}"))?;
    }
    let mut dst =
        Connection::open(dst_path).map_err(|e| format!("Cannot create snapshot file: {e}"))?;
    run_backup(src, &mut dst)?;
    // The copied header keeps WAL mode; switch to a rollback journal so the
    // snapshot is one self-contained file.
    dst.execute_batch("PRAGMA journal_mode = DELETE;")
        .map_err(|e| format!("Cannot finalize snapshot: {e}"))?;
    Ok(())
}

fn remove_db_files(path: &Path) {
    let _ = fs::remove_file(path);
    for suffix in ["-wal", "-shm", "-journal"] {
        let _ = fs::remove_file(sidecar(path, suffix));
    }
}

fn sidecar(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(suffix);
    PathBuf::from(name)
}

fn table_names(conn: &Connection) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts_%' ORDER BY name")
        .map_err(|e| e.to_string())?;
    let names = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    Ok(names)
}

fn count_rows(conn: &Connection, tables: &[String], table: &str) -> u64 {
    if !tables.iter().any(|t| t == table) {
        return 0;
    }
    conn.query_row(&format!("SELECT COUNT(*) FROM \"{table}\""), [], |row| {
        row.get::<_, i64>(0)
    })
    .map(|n| n.max(0) as u64)
    .unwrap_or(0)
}

fn database_counts(conn: &Connection, tables: &[String]) -> BackupCounts {
    BackupCounts {
        books: count_rows(conn, tables, "book_metadata"),
        annotations: count_rows(conn, tables, "book_annotations"),
        vocabulary: count_rows(conn, tables, "vocabulary"),
        rss_feeds: count_rows(conn, tables, "rss_feeds"),
        rss_articles: count_rows(conn, tables, "rss_articles"),
        reading_sessions: count_rows(conn, tables, "reading_sessions"),
        ..BackupCounts::default()
    }
}

fn book_ids(conn: &Connection, tables: &[String]) -> Result<Vec<String>, String> {
    let mut ids = std::collections::BTreeSet::new();
    for (table, column) in [("book_metadata", "book_id"), ("books", "id")] {
        if !tables.iter().any(|t| t == table) {
            continue;
        }
        let mut stmt = conn
            .prepare(&format!("SELECT {column} FROM {table}"))
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        for id in rows {
            ids.insert(id.map_err(|e| e.to_string())?);
        }
    }
    Ok(ids.into_iter().collect())
}

// ─── Device identity ────────────────────────────────────────────────────

fn read_kv_json(conn: &Connection, key: &str) -> Option<serde_json::Value> {
    let raw: String = conn
        .query_row(
            "SELECT value FROM kv_store WHERE key = ?1",
            params![key],
            |row| row.get(0),
        )
        .optional()
        .ok()
        .flatten()?;
    serde_json::from_str(&raw).ok()
}

fn update_kv_json(
    conn: &Connection,
    key: &str,
    edit: impl FnOnce(&mut serde_json::Value),
) -> Result<(), String> {
    let Some(mut value) = read_kv_json(conn, key) else {
        return Ok(());
    };
    edit(&mut value);
    let raw = serde_json::to_string(&value).map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE kv_store SET value = ?2 WHERE key = ?1",
        params![key, raw],
    )
    .map_err(|e| format!("Cannot update {key}: {e}"))?;
    Ok(())
}

fn has_kv_store(conn: &Connection) -> bool {
    conn.query_row(
        "SELECT COUNT(*) > 0 FROM sqlite_master WHERE type = 'table' AND name = 'kv_store'",
        [],
        |row| row.get::<_, bool>(0),
    )
    .unwrap_or(false)
}

/// Remove what ties a database to this device: the sync device id, paired
/// devices (whose doc tickets grant access to the sync document), the
/// provisioned flag, and OPDS catalog credentials.
pub fn strip_device_identity(conn: &Connection) -> Result<(), String> {
    if !has_kv_store(conn) {
        return Ok(());
    }
    update_kv_json(conn, SETTINGS_KV_KEY, |value| {
        if let Some(sync) = value.pointer_mut("/state/settings/deviceSync") {
            if let Some(obj) = sync.as_object_mut() {
                obj.insert("deviceId".into(), serde_json::Value::String(String::new()));
                obj.insert(
                    "deviceName".into(),
                    serde_json::Value::String(String::new()),
                );
                obj.insert("pairedDevices".into(), serde_json::Value::Array(Vec::new()));
            }
        }
    })?;
    update_kv_json(conn, OPDS_KV_KEY, |value| {
        if let Some(catalogs) = value
            .pointer_mut("/state/catalogs")
            .and_then(|c| c.as_array_mut())
        {
            for catalog in catalogs {
                if let Some(obj) = catalog.as_object_mut() {
                    obj.remove("auth");
                }
            }
        }
    })?;
    conn.execute(
        "DELETE FROM kv_store WHERE key = ?1",
        params![SYNC_PROVISIONED_KV_KEY],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Carry this device's own identity (sync settings, catalog credentials)
/// from the live database into a database about to replace it, so a restore
/// keeps the device paired and signed in.
pub fn carry_device_identity(live: &Connection, incoming: &Connection) -> Result<(), String> {
    if !has_kv_store(incoming) {
        return Ok(());
    }
    let live_settings = if has_kv_store(live) {
        read_kv_json(live, SETTINGS_KV_KEY)
    } else {
        None
    };
    let live_opds = if has_kv_store(live) {
        read_kv_json(live, OPDS_KV_KEY)
    } else {
        None
    };

    if let Some(local_sync) = live_settings
        .as_ref()
        .and_then(|v| v.pointer("/state/settings/deviceSync"))
        .cloned()
    {
        update_kv_json(incoming, SETTINGS_KV_KEY, |value| {
            if let Some(settings) = value
                .pointer_mut("/state/settings")
                .and_then(|s| s.as_object_mut())
            {
                settings.insert("deviceSync".into(), local_sync);
            }
        })?;
    }

    if let Some(local_catalogs) = live_opds
        .as_ref()
        .and_then(|v| v.pointer("/state/catalogs"))
        .and_then(|c| c.as_array())
    {
        update_kv_json(incoming, OPDS_KV_KEY, |value| {
            if let Some(catalogs) = value
                .pointer_mut("/state/catalogs")
                .and_then(|c| c.as_array_mut())
            {
                for catalog in catalogs {
                    let id = catalog.get("id").cloned();
                    let auth = local_catalogs
                        .iter()
                        .find(|c| c.get("id") == id.as_ref() && id.is_some())
                        .and_then(|c| c.get("auth"))
                        .cloned();
                    if let (Some(auth), Some(obj)) = (auth, catalog.as_object_mut()) {
                        obj.insert("auth".into(), auth);
                    }
                }
            }
        })?;
    }

    // The restored library is new to the sync document: provision it again.
    incoming
        .execute(
            "DELETE FROM kv_store WHERE key = ?1",
            params![SYNC_PROVISIONED_KV_KEY],
        )
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ─── Writing a backup ───────────────────────────────────────────────────

struct PlannedFile {
    source: PathBuf,
    entry: String,
    size: u64,
}

fn collect_tree(root: &Path, prefix: &str, out: &mut Vec<PlannedFile>) {
    if !root.is_dir() {
        return;
    }
    for entry in walkdir::WalkDir::new(root)
        .follow_links(false)
        .sort_by_file_name()
        .into_iter()
        .filter_map(Result::ok)
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let Ok(rel) = entry.path().strip_prefix(root) else {
            continue;
        };
        let parts: Option<Vec<&str>> = rel
            .components()
            .map(|c| match c {
                Component::Normal(s) => s.to_str(),
                _ => None,
            })
            .collect();
        let Some(parts) = parts else { continue };
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        out.push(PlannedFile {
            source: entry.path().to_path_buf(),
            entry: format!("{prefix}/{}", parts.join("/")),
            size,
        });
    }
}

fn file_options(size: u64, compress: bool) -> zip::write::SimpleFileOptions {
    zip::write::SimpleFileOptions::default()
        .compression_method(if compress {
            zip::CompressionMethod::Deflated
        } else {
            zip::CompressionMethod::Stored
        })
        .large_file(size >= u32::MAX as u64)
}

/// Write a `.theorem-backup` archive of `live` plus the app's files under
/// `app_data_dir` to `out_path`, streaming each entry. The archive is written
/// to `<out_path>.partial` and renamed when complete.
pub fn write_backup(
    live: &Connection,
    app_data_dir: &Path,
    out_path: &Path,
    options: &BackupOptions,
    progress: &mut dyn FnMut(BackupProgress),
) -> Result<BackupManifest, String> {
    let tmp_dir = app_data_dir.join(BACKUP_TMP_DIR);
    fs::create_dir_all(&tmp_dir).map_err(|e| format!("Cannot create {tmp_dir:?}: {e}"))?;
    let snapshot_path = tmp_dir.join(format!("snapshot-{}.db", uuid::Uuid::new_v4()));
    let partial_path = sidecar(out_path, ".partial");

    let result = (|| {
        progress(BackupProgress {
            operation: "backup",
            phase: "database",
            current: 0,
            total: 1,
        });
        snapshot_connection(live, &snapshot_path)?;

        let (schema, mut counts, ids) = {
            let snap = Connection::open(&snapshot_path)
                .map_err(|e| format!("Cannot open snapshot: {e}"))?;
            // Overwrite freed pages so stripped values leave no trace.
            snap.execute_batch("PRAGMA secure_delete = ON;")
                .map_err(|e| e.to_string())?;
            strip_device_identity(&snap)?;
            // Rebuild the file: free pages copied from the live database can
            // still hold older copies of what was just stripped.
            snap.execute_batch("VACUUM;")
                .map_err(|e| format!("Cannot compact snapshot: {e}"))?;
            quick_check(&snap)?;
            let tables = table_names(&snap)?;
            let user_version: i64 = snap
                .query_row("PRAGMA user_version", [], |row| row.get(0))
                .unwrap_or(0);
            let counts = database_counts(&snap, &tables);
            let ids = book_ids(&snap, &tables)?;
            (
                SchemaInfo {
                    user_version,
                    tables,
                },
                counts,
                ids,
            )
        };

        let mut files = Vec::new();
        let cache_dir = app_data_dir.join(BOOK_CACHE_DIR);
        for id in &ids {
            if !is_safe_file_name(id) {
                continue;
            }
            let path = cache_dir.join(format!("{id}.book"));
            match fs::metadata(&path) {
                Ok(meta) if meta.is_file() => {
                    files.push(PlannedFile {
                        source: path,
                        entry: format!("{BOOK_CACHE_DIR}/{id}.book"),
                        size: meta.len(),
                    });
                    counts.book_files += 1;
                }
                _ => counts.missing_book_files += 1,
            }
        }
        let before = files.len();
        collect_tree(
            &app_data_dir.join(AUDIOBOOKS_DIR),
            AUDIOBOOKS_DIR,
            &mut files,
        );
        counts.audiobook_files = (files.len() - before) as u64;
        if options.include_dictionaries {
            let before = files.len();
            collect_tree(
                &app_data_dir.join(DICTIONARIES_DIR),
                DICTIONARIES_DIR,
                &mut files,
            );
            counts.dictionary_files = (files.len() - before) as u64;
        }

        let db_size = fs::metadata(&snapshot_path).map(|m| m.len()).unwrap_or(0);
        let manifest = BackupManifest {
            format: BACKUP_FORMAT.into(),
            format_version: BACKUP_FORMAT_VERSION,
            app_version: options.app_version.clone(),
            created_at: options.created_at.clone(),
            platform: options.platform.clone(),
            schema,
            counts,
            includes_dictionaries: options.include_dictionaries,
            total_bytes: db_size + files.iter().map(|f| f.size).sum::<u64>(),
        };

        if let Some(parent) = out_path.parent() {
            if !parent.as_os_str().is_empty() {
                fs::create_dir_all(parent).map_err(|e| format!("Cannot create {parent:?}: {e}"))?;
            }
        }
        let out =
            File::create(&partial_path).map_err(|e| format!("Cannot create backup file: {e}"))?;
        let mut zip = zip::ZipWriter::new(BufWriter::with_capacity(1 << 20, out));
        let write_err = |e: zip::result::ZipError| format!("Cannot write backup: {e}");
        let io_err = |e: io::Error| format!("Cannot write backup: {e}");

        let manifest_json = serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?;
        zip.start_file(MANIFEST_ENTRY, file_options(0, true))
            .map_err(write_err)?;
        zip.write_all(&manifest_json).map_err(io_err)?;

        zip.start_file(DB_ENTRY, file_options(db_size, true))
            .map_err(write_err)?;
        let mut db_file = BufReader::new(
            File::open(&snapshot_path).map_err(|e| format!("Cannot read snapshot: {e}"))?,
        );
        io::copy(&mut db_file, &mut zip).map_err(io_err)?;

        let total = files.len() as u64;
        for (index, file) in files.iter().enumerate() {
            progress(BackupProgress {
                operation: "backup",
                phase: if file.entry.starts_with(BOOK_CACHE_DIR) {
                    "books"
                } else if file.entry.starts_with(AUDIOBOOKS_DIR) {
                    "audiobooks"
                } else {
                    "dictionaries"
                },
                current: index as u64,
                total,
            });
            let source = match File::open(&file.source) {
                Ok(f) => f,
                // A file removed since planning: skip it rather than abort.
                Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
                Err(e) => return Err(format!("Cannot read {:?}: {e}", file.source)),
            };
            zip.start_file(file.entry.as_str(), file_options(file.size, false))
                .map_err(write_err)?;
            io::copy(&mut BufReader::with_capacity(1 << 20, source), &mut zip).map_err(io_err)?;
        }

        progress(BackupProgress {
            operation: "backup",
            phase: "finalizing",
            current: total,
            total,
        });
        let writer = zip.finish().map_err(write_err)?;
        let file = writer
            .into_inner()
            .map_err(|e| format!("Cannot write backup: {}", e.error()))?;
        file.sync_all().map_err(io_err)?;
        drop(file);
        fs::rename(&partial_path, out_path)
            .map_err(|e| format!("Cannot finish backup file: {e}"))?;
        Ok(manifest)
    })();

    remove_db_files(&snapshot_path);
    let _ = fs::remove_dir(&tmp_dir);
    if result.is_err() {
        let _ = fs::remove_file(&partial_path);
    }
    result
}

// ─── Reading and restoring a backup ─────────────────────────────────────

fn is_safe_file_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 255
        && name != "."
        && !name.starts_with('.')
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
}

/// Map an archive entry name to a path relative to the app data dir, or
/// `None` when it is not something a backup may restore.
pub fn restorable_entry_path(name: &str) -> Option<PathBuf> {
    let mut parts = name.split('/');
    let top = parts.next()?;
    let rest: Vec<&str> = parts.collect();
    match top {
        BOOK_CACHE_DIR => {
            if rest.len() != 1 {
                return None;
            }
            let file = rest[0];
            if !file.ends_with(".book") || !is_safe_file_name(file) {
                return None;
            }
            Some(Path::new(BOOK_CACHE_DIR).join(file))
        }
        AUDIOBOOKS_DIR | DICTIONARIES_DIR => {
            if rest.is_empty() || rest.len() > 8 {
                return None;
            }
            let mut path = PathBuf::from(top);
            for part in rest {
                if part.is_empty()
                    || part == "."
                    || part == ".."
                    || part.contains('\\')
                    || part.contains(':')
                    || part.contains('\0')
                {
                    return None;
                }
                path.push(part);
            }
            Some(path)
        }
        _ => None,
    }
}

fn parse_version(v: &str) -> (u64, u64, u64) {
    let core = v.trim().trim_start_matches('v');
    let core = core.split(['-', '+']).next().unwrap_or("");
    let mut nums = core.split('.').map(|p| p.parse::<u64>().unwrap_or(0));
    (
        nums.next().unwrap_or(0),
        nums.next().unwrap_or(0),
        nums.next().unwrap_or(0),
    )
}

fn open_archive(path: &Path) -> Result<zip::ZipArchive<BufReader<File>>, String> {
    let file = File::open(path).map_err(|e| format!("Cannot open backup file: {e}"))?;
    zip::ZipArchive::new(BufReader::new(file))
        .map_err(|_| "This is not a Theorem backup file (not a valid archive).".to_string())
}

fn read_manifest_from(
    archive: &mut zip::ZipArchive<BufReader<File>>,
) -> Result<BackupManifest, String> {
    let entry = archive
        .by_name(MANIFEST_ENTRY)
        .map_err(|_| "This is not a Theorem backup file (no manifest).".to_string())?;
    if entry.size() > MANIFEST_MAX_BYTES {
        return Err("The backup manifest is invalid.".into());
    }
    let mut raw = Vec::new();
    entry
        .take(MANIFEST_MAX_BYTES)
        .read_to_end(&mut raw)
        .map_err(|e| format!("The backup manifest cannot be read: {e}"))?;
    serde_json::from_slice(&raw).map_err(|_| "The backup manifest is invalid.".to_string())
}

pub fn validate_manifest(manifest: &BackupManifest, current_version: &str) -> Result<(), String> {
    if manifest.format != BACKUP_FORMAT {
        return Err("This is not a Theorem backup file.".into());
    }
    if manifest.format_version == 0 || manifest.format_version > BACKUP_FORMAT_VERSION {
        return Err(format!(
            "This backup uses a newer format ({}). Update Theorem to restore it.",
            manifest.format_version
        ));
    }
    if parse_version(&manifest.app_version) > parse_version(current_version) {
        return Err(format!(
            "This backup was made by Theorem {}. Update Theorem (now {current_version}) to restore it.",
            manifest.app_version
        ));
    }
    Ok(())
}

/// Read and validate a backup's manifest without extracting anything.
pub fn inspect_backup(path: &Path, current_version: &str) -> Result<BackupManifest, String> {
    let mut archive = open_archive(path)?;
    let manifest = read_manifest_from(&mut archive)?;
    validate_manifest(&manifest, current_version)?;
    Ok(manifest)
}

pub struct StagedRestore {
    pub db_path: PathBuf,
    pub files_dir: PathBuf,
    pub manifest: BackupManifest,
}

/// Extract a backup into `staging_dir` and validate it: manifest, database
/// integrity, and that the archive holds what the manifest lists.
pub fn stage_backup(
    path: &Path,
    staging_dir: &Path,
    current_version: &str,
    progress: &mut dyn FnMut(BackupProgress),
) -> Result<StagedRestore, String> {
    let _ = fs::remove_dir_all(staging_dir);
    fs::create_dir_all(staging_dir).map_err(|e| format!("Cannot create staging folder: {e}"))?;
    let result = stage_backup_inner(path, staging_dir, current_version, progress);
    if result.is_err() {
        let _ = fs::remove_dir_all(staging_dir);
    }
    result
}

fn stage_backup_inner(
    path: &Path,
    staging_dir: &Path,
    current_version: &str,
    progress: &mut dyn FnMut(BackupProgress),
) -> Result<StagedRestore, String> {
    let mut archive = open_archive(path)?;
    let manifest = read_manifest_from(&mut archive)?;
    validate_manifest(&manifest, current_version)?;

    progress(BackupProgress {
        operation: "restore",
        phase: "database",
        current: 0,
        total: 1,
    });
    let db_path = staging_dir.join(DB_FILE_NAME);
    {
        let mut entry = archive
            .by_name(DB_ENTRY)
            .map_err(|_| "The backup has no library database.".to_string())?;
        let mut out = BufWriter::new(
            File::create(&db_path).map_err(|e| format!("Cannot stage database: {e}"))?,
        );
        io::copy(&mut entry, &mut out)
            .map_err(|e| format!("The backup's database is damaged: {e}"))?;
        out.flush().map_err(|e| e.to_string())?;
    }
    {
        let conn = Connection::open(&db_path)
            .map_err(|e| format!("The backup's database cannot be opened: {e}"))?;
        quick_check(&conn).map_err(|e| format!("The backup's database is damaged: {e}"))?;
        let tables =
            table_names(&conn).map_err(|e| format!("The backup's database is damaged: {e}"))?;
        for required in ["book_metadata", "kv_store"] {
            if !tables.iter().any(|t| t == required) {
                return Err("The backup's database is not a Theorem library.".into());
            }
        }
        let counts = database_counts(&conn, &tables);
        if counts.books != manifest.counts.books
            || counts.annotations != manifest.counts.annotations
        {
            return Err(
                "The backup's database does not match its manifest; the file may be damaged."
                    .into(),
            );
        }
    }

    let files_dir = staging_dir.join("files");
    let total = archive.len() as u64;
    let mut book_files = 0u64;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|e| format!("The backup is damaged: {e}"))?;
        let name = entry
            .name()
            .map_err(|e| format!("The backup is damaged: {e}"))?
            .to_string();
        if entry.is_dir() || name == MANIFEST_ENTRY || name == DB_ENTRY {
            continue;
        }
        let Some(rel) = restorable_entry_path(&name) else {
            continue;
        };
        if rel.starts_with(BOOK_CACHE_DIR) {
            book_files += 1;
        }
        progress(BackupProgress {
            operation: "restore",
            phase: "files",
            current: index as u64,
            total,
        });
        let target = files_dir.join(&rel);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("Cannot stage files: {e}"))?;
        }
        let mut out = BufWriter::with_capacity(
            1 << 20,
            File::create(&target).map_err(|e| format!("Cannot stage files: {e}"))?,
        );
        // Reading to the end verifies the entry's CRC.
        io::copy(&mut entry, &mut out)
            .map_err(|e| format!("The backup is damaged ({name}): {e}"))?;
        out.flush().map_err(|e| e.to_string())?;
    }
    if book_files != manifest.counts.book_files {
        return Err(format!(
            "The backup lists {} book files but holds {book_files}; the file may be damaged.",
            manifest.counts.book_files
        ));
    }

    Ok(StagedRestore {
        db_path,
        files_dir,
        manifest,
    })
}

/// Move staged files into the app data dir. Files with the same name are
/// replaced; other files already there are left alone (the pre-restore
/// database still refers to them).
pub fn install_staged_files(files_dir: &Path, app_data_dir: &Path) -> Result<u64, String> {
    if !files_dir.is_dir() {
        return Ok(0);
    }
    let mut moved = 0;
    for entry in walkdir::WalkDir::new(files_dir)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let Ok(rel) = entry.path().strip_prefix(files_dir) else {
            continue;
        };
        let target = app_data_dir.join(rel);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("Cannot create {parent:?}: {e}"))?;
        }
        if fs::rename(entry.path(), &target).is_err() {
            fs::copy(entry.path(), &target).map_err(|e| format!("Cannot restore {rel:?}: {e}"))?;
            let _ = fs::remove_file(entry.path());
        }
        moved += 1;
    }
    Ok(moved)
}

pub fn pre_restore_path(live_db: &Path) -> PathBuf {
    sidecar(live_db, PRE_RESTORE_SUFFIX)
}

/// Replace the live database's contents with `src_db`.
///
/// The current database is first kept as `theorem.db.pre-restore`. The copy
/// uses the online backup API into the live file, so connections in the pool
/// stay valid and see the new contents. `pool_open` says whether the app's
/// pool holds the file open; only when it does not may a live file too
/// damaged for the backup API be replaced on disk instead.
pub fn replace_live_database(
    src_db: &Path,
    live_db: &Path,
    carry_identity: bool,
    pool_open: bool,
) -> Result<(), String> {
    quick_check_file(src_db)?;

    // 1. Keep the current database for rollback.
    let pre_restore = pre_restore_path(live_db);
    if live_db.exists() {
        let kept = Connection::open(live_db)
            .map_err(|e| e.to_string())
            .and_then(|live| snapshot_connection(&live, &pre_restore));
        if kept.is_err() {
            // Too damaged to read through SQLite: keep the raw files.
            remove_db_files(&pre_restore);
            fs::copy(live_db, &pre_restore)
                .map_err(|e| format!("Cannot keep the current database: {e}"))?;
            let wal = sidecar(live_db, "-wal");
            if wal.exists() {
                let _ = fs::copy(&wal, sidecar(&pre_restore, "-wal"));
            }
        }
    }

    // 2. This device keeps its own sync identity and catalog sign-ins.
    let src = Connection::open(src_db).map_err(|e| format!("Cannot open restore source: {e}"))?;
    if carry_identity {
        if let Ok(live) = Connection::open_with_flags(
            &pre_restore,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        ) {
            if let Err(e) = carry_device_identity(&live, &src) {
                log::warn!("[db_backup] Could not carry device identity: {e}");
            }
        }
    }

    // 3. Copy into the live file.
    let copied = Connection::open(live_db)
        .map_err(|e| e.to_string())
        .and_then(|mut dst| {
            dst.busy_timeout(Duration::from_secs(5))
                .map_err(|e| e.to_string())?;
            run_backup(&src, &mut dst)?;
            quick_check(&dst)
        });
    drop(src);
    match copied {
        Ok(()) => Ok(()),
        Err(e) if !pool_open => {
            log::warn!("[db_backup] Online restore failed ({e}); replacing the file");
            remove_db_files(live_db);
            fs::copy(src_db, live_db).map_err(|e| format!("Cannot restore database: {e}"))?;
            quick_check_file(live_db)
        }
        Err(e) => Err(format!(
            "Restore failed: {e}. Your previous library is kept as {}.",
            pre_restore.display()
        )),
    }
}

// ─── Automatic snapshots ────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotInfo {
    pub name: String,
    pub created_at: i64,
    pub app_version: String,
    pub size: u64,
}

pub fn snapshot_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(SNAPSHOT_DIR)
}

fn snapshot_name(now_secs: i64, version: &str) -> String {
    let version: String = version
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '.' || *c == '-')
        .collect();
    format!("{SNAPSHOT_PREFIX}{now_secs}-v{version}{SNAPSHOT_SUFFIX}")
}

fn parse_snapshot_name(name: &str) -> Option<(i64, String)> {
    let core = name
        .strip_prefix(SNAPSHOT_PREFIX)?
        .strip_suffix(SNAPSHOT_SUFFIX)?;
    let (ts, version) = core.split_once("-v")?;
    if !is_safe_file_name(name) {
        return None;
    }
    Some((ts.parse().ok()?, version.to_string()))
}

/// Snapshots, newest first.
pub fn list_snapshots(app_data_dir: &Path) -> Vec<SnapshotInfo> {
    let Ok(entries) = fs::read_dir(snapshot_dir(app_data_dir)) else {
        return Vec::new();
    };
    let mut list: Vec<SnapshotInfo> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            let (created_at, app_version) = parse_snapshot_name(&name)?;
            let size = entry.metadata().ok()?.len();
            Some(SnapshotInfo {
                name,
                created_at,
                app_version,
                size,
            })
        })
        .collect();
    list.sort_by(|a, b| b.created_at.cmp(&a.created_at).then(b.name.cmp(&a.name)));
    list
}

/// Write a new snapshot of `conn` and keep only the newest `SNAPSHOT_KEEP`.
pub fn take_snapshot(
    conn: &Connection,
    app_data_dir: &Path,
    version: &str,
    now_secs: i64,
) -> Result<PathBuf, String> {
    let dir = snapshot_dir(app_data_dir);
    fs::create_dir_all(&dir).map_err(|e| format!("Cannot create {dir:?}: {e}"))?;
    let path = dir.join(snapshot_name(now_secs, version));
    let partial = sidecar(&path, ".partial");
    snapshot_connection(conn, &partial)?;
    fs::rename(&partial, &path).map_err(|e| format!("Cannot finish snapshot: {e}"))?;
    for old in list_snapshots(app_data_dir).into_iter().skip(SNAPSHOT_KEEP) {
        remove_db_files(&dir.join(old.name));
    }
    Ok(path)
}

pub fn snapshot_path(app_data_dir: &Path, name: &str) -> Result<PathBuf, String> {
    if parse_snapshot_name(name).is_none() {
        return Err("Unknown snapshot".into());
    }
    let path = snapshot_dir(app_data_dir).join(name);
    if !path.is_file() {
        return Err("This snapshot no longer exists.".into());
    }
    Ok(path)
}

// ─── Startup guard ──────────────────────────────────────────────────────

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct HealthRecord {
    last_check_at: i64,
    last_check_version: String,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DbStatus {
    Ok,
    Corrupt,
    MigrationFailed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbHealth {
    pub status: DbStatus,
    pub message: Option<String>,
    /// Whether `quick_check` ran this start.
    pub checked: bool,
    pub snapshots: Vec<SnapshotInfo>,
}

impl DbHealth {
    fn ok(checked: bool) -> Self {
        DbHealth {
            status: DbStatus::Ok,
            message: None,
            checked,
            snapshots: Vec::new(),
        }
    }
}

fn read_health_record(app_data_dir: &Path) -> HealthRecord {
    fs::read(app_data_dir.join(HEALTH_FILE))
        .ok()
        .and_then(|raw| serde_json::from_slice(&raw).ok())
        .unwrap_or_default()
}

fn write_health_record(app_data_dir: &Path, record: &HealthRecord) {
    if let Ok(raw) = serde_json::to_vec(record) {
        let _ = fs::write(app_data_dir.join(HEALTH_FILE), raw);
    }
}

/// Whether this start should check and snapshot the database.
pub fn check_due(last_check_at: i64, last_version: &str, version: &str, now_secs: i64) -> bool {
    last_version != version
        || now_secs < last_check_at
        || now_secs - last_check_at >= CHECK_INTERVAL_SECS
}

fn looks_corrupt(message: &str) -> bool {
    let m = message.to_ascii_lowercase();
    m.contains("malformed") || m.contains("not a database") || m.contains("corrupt")
}

/// Check, snapshot, then migrate the database at `db_path`.
pub fn startup_guard_at(
    db_path: &Path,
    app_data_dir: &Path,
    version: &str,
    now_secs: i64,
    migrate: impl FnOnce() -> Result<(), String>,
) -> DbHealth {
    let mut health = DbHealth::ok(false);
    let exists = fs::metadata(db_path).map(|m| m.len() > 0).unwrap_or(false);

    if exists {
        let record = read_health_record(app_data_dir);
        if check_due(
            record.last_check_at,
            &record.last_check_version,
            version,
            now_secs,
        ) {
            health.checked = true;
            let checked = Connection::open(db_path)
                .map_err(|e| format!("Cannot open database: {e}"))
                .and_then(|conn| {
                    quick_check(&conn)?;
                    Ok(conn)
                });
            match checked {
                Ok(conn) => {
                    if let Err(e) = take_snapshot(&conn, app_data_dir, version, now_secs) {
                        log::warn!("[db_backup] Automatic snapshot failed: {e}");
                    }
                    write_health_record(
                        app_data_dir,
                        &HealthRecord {
                            last_check_at: now_secs,
                            last_check_version: version.to_string(),
                        },
                    );
                }
                Err(message) => {
                    // Leave the record alone so the next start checks again,
                    // and do not migrate (or VACUUM) a damaged file.
                    health.status = DbStatus::Corrupt;
                    health.message = Some(message);
                    health.snapshots = list_snapshots(app_data_dir);
                    return health;
                }
            }
        }
    } else {
        write_health_record(
            app_data_dir,
            &HealthRecord {
                last_check_at: now_secs,
                last_check_version: version.to_string(),
            },
        );
    }

    if let Err(message) = migrate() {
        health.status = if looks_corrupt(&message) {
            DbStatus::Corrupt
        } else {
            DbStatus::MigrationFailed
        };
        health.message = Some(message);
        health.snapshots = list_snapshots(app_data_dir);
    }
    health
}

static HEALTH: Mutex<Option<DbHealth>> = Mutex::new(None);

fn set_health(health: DbHealth) {
    if let Ok(mut slot) = HEALTH.lock() {
        *slot = Some(health);
    }
}

fn current_health() -> DbHealth {
    HEALTH
        .lock()
        .ok()
        .and_then(|slot| slot.clone())
        .unwrap_or_else(|| DbHealth::ok(false))
}

// ─── Tauri glue ─────────────────────────────────────────────────────────

use tauri::{AppHandle, Emitter, Manager};

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data directory: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("Cannot create {dir:?}: {e}"))?;
    Ok(dir)
}

fn app_version(app: &AppHandle) -> String {
    app.package_info().version.to_string()
}

fn now_secs() -> i64 {
    chrono::Utc::now().timestamp()
}

/// Called from `setup`: the integrity check and the startup migrations.
/// Returns whether the database is healthy, i.e. whether the deferred
/// maintenance (`db_maintenance`) may run on it.
pub fn run_startup_guard(app: &AppHandle) -> bool {
    let dir = match app_data_dir(app) {
        Ok(dir) => dir,
        Err(e) => {
            log::warn!("[db_backup] {e}");
            return match crate::database::run_startup_migrations(app) {
                Ok(()) => true,
                Err(e) => {
                    log::error!("[database] Schema migration failed: {e}");
                    false
                }
            };
        }
    };
    let started = std::time::Instant::now();
    let health = startup_guard_at(
        &dir.join(DB_FILE_NAME),
        &dir,
        &app_version(app),
        now_secs(),
        || crate::database::run_startup_migrations(app),
    );
    if health.checked {
        log::warn!(
            "[db_backup] Integrity check and snapshot took {} ms",
            started.elapsed().as_millis()
        );
    }
    if health.status != DbStatus::Ok {
        log::warn!(
            "[db_backup] Database needs attention ({:?}): {}",
            health.status,
            health.message.as_deref().unwrap_or("")
        );
    }
    let healthy = crate::db_maintenance::may_run_after(&health);
    set_health(health);
    healthy
}

fn emit_progress(app: &AppHandle) -> impl FnMut(BackupProgress) + '_ {
    move |progress| {
        let _ = app.emit(PROGRESS_EVENT, progress);
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupResult {
    /// Where the backup ended up: a file path, or on Android a content URI.
    pub location: String,
    pub manifest: BackupManifest,
    pub size: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreResult {
    pub manifest: Option<BackupManifest>,
    pub files_restored: u64,
    /// Set when the restored database could not be migrated to this version.
    pub migration_error: Option<String>,
}

pub fn default_backup_file_name(now: chrono::DateTime<chrono::Local>) -> String {
    format!("theorem-{}.{BACKUP_EXTENSION}", now.format("%Y-%m-%d"))
}

fn create_backup_blocking(
    app: &AppHandle,
    output_path: Option<String>,
    include_dictionaries: bool,
) -> Result<BackupResult, String> {
    let dir = app_data_dir(app)?;
    let file_name = default_backup_file_name(chrono::Local::now());
    // Android writes into the app cache first, then streams it to Downloads.
    let (out_path, export_to_downloads) = match output_path {
        Some(path) if !path.trim().is_empty() => (PathBuf::from(path), false),
        _ if cfg!(target_os = "android") => {
            let cache = app
                .path()
                .app_cache_dir()
                .map_err(|e| format!("Cannot resolve cache folder: {e}"))?;
            (cache.join(&file_name), true)
        }
        _ => return Err("Choose where to save the backup.".into()),
    };

    let options = BackupOptions {
        include_dictionaries,
        app_version: app_version(app),
        platform: std::env::consts::OS.to_string(),
        created_at: chrono::Utc::now().to_rfc3339(),
    };
    let mut progress = emit_progress(app);
    let manifest = crate::database::with_connection(app, |conn| {
        Ok(write_backup(conn, &dir, &out_path, &options, &mut progress))
    })??;
    let size = fs::metadata(&out_path).map(|m| m.len()).unwrap_or(0);

    let location = if export_to_downloads {
        let exported = export_file_to_downloads(app, &out_path, &file_name);
        let _ = fs::remove_file(&out_path);
        exported?
    } else {
        out_path.to_string_lossy().into_owned()
    };
    Ok(BackupResult {
        location,
        manifest,
        size,
    })
}

#[cfg(target_os = "android")]
fn export_file_to_downloads(
    app: &AppHandle,
    path: &Path,
    file_name: &str,
) -> Result<String, String> {
    tauri_plugin_mobile_folder_scan::save_file_from_path(app, &path.to_string_lossy(), file_name)
}

#[cfg(not(target_os = "android"))]
fn export_file_to_downloads(
    _app: &AppHandle,
    path: &Path,
    _file_name: &str,
) -> Result<String, String> {
    Ok(path.to_string_lossy().into_owned())
}

/// Bring a restored database up to the current schema. The restore itself
/// already succeeded, so a migration failure is reported, not returned.
fn finish_restore(app: &AppHandle) -> Option<String> {
    match crate::database::run_schema_migrations(app) {
        Ok(()) => {
            set_health(DbHealth::ok(true));
            None
        }
        Err(message) => {
            set_health(DbHealth {
                status: DbStatus::MigrationFailed,
                message: Some(message.clone()),
                checked: true,
                snapshots: Vec::new(),
            });
            Some(message)
        }
    }
}

fn restore_backup_blocking(app: &AppHandle, path: String) -> Result<RestoreResult, String> {
    let dir = app_data_dir(app)?;
    let staging = dir.join(STAGING_DIR);
    let mut progress = emit_progress(app);
    let staged = stage_backup(Path::new(&path), &staging, &app_version(app), &mut progress)?;
    let result = (|| {
        progress(BackupProgress {
            operation: "restore",
            phase: "applying",
            current: 0,
            total: 1,
        });
        let files_restored = install_staged_files(&staged.files_dir, &dir)?;
        replace_live_database(
            &staged.db_path,
            &dir.join(DB_FILE_NAME),
            true,
            crate::database::db_pool_initialized(),
        )?;
        Ok(RestoreResult {
            manifest: Some(staged.manifest.clone()),
            files_restored,
            migration_error: finish_restore(app),
        })
    })();
    let _ = fs::remove_dir_all(&staging);
    result
}

fn restore_snapshot_blocking(app: &AppHandle, name: String) -> Result<RestoreResult, String> {
    let dir = app_data_dir(app)?;
    let snapshot = snapshot_path(&dir, &name)?;
    // Work on a copy: carrying the device identity writes to the source.
    let staging = dir.join(STAGING_DIR);
    let _ = fs::remove_dir_all(&staging);
    fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
    let copy = staging.join(DB_FILE_NAME);
    let result = fs::copy(&snapshot, &copy)
        .map_err(|e| format!("Cannot read snapshot: {e}"))
        .and_then(|_| {
            replace_live_database(
                &copy,
                &dir.join(DB_FILE_NAME),
                true,
                crate::database::db_pool_initialized(),
            )
        });
    let _ = fs::remove_dir_all(&staging);
    result?;
    Ok(RestoreResult {
        manifest: None,
        files_restored: 0,
        migration_error: finish_restore(app),
    })
}

async fn offload<T, F>(task: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|e| format!("Background task failed: {e}"))?
}

#[tauri::command]
pub fn db_health_status(app: AppHandle) -> DbHealth {
    let mut health = current_health();
    if health.status != DbStatus::Ok {
        if let Ok(dir) = app_data_dir(&app) {
            health.snapshots = list_snapshots(&dir);
        }
    }
    health
}

/// The user chose to continue with the database as it is.
#[tauri::command]
pub fn db_health_dismiss() {
    let mut health = current_health();
    health.status = DbStatus::Ok;
    health.message = None;
    set_health(health);
}

#[tauri::command]
pub async fn db_list_snapshots(app: AppHandle) -> Result<Vec<SnapshotInfo>, String> {
    offload(move || Ok(list_snapshots(&app_data_dir(&app)?))).await
}

#[tauri::command]
pub async fn db_backup_create(
    app: AppHandle,
    output_path: Option<String>,
    include_dictionaries: bool,
) -> Result<BackupResult, String> {
    offload(move || create_backup_blocking(&app, output_path, include_dictionaries)).await
}

#[tauri::command]
pub async fn db_backup_inspect(app: AppHandle, path: String) -> Result<BackupManifest, String> {
    offload(move || inspect_backup(Path::new(&path), &app_version(&app))).await
}

#[tauri::command]
pub async fn db_backup_restore(app: AppHandle, path: String) -> Result<RestoreResult, String> {
    offload(move || restore_backup_blocking(&app, path)).await
}

#[tauri::command]
pub async fn db_restore_snapshot(app: AppHandle, name: String) -> Result<RestoreResult, String> {
    offload(move || restore_snapshot_blocking(&app, name)).await
}

#[cfg(test)]
mod tests;
