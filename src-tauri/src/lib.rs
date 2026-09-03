pub mod article_extractor;
pub mod batch_ingest;
pub mod book_search;
#[cfg(not(target_os = "android"))]
pub mod cli;
#[cfg(not(target_os = "android"))]
pub mod cli_tui;
mod database;
mod epub_parser;
mod epub_rewriter;
pub mod epubcfi;
mod file_transfer;
mod iroh_sync;
pub mod mdict;
pub mod mobi_parser;
pub mod opds_parser;
pub mod stardict;
mod sync_commands;
#[cfg(target_os = "linux")]
mod tts_linux;

use reqwest::blocking::Client;
use serde::Serialize;
use std::env;

use std::fs;
#[cfg(not(target_os = "android"))]
use std::io::{Cursor, Write};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use tauri::ipc::Response;
use tauri::AppHandle;
use tauri::Emitter;
use tauri::Manager;

fn shared_http_client() -> &'static Client {
    static CLIENT: OnceLock<Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        Client::builder()
            .cookie_store(true)
            .timeout(std::time::Duration::from_secs(60))
            .redirect(reqwest::redirect::Policy::limited(10))
            .user_agent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36")
            .build()
            .expect("Failed to create shared HTTP client — install OpenSSL (libssl-dev)")
    })
}

#[cfg(desktop)]
use tauri::menu::{MenuBuilder, MenuItemBuilder};
#[cfg(desktop)]
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri::WindowEvent;

#[derive(Default)]
struct PendingOpenFiles(Mutex<Vec<String>>);

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

fn collect_open_paths(args: Vec<String>, cwd: Option<&str>) -> Vec<String> {
    args.into_iter()
        .filter_map(|arg| normalize_open_path(&arg, cwd))
        .collect()
}

