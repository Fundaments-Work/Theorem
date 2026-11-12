//! StarDict dictionary downloads and online definitions.

use crate::database;
use crate::http;
use std::io::Read;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::AppHandle;
use tauri::Emitter;
use tauri::Manager;

const MAX_DICT_DOWNLOAD_BYTES: usize = 256 * 1024 * 1024;
const MAX_DICT_ENTRY_BYTES: usize = 256 * 1024 * 1024;
const MAX_DICT_TAR_BYTES: usize = 512 * 1024 * 1024;

static DICT_DOWNLOAD_GEN: AtomicU64 = AtomicU64::new(0);

#[tauri::command]
pub(crate) fn cancel_stardict_download() {
    DICT_DOWNLOAD_GEN.fetch_add(1, Ordering::SeqCst);
}

#[tauri::command]
pub(crate) async fn download_and_extract_stardict(
    app: AppHandle,
    url: String,
) -> Result<serde_json::Value, String> {
    use futures::StreamExt;

    let download_gen = DICT_DOWNLOAD_GEN
        .fetch_add(1, Ordering::SeqCst)
        .wrapping_add(1);
    let parsed_url = http::validate_http_url(&url)?;
    let response = http::download_client()?
        .get(parsed_url)
        .timeout(std::time::Duration::from_secs(300))
        .send()
        .await
        .map_err(|e| format!("Download failed: {e}"))?;

    if DICT_DOWNLOAD_GEN.load(Ordering::SeqCst) != download_gen {
        return Err("Download cancelled".to_string());
    }

    let status = response.status();
    if !status.is_success() {
        return Err(format!("Server returned HTTP {}", status.as_u16()));
    }

    let total_size = response.content_length().unwrap_or(0);
    if total_size > MAX_DICT_DOWNLOAD_BYTES as u64 {
        return Err(format!(
            "Dictionary download exceeds maximum allowed size ({MAX_DICT_DOWNLOAD_BYTES} bytes)"
        ));
    }
    let mut downloaded: u64 = 0;
    let mut body = Vec::new();

    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        if DICT_DOWNLOAD_GEN.load(Ordering::SeqCst) != download_gen {
            return Err("Download cancelled".to_string());
        }
        let chunk = chunk.map_err(|e| format!("Stream error: {e}"))?;
        downloaded = downloaded.saturating_add(chunk.len() as u64);
        if downloaded > MAX_DICT_DOWNLOAD_BYTES as u64 {
            return Err(format!(
                "Dictionary download exceeds maximum allowed size ({MAX_DICT_DOWNLOAD_BYTES} bytes)"
            ));
        }
        body.extend_from_slice(&chunk);

        if total_size > 0 {
            let percent = (downloaded as f64 / total_size as f64 * 100.0) as u32;
            let _ = app.emit(
                "dictionary-download-progress",
                serde_json::json!({
                    "percent": percent,
                    "downloaded": downloaded,
                    "total": total_size,
                }),
            );
        }
    }

    let id = uuid::Uuid::new_v4().to_string();
    let app_data = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    let dict_dir = app_data.join("dictionaries").join(&id);
    if DICT_DOWNLOAD_GEN.load(Ordering::SeqCst) != download_gen {
        return Err("Download cancelled".to_string());
    }
    std::fs::create_dir_all(&dict_dir).map_err(|e| {
        format!(
            "Failed to create dictionary directory {}: {e}",
            dict_dir.display()
        )
    })?;

    if url.ends_with(".mdx") {
        let size_bytes = body.len() as u64;
        let mdx_file = dict_dir.join("dict-en-en.mdx");
        std::fs::write(&mdx_file, &body).map_err(|e| format!("Failed to write MDX file: {e}"))?;

        let name = "English Wiktionary (MDX)".to_string();
        let lang = "en".to_string();

        let manifest_key = format!("theorem-stardict:{id}:manifest");
        let manifest = serde_json::json!({
            "id": id,
            "name": name,
            "language": lang,
            "sizeBytes": size_bytes,
            "format": "mdx",
        });
        database::sqlite_set_kv(
            app.clone(),
            manifest_key,
            serde_json::to_string(&manifest).map_err(|e| e.to_string())?,
        )?;

        return Ok(serde_json::json!({
            "id": id,
            "name": name,
            "language": lang,
            "sizeBytes": size_bytes,
        }));
    }

    let is_zip = url.ends_with(".zip");

    let (ifo, idx, dict, syn) = tokio::task::spawn_blocking(move || {
        if is_zip {
            extract_stardict_parts_from_zip(&body)
        } else {
            extract_stardict_parts_from_tar_bz2(&body)
        }
    })
    .await
    .map_err(|e| format!("Extraction task failed: {e}"))?
    .map_err(|e| format!("Extraction failed: {e}"))?;

    let ifo_text = String::from_utf8_lossy(&ifo);
    let mut name = String::from("Unknown Dictionary");
    let mut lang = String::from("en");
    for line in ifo_text.lines() {
        let trimmed = line.trim();
        if let Some(value) = trimmed.strip_prefix("bookname=") {
            name = value.trim().to_string();
        } else if trimmed.starts_with("sametypesequence=") {
        }
    }

    if let Some(segments) = url.split('/').nth(4) {
        if segments.len() == 2 {
            lang = segments.to_string();
        }
    }

    let size_bytes = (ifo.len() as u64)
        .saturating_add(idx.len() as u64)
        .saturating_add(dict.len() as u64)
        .saturating_add(syn.as_ref().map_or(0, |s| s.len() as u64));

    let manifest_key = format!("theorem-stardict:{id}:manifest");
    let manifest = serde_json::json!({
        "id": id,
        "name": name,
        "language": lang,
        "sizeBytes": size_bytes,
        "hasSyn": syn.is_some(),
    });
    database::sqlite_set_kv(
        app.clone(),
        manifest_key,
        serde_json::to_string(&manifest).map_err(|e| e.to_string())?,
    )?;

    std::fs::write(dict_dir.join("dict.ifo"), &ifo)
        .map_err(|e| format!("Failed to write dict.ifo: {e}"))?;
    std::fs::write(dict_dir.join("dict.idx"), &idx)
        .map_err(|e| format!("Failed to write dict.idx: {e}"))?;
    std::fs::write(dict_dir.join("dict.dict.dz"), &dict)
        .map_err(|e| format!("Failed to write dict.dict.dz: {e}"))?;
    if let Some(ref syn_data) = syn {
        std::fs::write(dict_dir.join("dict.syn"), syn_data)
            .map_err(|e| format!("Failed to write dict.syn: {e}"))?;
    }

    Ok(serde_json::json!({
        "id": id,
        "name": name,
        "language": lang,
        "sizeBytes": size_bytes,
    }))
}

