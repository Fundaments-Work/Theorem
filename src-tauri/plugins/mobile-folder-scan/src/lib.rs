use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

use serde::{Deserialize, Serialize};

#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ScannedBookFile {
    pub path: Box<str>,
    pub relative_path: Box<str>,
    pub root_name: Box<str>,
    /// Size in bytes, when the scanner could read it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    /// Last modification time (Unix milliseconds), when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modified_ms: Option<i64>,
}

/// A folder or book file the scanner could not use, with the reason.
#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ScanIssue {
    pub path: Box<str>,
    pub reason: Box<str>,
}

/// Everything a folder scan found.
#[derive(Deserialize, Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct FolderScan {
    pub files: Vec<ScannedBookFile>,
    #[serde(default)]
    pub issues: Vec<ScanIssue>,
    /// The scan was stopped before it finished.
    #[serde(default)]
    pub cancelled: bool,
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
pub fn scan_folder<R: Runtime>(app: &AppHandle<R>, tree_uri: &str) -> Result<FolderScan, String> {
    let state = get_scan_state(app)?;
    state
        .handle
        .run_mobile_plugin::<FolderScan>(
            "scanFolder",
            ScanFolderPayload {
                tree_uri,
                recursive: true,
            },
        )
        .map_err(|error| error.to_string())
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
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SaveFileFromPathPayload<'a> {
    source_path: &'a str,
    filename: &'a str,
}

/// Stream a local file into Downloads/Theorem through MediaStore without
/// loading it into memory (large backups). Returns the content URI.
#[cfg(target_os = "android")]
pub fn save_file_from_path<R: Runtime>(
    app: &AppHandle<R>,
    source_path: &str,
    filename: &str,
) -> Result<String, String> {
    let state = get_scan_state(app)?;
    let response = state
        .handle
        .run_mobile_plugin::<SaveFileResponse>(
            "saveFileFromPath",
            SaveFileFromPathPayload {
                source_path,
                filename,
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
    managed_import: bool,
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
            MaterializeContentUriPayload {
                uri,
                file_name,
                managed_import: false,
            },
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

/// Whether daily reading reminders can be delivered at the exact minute.
#[derive(Deserialize, Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReminderStatus {
    pub exact_alarms: bool,
    pub can_request_exact_alarms: bool,
    /// When the next reminder is due (Unix milliseconds), if one is scheduled.
    #[serde(default)]
    pub next_reminder_at: Option<i64>,
}

/// The daily reading reminder as the app configures it; Android schedules from this.
#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ReminderConfig {
    pub enabled: bool,
    pub hour: u8,
    pub minute: u8,
    pub title: Box<str>,
    pub body: Box<str>,
    /// "YYYY-MM-DD": the local day with no reminder, because its goal is met.
    pub skip_date: Option<Box<str>>,
}

#[cfg(target_os = "android")]
pub fn reminder_status<R: Runtime>(app: &AppHandle<R>) -> Result<ReminderStatus, String> {
    let state = get_scan_state(app)?;
    state
        .handle
        .run_mobile_plugin::<ReminderStatus>("reminderStatus", serde_json::json!({}))
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "android")]
pub fn open_exact_alarm_settings<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let state = get_scan_state(app)?;
    state
        .handle
        .run_mobile_plugin::<serde_json::Value>("openExactAlarmSettings", serde_json::json!({}))
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "android")]
pub fn open_notification_settings<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let state = get_scan_state(app)?;
    state
        .handle
        .run_mobile_plugin::<serde_json::Value>("openNotificationSettings", serde_json::json!({}))
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "android")]
pub fn configure_reminder<R: Runtime>(
    app: &AppHandle<R>,
    config: &ReminderConfig,
) -> Result<(), String> {
    let state = get_scan_state(app)?;
    state
        .handle
        .run_mobile_plugin::<serde_json::Value>("configureReminder", config)
        .map(|_| ())
        .map_err(|error| error.to_string())
}

/// Space taken by the system bars and the camera cutout at each edge, in CSS pixels.
#[derive(Deserialize, Serialize, Clone, Copy, Debug, Default, PartialEq)]
pub struct SystemInsets {
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
    pub left: f64,
}

#[cfg(target_os = "android")]
pub fn system_insets<R: Runtime>(app: &AppHandle<R>) -> Result<SystemInsets, String> {
    let state = get_scan_state(app)?;
    state
        .handle
        .run_mobile_plugin::<SystemInsets>("systemInsets", serde_json::json!({}))
        .map_err(|error| error.to_string())
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportServiceStatus {
    pub stopped: bool,
    pub copying: bool,
    pub completed_bytes: u64,
    pub total_bytes: Option<u64>,
}

#[cfg(target_os = "android")]
pub fn start_import_service<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    get_scan_state(app)?
        .handle
        .run_mobile_plugin::<serde_json::Value>("startImportService", serde_json::json!({}))
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(target_os = "android")]
pub fn stop_import_service<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    get_scan_state(app)?
        .handle
        .run_mobile_plugin::<serde_json::Value>("stopImportService", serde_json::json!({}))
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(target_os = "android")]
pub fn import_service_status<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<ImportServiceStatus, String> {
    get_scan_state(app)?
        .handle
        .run_mobile_plugin("importServiceStatus", serde_json::json!({}))
        .map_err(|error| error.to_string())
}

#[derive(serde::Deserialize, serde::Serialize)]
pub struct ImportDocument {
    pub source: Box<str>,
    pub name: Box<str>,
}

#[cfg(target_os = "android")]
pub fn pick_import_books<R: Runtime>(app: &AppHandle<R>) -> Result<Vec<ImportDocument>, String> {
    #[derive(serde::Deserialize)]
    struct Response {
        documents: Vec<ImportDocument>,
    }
    let response: Response = get_scan_state(app)?
        .handle
        .run_mobile_plugin("pickImportBooks", serde_json::json!({}))
        .map_err(|error| error.to_string())?;
    Ok(response.documents)
}

#[cfg(target_os = "android")]
pub fn materialize_import_document<R: Runtime>(
    app: &AppHandle<R>,
    uri: &str,
    file_name: &str,
) -> Result<String, String> {
    let response = get_scan_state(app)?
        .handle
        .run_mobile_plugin::<MaterializeContentUriResponse>(
            "materializeContentUri",
            MaterializeContentUriPayload {
                uri,
                file_name,
                managed_import: true,
            },
        )
        .map_err(|error| error.to_string())?;
    Ok(response.path)
}