fn enqueue_open_paths(app: &tauri::AppHandle, paths: Vec<String>, emit_event: bool) {
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
fn take_pending_open_files(state: tauri::State<PendingOpenFiles>) -> Vec<String> {
    let mut guard = state.0.lock().unwrap_or_else(|poison| poison.into_inner());
    guard.drain(..).collect()
}

#[derive(Serialize)]
struct PdfMetadata {
    title: Option<String>,
    author: Option<String>,
    pages: Option<u32>,
    creator: Option<String>,
    producer: Option<String>,
    creation_date: Option<String>,
    modification_date: Option<String>,
}

#[tauri::command]
fn read_file(path: String) -> Result<Response, String> {
    let data = fs::read(&path).map_err(|e| format!("Failed to read file '{}': {}", path, e))?;
    Ok(Response::new(data))
}

#[tauri::command]
fn read_cbr_as_cbz(path: String) -> Result<Response, String> {
    #[cfg(not(target_os = "android"))]
    {
        let archive = unrar_ng::Archive::new(&path)
            .open_for_processing()
            .map_err(|e| format!("Failed to open CBR archive '{}': {}", path, e))?;
        let mut zip_buffer = Cursor::new(Vec::new());
        {
            let mut zip_writer = zip::ZipWriter::new(&mut zip_buffer);
            let options: zip::write::FileOptions<'_, ()> = zip::write::FileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
            let mut archive = archive;
            loop {
                let entry = archive
                    .read_header()
                    .map_err(|e| format!("Failed to read CBR header: {}", e))?;
                let Some(entry) = entry else { break };
                let filename = entry.entry().filename.to_string_lossy().to_string();
                if entry.entry().is_file() {
                    let (data, next_archive) = entry
                        .read()
                        .map_err(|e| format!("Failed to extract '{}': {}", filename, e))?;
                    zip_writer
                        .start_file(filename.clone(), options)
                        .map_err(|e| format!("Failed to write ZIP entry '{}': {}", filename, e))?;
                    zip_writer.write_all(&data).map_err(|e| {
                        format!("Failed to write ZIP data for '{}': {}", filename, e)
                    })?;
                    archive = next_archive;
                } else {
                    archive = entry
                        .skip()
                        .map_err(|e| format!("Failed to skip entry '{}': {}", filename, e))?;
                }
            }
            zip_writer
                .finish()
                .map_err(|e| format!("Failed to finalize ZIP: {}", e))?;
        }
        Ok(Response::new(zip_buffer.into_inner()))
    }
    #[cfg(target_os = "android")]
    {
        Err(format!(
            "CBR/RAR files are not supported on Android: {}",
            path
        ))
    }
}

#[tauri::command]
fn read_pdf_file(path: String) -> Result<Response, String> {
    let data = fs::read(&path).map_err(|e| format!("Failed to read PDF file '{}': {}", path, e))?;
    Ok(Response::new(data))
}

#[tauri::command]
fn read_pdf_file_size(path: String) -> Result<u64, String> {
    fs::metadata(&path)
        .map(|metadata| metadata.len())
        .map_err(|e| format!("Failed to read PDF file metadata '{}': {}", path, e))
}

#[tauri::command]
fn read_pdf_range(path: String, offset: u64, length: u64) -> Result<Response, String> {
    if length == 0 {
        return Ok(Response::new(Vec::new()));
    }

    let metadata = fs::metadata(&path)
        .map_err(|e| format!("Failed to read PDF file metadata '{}': {}", path, e))?;
    let file_size = metadata.len();
    if offset >= file_size {
        return Ok(Response::new(Vec::new()));
    }

    let clamped_len = length.min(file_size.saturating_sub(offset));
    let read_len = usize::try_from(clamped_len).map_err(|_| {
        format!(
            "Requested PDF range is too large for this platform: {}",
            clamped_len
        )
    })?;

    let mut file =
        fs::File::open(&path).map_err(|e| format!("Failed to open PDF file '{}': {}", path, e))?;
    file.seek(SeekFrom::Start(offset))
        .map_err(|e| format!("Failed to seek PDF file '{}': {}", path, e))?;

    let mut buffer = vec![0_u8; read_len];
    file.read_exact(&mut buffer)
        .map_err(|e| format!("Failed to read PDF range from '{}': {}", path, e))?;

    Ok(Response::new(buffer))
}

#[tauri::command]
fn get_pdf_metadata(path: String) -> Result<PdfMetadata, String> {
    let metadata = fs::metadata(&path)
        .map_err(|e| format!("Failed to read PDF file metadata '{}': {}", path, e))?;
    let file_size = metadata.len();

    const HEAD_SIZE: u64 = 65536;
    let first_chunk_size = HEAD_SIZE.min(file_size);

    let mut file =
        fs::File::open(&path).map_err(|e| format!("Failed to open PDF file '{}': {}", path, e))?;

    let mut first_bytes = vec![0_u8; first_chunk_size as usize];
    file.read_exact(&mut first_bytes)
        .map_err(|e| format!("Failed to read PDF header from '{}': {}", path, e))?;

    let metadata = extract_pdf_metadata(&first_bytes);

    if metadata.title.is_none() && file_size > HEAD_SIZE {
        let tail_size = HEAD_SIZE.min(file_size);
        let tail_offset = file_size.saturating_sub(tail_size);

        file.seek(SeekFrom::Start(tail_offset))
            .map_err(|e| format!("Failed to seek PDF tail '{}': {}", path, e))?;

        let mut tail_bytes = vec![0_u8; tail_size as usize];
        file.read_exact(&mut tail_bytes)
            .map_err(|e| format!("Failed to read PDF tail from '{}': {}", path, e))?;

        let tail_metadata = extract_pdf_metadata(&tail_bytes);

        let title = metadata.title.or(tail_metadata.title);
        let author = metadata.author.or(tail_metadata.author);
        let creator = metadata.creator.or(tail_metadata.creator);
        let producer = metadata.producer.or(tail_metadata.producer);
        let creation_date = metadata.creation_date.or(tail_metadata.creation_date);
        let modification_date = metadata
            .modification_date
            .or(tail_metadata.modification_date);

        return Ok(PdfMetadata {
            title,
            author,
            pages: metadata.pages,
            creator,
            producer,
            creation_date,
            modification_date,
        });
    }

    Ok(metadata)
}

fn extract_pdf_metadata(bytes: &[u8]) -> PdfMetadata {
    let content = String::from_utf8_lossy(bytes);

    let pages = content
        .matches("/Type /Page")
        .count()
        .try_into()
        .ok()
        .filter(|&n: &u32| n > 0);

    let title = extract_pdf_string(&content, "/Title");
    let author = extract_pdf_string(&content, "/Author");
    let creator = extract_pdf_string(&content, "/Creator");
    let producer = extract_pdf_string(&content, "/Producer");
    let creation_date = extract_pdf_string(&content, "/CreationDate");
    let modification_date = extract_pdf_string(&content, "/ModDate");

    PdfMetadata {
        title,
        author,
        pages,
        creator,
        producer,
        creation_date,
        modification_date,
    }
}

fn extract_pdf_string(content: &str, key: &str) -> Option<String> {
    if let Some(pos) = content.find(key) {
        let after_key = &content[pos + key.len()..];
        let trimmed = after_key.trim_start();

        if let Some(rest) = trimmed.strip_prefix('(') {
            if let Some(end_pos) = find_closing_paren(rest) {
                let value = &rest[..end_pos];
                return Some(decode_pdf_string(value));
            }
        }

        if let Some(rest) = trimmed.strip_prefix('<') {
            if let Some(end_pos) = rest.find('>') {
                let hex = &rest[..end_pos];
                return decode_hex_string(hex);
            }
        }
    }
    None
}

fn find_closing_paren(s: &str) -> Option<usize> {
    let mut depth = 1;
    let mut escaped = false;

    for (i, c) in s.chars().enumerate() {
        if escaped {
            escaped = false;
            continue;
        }

        match c {
            '\\' => escaped = true,
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            _ => {}
        }
    }
    None
}

fn decode_pdf_string(s: &str) -> String {
    let mut result = String::new();
    let mut chars = s.chars().peekable();

    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.next() {
                Some('n') => result.push('\n'),
                Some('r') => result.push('\r'),
                Some('t') => result.push('\t'),
                Some('b') => result.push('\x08'),
                Some('f') => result.push('\x0c'),
                Some('\n') => {}
                Some(d) if d.is_ascii_digit() => {
                    let mut octal = String::new();
                    octal.push(d);
                    for _ in 0..2 {
                        if let Some(&next) = chars.peek() {
                            if next.is_ascii_digit() {
                                if let Some(digit) = chars.next() {
                                    octal.push(digit);
                                }
                            } else {
                                break;
                            }
                        }
                    }
                    if let Ok(val) = u8::from_str_radix(&octal, 8) {
                        result.push(val as char);
                    }
                }
                Some(c) => result.push(c),
                None => break,
            }
        } else {
            result.push(c);
        }
    }

    result
}

