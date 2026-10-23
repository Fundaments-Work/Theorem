//! End-to-end test hooks. Compiled only with `--features e2e`; release and
//! normal debug builds never contain this module.
//!
//! WebDriver drives the webview but cannot reach the native GTK dialogs the
//! dialog plugin opens (file pickers, confirm boxes), and `__TAURI_INTERNALS__`
//! is frozen, so the calls cannot be intercepted in JavaScript either. An e2e
//! build therefore registers this stand-in under the plugin name `dialog`:
//! the same commands (`open`, `save`, `message`), the same capabilities, but
//! the answers come from files the test writes into the directory named by
//! `THEOREM_E2E_DIALOGS`:
//!
//! * `<seq>.open.json` / `<seq>.save.json` / `<seq>.message.json` hold the
//!   JSON answer for the next call of that kind (oldest `<seq>` first);
//! * with nothing queued, `open`/`save` answer "cancelled" (`null`) and
//!   `message` presses the dialog's OK/Yes button;
//! * every call is appended to `calls.jsonl` so a test can assert what was asked;
//! * a file named `quit` in the directory is the tray's "Quit": the app runs
//!   its graceful quit (every window flushes its pending writes, then exit).
//!   The tray itself is out of WebDriver's reach.
//!
//! Everything after the dialog (the app's commands, file I/O, the database)
//! runs for real.

use serde_json::{json, Value};
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Manager, Wry};

static LOCK: Mutex<()> = Mutex::new(());

fn queue_dir() -> Option<PathBuf> {
    std::env::var_os("THEOREM_E2E_DIALOGS").map(PathBuf::from)
}

fn record(kind: &str, args: &Value) {
    let Some(dir) = queue_dir() else { return };
    if let Ok(mut f) = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("calls.jsonl"))
    {
        let _ = writeln!(f, "{}", json!({ "kind": kind, "args": args }));
    }
}

fn take(kind: &str) -> Option<Value> {
    let dir = queue_dir()?;
    let suffix = format!(".{kind}.json");
    let mut entries: Vec<PathBuf> = fs::read_dir(&dir)
        .ok()?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.ends_with(&suffix))
        })
        .collect();
    entries.sort();
    let first = entries.into_iter().next()?;
    let text = fs::read_to_string(&first).ok()?;
    let _ = fs::remove_file(&first);
    serde_json::from_str(&text).ok()
}

fn default_message_answer(buttons: &Value) -> Value {
    match buttons {
        Value::String(s) if s.starts_with("YesNo") => json!("Yes"),
        Value::Object(map) => {
            if let Some(Value::Array(labels)) = map.get("OkCancelCustom") {
                return labels.first().cloned().unwrap_or(json!("Ok"));
            }
            if let Some(Value::Array(labels)) = map.get("YesNoCancelCustom") {
                return labels.first().cloned().unwrap_or(json!("Yes"));
            }
            if let Some(label) = map.get("OkCustom") {
                return label.clone();
            }
            json!("Ok")
        }
        _ => json!("Ok"),
    }
}

#[tauri::command]
fn open(options: Option<Value>) -> Value {
    let _guard = LOCK.lock().unwrap_or_else(|p| p.into_inner());
    record("open", &options.unwrap_or(Value::Null));
    take("open").unwrap_or(Value::Null)
}

#[tauri::command]
fn save(options: Option<Value>) -> Value {
    let _guard = LOCK.lock().unwrap_or_else(|p| p.into_inner());
    record("save", &options.unwrap_or(Value::Null));
    take("save").unwrap_or(Value::Null)
}

#[tauri::command]
fn message(
    message: Option<String>,
    title: Option<String>,
    kind: Option<Value>,
    buttons: Option<Value>,
) -> Value {
    let _guard = LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let buttons = buttons.unwrap_or(Value::Null);
    record(
        "message",
        &json!({ "message": message, "title": title, "kind": kind, "buttons": buttons }),
    );
    take("message").unwrap_or_else(|| default_message_answer(&buttons))
}

/// Registered in place of `tauri_plugin_dialog::init()` in e2e builds.
pub fn dialog_plugin() -> TauriPlugin<Wry> {
    Builder::new("dialog")
        .invoke_handler(tauri::generate_handler![open, save, message])
        .setup(|app, _api| {
            if let Some(dir) = queue_dir() {
                let handle = app.app_handle().clone();
                std::thread::spawn(move || {
                    let flag = dir.join("quit");
                    loop {
                        if flag.exists() {
                            let _ = fs::remove_file(&flag);
                            crate::request_graceful_quit(&handle);
                        }
                        std::thread::sleep(std::time::Duration::from_millis(100));
                    }
                });
            }
            Ok(())
        })
        .build()
}
