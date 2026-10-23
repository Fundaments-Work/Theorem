//! Database housekeeping that does not have to finish before the first paint.
//!
//! `setup()` runs before the window can draw (and, on Android, inside the
//! activity's start, where a few seconds mean an "app not responding"
//! dialog). It used to run all of this there as well. Only what the interface
//! reads at startup stays on that path (`database::run_startup_migrations`:
//! schema, versioned migrations, RSS time units). Everything here is safe to
//! finish later because a reader of the data copes with the old form:
//!
//! - covers still stored as data URLs: the cover protocol and the cover
//!   commands decode either form;
//! - books still stored in `books.data`: book reads fall back to the BLOB and
//!   write the cache file themselves;
//! - StarDict dictionaries still in `blob_store`: lookups find them once they
//!   are on disk (a few seconds after start, instead of before it);
//! - books flagged `syncedWithoutFile` whose file is present: the interface
//!   is told (`HEALED_EVENT`) and clears the flag on the books it loaded;
//! - `books_fts` drift: search misses at most what changed outside the app,
//!   for the seconds this takes;
//! - legacy directories, and the `VACUUM` that gives the space of reclaimed
//!   BLOBs back to the disk.
//!
//! Every write here is guarded so it cannot overwrite a change the app made
//! meanwhile, runs in short transactions on pooled connections (WAL: the UI
//! keeps reading and writing), and a failing step is logged and skipped, never
//! retried in a loop and never surfaced as a database error. `VACUUM` blocks
//! every writer while it runs, so it waits until the database has been idle
//! for a while; if that never happens it stays pending for the next start.

use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;
use std::time::{Duration, Instant, SystemTime};

/// Set in `kv_store` when reclaimed BLOBs left free pages for `VACUUM` to
/// return; cleared once it has run. Never synced (`is_syncable_kv_key`).
pub(crate) const VACUUM_PENDING_KEY: &str = "maintenance:vacuum_pending";

/// Tells the interface which books the heal pass cleared `syncedWithoutFile`
/// on: it loaded the library before the heal, and would otherwise show them
/// as not downloaded (and write the stale flag back) until the next start.
pub(crate) const HEALED_EVENT: &str = "library-books-healed";

/// Let the interface load the library first.
const START_DELAY: Duration = Duration::from_secs(2);
/// `VACUUM` waits for this long without a write to the database…
const QUIET_FOR: Duration = Duration::from_secs(20);
const POLL_EVERY: Duration = Duration::from_secs(5);
/// …and gives up (until the next start) after this.
const GIVE_UP_AFTER: Duration = Duration::from_secs(15 * 60);

pub(crate) type Step<'a> = dyn FnMut(&Connection) -> Result<(), String> + 'a;

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(crate) struct MaintenanceReport {
    pub covers_converted: usize,
    pub books_reclaimed: usize,
    pub dict_entries_reclaimed: usize,
    pub books_healed: usize,
    /// The healed books, for the interface (`HEALED_EVENT`).
    pub healed: Vec<crate::database::HealedBook>,
    pub fts_rows_changed: usize,
    pub vacuum_pending: bool,
    pub failed_steps: Vec<&'static str>,
}