fn decode_hex_string(hex: &str) -> Option<String> {
    let cleaned: String = hex.chars().filter(|c| !c.is_whitespace()).collect();

    (0..cleaned.len())
        .step_by(2)
        .map(|i| {
            let byte_str = &cleaned[i..i + 2.min(cleaned.len() - i)];
            u8::from_str_radix(byte_str, 16).ok()
        })
        .collect::<Option<Vec<u8>>>()
        .and_then(|bytes| {
            if bytes.len() >= 2 && bytes[0] == 0xFE && bytes[1] == 0xFF {
                let units: Vec<u16> = bytes[2..]
                    .chunks_exact(2)
                    .map(|chunk| u16::from_be_bytes([chunk[0], chunk[1]]))
                    .collect();
                Some(String::from_utf16_lossy(&units))
            } else if bytes.len() >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE {
                let units: Vec<u16> = bytes[2..]
                    .chunks_exact(2)
                    .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
                    .collect();
                Some(String::from_utf16_lossy(&units))
            } else {
                String::from_utf8(bytes.clone())
                    .ok()
                    .or_else(|| Some(String::from_utf8_lossy(&bytes).into_owned()))
            }
        })
}

#[tauri::command]
fn fetch_rss_feed(url: String) -> Result<String, String> {
    let response = shared_http_client()
        .get(&url)
        .timeout(std::time::Duration::from_secs(30))
        .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .header("Accept", "application/atom+xml;profile=opds-catalog, application/atom+xml, application/rss+xml, application/xml, text/xml, */*")
        .send()
        .map_err(|e| format!("Failed to fetch feed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!(
            "HTTP error: {} {}",
            response.status(),
            response.status().canonical_reason().unwrap_or("Unknown")
        ));
    }

    response
        .text()
        .map_err(|e| format!("Failed to read response: {}", e))
}

#[tauri::command]
fn fetch_url_content(url: String) -> Result<String, String> {
    let parsed_url =
        reqwest::Url::parse(&url).map_err(|e| format!("Invalid URL '{}': {}", url, e))?;
    let referer = {
        let mut origin = parsed_url.clone();
        origin.set_path("/");
        origin.set_query(None);
        origin.set_fragment(None);
        origin.to_string()
    };

    let user_agents = [
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.7; rv:134.0) Gecko/20100101 Firefox/134.0",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15",
    ];

    let mut last_error: Option<String> = None;
    for (attempt, user_agent) in user_agents.iter().enumerate() {
        if attempt > 0 {
            std::thread::sleep(std::time::Duration::from_millis(150));
        }

        let response = shared_http_client()
            .get(parsed_url.clone())
            .timeout(std::time::Duration::from_secs(8))
            .header("User-Agent", *user_agent)
            .header(
                "Accept",
                "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            )
            .header("Accept-Language", "en-US,en;q=0.9")
            .header("Referer", &referer)
            .header("Upgrade-Insecure-Requests", "1")
            .header("DNT", "1")
            .send();

        let response = match response {
            Ok(response) => response,
            Err(error) => {
                last_error = Some(format!("Failed to fetch URL content: {}", error));
                continue;
            }
        };

        if response.status().is_success() {
            return response
                .text()
                .map_err(|e| format!("Failed to read response: {}", e));
        }

        let status = response.status();
        let status_code = status.as_u16();

        if status_code == 429 || status_code == 403 {
            if status_code == 429 {
                let retry_after = response
                    .headers()
                    .get("Retry-After")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.parse::<u64>().ok())
                    .unwrap_or(3)
                    .clamp(2, 8);
                std::thread::sleep(std::time::Duration::from_secs(retry_after));
            }
            last_error = Some(format!(
                "HTTP error: {} {}",
                status,
                status.canonical_reason().unwrap_or(if status_code == 429 {
                    "Too Many Requests"
                } else {
                    "Forbidden"
                })
            ));
            continue;
        }

        return Err(format!(
            "HTTP error: {} {}",
            status,
            status.canonical_reason().unwrap_or("Unknown")
        ));
    }

    Err(last_error.unwrap_or_else(|| "Failed to fetch URL content".to_string()))
}

