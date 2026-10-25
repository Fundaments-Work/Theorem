//! Reader windows, printing and hiding to the tray.

use tauri::AppHandle;
use tauri::Manager;

/// Label prefix for reader windows opened via "Open in New Window" / the CLI.
#[cfg(desktop)]
const READER_WINDOW_PREFIX: &str = "reader_";

/// Close every reader window this app opened.
///
/// Reader windows are independent webviews, not children of the main window, so
/// closing (or, in release builds, hiding) the main window left them on screen.
#[cfg(desktop)]
pub(crate) fn close_reader_windows(app: &tauri::AppHandle) {
    use tauri::Manager;
    for (_, window) in app.webview_windows() {
        if window.label().starts_with(READER_WINDOW_PREFIX) {
            let _ = window.close();
        }
    }
}

#[tauri::command]
#[allow(unused_variables)]
pub(crate) async fn open_book_in_new_window(
    app: tauri::AppHandle,
    book_id: String,
    title: String,
) -> Result<(), String> {
    open_reader_window(&app, &book_id, &title)
}

/// Open a reader window for a book (shared by `open_book_in_new_window` and
/// the CLI `theorem open <book-id>` bridge).
pub fn open_reader_window(app: &AppHandle, book_id: &str, title: &str) -> Result<(), String> {
    #[cfg(desktop)]
    {
        use tauri::Manager;
        use tauri::WebviewUrl;
        use tauri::WebviewWindowBuilder;

        let safe_id = book_id.replace(|c: char| !c.is_alphanumeric(), "_");
        let label = format!("{}{}", READER_WINDOW_PREFIX, safe_id);

        if let Some(existing) = app.get_webview_window(&label) {
            let _ = existing.show();
            let _ = existing.unminimize();
            let _ = existing.set_focus();
            return Ok(());
        }

        let url = WebviewUrl::App(format!("index.html?route=reader&bookId={}", book_id).into());
        let win = WebviewWindowBuilder::new(app, &label, url)
            .title(title)
            .inner_size(1024.0, 768.0)
            .min_inner_size(600.0, 400.0)
            // Frameless, like the main window. With `decorations(true)` the reader
            // drew its own titlebar *and* the OS one, stacking two title bars, so
            // the window did not look like the rest of the app.
            .decorations(false)
            .build()
            .map_err(|e| format!("Failed to create new window: {e}"))?;

        let _ = win.set_focus();
        Ok(())
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, book_id, title);
        Err("Multi-window reading is only supported on desktop".to_string())
    }
}

/// Native print dialog for the calling webview. `window.print()` does nothing
/// in macOS WKWebView; on Linux this runs WebKitGTK's print operation.
#[tauri::command]
pub(crate) fn print_webview(webview: tauri::Webview) -> Result<(), String> {
    #[cfg(desktop)]
    {
        webview.print().map_err(|e| e.to_string())
    }
    #[cfg(not(desktop))]
    {
        let _ = webview;
        Err("Printing is not supported on this platform".to_string())
    }
}

#[tauri::command]
pub(crate) fn hide_to_tray(app: tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .or_else(|| app.webview_windows().into_values().next());
    if let Some(window) = window {
        window
            .hide()
            .map_err(|e| format!("Failed to hide window: {e}"))
    } else {
        Ok(())
    }
}
