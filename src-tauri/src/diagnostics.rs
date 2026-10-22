//! Diagnostics: the log file setup, the panic hook, and the "Export logs"
//! bundle users attach to bug reports.
//!
//! Logs may end up in public issues, so nothing here records user content
//! (book text, notes), device keys or identifiers. The export adds only the
//! app version and platform, and replaces the home directory with `~`.

use std::io::{Cursor, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use tauri::plugin::TauriPlugin;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_log::log::LevelFilter;
use tauri_plugin_log::{RotationStrategy, Target, TargetKind, TimezoneStrategy};

/// Base name of the log file in the platform log directory (`theorem.log`).
pub const LOG_FILE_NAME: &str = "theorem";
/// A log file is rotated once it would grow past this size.
pub const LOG_FILE_MAX_BYTES: u64 = 2 * 1024 * 1024;
/// Rotated files kept besides the active one (so at most ~10 MB on disk).
pub const LOG_FILES_KEPT: usize = 4;
/// Upper bound per file in an export, so a runaway log cannot make a bundle
/// too large to attach. The newest bytes are kept.
const EXPORT_MAX_BYTES_PER_FILE: u64 = 4 * 1024 * 1024;

/// Crates whose info/debug output is network chatter, not diagnosis. They log
/// warnings and errors only.
const NOISY_TARGETS: &[&str] = &[
    "iroh",
    "iroh_base",
    "iroh_blobs",
    "iroh_docs",
    "iroh_gossip",
    "iroh_relay",
    "iroh_quinn",
    "iroh_quinn_proto",
    "iroh_quinn_udp",
    "iroh_mdns_address_lookup",
    "iroh_metrics",
    "quinn",
    "quinn_proto",
    "quinn_udp",
    "netwatch",
    "portmapper",
    "swarm_discovery",
    "hickory_proto",
    "hickory_resolver",
    "reqwest",
    "hyper",
    "hyper_util",
    "rustls",
    "h2",
    "tracing",
    "mio",
    "tao",
    "wry",
];

/// The tauri-plugin-log setup: stdout (logcat on Android) plus a rotating
/// file in the platform log directory. Debug level under `tauri dev`, info
/// in shipped builds.
pub fn log_plugin<R: Runtime>() -> TauriPlugin<R> {
    let level = if tauri::is_dev() {
        LevelFilter::Debug
    } else {
        LevelFilter::Info
    };
    let mut builder = tauri_plugin_log::Builder::new()
        .level(level)
        .max_file_size(u128::from(LOG_FILE_MAX_BYTES))
        .rotation_strategy(RotationStrategy::KeepSome(LOG_FILES_KEPT))
        .timezone_strategy(TimezoneStrategy::UseUtc)
        .targets([
            Target::new(TargetKind::Stdout),
            Target::new(TargetKind::LogDir {
                file_name: Some(LOG_FILE_NAME.to_string()),
            }),
        ]);
    for target in NOISY_TARGETS {
        builder = builder.level_for(*target, LevelFilter::Warn);
    }
    builder.build()
}

/// Logs every panic (thread, location, message, and a backtrace when
/// `RUST_BACKTRACE` asks for one) before the default hook runs. Release
/// builds use `panic = "abort"`, so this is the only record a crash leaves.
pub fn install_panic_hook() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let payload = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| (*s).to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "non-string panic payload".to_string());
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "unknown location".to_string());
        let thread = std::thread::current();
        let thread_name = thread.name().unwrap_or("unnamed");
        let backtrace = std::backtrace::Backtrace::capture();
        let backtrace = match backtrace.status() {
            std::backtrace::BacktraceStatus::Captured => format!("\n{backtrace}"),
            _ => String::new(),
        };
        log::error!(
            target: "panic",
            "thread '{thread_name}' panicked at {location}: {}{backtrace}",
            sanitize_panic_message(&payload)
        );
        log::logger().flush();
        default_hook(info);
    }));
}

/// Panic messages can quote the data they failed on (a string slice panic
/// quotes the text, which may be a book's). Quoted spans longer than a short
/// identifier are replaced by their length, and the whole message is capped.
pub fn sanitize_panic_message(message: &str) -> String {
    const MAX_QUOTED: usize = 40;
    const MAX_TOTAL: usize = 1000;

    let mut out = String::with_capacity(message.len().min(MAX_TOTAL));
    let mut rest = message;
    while let Some(open) = rest.find('`') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        match after.find('`') {
            Some(close) => {
                let quoted = &after[..close];
                if quoted.chars().count() > MAX_QUOTED {
                    out.push_str(&format!("`<{} chars redacted>`", quoted.chars().count()));
                } else {
                    out.push('`');
                    out.push_str(quoted);
                    out.push('`');
                }
                rest = &after[close + 1..];
            }
            None => {
                // An unterminated quote: keep it only if it is short.
                if after.chars().count() > MAX_QUOTED {
                    out.push_str(&format!("`<{} chars redacted>", after.chars().count()));
                } else {
                    out.push('`');
                    out.push_str(after);
                }
                rest = "";
            }
        }
    }
    out.push_str(rest);

    if out.chars().count() > MAX_TOTAL {
        let cut: String = out.chars().take(MAX_TOTAL).collect();
        format!("{cut}… [truncated]")
    } else {
        out
    }
}

