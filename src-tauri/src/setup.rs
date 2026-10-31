//! App startup: platform workarounds, the dialog plugin and the `setup()` hook.

#[cfg(target_os = "linux")]
use std::env;

use tauri::Manager;

#[cfg(feature = "e2e")]
use crate::e2e_hooks;
use crate::open_files::{collect_open_paths, enqueue_open_paths};
#[cfg(desktop)]
use crate::tray;
use crate::window::open_reader_window;
use crate::{db_backup, db_maintenance, sync_commands};

/// Native dialogs. The e2e build (`pnpm e2e`, `--features e2e`) swaps in a
/// stand-in whose answers the WebDriver suite scripts; see `e2e_hooks.rs`.
#[cfg(not(feature = "e2e"))]
pub(crate) fn dialog_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri_plugin_dialog::init()
}

#[cfg(feature = "e2e")]
pub(crate) fn dialog_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    e2e_hooks::dialog_plugin()
}

#[cfg(target_os = "linux")]
pub(crate) fn apply_linux_webkit_workarounds() {
    if env::var("THEOREM_WEBKIT_WORKAROUNDS")
        .map(|value| value == "0")
        .unwrap_or(false)
    {
        return;
    }

    if env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    // Hardware compositing is preserved by default for 60fps scrolling and GPU transforms.
    // If an environment explicitly requires disabling compositing, WEBKIT_DISABLE_COMPOSITING_MODE=1 can be set.

    let existing_gdk_debug = env::var("GDK_DEBUG").unwrap_or_default();
    if existing_gdk_debug
        .split(',')
        .all(|flag| flag.trim() != "gl-no-fractional")
    {
        let merged = if existing_gdk_debug.trim().is_empty() {
            "gl-no-fractional".to_string()
        } else {
            format!("{},gl-no-fractional", existing_gdk_debug)
        };
        env::set_var("GDK_DEBUG", merged);
    }
}

/// The `setup()` hook: database guard and migrations, sync, files to open,
/// and the tray (desktop).
pub(crate) fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    // Exercise phone-width layouts through WebDriver; production keeps its
    // desktop minimum, and Android uses its own native viewport.
    #[cfg(feature = "e2e")]
    if let Some(window) = app.get_webview_window("main") {
        window.set_min_size(Some(tauri::LogicalSize::new(320.0, 480.0)))?;
    }
    let app_data_dir = app
        .path()
        .app_data_dir()
        .or_else(|_| app.path().app_cache_dir())
        .unwrap_or_else(|_| std::path::PathBuf::from("."));

    log::info!(
        "[startup] Theorem {} on {} {}",
        app.package_info().version,
        std::env::consts::OS,
        std::env::consts::ARCH
    );
    log::info!("[startup] Running database schema migrations...");
    // Integrity check + rolling snapshot (when due), then the
    // migrations the interface needs; a damaged database is reported
    // to the frontend, not hidden. Repairs and clean-ups that can wait
    // run on their own thread once the window is up, on a healthy
    // database only.
    let setup_started = std::time::Instant::now();
    if db_backup::run_startup_guard(app.handle()) {
        db_maintenance::spawn_startup_maintenance(app.handle());
    }
    log::info!(
        "[startup] Database ready in {} ms",
        setup_started.elapsed().as_millis()
    );

    log::info!("[startup] Initializing device sync");
    match sync_commands::init_sync(app_data_dir, app.handle().clone()) {
        Ok(sync_state) => {
            app.manage(sync_state);
        }
        Err(e) => {
            log::warn!("[startup] Failed to initialize sync: {e}");
        }
    }

    let startup_args: Vec<String> = std::env::args().skip(1).collect();
    if let Some(book_id) = startup_args
        .iter()
        .find_map(|a| a.strip_prefix("--open-book=").map(str::to_string))
    {
        // CLI bridge: `theorem open <book-id>` re-execs with this marker.
        let _ = open_reader_window(app.handle(), &book_id, "Theorem Reader");
    } else {
        let open_paths = collect_open_paths(startup_args, None);
        enqueue_open_paths(app.handle(), open_paths, false);
    }

    #[cfg(desktop)]
    tray::build_tray(app);

    log::info!("[startup] Theorem ready.");
    Ok(())
}
