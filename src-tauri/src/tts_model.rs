//! Neural TTS (Supertonic) asset download layer — desktop only.
//!
//! Nothing ships with the app: the fp32 ONNX models, voice styles, and (on
//! desktop) the ONNX Runtime dylib are downloaded at first use from
//! the `fundaments-work/supertonic-assets` GitHub release (tag `v1`) and verified
//! against the pinned SHA-256 manifest below. Weights: Supertone/supertonic-3
//! (OpenRAIL-M, shipped alongside as LICENSE). Android uses a companion TTS engine app instead
//! (see the audiobook plan, section 0.3).

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};

/// Asset bundle version tag in the supertonic-assets repo.
const ASSETS_TAG: &str = "v1";
const ASSETS_BASE: &str = "https://github.com/fundaments-work/supertonic-assets/releases/download";

/// One downloadable asset. GitHub release assets are flat filenames, so
/// `remote` carries no path separators; `dest` defines the on-disk layout.
struct TtsAsset {
    /// File name in the release
    remote: String,
    /// Destination path relative to the tts dir
    dest: String,
    /// Exact size in bytes (status display + progress fallback)
    size_bytes: u64,
    /// Pinned SHA-256 (hex), computed from the published release asset.
    sha256: String,
}

impl TtsAsset {
    fn new(remote: &str, dest: &str, size_bytes: u64, sha256: &str) -> TtsAsset {
        TtsAsset {
            remote: remote.to_string(),
            dest: dest.to_string(),
            size_bytes,
            sha256: sha256.to_string(),
        }
    }
}

/// Desktop OS → ONNX Runtime dylib asset mapping.
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
fn runtime_asset() -> TtsAsset {
    TtsAsset::new(
        "libonnxruntime-linux-x64-1.22.0.so",
        "runtime/libonnxruntime.so",
        21042416,
        "3da6146e14e7b8aaec625dde11d6114c7457c87a5f93d744897da8781e35c673",
    )
}
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn runtime_asset() -> TtsAsset {
    TtsAsset::new(
        "libonnxruntime-osx-arm64-1.22.0.dylib",
        "runtime/libonnxruntime.dylib",
        33481272,
        "2b885992d3d6fa4130d39ec84a80d7504ff52750027c547bb22c86165f19406a",
    )
}
#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
fn runtime_asset() -> TtsAsset {
    TtsAsset::new(
        "onnxruntime-win-x64-1.22.0.dll",
        "runtime/onnxruntime.dll",
        12418080,
        "579b636403983254346a5c1d80bd28f1519cd1e284cd204f8d4ff41f8d711559",
    )
}
#[cfg(not(any(
    all(target_os = "linux", target_arch = "x86_64"),
    all(target_os = "macos", target_arch = "aarch64"),
    all(target_os = "windows", target_arch = "x86_64")
)))]
fn runtime_asset() -> TtsAsset {
    TtsAsset::new("unsupported", "runtime/unsupported", 0, "")
}

/// Models + config + license (shared across desktop OSes). SHA-256s are of
/// the published release assets (upstream Supertone/supertonic-3 files).
fn model_assets() -> Vec<TtsAsset> {
    vec![
        TtsAsset::new(
            "duration_predictor.onnx",
            "models/duration_predictor.onnx",
            3700147,
            "c3eb91414d5ff8a7a239b7fe9e34e7e2bf8a8140d8375ffb14718b1c639325db",
        ),
        TtsAsset::new(
            "text_encoder.onnx",
            "models/text_encoder.onnx",
            36416150,
            "c7befd5ea8c3119769e8a6c1486c4edc6a3bc8365c67621c881bbb774b9902ff",
        ),
        TtsAsset::new(
            "vector_estimator.onnx",
            "models/vector_estimator.onnx",
            256534781,
            "883ac868ea0275ef0e991524dc64f16b3c0376efd7c320af6b53f5b780d7c61c",
        ),
        TtsAsset::new(
            "vocoder.onnx",
            "models/vocoder.onnx",
            101424195,
            "085de76dd8e8d5836d6ca66826601f615939218f90e519f70ee8a36ed2a4c4ba",
        ),
        TtsAsset::new(
            "tts.json",
            "models/tts.json",
            8253,
            "42078d3aef1cd43ab43021f3c54f47d2d75ceb4e75f627f118890128b06a0d09",
        ),
        TtsAsset::new(
            "unicode_indexer.json",
            "models/unicode_indexer.json",
            277676,
            "9bf7346e43883a81f8645c81224f786d43c5b57f3641f6e7671a7d6c493cb24f",
        ),
        TtsAsset::new(
            "LICENSE",
            "LICENSE-Supertonic",
            15007,
            "0d944a9110fed9a9602d60e0423a272903e7bd21ab060490774efc77c2275e9f",
        ),
    ]
}

const VOICE_NAMES: &[&str] = &["F1", "F2", "F3", "F4", "F5", "M1", "M2", "M3", "M4", "M5"];

fn voice_asset(name: &str) -> TtsAsset {
    let sha = match name {
        "F1" => "bbdec6ee00231c2c742ad05483df5334cab3b52fda3ba38e6a07059c4563dbc2",
        "F2" => "7c722c6a72707b1a77f035d67f0d1351ba187738e06f7683e8c72b1df3477fc6",
        "F3" => "12f6ef2573baa2defa1128069cb59f203e3ab67c92af77b42df8a0e3a2f7c6ab",
        "F4" => "c2fa764c1225a76dfc3e2c73e8aa4f70d9ee48793860eb34c295fff01c2e032b",
        "F5" => "45966e73316415626cf41a7d1c6f3b4c70dbc1ba2bee5c1978ef0ce33244fc8d",
        "M1" => "e35604687f5d23694b8e91593a93eec0e4eca6c0b02bb8ed69139ab2ea6b0a5b",
        "M2" => "b76cbf62bac707c710cf0ae5aba5e31eea1a6339a9734bfae33ab98499534a50",
        "M3" => "ea1ac35ccb91b0d7ecad533a2fbd0eec10c91513d8951e3b25fbba99954e159b",
        "M4" => "ca8eefad4fcd989c9379032ff3e50738adc547eeb5e221b82593a6d7b3bac303",
        "M5" => "dd22b92740314321f8ae11c5e87f8dd60d060f15dd3a632b5adf77f471f77af2",
        _ => "",
    };
    TtsAsset::new(
        &format!("{name}.json"),
        &format!("voices/{name}.json"),
        292_000,
        sha,
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
        return Err(format!(
            "Server returned HTTP {} for {}",
            status.as_u16(),
            asset.remote
        ));
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