#[tauri::command]
fn fetch_binary_content(url: String) -> Result<Response, String> {
    let parsed_url =
        reqwest::Url::parse(&url).map_err(|e| format!("Invalid URL '{}': {}", url, e))?;
    let referer = {
        let mut origin = parsed_url.clone();
        origin.set_path("/");
        origin.set_query(None);
        origin.set_fragment(None);
        origin.to_string()
    };

    let response = shared_http_client()
        .get(parsed_url)
        .timeout(std::time::Duration::from_secs(90))
        .header(
            "User-Agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
             (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
        )
        .header("Accept", "application/pdf,application/octet-stream,*/*")
        .header("Accept-Language", "en-US,en;q=0.9")
        .header("Referer", &referer)
        .send()
        .map_err(|e| format!("Failed to fetch binary content: {}", e))?;

    if !response.status().is_success() {
        return Err(format!(
            "HTTP error: {} {}",
            response.status(),
            response.status().canonical_reason().unwrap_or("Unknown")
        ));
    }

    let bytes = response
        .bytes()
        .map_err(|e| format!("Failed to read binary response: {}", e))?;
    Ok(Response::new(bytes.to_vec()))
}

#[tauri::command]
fn pick_library_folder_mobile(app: tauri::AppHandle) -> Result<Option<String>, String> {
    #[cfg(target_os = "android")]
    {
        tauri_plugin_mobile_folder_scan::pick_folder(&app)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Err("Mobile folder selection is only available on Android.".to_string())
    }
}

#[tauri::command]
fn scan_library_folder_mobile(
    app: tauri::AppHandle,
    tree_uri: String,
) -> Result<Vec<String>, String> {
    #[cfg(target_os = "android")]
    {
        tauri_plugin_mobile_folder_scan::scan_folder(&app, &tree_uri)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, tree_uri);
        Err("Mobile folder scanning is only available on Android.".to_string())
    }
}

#[tauri::command]
fn scan_library_folder_desktop(folder_path: String) -> Result<Vec<String>, String> {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let _ = folder_path;
        Err("Desktop folder scanning is only available on desktop.".to_string())
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let path = Path::new(&folder_path);
        if !path.is_dir() {
            return Err(format!("Not a directory: {}", folder_path));
        }

        const SUPPORTED_EXTENSIONS: &[&str] = &[
            ".epub", ".mobi", ".azw", ".azw3", ".fb2", ".fbz", ".fb2.zip", ".cbz", ".cbr", ".pdf",
        ];

        let mut book_files: Vec<String> = Vec::new();

        for entry in walkdir::WalkDir::new(path)
            .follow_links(false)
            .into_iter()
            .filter_map(|e| e.ok())
        {
            if entry.file_type().is_file() {
                let entry_path = entry.path();
                let name_lower = entry_path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .map(|s| s.to_lowercase())
                    .unwrap_or_default();

                if SUPPORTED_EXTENSIONS
                    .iter()
                    .any(|ext| name_lower.ends_with(ext))
                {
                    book_files.push(entry_path.to_string_lossy().to_string());
                }
            }
        }

        book_files.sort();
        Ok(book_files)
    }
}

#[tauri::command]
async fn save_share_image_mobile(
    app: tauri::AppHandle,
    filename: String,
    base64_data: String,
) -> Result<String, String> {
    #[cfg(target_os = "android")]
    {
        tauri_plugin_mobile_folder_scan::save_image(&app, &filename, &base64_data)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, filename, base64_data);
        Err("Mobile image saving is only available on Android.".to_string())
    }
}

#[tauri::command]
async fn save_file_mobile(
    app: tauri::AppHandle,
    filename: String,
    base64_data: String,
) -> Result<String, String> {
    #[cfg(target_os = "android")]
    {
        tauri_plugin_mobile_folder_scan::save_file(&app, &filename, &base64_data)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, filename, base64_data);
        Err("Mobile file saving is only available on Android.".to_string())
    }
}

#[tauri::command]
async fn materialize_android_content_uri(
    app: tauri::AppHandle,
    uri: String,
    file_name: String,
) -> Result<String, String> {
    #[cfg(target_os = "android")]
    {
        tauri_plugin_mobile_folder_scan::materialize_content_uri(&app, &uri, &file_name)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, uri, file_name);
        Err("Content URI materialization is only available on Android.".to_string())
    }
}

#[cfg(target_os = "linux")]
fn apply_linux_webkit_workarounds() {
    if env::var("THEOREM_WEBKIT_WORKAROUNDS")
        .map(|value| value == "0")
        .unwrap_or(false)
    {
        return;
    }

    if env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    if env::var_os("WEBKIT_DISABLE_COMPOSITING_MODE").is_none() {
        env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
    }

    let existing_gdk_debug = env::var("GDK_DEBUG").unwrap_or_default();
    if existing_gdk_debug
        .split(',')
        .all(|flag| flag.trim() != "gl-no-fractional")
    {
        let merged = if existing_gdk_debug.trim().is_empty() {
            "gl-no-fractional".to_string()
        } else {
            format!("{},gl-no-fractional", existing_gdk_debug)
        };
        env::set_var("GDK_DEBUG", merged);
    }
}

