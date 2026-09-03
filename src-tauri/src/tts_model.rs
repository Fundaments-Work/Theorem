//! Neural TTS (Supertonic) asset download layer — desktop only.
//!
//! Nothing ships with the app: the fp32 ONNX models, voice styles, and (on
//! desktop) the ONNX Runtime dylib are downloaded at first use from
//! `fundaments-work/supertonic-assets` GitHub releases and verified against
//! the pinned manifest below. Android uses a companion TTS engine app instead
//! (see the audiobook plan, section 0.3).

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};

/// Asset bundle version tag in the supertonic-assets repo.
const ASSETS_TAG: &str = "v1";
const ASSETS_BASE: &str = "https://github.com/fundaments-work/supertonic-assets/releases/download";

/// One downloadable asset. `sha256` left empty means "not yet pinned" —
/// verification is skipped (logged loudly). MUST be pinned before release.
struct TtsAsset {
    /// File name in the release
    remote: String,
    /// Destination path relative to the tts dir
    dest: String,
    /// Approximate size in bytes (status display only)
    size_bytes: u64,
    /// Pinned SHA-256 (hex). Empty = unpinned, verification skipped.
    #[allow(dead_code)]
    sha256: String,
}

impl TtsAsset {
    fn new(remote: &str, dest: &str, size_bytes: u64) -> TtsAsset {
        TtsAsset {
            remote: remote.to_string(),
            dest: dest.to_string(),
            size_bytes,
            sha256: String::new(),
        }
    }
}

/// Desktop OS → ONNX Runtime dylib asset mapping.
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
fn runtime_asset() -> TtsAsset {
    TtsAsset::new(
        "onnxruntime-linux-x64-1.22.0/libonnxruntime.so",
        "runtime/libonnxruntime.so",
        18_000_000,
    )
}
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn runtime_asset() -> TtsAsset {
    TtsAsset::new(
        "onnxruntime-macos-arm64-1.22.0/libonnxruntime.dylib",
        "runtime/libonnxruntime.dylib",
        18_000_000,
    )
}
#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
fn runtime_asset() -> TtsAsset {
    TtsAsset::new(
        "onnxruntime-windows-x64-1.22.0/onnxruntime.dll",
        "runtime/onnxruntime.dll",
        18_000_000,
    )
}
#[cfg(not(any(
    all(target_os = "linux", target_arch = "x86_64"),
    all(target_os = "macos", target_arch = "aarch64"),
    all(target_os = "windows", target_arch = "x86_64")
)))]
fn runtime_asset() -> TtsAsset {
    TtsAsset::new("unsupported", "runtime/unsupported", 0)
}

/// Models + config + voices (shared across desktop OSes).
fn model_assets() -> Vec<TtsAsset> {
    vec![
        TtsAsset::new(
            "onnx/duration_predictor.onnx",
            "models/duration_predictor.onnx",
            3_700_000,
        ),
        TtsAsset::new(
            "onnx/text_encoder.onnx",
            "models/text_encoder.onnx",
            36_400_000,
        ),
        TtsAsset::new(
            "onnx/vector_estimator.onnx",
            "models/vector_estimator.onnx",
            257_000_000,
        ),
        TtsAsset::new("onnx/vocoder.onnx", "models/vocoder.onnx", 101_000_000),
        TtsAsset::new("onnx/tts.json", "models/tts.json", 8_250),
        TtsAsset::new(
            "onnx/unicode_indexer.json",
            "models/unicode_indexer.json",
            278_000,
        ),
    ]
}

const VOICE_NAMES: &[&str] = &["F1", "F2", "F3", "F4", "F5", "M1", "M2", "M3", "M4", "M5"];

fn voice_asset(name: &str) -> TtsAsset {
    TtsAsset::new(
        &format!("voice_styles/{name}.json"),
        &format!("voices/{name}.json"),
        292_000,
    )
}

fn asset_url(asset: &TtsAsset) -> String {
    format!("{ASSETS_BASE}/{ASSETS_TAG}/{}", asset.remote)
}

pub fn tts_dir(app: &AppHandle) -> std::path::PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."))
        .join("tts")
}

#[derive(Serialize, Clone)]
pub struct TtsAssetStatus {
    pub name: String,
    pub installed: bool,
    pub size_bytes: u64,
}

#[derive(Serialize, Clone)]
pub struct TtsModelStatus {
    pub installed: bool,
    /// Voice names available for download
    pub voices: Vec<String>,
    pub assets: Vec<TtsAssetStatus>,
    pub missing_count: usize,
    /// Bytes on disk under the tts dir
    pub installed_bytes: u64,
    pub dir: String,
    pub platform_supported: bool,
}

fn all_assets() -> Vec<TtsAsset> {
    let mut assets = vec![runtime_asset()];
    assets.extend(model_assets());
    for voice in VOICE_NAMES {
        assets.push(voice_asset(voice));
    }
    assets
}

