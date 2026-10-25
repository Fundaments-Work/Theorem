//! Library folder picking and scanning, with cancellation.

use crate::folder_walk;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use std::path::Path;

#[tauri::command]
pub(crate) fn pick_library_folder_mobile(app: tauri::AppHandle) -> Result<Option<String>, String> {
    #[cfg(target_os = "android")]
    {
        tauri_plugin_mobile_folder_scan::pick_folder(&app)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Err("Mobile folder selection is only available on Android.".to_string())
    }
}

/// Async so the Android scan never blocks the main thread.
#[tauri::command]
pub(crate) async fn scan_library_folder_mobile(
    app: tauri::AppHandle,
    tree_uri: String,
) -> Result<tauri_plugin_mobile_folder_scan::FolderScan, String> {
    #[cfg(target_os = "android")]
    {
        tauri::async_runtime::spawn_blocking(move || {
            tauri_plugin_mobile_folder_scan::scan_folder(&app, &tree_uri)
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, tree_uri);
        Err("Mobile folder scanning is only available on Android.".to_string())
    }
}

pub(crate) fn scan_library_folder_desktop(
    folder_path: String,
    job_id: Option<String>,
) -> Result<tauri_plugin_mobile_folder_scan::FolderScan, String> {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let _ = (folder_path, job_id);
        Err("Desktop folder scanning is only available on desktop.".to_string())
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let job = folder_walk::register_job(job_id);
        folder_walk::walk_book_folder(Path::new(&folder_path), &job.flag)
    }
}

/// Stop a folder scan or native import started with this `job_id`.
#[tauri::command]
pub(crate) fn cancel_import_job(job_id: String) {
    folder_walk::cancel_job(&job_id);
}
