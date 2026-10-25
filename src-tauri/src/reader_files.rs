//! Whole-file reads for the reader (books, CBR converted to CBZ).

use crate::cbr;
use std::fs;
use std::path::Path;
use tauri::ipc::Response;

pub(crate) fn read_file(path: String) -> Result<Response, String> {
    let data = fs::read(&path).map_err(|e| format!("Failed to read file '{}': {}", path, e))?;
    Ok(Response::new(data))
}

pub(crate) fn read_cbr_as_cbz(path: String) -> Result<Response, String> {
    let bytes = cbr::convert_cbr_to_cbz(Path::new(&path))?;
    Ok(Response::new(bytes))
}