fn step<W>(with_conn: &mut W, failed: &mut Vec<&'static str>, name: &'static str, f: &mut Step<'_>)
where
    W: FnMut(&mut Step<'_>) -> Result<(), String>,
{
    let started = Instant::now();
    match with_conn(f) {
        Ok(()) => log::debug!(
            "[db-maintenance] {name}: {} ms",
            started.elapsed().as_millis()
        ),
        Err(e) => {
            log::warn!("[db-maintenance] {name} failed (skipped until next start): {e}");
            failed.push(name);
        }
    }
}

fn sql(e: rusqlite::Error) -> String {
    e.to_string()
}

/// The deferred maintenance runs only after the startup guard passed: the
/// startup migrations are done (so it works on the current schema), and
/// never on a file the guard found damaged or could not migrate (which the
/// interface offers to restore, and which must stay as it was).
pub(crate) fn may_run_after(health: &crate::db_backup::DbHealth) -> bool {
    health.status == crate::db_backup::DbStatus::Ok
}

/// Run every deferred step once. `with_conn` lends a connection for one
/// step at a time (the pool in the app, so a step never holds one longer
/// than it needs).
pub(crate) fn run_maintenance<W>(app_data_dir: &Path, mut with_conn: W) -> MaintenanceReport
where
    W: FnMut(&mut Step<'_>) -> Result<(), String>,
{
    use crate::database as db;
    let mut report = MaintenanceReport::default();
    let mut failed = Vec::new();

    step(&mut with_conn, &mut failed, "cover bytes", &mut |c| {
        report.covers_converted = db::migrate_cover_data_urls(c).map_err(sql)?;
        Ok(())
    });
    step(&mut with_conn, &mut failed, "legacy book BLOBs", &mut |c| {
        report.books_reclaimed = db::reclaim_legacy_book_blobs(c, app_data_dir)?;
        Ok(())
    });
    step(
        &mut with_conn,
        &mut failed,
        "legacy StarDict BLOBs",
        &mut |c| {
            report.dict_entries_reclaimed = db::reclaim_legacy_stardict_blobs(c, app_data_dir)?;
            Ok(())
        },
    );
    if report.books_reclaimed > 0 || report.dict_entries_reclaimed > 0 {
        step(
            &mut with_conn,
            &mut failed,
            "mark VACUUM pending",
            &mut |c| set_vacuum_pending(c).map_err(sql),
        );
    }
    step(
        &mut with_conn,
        &mut failed,
        "syncedWithoutFile heal",
        &mut |c| {
            report.healed = db::reconcile_synced_without_file_metadata(c, app_data_dir)?;
            report.books_healed = report.healed.len();
            Ok(())
        },
    );
    db::cleanup_legacy_directories(app_data_dir);
    step(
        &mut with_conn,
        &mut failed,
        "books_fts reconcile",
        &mut |c| {
            report.fts_rows_changed = db::reconcile_books_fts(c).map_err(sql)?;
            Ok(())
        },
    );
    step(&mut with_conn, &mut failed, "read VACUUM flag", &mut |c| {
        report.vacuum_pending = vacuum_pending(c).map_err(sql)?;
        Ok(())
    });
    report.failed_steps = failed;
    report
}

/// For the CLI and restore, which have no window to keep responsive: every
/// step at once on the caller's connection, `VACUUM` included.
pub(crate) fn run_maintenance_inline(app_data_dir: &Path, conn: &Connection) -> MaintenanceReport {
    let report = run_maintenance(app_data_dir, |f| f(conn));
    if report.vacuum_pending {
        if let Err(e) = vacuum_now(conn) {
            log::warn!("[db-maintenance] VACUUM failed: {e}");
        }
    }
    report
}

pub(crate) fn set_vacuum_pending(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO kv_store (key, value, updated_at) VALUES (?1, '1', unixepoch())
         ON CONFLICT(key) DO NOTHING",
        params![VACUUM_PENDING_KEY],
    )?;
    Ok(())
}

pub(crate) fn vacuum_pending(conn: &Connection) -> rusqlite::Result<bool> {
    Ok(conn
        .query_row(
            "SELECT 1 FROM kv_store WHERE key = ?1",
            params![VACUUM_PENDING_KEY],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

/// `VACUUM`, then hand the WAL's copy of the database back to the disk.
pub(crate) fn vacuum_now(conn: &Connection) -> Result<(), String> {
    conn.execute_batch("VACUUM")
        .map_err(|e| format!("VACUUM: {e}"))?;
    conn.execute(
        "DELETE FROM kv_store WHERE key = ?1",
        params![VACUUM_PENDING_KEY],
    )
    .map_err(sql)?;
    // Best effort: a reader holding the WAL just delays the truncation.
    let _ = conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()));
    Ok(())
}

/// The last time anything wrote to the database (its file or its WAL).
pub(crate) fn last_write(db_path: &Path) -> Option<SystemTime> {
    let mut wal = db_path.as_os_str().to_owned();
    wal.push("-wal");
    [db_path.to_path_buf(), wal.into()]
        .iter()
        .filter_map(|p| std::fs::metadata(p).and_then(|m| m.modified()).ok())
        .max()
}

/// Wait until nothing has written to the database for `quiet`, checking
/// every `poll`. False if that has not happened within `give_up`.
pub(crate) fn wait_until_quiet(
    db_path: &Path,
    quiet: Duration,
    poll: Duration,
    give_up: Duration,
    mut sleep: impl FnMut(Duration),
) -> bool {
    let started = Instant::now();
    loop {
        let idle = last_write(db_path)
            .and_then(|at| SystemTime::now().duration_since(at).ok())
            .unwrap_or(Duration::ZERO);
        if idle >= quiet {
            return true;
        }
        if started.elapsed() >= give_up {
            return false;
        }
        sleep(poll.min(quiet - idle).max(Duration::from_millis(1)));
    }
}

/// Start the deferred work on its own thread, after `setup()` has returned.
pub fn spawn_startup_maintenance(app: &tauri::AppHandle) {
    use tauri::Manager;
    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("db-maintenance".into())
        .spawn(move || {
            std::thread::sleep(START_DELAY);
            // First, so the daily rollback point predates this start's repairs.
            crate::db_backup::run_deferred_snapshot(&app);
            let dir = match app.path().app_data_dir() {
                Ok(dir) => dir,
                Err(e) => {
                    log::warn!("[db-maintenance] No app data directory: {e}");
                    return;
                }
            };
            let with_pool = |f: &mut Step<'_>| -> Result<(), String> {
                crate::database::with_connection(&app, |c| Ok(f(c)))?
            };
            let started = Instant::now();
            let report = run_maintenance(&dir, with_pool);
            log::info!(
                "[db-maintenance] Done in {} ms: {} covers converted, {} legacy books and {} \
                 dictionary entries reclaimed, {} books healed, {} search rows fixed{}",
                started.elapsed().as_millis(),
                report.covers_converted,
                report.books_reclaimed,
                report.dict_entries_reclaimed,
                report.books_healed,
                report.fts_rows_changed,
                if report.failed_steps.is_empty() {
                    String::new()
                } else {
                    format!("; failed: {}", report.failed_steps.join(", "))
                }
            );
            if !report.healed.is_empty() {
                use tauri::Emitter;
                if let Err(e) = app.emit(HEALED_EVENT, &report.healed) {
                    log::warn!("[db-maintenance] Could not report healed books: {e}");
                }
            }
            if !report.vacuum_pending {
                return;
            }
            let db_path = dir.join("theorem.db");
            if !wait_until_quiet(
                &db_path,
                QUIET_FOR,
                POLL_EVERY,
                GIVE_UP_AFTER,
                std::thread::sleep,
            ) {
                log::info!("[db-maintenance] Database never idle; VACUUM left for the next start");
                return;
            }
            let started = Instant::now();
            match crate::database::with_connection(&app, |c| Ok(vacuum_now(c))) {
                Ok(Ok(())) => log::info!(
                    "[db-maintenance] VACUUM took {} ms",
                    started.elapsed().as_millis()
                ),
                Ok(Err(e)) | Err(e) => {
                    log::warn!("[db-maintenance] VACUUM failed (retried next start): {e}")
                }
            }
        });
    if let Err(e) = spawned {
        log::warn!("[db-maintenance] Could not start: {e}");
    }
}

#[cfg(test)]
mod bench;
#[cfg(test)]
mod tests;