type StardictParts = (Vec<u8>, Vec<u8>, Vec<u8>, Option<Vec<u8>>);

fn read_bounded_entry<R: std::io::Read>(
    reader: &mut R,
    max_bytes: usize,
    label: &str,
) -> Result<Vec<u8>, String> {
    let mut data = Vec::new();
    std::io::Read::take(reader, (max_bytes as u64).saturating_add(1))
        .read_to_end(&mut data)
        .map_err(|e| format!("Failed to read {label}: {e}"))?;
    if data.len() > max_bytes {
        return Err(format!(
            "{label} exceeds maximum allowed size ({max_bytes} bytes)"
        ));
    }
    Ok(data)
}

fn extract_stardict_parts_from_zip(data: &[u8]) -> Result<StardictParts, String> {
    let reader = std::io::Cursor::new(data);
    let mut archive = crate::zip_util::open_zip_archive(reader)
        .map_err(|e| format!("ZIP parsing failed: {e}"))?;

    let mut ifo_bytes: Option<Vec<u8>> = None;
    let mut idx_bytes: Option<Vec<u8>> = None;
    let mut dict_bytes: Option<Vec<u8>> = None;
    let mut syn_bytes: Option<Vec<u8>> = None;

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("ZIP entry error: {e}"))?;
        let name = entry
            .name()
            .map_err(|e| format!("ZIP entry name error: {e}"))?
            .into_owned();
        if entry.is_dir() {
            continue;
        }
        let wanted = name.ends_with(".ifo")
            || (name.ends_with(".idx") && !name.ends_with(".idx.gz"))
            || name.ends_with(".dict.dz")
            || name.ends_with(".dict")
            || name.ends_with(".syn");
        if !wanted {
            continue;
        }
        let data = read_bounded_entry(
            &mut entry,
            MAX_DICT_ENTRY_BYTES,
            &format!("ZIP entry '{name}'"),
        )?;

        if name.ends_with(".ifo") {
            ifo_bytes = Some(data);
        } else if name.ends_with(".idx") && !name.ends_with(".idx.gz") {
            idx_bytes = Some(data);
        } else if name.ends_with(".dict.dz") || name.ends_with(".dict") {
            dict_bytes = Some(data);
        } else if name.ends_with(".syn") {
            syn_bytes = Some(data);
        }
    }

    let ifo = ifo_bytes.ok_or("Archive missing .ifo file")?;
    let idx = idx_bytes.ok_or("Archive missing .idx file")?;
    let dict = dict_bytes.ok_or("Archive missing .dict.dz/.dict file")?;

    Ok((ifo, idx, dict, syn_bytes))
}

