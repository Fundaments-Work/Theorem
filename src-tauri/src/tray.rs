//! The system tray (desktop).

use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri::Emitter;
use tauri::Manager;

use crate::lifecycle::request_graceful_quit;

/// Whether the tray icon exists, so closing the window knows if hiding it
/// leaves a way back. It does not say that the desktop shows the icon.
#[derive(Default)]
pub(crate) struct TrayState {
    built: std::sync::atomic::AtomicBool,
}

impl TrayState {
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    pub(crate) fn is_built(&self) -> bool {
        self.built.load(std::sync::atomic::Ordering::SeqCst)
    }

    fn mark_built(&self) {
        self.built.store(true, std::sync::atomic::Ordering::SeqCst);
    }
}

/// The file names `libappindicator-sys` 0.9 tries. It panics when none loads,
/// which ends a release build (`panic = "abort"`), so they are tried first.
#[cfg(target_os = "linux")]
const APPINDICATOR_LIBRARIES: [&std::ffi::CStr; 4] = [
    c"libayatana-appindicator3.so.1",
    c"libappindicator3.so.1",
    c"libayatana-appindicator3.so",
    c"libappindicator3.so",
];

#[cfg(target_os = "linux")]
fn any_library_loads(names: &[&std::ffi::CStr]) -> bool {
    names.iter().any(|name| {
        // SAFETY: `name` is NUL-terminated, and loading runs only the library's
        // own initialisers. The handle is kept open: the tray needs it next.
        !unsafe { libc::dlopen(name.as_ptr(), libc::RTLD_LAZY | libc::RTLD_LOCAL) }.is_null()
    })
}

/// Where the tray icon's image is written. The desktop reads it by path, and
/// inside Flatpak the default (`$XDG_RUNTIME_DIR/tray-icon`) is private to the
/// sandbox; `app/<id>` is the part the host sees at the same path.
#[cfg(target_os = "linux")]
fn tray_icon_dir(
    flatpak_id: Option<&str>,
    runtime_dir: Option<&std::path::Path>,
) -> Option<std::path::PathBuf> {
    Some(runtime_dir?.join("app").join(flatpak_id?).join("tray-icon"))
}

/// Build the tray icon and its menu. A failure is logged, never fatal.
pub(crate) fn build_tray(app: &mut tauri::App) {
    #[cfg(target_os = "linux")]
    if !any_library_loads(&APPINDICATOR_LIBRARIES) {
        log::warn!("[tray] No appindicator library; continuing without a system tray");
        return;
    }

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

        #[cfg(target_os = "linux")]
        if let Some(dir) = tray_icon_dir(
            crate::linux_sandbox::flatpak_id().as_deref(),
            dirs::runtime_dir().as_deref(),
        ) {
            tray_builder = tray_builder.temp_dir_path(dir);
        }

        tray_builder.build(app)?;
        Ok(())
    })();

    match tray_result {
        Ok(()) => app.state::<TrayState>().mark_built(),
        Err(e) => log::warn!("[tray] System tray not initialized (continuing anyway): {e}"),
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    #[test]
    fn a_missing_library_is_reported_not_fatal() {
        assert!(!any_library_loads(&[]));
        assert!(!any_library_loads(&[c"libtheorem-no-such-library.so.1"]));
        assert!(any_library_loads(&[
            c"libtheorem-no-such-library.so.1",
            c"libc.so.6"
        ]));
    }

    #[test]
    fn the_icon_moves_only_inside_flatpak() {
        let run = Path::new("/run/user/1000");
        assert_eq!(
            tray_icon_dir(Some("work.fundaments.theorem"), Some(run)),
            Some(PathBuf::from(
                "/run/user/1000/app/work.fundaments.theorem/tray-icon"
            ))
        );
        assert_eq!(tray_icon_dir(None, Some(run)), None);
        assert_eq!(tray_icon_dir(Some("work.fundaments.theorem"), None), None);
    }

    #[test]
    fn the_tray_counts_as_missing_until_it_is_built() {
        let state = TrayState::default();
        assert!(!state.is_built());
        state.mark_built();
        assert!(state.is_built());
    }
}
