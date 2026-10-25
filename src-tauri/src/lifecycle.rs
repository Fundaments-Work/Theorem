//! Graceful quit, the build stamp and giving memory back.

use crate::database;
use serde::Serialize;
use tauri::AppHandle;
use tauri::Emitter;
use tauri::Manager;

/// Graceful quit: every webview gets `app-quit-requested`, flushes its pending
/// store writes to SQLite, and acknowledges via `app_quit_ready`. The app exits
/// once all acknowledged or after `QUIT_FLUSH_TIMEOUT`, whichever comes first,
/// so a hung or not-yet-booted webview can never block quitting.
#[derive(Default)]
pub(crate) struct QuitCoordinator {
    awaiting: std::sync::atomic::AtomicUsize,
    in_progress: std::sync::atomic::AtomicBool,
}

#[cfg_attr(mobile, allow(dead_code))]
const QUIT_FLUSH_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(3000);

#[cfg_attr(mobile, allow(dead_code))]
pub(crate) fn request_graceful_quit(app: &AppHandle) {
    use std::sync::atomic::Ordering;
    let coordinator = app.state::<QuitCoordinator>();
    if coordinator.in_progress.swap(true, Ordering::SeqCst) {
        return;
    }
    let webviews = app.webview_windows().len();
    if webviews == 0 {
        app.exit(0);
        return;
    }
    coordinator.awaiting.store(webviews, Ordering::SeqCst);
    if app.emit("app-quit-requested", ()).is_err() {
        app.exit(0);
        return;
    }
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(QUIT_FLUSH_TIMEOUT);
        handle.exit(0);
    });
}

#[tauri::command]
pub(crate) fn app_quit_ready(app: AppHandle) {
    use std::sync::atomic::Ordering;
    let coordinator = app.state::<QuitCoordinator>();
    if !coordinator.in_progress.load(Ordering::SeqCst) {
        return;
    }
    let previous = coordinator
        .awaiting
        .try_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1))
        .unwrap_or(0);
    if previous <= 1 {
        app.exit(0);
    }
}

/// Compile-time build stamp (emitted by build.rs) so a stale release binary —
/// which embeds the UI at build time — is visible in Settings → About.
#[derive(Serialize)]
pub(crate) struct BuildInfo {
    build_date: String,
    git_hash: String,
}

#[tauri::command]
pub(crate) fn app_build_info() -> BuildInfo {
    BuildInfo {
        build_date: env!("THEOREM_BUILD_DATE").to_string(),
        git_hash: env!("THEOREM_GIT_HASH").to_string(),
    }
}

/// `trim_memory` off the UI thread, at most once every 30 seconds (focus can flicker).
#[cfg(desktop)]
pub(crate) fn trim_memory_soon(app: &tauri::AppHandle) {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};
    static LAST_TRIM_SECS: AtomicU64 = AtomicU64::new(0);

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let last = LAST_TRIM_SECS.load(Ordering::Relaxed);
    if now.saturating_sub(last) < 30
        || LAST_TRIM_SECS
            .compare_exchange(last, now, Ordering::Relaxed, Ordering::Relaxed)
            .is_err()
    {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || trim_memory(app));
}

pub(crate) fn trim_memory(app: tauri::AppHandle) {
    let _ = database::sqlite_shrink_memory(app);

    #[cfg(target_os = "linux")]
    unsafe {
        libc::malloc_trim(0);
    }

    #[cfg(target_os = "android")]
    unsafe {
        extern "C" {
            fn mallopt(param: std::ffi::c_int, value: std::ffi::c_int) -> std::ffi::c_int;
        }
        mallopt(-101, 0);
    }
}
