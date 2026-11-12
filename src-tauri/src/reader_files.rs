//! Whole-file reads and disk-backed CBR->CBZ conversion for the reader.

use crate::cbr;
use crate::error::AppError;
use sha2::{Digest, Sha256};
use std::fmt::Write as _;
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::UNIX_EPOCH;
use tauri::{ipc::Response, AppHandle, Manager};

fn io_error(context: impl std::fmt::Display, e: std::io::Error) -> AppError {
    if e.kind() == std::io::ErrorKind::NotFound {
        AppError::not_found(format!("{context}: {e}"))
    } else {
        AppError::io(format!("{context}: {e}"))
    }
}

pub(crate) fn read_file(path: String) -> Result<Response, AppError> {
    let data =
        fs::read(&path).map_err(|e| io_error(format!("Failed to read file '{}'", path), e))?;
    Ok(Response::new(data))
}

pub(crate) fn read_cbr_as_cbz(path: String) -> Result<Response, AppError> {
    let bytes = cbr::convert_cbr_to_cbz(Path::new(&path)).map_err(AppError::io)?;
    Ok(Response::new(bytes))
}

pub(crate) fn prepare_cbr_as_cbz(app: &AppHandle, path: String) -> Result<String, AppError> {
    static NEXT_TMP: AtomicU64 = AtomicU64::new(0);
    let src = Path::new(&path);
    let meta =
        fs::metadata(src).map_err(|e| io_error(format!("Failed to stat CBR '{}'", path), e))?;
    let mtime_ns = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_nanos());

    let mut hasher = Sha256::new();
    hasher.update(path.as_bytes());
    hasher.update(meta.len().to_le_bytes());
    hasher.update(mtime_ns.to_le_bytes());
    let digest = hasher.finalize();
    let mut key = String::with_capacity(32);
    for byte in &digest[..16] {
        let _ = write!(key, "{byte:02x}");
    }

    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| AppError::io(format!("Cache dir unavailable: {e}")))?
        .join("cbr-cache");
    fs::create_dir_all(&cache_dir)
        .map_err(|e| io_error("Failed to create CBR cache directory", e))?;
    let dest = cache_dir.join(format!("{key}.cbz"));
    if dest.is_file() {
        return Ok(dest.to_string_lossy().into_owned());
    }

    let tmp = cache_dir.join(format!(
        ".{key}.{}.{}.part",
        std::process::id(),
        NEXT_TMP.fetch_add(1, Ordering::Relaxed)
    ));
    cbr::convert_cbr_to_cbz_file(src, &tmp).map_err(AppError::io)?;
    if let Err(err) = fs::rename(&tmp, &dest) {
        let _ = fs::remove_file(&tmp);
        if dest.is_file() {
            return Ok(dest.to_string_lossy().into_owned());
        }
        return Err(io_error("Failed to store converted CBZ", err));
    }
    Ok(dest.to_string_lossy().into_owned())
}