fn is_installed(app: &AppHandle, asset: &TtsAsset) -> bool {
    let path = tts_dir(app).join(&asset.dest);
    match std::fs::metadata(&path) {
        Ok(meta) => meta.len() > 0,
        Err(_) => false,
    }
}

#[tauri::command]
pub fn tts_model_status(app: AppHandle) -> Result<TtsModelStatus, String> {
    let assets: Vec<TtsAssetStatus> = all_assets()
        .iter()
        .map(|a| TtsAssetStatus {
            name: a.dest.to_string(),
            installed: is_installed(&app, a),
            size_bytes: a.size_bytes,
        })
        .collect();
    let missing_count = assets.iter().filter(|a| !a.installed).count();
    let installed_bytes = dir_size(&tts_dir(&app));
    let platform_supported = tts_dir(&app).join(runtime_asset().dest).parent().is_some();

    Ok(TtsModelStatus {
        installed: missing_count == 0,
        voices: VOICE_NAMES.iter().map(|s| s.to_string()).collect(),
        missing_count,
        installed_bytes,
        dir: tts_dir(&app).display().to_string(),
        assets,
        platform_supported,
    })
}

fn dir_size(path: &std::path::Path) -> u64 {
    let mut total = 0;
    if let Ok(entries) = std::fs::read_dir(path) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                total += dir_size(&p);
            } else if let Ok(meta) = entry.metadata() {
                total += meta.len();
            }
        }
    }
    total
}

/// Download a single asset by its dest path (the frontend drives the queue so
/// progress and cancellation stay per-asset). Emits `tts-download-progress`
/// `{ name, percent, downloaded, total }` during transfer.
#[tauri::command]
pub async fn tts_model_download_asset(
    app: AppHandle,
    name: String,
) -> Result<TtsAssetStatus, String> {
    use futures::StreamExt;

    let asset = all_assets()
        .into_iter()
        .find(|a| a.dest == name)
        .ok_or_else(|| format!("Unknown TTS asset '{name}'"))?;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(1800))
        .redirect(reqwest::redirect::Policy::limited(10))
        .user_agent("Mozilla/5.0 Theorem")
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {e}"))?;

    let response = client
        .get(asset_url(&asset))
        .send()
        .await
        .map_err(|e| format!("Download failed: {e}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("Server returned HTTP {}", status.as_u16()));
    }

    let total_size = response.content_length().unwrap_or(asset.size_bytes);
    let dest = tts_dir(&app).join(&asset.dest);
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create {}: {e}", parent.display()))?;
    }
    let tmp_dest = dest.with_extension("part");

    let mut file = tokio::fs::File::create(&tmp_dest)
        .await
        .map_err(|e| format!("Failed to create {}: {e}", tmp_dest.display()))?;
    let mut downloaded: u64 = 0;
    let mut hasher = Sha256::new();
    let mut stream = response.bytes_stream();
    let mut last_emit = std::time::Instant::now();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Stream error: {e}"))?;
        tokio::io::AsyncWriteExt::write_all(&mut file, &chunk)
            .await
            .map_err(|e| format!("Write error: {e}"))?;
        hasher.update(&chunk);
        downloaded += chunk.len() as u64;

        if last_emit.elapsed().as_millis() > 120 {
            last_emit = std::time::Instant::now();
            let percent = if total_size > 0 {
                (downloaded as f64 / total_size as f64 * 100.0) as u32
            } else {
                0
            };
            let _ = app.emit(
                "tts-download-progress",
                serde_json::json!({
                    "name": asset.dest,
                    "percent": percent,
                    "downloaded": downloaded,
                    "total": total_size,
                }),
            );
        }
    }
    tokio::io::AsyncWriteExt::flush(&mut file)
        .await
        .map_err(|e| format!("Flush error: {e}"))?;
    drop(file);

    if !asset.sha256.is_empty() {
        let digest = format!("{:x}", hasher.finalize());
        if digest != asset.sha256.to_ascii_lowercase() {
            let _ = std::fs::remove_file(&tmp_dest);
            return Err(format!(
                "Checksum mismatch for {} (pinned release asset changed?)",
                asset.dest
            ));
        }
    } else {
        eprintln!(
            "[tts] WARNING: sha256 for {} is unpinned — verification skipped",
            asset.dest
        );
    }

    std::fs::rename(&tmp_dest, &dest)
        .map_err(|e| format!("Failed to finalize {}: {e}", dest.display()))?;

    Ok(TtsAssetStatus {
        name: asset.dest.to_string(),
        installed: true,
        size_bytes: downloaded,
    })
}

/// Remove the whole neural voice install (models, runtime, cache).
#[tauri::command]
pub fn tts_model_remove(app: AppHandle) -> Result<u64, String> {
    let dir = tts_dir(&app);
    let bytes = dir_size(&dir);
    if dir.exists() {
        std::fs::remove_dir_all(&dir)
            .map_err(|e| format!("Failed to remove {}: {e}", dir.display()))?;
    }
    Ok(bytes)
}