#[tauri::command]
#[allow(unused_variables, unreachable_code)]
fn tts_speak(app: tauri::AppHandle, text: String, voice: String) -> Result<(), String> {
    #[cfg(target_os = "android")]
    return tauri_plugin_android_tts_audio::tts_speak(&app, text, voice);
    #[cfg(target_os = "linux")]
    return tts_linux::linux_tts_speak(&text);
    #[cfg(target_os = "macos")]
    {
        let mut c = std::process::Command::new("say");
        if !voice.is_empty() {
            c.arg("-v").arg(&voice);
        }
        c.arg(&text)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        c.spawn().map_err(|e| format!("say: {e}"))?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("powershell").args([
            "-NoProfile", "-Command",
            &format!(r#"Add-Type -AssemblyName System.Speech; $s=New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Speak('{}')"#, text.replace('"', "'")),
        ]).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null())
        .spawn().map_err(|e| format!("TTS: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
#[allow(unused_variables, unreachable_code)]
fn tts_stop(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "android")]
    return tauri_plugin_android_tts_audio::tts_stop(&app);
    #[cfg(target_os = "linux")]
    return tts_linux::linux_tts_stop();
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("killall")
            .arg("say")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .ok();
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("taskkill")
            .args(["/F", "/IM", "powershell.exe"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .ok();
    }
    Ok(())
}

#[tauri::command]
fn tts_pause(app: tauri::AppHandle) -> Result<(), String> {
    tts_stop(app)
}

#[tauri::command]
fn tts_resume(_app: tauri::AppHandle) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
#[allow(unused_variables)]
fn tts_get_engines(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    tauri_plugin_android_tts_audio::tts_get_engines(&app)
}

#[tauri::command]
#[allow(unused_variables)]
fn tts_set_engine(app: tauri::AppHandle, engine: String) -> Result<serde_json::Value, String> {
    tauri_plugin_android_tts_audio::tts_set_engine(&app, engine)
}

#[tauri::command]
#[allow(unused_variables)]
async fn tts_synthesize_to_file(
    app: tauri::AppHandle,
    text: String,
    voice: String,
    file_name: String,
) -> Result<serde_json::Value, String> {
    tauri_plugin_android_tts_audio::tts_synthesize_to_file(&app, text, voice, file_name)
}

#[tauri::command]
#[allow(unused_variables, unreachable_code)]
fn tts_get_voices(app: tauri::AppHandle) -> Result<Vec<serde_json::Value>, String> {
    #[cfg(target_os = "android")]
    return tauri_plugin_android_tts_audio::tts_get_voices(&app);
    let _ = app;
    Ok(Vec::new())
}

#[tauri::command]
#[allow(unused_variables)]
async fn open_book_in_new_window(
    app: tauri::AppHandle,
    book_id: String,
    title: String,
) -> Result<(), String> {
    open_reader_window(&app, &book_id, &title)
}

/// Open a reader window for a book (shared by `open_book_in_new_window` and
/// the CLI `theorem open <book-id>` bridge).
pub fn open_reader_window(app: &AppHandle, book_id: &str, title: &str) -> Result<(), String> {
    #[cfg(desktop)]
    {
        use tauri::Manager;
        use tauri::WebviewUrl;
        use tauri::WebviewWindowBuilder;

        let safe_id = book_id.replace(|c: char| !c.is_alphanumeric(), "_");
        let label = format!("reader_{}", safe_id);

        if let Some(existing) = app.get_webview_window(&label) {
            let _ = existing.show();
            let _ = existing.unminimize();
            let _ = existing.set_focus();
            return Ok(());
        }

        let url = WebviewUrl::App(format!("index.html?route=reader&bookId={}", book_id).into());
        let win = WebviewWindowBuilder::new(app, &label, url)
            .title(title)
            .inner_size(1024.0, 768.0)
            .min_inner_size(600.0, 400.0)
            .decorations(true)
            .build()
            .map_err(|e| format!("Failed to create new window: {e}"))?;

        let _ = win.set_focus();
        Ok(())
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, book_id, title);
        Err("Multi-window reading is only supported on desktop".to_string())
    }
}

// ── CLI symlink setup (Settings → Terminal CLI + `theorem setup-cli`) ────────

/// Tauri command backing the "Enable CLI" toggle. Creates (or refreshes) a
/// `theorem` symlink in `~/.local/bin` pointing at the running executable.
#[tauri::command]
fn setup_linux_cli_symlink() -> Result<String, String> {
    setup_linux_cli_symlink_inner()
}

pub fn setup_linux_cli_symlink_inner() -> Result<String, String> {
    #[cfg(target_os = "linux")]
    {
        let exe = cli_symlink_target_exe()?;
        let link = cli_symlink_path()?;

        match std::fs::symlink_metadata(&link) {
            Ok(meta) if meta.file_type().is_symlink() => {
                let _ = std::fs::remove_file(&link);
            }
            Ok(_) => {
                let link_target = std::fs::canonicalize(&link).ok();
                let exe_target = std::fs::canonicalize(&exe).ok();
                if link_target.is_some() && link_target == exe_target {
                    return Ok(link.display().to_string());
                }
                return Err(format!(
                    "Refusing to overwrite existing file {} (not a Theorem symlink)",
                    link.display()
                ));
            }
            Err(_) => {}
        }

        if let Some(parent) = link.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create {}: {e}", parent.display()))?;
        }
        std::os::unix::fs::symlink(&exe, &link).map_err(|e| {
            format!(
                "Failed to symlink {} -> {}: {e}",
                link.display(),
                exe.display()
            )
        })?;
        Ok(link.display().to_string())
    }

    #[cfg(not(target_os = "linux"))]
    {
        Err("CLI symlink setup is only supported on Linux".to_string())
    }
}

/// AppImage note: `current_exe` inside an AppImage points into the temporary
/// squashfs mount, which disappears on reboot — symlink the AppImage file
/// itself (`$APPIMAGE`) when available so the link survives.
fn cli_symlink_target_exe() -> Result<PathBuf, String> {
    if let Ok(appimage) = std::env::var("APPIMAGE") {
        if !appimage.is_empty() {
            return Ok(PathBuf::from(appimage));
        }
    }
    std::env::current_exe().map_err(|e| format!("Failed to resolve executable path: {e}"))
}

/// Tauri command: current CLI symlink status for the Settings UI.
#[tauri::command]
fn cli_setup_status() -> Result<CliSetupStatus, String> {
    cli_setup_status_inner()
}

#[derive(serde::Serialize)]
pub struct CliSetupStatus {
    /// A valid `theorem` symlink exists in ~/.local/bin
    installed: bool,
    link_path: String,
    is_app_image: bool,
}

fn cli_setup_status_inner() -> Result<CliSetupStatus, String> {
    #[cfg(target_os = "linux")]
    {
        let link = cli_symlink_path()?;
        let installed = std::fs::symlink_metadata(&link)
            .map(|meta| meta.file_type().is_symlink())
            .unwrap_or(false);
        Ok(CliSetupStatus {
            installed,
            link_path: link.display().to_string(),
            is_app_image: std::env::var("APPIMAGE")
                .map(|v| !v.is_empty())
                .unwrap_or(false),
        })
    }

    #[cfg(not(target_os = "linux"))]
    {
        Err("CLI symlink setup is only supported on Linux".to_string())
    }
}

/// Tauri command: remove the ~/.local/bin/theorem symlink (toggle OFF).
#[tauri::command]
fn remove_linux_cli_symlink() -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let link = cli_symlink_path()?;
        match std::fs::symlink_metadata(&link) {
            Ok(meta) if meta.file_type().is_symlink() => {
                std::fs::remove_file(&link)
                    .map_err(|e| format!("Failed to remove {}: {e}", link.display()))?;
                Ok(())
            }
            Ok(_) => Err(format!(
                "Refusing to remove {}: not a Theorem symlink",
                link.display()
            )),
            Err(_) => Ok(()),
        }
    }

    #[cfg(not(target_os = "linux"))]
    {
        Err("CLI symlink setup is only supported on Linux".to_string())
    }
}

