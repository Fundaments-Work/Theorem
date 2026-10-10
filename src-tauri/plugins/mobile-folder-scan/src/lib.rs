use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

use serde::{Deserialize, Serialize};

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScannedBookFile {
    pub path: Box<str>,
    pub relative_path: Box<str>,
    pub root_name: Box<str>,
}
#[cfg(target_os = "android")]
use tauri::{AppHandle, Manager};

#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "work.fundamentals.theorem.libraryscan";

#[cfg(target_os = "android")]
struct MobileFolderScan<R: Runtime> {
    handle: tauri::plugin::PluginHandle<R>,
}

#[cfg(target_os = "android")]
fn get_scan_state<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<tauri::State<'_, MobileFolderScan<R>>, String> {
    app.try_state::<MobileFolderScan<R>>()
        .ok_or_else(|| "Mobile folder scan plugin is not initialized.".to_string())
}

#[cfg(target_os = "android")]
#[derive(Deserialize)]
struct PickFolderResponse {
    uri: Option<String>,
}

#[cfg(target_os = "android")]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanFolderPayload<'a> {
    tree_uri: &'a str,
    recursive: bool,
}

#[cfg(target_os = "android")]
#[derive(Deserialize)]
struct ScanFolderResponse {
    files: Vec<ScannedBookFile>,
}

#[cfg(target_os = "android")]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SaveImagePayload<'a> {
    filename: &'a str,
    base64_data: &'a str,
}

#[cfg(target_os = "android")]
#[derive(Deserialize)]
struct SaveFileResponse {
    uri: String,
}

#[cfg(target_os = "android")]
#[derive(Deserialize)]
struct SaveImageResponse {
    uri: String,
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("mobile-folder-scan")
        .setup(|app, api| {
            #[cfg(not(target_os = "android"))]
            {
                let _ = (&app, &api);
            }
            #[cfg(target_os = "android")]
            {
                let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "FolderScanPlugin")?;
                app.manage(MobileFolderScan { handle });
            }
            Ok(())
        })
        .build()
}

#[cfg(target_os = "android")]
pub fn pick_folder<R: Runtime>(app: &AppHandle<R>) -> Result<Option<String>, String> {
    let state = get_scan_state(app)?;
    let response = state
        .handle
        .run_mobile_plugin::<PickFolderResponse>("pickFolder", serde_json::json!({}))
        .map_err(|error| error.to_string())?;

    Ok(response.uri.and_then(|value| {
        let trimmed = value.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    }))
}

#[cfg(target_os = "android")]
pub fn scan_folder<R: Runtime>(
    app: &AppHandle<R>,
    tree_uri: &str,
) -> Result<Vec<ScannedBookFile>, String> {
    let state = get_scan_state(app)?;
    let response = state
        .handle
        .run_mobile_plugin::<ScanFolderResponse>(
            "scanFolder",
            ScanFolderPayload {
                tree_uri,
                recursive: true,
            },
        )
        .map_err(|error| error.to_string())?;

    Ok(response.files)
}

#[cfg(target_os = "android")]
pub fn save_image<R: Runtime>(
    app: &AppHandle<R>,
    filename: &str,
    base64_data: &str,
) -> Result<String, String> {
    let state = get_scan_state(app)?;
    let response = state
        .handle
        .run_mobile_plugin::<SaveImageResponse>(
            "saveImage",
            SaveImagePayload {
                filename,
                base64_data,
            },
        )
        .map_err(|error| error.to_string())?;

    Ok(response.uri)
}

#[cfg(target_os = "android")]
pub fn save_file<R: Runtime>(
    app: &AppHandle<R>,
    filename: &str,
    base64_data: &str,
) -> Result<String, String> {
    let state = get_scan_state(app)?;
    let response = state
        .handle
        .run_mobile_plugin::<SaveFileResponse>(
            "saveFile",
            SaveImagePayload {
                filename,
                base64_data,
            },
        )
        .map_err(|error| error.to_string())?;

    Ok(response.uri)
}

#[cfg(target_os = "android")]
#[derive(Deserialize)]
struct GetAndroidIdResponse {
    #[serde(rename = "androidId")]
    android_id: String,
}

#[cfg(target_os = "android")]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MaterializeContentUriPayload<'a> {
    uri: &'a str,
    file_name: &'a str,
}

#[cfg(target_os = "android")]
#[derive(Deserialize)]
struct MaterializeContentUriResponse {
    path: String,
}

#[cfg(target_os = "android")]
pub fn materialize_content_uri<R: Runtime>(
    app: &AppHandle<R>,
    uri: &str,
    file_name: &str,
) -> Result<String, String> {
    let state = get_scan_state(app)?;
    let response = state
        .handle
        .run_mobile_plugin::<MaterializeContentUriResponse>(
            "materializeContentUri",
            MaterializeContentUriPayload { uri, file_name },
        )
        .map_err(|error| error.to_string())?;

    Ok(response.path)
}

#[cfg(target_os = "android")]
pub fn get_android_id<R: Runtime>(app: &AppHandle<R>) -> Result<String, String> {
    let state = get_scan_state(app)?;
    let response = state
        .handle
        .run_mobile_plugin::<GetAndroidIdResponse>("getAndroidId", serde_json::json!({}))
        .map_err(|error| error.to_string())?;

    Ok(response.android_id)
}