/// What the export says about the build and platform. Nothing that
/// identifies the device or the user.
#[derive(Debug, Clone)]
pub struct DiagnosticsInfo {
    pub app_version: String,
    pub os: &'static str,
    pub os_family: &'static str,
    pub arch: &'static str,
    pub build: &'static str,
    pub webview: Option<String>,
    pub generated_at: String,
}

impl DiagnosticsInfo {
    pub fn collect<R: Runtime>(app: &AppHandle<R>) -> Self {
        Self {
            app_version: app.package_info().version.to_string(),
            os: std::env::consts::OS,
            os_family: std::env::consts::FAMILY,
            arch: std::env::consts::ARCH,
            build: if tauri::is_dev() {
                "development"
            } else {
                "release"
            },
            webview: tauri::webview_version().ok(),
            generated_at: chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string(),
        }
    }

    fn render(&self) -> String {
        format!(
            "Theorem diagnostics\n\
             app version: {}\n\
             os: {} ({}), arch: {}\n\
             build: {}\n\
             webview: {}\n\
             generated: {}\n",
            self.app_version,
            self.os,
            self.os_family,
            self.arch,
            self.build,
            self.webview.as_deref().unwrap_or("unknown"),
            self.generated_at,
        )
    }
}

/// The `*.log` files directly inside `dir`, oldest name first. A missing
/// directory is an empty list (no log has been written yet).
fn log_files(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut files: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|x| x.to_str()) == Some("log"))
        .collect();
    files.sort();
    files
}

/// Reads at most the last `max` bytes of `path`.
fn read_tail(path: &Path, max: u64) -> std::io::Result<(Vec<u8>, bool)> {
    let mut file = std::fs::File::open(path)?;
    let len = file.metadata()?.len();
    let truncated = len > max;
    if truncated {
        file.seek(SeekFrom::Start(len - max))?;
    }
    let mut buf = Vec::with_capacity(len.min(max) as usize);
    file.take(max).read_to_end(&mut buf)?;
    Ok((buf, truncated))
}

fn redact_home(text: &str, home: Option<&Path>) -> String {
    let Some(home) = home.map(|h| h.to_string_lossy().into_owned()) else {
        return text.to_string();
    };
    let home = home.trim_end_matches(['/', '\\']);
    // A root or empty "home" would replace every separator.
    if home.len() < 2 {
        return text.to_string();
    }
    text.replace(home, "~")
}

/// Builds the zip users save: `diagnostics.txt` plus every log file, with
/// the home directory written as `~`.
pub fn build_log_bundle(
    log_dir: &Path,
    home: Option<&Path>,
    info: &DiagnosticsInfo,
) -> Result<Vec<u8>, String> {
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .unix_permissions(0o644);

    let files = log_files(log_dir);
    let mut summary = info.render();
    summary.push_str(&format!("log files: {}\n", files.len()));

    for path in &files {
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let (bytes, truncated) = match read_tail(path, EXPORT_MAX_BYTES_PER_FILE) {
            Ok(read) => read,
            Err(e) => {
                summary.push_str(&format!("  {name}: unreadable ({e})\n"));
                continue;
            }
        };
        summary.push_str(&format!(
            "  {name}: {} bytes{}\n",
            bytes.len(),
            if truncated { " (newest part only)" } else { "" }
        ));
        let text = redact_home(&String::from_utf8_lossy(&bytes), home);
        zip.start_file(format!("logs/{name}"), options)
            .map_err(|e| format!("Failed to add {name}: {e}"))?;
        zip.write_all(text.as_bytes())
            .map_err(|e| format!("Failed to write {name}: {e}"))?;
    }

    zip.start_file("diagnostics.txt", options)
        .map_err(|e| format!("Failed to add diagnostics.txt: {e}"))?;
    zip.write_all(summary.as_bytes())
        .map_err(|e| format!("Failed to write diagnostics.txt: {e}"))?;

    zip.finish()
        .map(Cursor::into_inner)
        .map_err(|e| format!("Failed to finish the log bundle: {e}"))
}