fn cli_symlink_path() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME environment variable not set")?;
    Ok(PathBuf::from(home)
        .join(".local")
        .join("bin")
        .join("theorem"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "linux")]
    apply_linux_webkit_workarounds();

    let _ = rustls::crypto::ring::default_provider().install_default();

    let builder = tauri::Builder::default()
        .manage(PendingOpenFiles::default())
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    let _ = window.hide();
                    api.prevent_close();
                }
            }
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([tauri_plugin_log::Target::new(
                    tauri_plugin_log::TargetKind::Stdout,
                )])
                .build(),
        )
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_mobile_folder_scan::init())
        .plugin(tauri_plugin_android_tts_audio::init());

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
        if let Some(book_id) = argv
            .iter()
            .find_map(|a| a.strip_prefix("--open-book=").map(str::to_string))
        {
            let _ = open_reader_window(app, &book_id, "Theorem Reader");
            return;
        }
        let paths = collect_open_paths(argv, Some(&cwd));
        enqueue_open_paths(app, paths, true);

        let window = app
            .get_webview_window("main")
            .or_else(|| app.webview_windows().into_values().next());
        if let Some(window) = window {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
    }));

    #[cfg(desktop)]
    let builder = builder
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::all()
                        & !tauri_plugin_window_state::StateFlags::VISIBLE,
                )
                .build(),
        )
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build());

    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_barcode_scanner::init());

    builder
        .setup(|app| {
            let app_data_dir = app
                .path()
                .app_data_dir()
                .or_else(|_| app.path().app_cache_dir())
                .unwrap_or_else(|_| std::path::PathBuf::from("."));

            eprintln!("[startup] Running database schema migrations...");
            if let Err(e) = database::run_schema_migrations(app.handle()) {
                eprintln!("[database] Schema migration failed: {e}");
            }

            let device_name = std::env::var("HOSTNAME")
                .or_else(|_| std::env::var("COMPUTERNAME"))
                .unwrap_or_else(|_| "Theorem Device".to_string());

            eprintln!("[startup] Initializing device sync for: {}", device_name);
            match sync_commands::init_sync(app_data_dir, device_name, app.handle().clone()) {
                Ok(sync_state) => {
                    app.manage(sync_state);
                }
                Err(e) => {
                    eprintln!("[theorem] Warning: Failed to initialize sync: {}", e);
                }
            }

            let startup_args: Vec<String> = std::env::args().skip(1).collect();
            if let Some(book_id) = startup_args
                .iter()
                .find_map(|a| a.strip_prefix("--open-book=").map(str::to_string))
            {
                // CLI bridge: `theorem open <book-id>` re-execs with this marker.
                let _ = open_reader_window(app.handle(), &book_id, "Theorem Reader");
            } else {
                let open_paths = collect_open_paths(startup_args, None);
                enqueue_open_paths(app.handle(), open_paths, false);
            }

            #[cfg(desktop)]
            {
                let tray_result: Result<(), Box<dyn std::error::Error>> = (|| {
                    let show = MenuItemBuilder::with_id("show", "Show Theorem").build(app)?;
                    let sync_now = MenuItemBuilder::with_id("sync_now", "Sync Now").build(app)?;
                    let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;

                    let menu = MenuBuilder::new(app)
                        .item(&show)
                        .item(&sync_now)
                        .separator()
                        .item(&quit)
                        .build()?;

                    let mut tray_builder = TrayIconBuilder::new()
                        .menu(&menu)
                        .tooltip("Theorem")
                        .on_menu_event(|app, event| match event.id().as_ref() {
                            "show" => {
                                let window = app
                                    .get_webview_window("main")
                                    .or_else(|| app.webview_windows().into_values().next());
                                if let Some(window) = window {
                                    let _ = window.show();
                                    let _ = window.unminimize();
                                    let _ = window.set_focus();
                                }
                            }
                            "sync_now" => {
                                let _ = app.emit("tray-sync-now", ());
                            }
                            "quit" => {
                                app.exit(0);
                            }
                            _ => {}
                        })
                        .on_tray_icon_event(|tray, event| {
                            if let TrayIconEvent::Click { .. } = event {
                                let app = tray.app_handle();
                                let window = app
                                    .get_webview_window("main")
                                    .or_else(|| app.webview_windows().into_values().next());
                                if let Some(window) = window {
                                    let _ = window.show();
                                    let _ = window.unminimize();
                                    let _ = window.set_focus();
                                }
                            }
                        });

                    if let Some(icon) = app.default_window_icon() {
                        tray_builder = tray_builder.icon(icon.clone());
                    }

                    tray_builder.build(app)?;
                    Ok(())
                })();

                if let Err(e) = tray_result {
                    eprintln!(
                        "[tray] Warning: System tray not initialized (continuing anyway): {e}"
                    );
                }
            }

            eprintln!("[startup] Theorem ready.");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            setup_linux_cli_symlink,
            tts_get_engines,
            tts_set_engine,
            tts_synthesize_to_file,
            cli_setup_status,
            remove_linux_cli_symlink,
            tts_speak,
            tts_stop,
            tts_pause,
            tts_resume,
            tts_get_voices,
            epub_parser::prefetch_zip_metadata,
            epub_rewriter::rewrite_epub_metadata,
            read_file,
            read_cbr_as_cbz,
            read_pdf_file,
            read_pdf_file_size,
            read_pdf_range,
            get_pdf_metadata,
            take_pending_open_files,
            fetch_rss_feed,
            fetch_url_content,
            fetch_binary_content,
            pick_library_folder_mobile,
            scan_library_folder_mobile,
            scan_library_folder_desktop,
            save_share_image_mobile,
            save_file_mobile,
            materialize_android_content_uri,
            database::sqlite_save_book_data,
            database::sqlite_register_materialized_book,
            database::sqlite_get_book_data,
            database::sqlite_delete_book_data,
            database::sqlite_get_materialized_book_path,
            database::sqlite_save_cover_image,
            database::sqlite_get_cover_image,
            database::sqlite_delete_cover_image,
            database::sqlite_get_storage_stats,
            database::sqlite_cleanup_orphaned_storage,
            database::sqlite_clear_all_storage,
            database::sqlite_get_kv,
            database::sqlite_check_goal_reminder,
            database::sqlite_batch_get_kv,
            database::sqlite_set_kv,
            database::sqlite_delete_kv,
            database::sqlite_count_kv_by_prefix,
            database::sqlite_delete_kv_by_prefix,
            database::sqlite_set_blob,
            database::sqlite_get_blob,
            database::sqlite_delete_blob,
            database::sqlite_delete_blobs_by_prefix,
            database::sqlite_get_blob_stats,
            database::sqlite_index_book_fts,
            database::sqlite_index_books_fts_batch,
            database::sqlite_search_books,
            database::sqlite_save_book_metadata,
            database::sqlite_get_book_metadata,
            database::sqlite_save_book_annotations,
            database::sqlite_get_book_annotations,
            database::sqlite_shrink_memory,
            sync_commands::iroh_start,
            sync_commands::iroh_stop,
            sync_commands::iroh_pair,
            sync_commands::generate_pairing_qr,
            sync_commands::submit_pairing_code,
            sync_commands::get_device_identity,
            sync_commands::set_device_fingerprint,
            sync_commands::get_paired_devices,
            sync_commands::unpair_device,
            sync_commands::docs_create_sync_doc,
            sync_commands::docs_import_sync_doc,
            sync_commands::docs_set_entry,
            sync_commands::docs_get_all_entries,
            sync_commands::docs_sync_now,
            file_transfer::request_book_file,
            file_transfer::download_book_file,
            sync_commands::clear_sync_databases,
            set_android_fingerprint,
            hide_to_tray,
            download_and_extract_stardict,
            stardict::stardict_lookup,
            stardict::stardict_delete,
            fetch_online_definition,
            batch_ingest::ingest_books_native,
            book_search::search_book_content,
            mobi_parser::decompress_palmdoc_record,
            mobi_parser::get_mobi_metadata,
            article_extractor::fetch_and_extract_article_native,
            opds_parser::fetch_and_parse_opds_native,
            open_book_in_new_window,
            mdict::mdx_lookup,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[tauri::command]
async fn set_android_fingerprint(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        match tauri_plugin_mobile_folder_scan::get_android_id(&app) {
            Ok(android_id) if !android_id.is_empty() => {
                theorem_sync_core::sync_crypto::set_fingerprint_from_frontend(&android_id);
                eprintln!("[sync] Android fingerprint set from ANDROID_ID");
            }
            _ => {
                theorem_sync_core::sync_crypto::set_fingerprint_from_frontend("android:unknown");
            }
        }
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = &app;
    }
    Ok(())
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "C" fn Java_work_fundamentals_theorem_MainActivity_initNdkContext(
    env: jni::JNIEnv,
    _class: jni::objects::JClass,
    context: jni::objects::JObject,
) {
    let jvm = match env.get_java_vm() {
        Ok(vm) => vm,
        Err(e) => {
            eprintln!("[ndk-context] Failed to get JavaVM: {e}");
            return;
        }
    };
    let jvm_ptr = jvm.get_java_vm_pointer() as *mut std::ffi::c_void;

    let global_ref = match env.new_global_ref(context) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("[ndk-context] Failed to create global ref: {e}");
            return;
        }
    };
    let raw_ptr = global_ref.as_raw() as *mut std::ffi::c_void;
    std::mem::forget(global_ref);

    unsafe {
        ndk_context::initialize_android_context(jvm_ptr, raw_ptr);
    }
    eprintln!("[ndk-context] Initialized via applicationContext");
}

