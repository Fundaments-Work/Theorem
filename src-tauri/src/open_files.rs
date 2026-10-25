//! Files the OS asks Theorem to open (arguments, `file://` URIs, single-instance).

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::Emitter;
use tauri::Manager;

#[derive(Default)]
pub(crate) struct PendingOpenFiles(Mutex<Vec<String>>);

fn decode_percent_escapes(value: &str) -> String {
    fn from_hex(b: u8) -> Option<u8> {
        match b {
            b'0'..=b'9' => Some(b - b'0'),
            b'a'..=b'f' => Some(b - b'a' + 10),
            b'A'..=b'F' => Some(b - b'A' + 10),
            _ => None,
        }
    }

    let bytes = value.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;

    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let (Some(high), Some(low)) =
                (from_hex(bytes[index + 1]), from_hex(bytes[index + 2]))
            {
                output.push(high << 4 | low);
                index += 3;
                continue;
            }
        }

        output.push(bytes[index]);
        index += 1;
    }

    String::from_utf8_lossy(&output).to_string()
}

fn file_uri_to_path(candidate: &str) -> Option<String> {
    if !candidate.starts_with("file://") {
        return None;
    }

    let mut rest = candidate.trim_start_matches("file://");
    if let Some(after_localhost) = rest.strip_prefix("localhost") {
        rest = after_localhost;
    }

    let decoded = decode_percent_escapes(rest);

    if decoded.starts_with('/') {
        let bytes = decoded.as_bytes();
        if bytes.len() > 3 && bytes[2] == b':' {
            return Some(decoded.trim_start_matches('/').to_string());
        }
    }

    Some(decoded)
}

fn is_supported_open_path(candidate: &str) -> bool {
    let lower = candidate.to_ascii_lowercase();
    lower.ends_with(".epub")
        || lower.ends_with(".mobi")
        || lower.ends_with(".azw")
        || lower.ends_with(".azw3")
        || lower.ends_with(".fb2")
        || lower.ends_with(".fbz")
        || lower.ends_with(".fb2.zip")
        || lower.ends_with(".cbz")
        || lower.ends_with(".cbr")
        || lower.ends_with(".pdf")
}

fn normalize_open_path(candidate: &str, cwd: Option<&str>) -> Option<String> {
    let trimmed = candidate.trim();
    if trimmed.is_empty() || trimmed.starts_with('-') {
        return None;
    }

    if trimmed.contains("://") && !trimmed.starts_with("file://") {
        return None;
    }

    let candidate_path = file_uri_to_path(trimmed).unwrap_or_else(|| trimmed.to_string());
    let mut path = PathBuf::from(&candidate_path);
    if !path.is_absolute() {
        if let Some(cwd) = cwd {
            path = Path::new(cwd).join(path);
        }
    }

    let as_string = path.to_string_lossy().to_string();
    if !is_supported_open_path(&as_string) {
        return None;
    }

    if path.exists() {
        Some(as_string)
    } else {
        None
    }
}

pub(crate) fn collect_open_paths(args: Vec<String>, cwd: Option<&str>) -> Vec<String> {
    args.into_iter()
        .filter_map(|arg| normalize_open_path(&arg, cwd))
        .collect()
}

pub(crate) fn enqueue_open_paths(app: &tauri::AppHandle, paths: Vec<String>, emit_event: bool) {
    if paths.is_empty() {
        return;
    }

    {
        let state = app.state::<PendingOpenFiles>();
        let mut guard = state.0.lock().unwrap_or_else(|poison| poison.into_inner());
        guard.extend(paths.clone());
    }

    if emit_event {
        let _ = app.emit("theorem://open-files", paths);
    }
}

#[tauri::command]
pub(crate) fn take_pending_open_files(state: tauri::State<PendingOpenFiles>) -> Vec<String> {
    let mut guard = state.0.lock().unwrap_or_else(|poison| poison.into_inner());
    guard.drain(..).collect()
}