fn extract_stardict_parts_from_tar_bz2(data: &[u8]) -> Result<StardictParts, String> {
    let decompressed = {
        let mut decoder = bzip2::read::BzDecoder::new(data);
        read_bounded_entry(&mut decoder, MAX_DICT_TAR_BYTES, "Bzip2 archive")?
    };

    let mut archive = tar::Archive::new(&decompressed[..]);

    let mut ifo_bytes: Option<Vec<u8>> = None;
    let mut idx_bytes: Option<Vec<u8>> = None;
    let mut dict_bytes: Option<Vec<u8>> = None;
    let mut syn_bytes: Option<Vec<u8>> = None;

    for entry in archive
        .entries()
        .map_err(|e| format!("Tar parsing failed: {e}"))?
    {
        let mut entry = entry.map_err(|e| format!("Tar entry error: {e}"))?;
        let name = {
            let path = entry.path().map_err(|e| format!("Tar path error: {e}"))?;
            path.file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_owned()
        };
        let wanted = name.ends_with(".ifo")
            || (name.ends_with(".idx") && !name.ends_with(".idx.gz"))
            || name.ends_with(".dict.dz")
            || name.ends_with(".dict")
            || name.ends_with(".syn");
        if !wanted {
            continue;
        }
        let data = read_bounded_entry(
            &mut entry,
            MAX_DICT_ENTRY_BYTES,
            &format!("tar entry '{name}'"),
        )?;

        if name.ends_with(".ifo") {
            ifo_bytes = Some(data);
        } else if name.ends_with(".idx") && !name.ends_with(".idx.gz") {
            idx_bytes = Some(data);
        } else if name.ends_with(".dict.dz") || name.ends_with(".dict") {
            dict_bytes = Some(data);
        } else if name.ends_with(".syn") {
            syn_bytes = Some(data);
        }
    }

    let ifo = ifo_bytes.ok_or("Archive missing .ifo file")?;
    let idx = idx_bytes.ok_or("Archive missing .idx file")?;
    let dict = dict_bytes.ok_or("Archive missing .dict.dz/.dict file")?;

    Ok((ifo, idx, dict, syn_bytes))
}

#[tauri::command]
pub(crate) async fn fetch_online_definition(
    term: String,
) -> Result<serde_json::Value, crate::error::AppError> {
    const MAX_DICT_API_BYTES: usize = 2 * 1024 * 1024;
    let clean = term.trim();
    if clean.is_empty() {
        return Err(crate::error::AppError::invalid_input("Term is empty"));
    }

    let encoded = percent_encoding::utf8_percent_encode(clean, percent_encoding::NON_ALPHANUMERIC)
        .to_string();
    let url = format!("https://api.dictionaryapi.dev/api/v2/entries/en/{encoded}");

    let resp = http::client()
        .map_err(crate::error::AppError::network)?
        .get(&url)
        .timeout(std::time::Duration::from_secs(4))
        .send()
        .await
        .map_err(|e| crate::error::AppError::network(format!("Network request failed: {e}")))?;

    if !resp.status().is_success() {
        return Err(crate::error::AppError::network(format!(
            "HTTP {}",
            resp.status().as_u16()
        )));
    }

    let bytes = http::read_response_bytes_bounded(resp, MAX_DICT_API_BYTES)
        .await
        .map_err(crate::error::AppError::network)?;
    serde_json::from_slice(&bytes).map_err(|e| {
        crate::error::AppError::new(
            crate::error::ErrorKind::Corrupt,
            format!("JSON parse error: {e}"),
        )
    })
}