#[tauri::command]
fn hide_to_tray(app: tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .or_else(|| app.webview_windows().into_values().next());
    if let Some(window) = window {
        window
            .hide()
            .map_err(|e| format!("Failed to hide window: {e}"))
    } else {
        Ok(())
    }
}

#[tauri::command]
async fn download_and_extract_stardict(
    app: AppHandle,
    url: String,
) -> Result<serde_json::Value, String> {
    use futures::StreamExt;

    let client = reqwest::Client::builder()
        .cookie_store(true)
        .timeout(std::time::Duration::from_secs(300))
        .redirect(reqwest::redirect::Policy::limited(10))
        .user_agent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36")
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {e}"))?;

    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Download failed: {e}"))?;

    let status = response.status();
    if !status.is_success() {
        return Err(format!("Server returned HTTP {}", status.as_u16()));
    }

    let total_size = response.content_length().unwrap_or(0);
    let mut downloaded: u64 = 0;
    let mut body = Vec::new();

    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Stream error: {e}"))?;
        downloaded += chunk.len() as u64;
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
    let _ = std::fs::create_dir_all(&dict_dir);

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

    let size_bytes =
        (ifo.len() + idx.len() + dict.len() + syn.as_ref().map_or(0, |s| s.len())) as u64;

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

    let _ = std::fs::write(dict_dir.join("dict.ifo"), &ifo);
    let _ = std::fs::write(dict_dir.join("dict.idx"), &idx);
    let _ = std::fs::write(dict_dir.join("dict.dict.dz"), &dict);
    if let Some(ref syn_data) = syn {
        let _ = std::fs::write(dict_dir.join("dict.syn"), syn_data);
    }

    database::sqlite_set_blob(app.clone(), format!("theorem-stardict:{id}:ifo"), ifo)?;
    database::sqlite_set_blob(app.clone(), format!("theorem-stardict:{id}:idx"), idx)?;
    database::sqlite_set_blob(app.clone(), format!("theorem-stardict:{id}:dict"), dict)?;
    if let Some(syn_data) = syn {
        database::sqlite_set_blob(app, format!("theorem-stardict:{id}:syn"), syn_data)?;
    }

    Ok(serde_json::json!({
        "id": id,
        "name": name,
        "language": lang,
        "sizeBytes": size_bytes,
    }))
}