/// Bundles the log files into a zip and returns its bytes; the frontend
/// saves them (desktop save dialog, Android Downloads).
#[tauri::command]
pub async fn export_logs_bundle(app: AppHandle) -> Result<tauri::ipc::Response, String> {
    log::info!("[diagnostics] Exporting logs");
    log::logger().flush();
    let log_dir = app
        .path()
        .app_log_dir()
        .map_err(|e| format!("Could not find the log folder: {e}"))?;
    let home = app.path().home_dir().ok();
    let info = DiagnosticsInfo::collect(&app);
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        build_log_bundle(&log_dir, home.as_deref(), &info)
    })
    .await
    .map_err(|e| format!("Log export failed: {e}"))??;
    Ok(tauri::ipc::Response::new(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info() -> DiagnosticsInfo {
        DiagnosticsInfo {
            app_version: "9.9.9".to_string(),
            os: "linux",
            os_family: "unix",
            arch: "x86_64",
            build: "release",
            webview: Some("2.48".to_string()),
            generated_at: "2026-01-01T00:00:00Z".to_string(),
        }
    }

    fn unzip(bytes: &[u8]) -> Vec<(String, String)> {
        let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        let mut out = Vec::new();
        for i in 0..archive.len() {
            let mut f = archive.by_index(i).unwrap();
            let mut s = String::new();
            f.read_to_string(&mut s).unwrap();
            out.push((f.name().unwrap().to_string(), s));
        }
        out.sort();
        out
    }

    #[test]
    fn bundle_has_diagnostics_and_every_log_file() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("theorem.log"), "current line\n").unwrap();
        std::fs::write(
            dir.path().join("theorem_2026-01-01_00-00-00.log"),
            "older line\n",
        )
        .unwrap();
        // Not logs: never exported.
        std::fs::write(dir.path().join("iroh-key"), "secret").unwrap();
        std::fs::write(dir.path().join("notes.txt"), "user text").unwrap();
        std::fs::create_dir(dir.path().join("nested.log")).unwrap();

        let files = unzip(&build_log_bundle(dir.path(), None, &info()).unwrap());
        let names: Vec<&str> = files.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(
            names,
            [
                "diagnostics.txt",
                "logs/theorem.log",
                "logs/theorem_2026-01-01_00-00-00.log"
            ]
        );
        assert_eq!(files[1].1, "current line\n");
        assert_eq!(files[2].1, "older line\n");

        let diag = &files[0].1;
        assert!(diag.contains("app version: 9.9.9"));
        assert!(diag.contains("os: linux (unix), arch: x86_64"));
        assert!(diag.contains("webview: 2.48"));
        assert!(diag.contains("log files: 2"));
        assert!(!files.iter().any(|(_, body)| body.contains("secret")));
    }

    #[test]
    fn bundle_works_without_a_log_folder() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("no-logs-yet");
        let files = unzip(&build_log_bundle(&missing, None, &info()).unwrap());
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].0, "diagnostics.txt");
        assert!(files[0].1.contains("log files: 0"));
    }

    #[test]
    fn bundle_replaces_the_home_directory_with_tilde() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("theorem.log"),
            "opened /home/alice/Books/a.epub\nhome is /home/alice\n",
        )
        .unwrap();
        let files =
            unzip(&build_log_bundle(dir.path(), Some(Path::new("/home/alice/")), &info()).unwrap());
        assert_eq!(files[1].1, "opened ~/Books/a.epub\nhome is ~\n");
    }

    #[test]
    fn root_home_is_not_redacted() {
        assert_eq!(redact_home("/a/b", Some(Path::new("/"))), "/a/b");
        assert_eq!(redact_home("/a/b", None), "/a/b");
    }

    #[test]
    fn oversized_log_keeps_only_the_newest_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("big.log");
        let mut body = vec![b'a'; EXPORT_MAX_BYTES_PER_FILE as usize];
        body.extend_from_slice(b"NEWEST");
        std::fs::write(&path, &body).unwrap();
        let (tail, truncated) = read_tail(&path, EXPORT_MAX_BYTES_PER_FILE).unwrap();
        assert!(truncated);
        assert_eq!(tail.len() as u64, EXPORT_MAX_BYTES_PER_FILE);
        assert!(tail.ends_with(b"NEWEST"));

        let (small, truncated) = read_tail(&path, u64::MAX).unwrap();
        assert!(!truncated);
        assert_eq!(small.len(), body.len());
    }

    #[test]
    fn panic_messages_drop_long_quoted_text() {
        let msg = "byte index 3 is not a char boundary; it is inside 'é' (bytes 2..4) of \
                   `It was the best of times, it was the worst of times, it was the age`";
        let clean = sanitize_panic_message(msg);
        assert!(!clean.contains("best of times"));
        assert!(clean.contains("`<67 chars redacted>`"));
        assert!(clean.starts_with("byte index 3 is not a char boundary"));
    }

    #[test]
    fn panic_messages_keep_short_quotes_and_plain_text() {
        assert_eq!(
            sanitize_panic_message("called `Option::unwrap()` on a `None` value"),
            "called `Option::unwrap()` on a `None` value"
        );
        assert_eq!(sanitize_panic_message(""), "");
        assert_eq!(sanitize_panic_message("no quotes"), "no quotes");
    }

    #[test]
    fn panic_messages_handle_unterminated_and_long_input() {
        let long_tail = format!("oops `{}", "x".repeat(100));
        assert_eq!(
            sanitize_panic_message(&long_tail),
            "oops `<100 chars redacted>"
        );
        assert_eq!(sanitize_panic_message("a `b"), "a `b");

        let huge = "y".repeat(5000);
        let clean = sanitize_panic_message(&huge);
        assert!(clean.ends_with("… [truncated]"));
        assert!(clean.chars().count() < 1100);
    }
}
