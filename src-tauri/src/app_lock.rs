//! "Is the app running?" for the command line.
//!
//! The running app holds an exclusive lock on `theorem-app.lock` in its data
//! folder for as long as it runs. A CLI command that changes the library
//! takes a shared lock on the same file: it fails only while the app holds
//! the exclusive one, any number of CLI commands can hold the shared lock at
//! once, and the app cannot take its lock in the middle of a CLI command.
//! The operating system drops the lock when a process exits, crashes
//! included, so there is no stale state to clean up.
//!
//! Desktop-only: there is no CLI on Android.

use std::fs::{File, OpenOptions, TryLockError};
use std::path::Path;
use std::sync::OnceLock;

pub const LOCK_FILE: &str = "theorem-app.lock";

/// The app's lock, held until the process exits.
static APP_LOCK: OnceLock<File> = OnceLock::new();

fn open_lock_file(app_data_dir: &Path) -> std::io::Result<File> {
    std::fs::create_dir_all(app_data_dir)?;
    OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(app_data_dir.join(LOCK_FILE))
}

/// Called once by the app at startup. When a CLI command holds the shared
/// lock right now, the app does not wait for it: a background thread takes
/// the lock as soon as the command ends.
pub fn hold_for_app(app_data_dir: &Path) {
    let file = match open_lock_file(app_data_dir) {
        Ok(file) => file,
        Err(e) => {
            log::warn!("[app-lock] cannot open the lock file: {e}");
            return;
        }
    };
    match file.try_lock() {
        Ok(()) => {
            let _ = APP_LOCK.set(file);
        }
        Err(TryLockError::WouldBlock) => {
            std::thread::spawn(move || match file.lock() {
                Ok(()) => {
                    let _ = APP_LOCK.set(file);
                }
                Err(e) => log::warn!("[app-lock] cannot take the lock: {e}"),
            });
        }
        Err(TryLockError::Error(e)) => log::warn!("[app-lock] cannot take the lock: {e}"),
    }
}

/// What a CLI write command learns about the app.
pub enum AppState {
    /// The app is not running. Keep the guard for the whole command: while
    /// it lives the app cannot start holding the library.
    NotRunning(File),
    Running,
}

/// Check whether the app is running, for a command about to change data.
pub fn check_from_cli(app_data_dir: &Path) -> Result<AppState, String> {
    let file = open_lock_file(app_data_dir)
        .map_err(|e| format!("cannot open {}: {e}", app_data_dir.join(LOCK_FILE).display()))?;
    match file.try_lock_shared() {
        Ok(()) => Ok(AppState::NotRunning(file)),
        Err(TryLockError::WouldBlock) => Ok(AppState::Running),
        Err(TryLockError::Error(e)) => Err(format!("cannot check whether Theorem is running: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cli_sees_the_app_lock_and_cli_commands_do_not_block_each_other() {
        let dir = tempfile::tempdir().unwrap();
        // Two CLI commands at once both get in.
        let first = check_from_cli(dir.path()).unwrap();
        let second = check_from_cli(dir.path()).unwrap();
        assert!(matches!(first, AppState::NotRunning(_)));
        assert!(matches!(second, AppState::NotRunning(_)));
        drop((first, second));

        // An exclusive holder (the app) is seen as running.
        let app = open_lock_file(dir.path()).unwrap();
        app.try_lock().unwrap();
        assert!(matches!(check_from_cli(dir.path()).unwrap(), AppState::Running));
        drop(app);
        assert!(matches!(
            check_from_cli(dir.path()).unwrap(),
            AppState::NotRunning(_)
        ));
    }
}