type StardictParts = (Vec<u8>, Vec<u8>, Vec<u8>, Option<Vec<u8>>);

fn extract_stardict_parts_from_zip(data: &[u8]) -> Result<StardictParts, String> {
    let reader = std::io::Cursor::new(data);
    let mut archive =
        zip::ZipArchive::new(reader).map_err(|e| format!("ZIP parsing failed: {e}"))?;

    let mut ifo_bytes: Option<Vec<u8>> = None;
    let mut idx_bytes: Option<Vec<u8>> = None;
    let mut dict_bytes: Option<Vec<u8>> = None;
    let mut syn_bytes: Option<Vec<u8>> = None;

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("ZIP entry error: {e}"))?;
        let name = entry.name().to_owned();
        let mut data = Vec::new();
        std::io::Read::read_to_end(&mut entry, &mut data)
            .map_err(|e| format!("Failed to read ZIP entry '{name}': {e}"))?;

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
        let mut buf = Vec::new();
        std::io::Read::read_to_end(&mut decoder, &mut buf)
            .map_err(|e| format!("Bzip2 decompression failed: {e}"))?;
        buf
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

        let mut data = Vec::new();
        std::io::Read::read_to_end(&mut entry, &mut data)
            .map_err(|e| format!("Failed to read tar entry '{name}': {e}"))?;

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
async fn fetch_online_definition(term: String) -> Result<serde_json::Value, String> {
    let clean = term.trim();
    if clean.is_empty() {
        return Err("Term is empty".to_string());
    }

    let encoded = percent_encoding::utf8_percent_encode(clean, percent_encoding::NON_ALPHANUMERIC)
        .to_string();
    let url = format!("https://api.dictionaryapi.dev/api/v2/entries/en/{encoded}");

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(4))
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))?;

    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Network request failed: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status().as_u16()));
    }

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("JSON parse error: {e}"))?;

    Ok(json)
}
