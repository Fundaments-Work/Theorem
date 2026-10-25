//! The system tray (desktop).

use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri::Emitter;
use tauri::Manager;

use crate::lifecycle::request_graceful_quit;

/// Build the tray icon and its menu. A failure is logged, never fatal.
pub(crate) fn build_tray(app: &mut tauri::App) {
    let tray_result: Result<(), Box<dyn std::error::Error>> = (|| {
        let show = MenuItemBuilder::with_id("show", "Show Theorem").build(app)?;
        let sync_now = MenuItemBuilder::with_id("sync_now", "Sync Now").build(app)?;
        let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;

        let menu = MenuBuilder::new(app)
            .item(&show)
            .item(&sync_now)
            .separator()
            .item(&quit)
            .build()?;

        let mut tray_builder = TrayIconBuilder::new()
            .menu(&menu)
            .tooltip("Theorem")
            .on_menu_event(|app, event| match event.id().as_ref() {
                "show" => {
                    let window = app
                        .get_webview_window("main")
                        .or_else(|| app.webview_windows().into_values().next());
                    if let Some(window) = window {
                        let _ = window.show();
                        let _ = window.unminimize();
                        let _ = window.set_focus();
                    }
                }
                "sync_now" => {
                    let _ = app.emit("tray-sync-now", ());
                }
                "quit" => {
                    request_graceful_quit(app);
                }
                _ => {}
            })
            .on_tray_icon_event(|tray, event| {
                if let TrayIconEvent::Click { .. } = event {
                    let app = tray.app_handle();
                    let window = app
                        .get_webview_window("main")
                        .or_else(|| app.webview_windows().into_values().next());
                    if let Some(window) = window {
                        let _ = window.show();
                        let _ = window.unminimize();
                        let _ = window.set_focus();
                    }
                }
            });

        if let Some(icon) = app.default_window_icon() {
            tray_builder = tray_builder.icon(icon.clone());
        }

        tray_builder.build(app)?;
        Ok(())
    })();

    if let Err(e) = tray_result {
        log::warn!("[tray] System tray not initialized (continuing anyway): {e}");
    }
}
