use std::path::{Path, PathBuf};

use iroh::endpoint;
use iroh::protocol::ProtocolHandler;
use tauri::Emitter;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};

const FILE_TRANSFER_ALPN: &[u8] = b"theorem-file/v1";

pub const ALPN_BYTES: &[u8] = FILE_TRANSFER_ALPN;

const CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);
const FILE_TRANSFER_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

#[derive(serde::Serialize, Clone)]
struct DownloadProgress {
    book_id: String,
    progress: f64,
    downloaded: usize,
    total: usize,
}

async fn connect_and_request(
    app: &tauri::AppHandle,
    peer_device_id: &str,
    book_id: &str,
) -> Result<(tokio::io::BufReader<iroh::endpoint::RecvStream>, usize), String> {
    use crate::sync_commands::{get_or_init_iroh, get_sync_state};

    let ep = get_or_init_iroh(app).await?;
    let sync_state = get_sync_state(app)?;

    let (peer_pk, relay_url, last_ip, last_port, canonical_device_id) = {
        let devices = sync_state.transport_state.paired_devices.lock().await;
        let peer = devices
            .get(peer_device_id)
            .or_else(|| {
                devices
                    .values()
                    .find(|d| d.device_id == peer_device_id || d.iroh_node_id == peer_device_id)
            })
            .or_else(|| {
                if devices.len() == 1 {
                    devices.values().next()
                } else {
                    None
                }
            })
            .ok_or_else(|| format!("peer '{peer_device_id}' not found among paired devices"))?;
        let pk: iroh::PublicKey = peer
            .iroh_node_id
            .parse()
            .map_err(|e| format!("parse peer key: {e}"))?;
        (
            pk,
            peer.peer_relay_url.clone(),
            peer.last_ip.clone(),
            peer.last_port,
            peer.device_id.clone(),
        )
    };

    let mut peer_addr = iroh::EndpointAddr::new(peer_pk);

    if !last_ip.is_empty() && last_port > 0 {
        if let Ok(ip) = last_ip.parse::<std::net::IpAddr>() {
            peer_addr = peer_addr.with_ip_addr(std::net::SocketAddr::new(ip, last_port));
        }
    }

    if !relay_url.is_empty() {
        if let Ok(url) = relay_url.parse::<iroh::RelayUrl>() {
            peer_addr = peer_addr.with_relay_url(url);
        }
    }

    let conn = tokio::time::timeout(
        CONNECT_TIMEOUT,
        ep.endpoint.connect(peer_addr, FILE_TRANSFER_ALPN),
    )
    .await
    .map_err(|_| format!("connect to peer '{canonical_device_id}' timed out after 15s"))?
    .map_err(|e| format!("connect to peer '{canonical_device_id}': {e}"))?;

    // Refresh last known IP/port from active connection paths
    let (connected_ip, connected_port) = {
        let paths = conn.paths();
        let mut direct = None;
        for p in paths.iter() {
            if let iroh::TransportAddr::Ip(addr) = p.remote_addr() {
                direct = Some((addr.ip().to_string(), addr.port()));
                break;
            }
        }
        direct.unwrap_or_default()
    };

    if !connected_ip.is_empty() && connected_port > 0 {
        let mut devices = sync_state.transport_state.paired_devices.lock().await;
        if let Some(peer_entry) = devices.get_mut(&canonical_device_id) {
            peer_entry.last_ip = connected_ip;
            peer_entry.last_port = connected_port;
            let _ = crate::iroh_sync::save_paired_devices_to_disk(
                &sync_state.transport_state.app_data_dir,
                &devices,
            );
        }
    }

    let (mut send, recv) = tokio::time::timeout(CONNECT_TIMEOUT, conn.open_bi())
        .await
        .map_err(|_| "open bi timed out".to_string())?
        .map_err(|e| format!("open bi: {e}"))?;

    let clean_book_id = book_id.trim();
    let request = format!("{}\n", clean_book_id);
    send.write_all(request.as_bytes())
        .await
        .map_err(|e| format!("send: {e}"))?;
    send.finish().map_err(|e| format!("finish: {e}"))?;
    drop(send);

    let mut reader = BufReader::new(recv);
    let mut status_line = String::new();
    tokio::time::timeout(FILE_TRANSFER_TIMEOUT, reader.read_line(&mut status_line))
        .await
        .map_err(|_| "read status timed out".to_string())?
        .map_err(|e| format!("read status: {e}"))?;
    let status_line = status_line.trim();

    if let Some(size_str) = status_line.strip_prefix("OK ") {
        let size: usize = size_str
            .parse()
            .map_err(|_| format!("invalid size: {size_str}"))?;
        Ok((reader, size))
    } else if let Some(err_msg) = status_line.strip_prefix("ERR ") {
        Err(format!("peer error: {err_msg}"))
    } else {
        Err(format!("unexpected response: {status_line}"))
    }
}

#[derive(Clone)]
pub struct FileTransferHandler {
    pub data_dir: PathBuf,
}

impl std::fmt::Debug for FileTransferHandler {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FileTransferHandler").finish()
    }
}

enum BookSource {
    File(tokio::fs::File, u64),
    Memory(Vec<u8>),
}

impl FileTransferHandler {
    fn open_read_db(data_dir: &Path) -> Result<rusqlite::Connection, String> {
        let db_path = data_dir.join("theorem.db");
        let conn = rusqlite::Connection::open_with_flags(
            &db_path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|e| format!("open db: {e}"))?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA foreign_keys = ON;
             PRAGMA busy_timeout = 5000;",
        )
        .map_err(|e| format!("pragma: {e}"))?;
        Ok(conn)
    }

    fn normalize_candidate_path(p_str: &str, data_dir: &Path) -> Vec<PathBuf> {
        let mut results = Vec::new();
        let trimmed = p_str.trim();
        if trimmed.is_empty() || trimmed.starts_with("idb://") {
            return results;
        }

        // Handle sqlite://<id>
        if let Some(sqlite_id) = trimmed.strip_prefix("sqlite://") {
            results.push(
                data_dir
                    .join("book-cache")
                    .join(format!("{sqlite_id}.book")),
            );
            results.push(data_dir.join("book-cache").join(sqlite_id));
            return results;
        }

        let mut clean_str = trimmed;
        if let Some(stripped) = clean_str.strip_prefix("file://") {
            clean_str = stripped;
        }

        let decoded = percent_encoding::percent_decode_str(clean_str)
            .decode_utf8_lossy()
            .to_string();

        let variants = if decoded != clean_str {
            vec![decoded, clean_str.to_string()]
        } else {
            vec![clean_str.to_string()]
        };

        for s in variants {
            // Windows file:///C:/path leaves /C:/path
            let s_trimmed = if s.len() >= 3 && s.starts_with('/') && s.chars().nth(2) == Some(':') {
                &s[1..]
            } else {
                &s
            };

            let pb = PathBuf::from(s_trimmed);
            if pb.is_absolute() {
                results.push(pb);
            } else {
                results.push(data_dir.join(&pb));
                results.push(pb);
            }
        }

        results
    }

    fn find_in_db(data_dir: &Path, book_id: &str) -> (Option<Vec<u8>>, Vec<PathBuf>) {
        let mut data = None;
        let mut paths = Vec::new();
        let conn = match Self::open_read_db(data_dir) {
            Ok(c) => c,
            Err(_) => return (None, paths),
        };

        // 1. Check books.data BLOB
        if let Ok(mut stmt) =
            conn.prepare("SELECT data FROM books WHERE id = ?1 AND length(data) > 0")
        {
            if let Ok(blob) =
                stmt.query_row(rusqlite::params![book_id], |row| row.get::<_, Vec<u8>>(0))
            {
                if !blob.is_empty() {
                    data = Some(blob);
                }
            }
        }

        // 2. Check book_metadata table
        if let Ok(mut stmt) =
            conn.prepare("SELECT metadata_json FROM book_metadata WHERE book_id = ?1")
        {
            if let Ok(meta_str) =
                stmt.query_row(rusqlite::params![book_id], |row| row.get::<_, String>(0))
            {
                if let Ok(meta_val) = serde_json::from_str::<serde_json::Value>(&meta_str) {
                    for key in &["filePath", "file_path", "storagePath", "storage_path"] {
                        if let Some(p_str) = meta_val.get(*key).and_then(|v| v.as_str()) {
                            paths.extend(Self::normalize_candidate_path(p_str, data_dir));
                        }
                    }
                }
            }
        }

        // 3. Check kv_store table for library state (check both zustand: and persist: prefixes)
        if let Ok(mut stmt) = conn.prepare(
            "SELECT value FROM kv_store WHERE key IN ('zustand:theorem-library', 'persist:theorem-library') OR key LIKE '%theorem-library'"
        ) {
            let rows = stmt.query_map([], |row| row.get::<_, String>(0));
            if let Ok(rows) = rows {
                for row in rows.flatten() {
                    if let Ok(lib_val) = serde_json::from_str::<serde_json::Value>(&row) {
                        let candidate_arrays: Vec<&Vec<serde_json::Value>> = vec![
                            lib_val.pointer("/state/books").and_then(|b| b.as_array()),
                            lib_val.get("books").and_then(|b| b.as_array()),
                            lib_val.pointer("/state/recentBooksCache").and_then(|b| b.as_array()),
                            lib_val.get("recentBooksCache").and_then(|b| b.as_array()),
                        ]
                        .into_iter()
                        .flatten()
                        .collect();

                        for arr in candidate_arrays {
                            for b in arr {
                                let id_match = b.get("id").and_then(|v| v.as_str()) == Some(book_id);
                                let content_match = b.get("contentHash").and_then(|v| v.as_str()) == Some(book_id);
                                let blob_match = b.get("blobHash").and_then(|v| v.as_str()) == Some(book_id);

                                if id_match || content_match || blob_match {
                                    for key in &["filePath", "file_path", "storagePath", "storage_path"] {
                                        if let Some(p_str) = b.get(*key).and_then(|v| v.as_str()) {
                                            paths.extend(Self::normalize_candidate_path(p_str, data_dir));
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        (data, paths)
    }

    async fn locate_book(data_dir: &Path, book_id: &str) -> Result<BookSource, String> {
        let clean_id = book_id.trim();

        // 1. Direct check in book-cache/{book_id}.book
        let cache_file = data_dir.join("book-cache").join(format!("{clean_id}.book"));
        if let Ok(metadata) = tokio::fs::metadata(&cache_file).await {
            if metadata.is_file() && metadata.len() > 0 {
                let file = tokio::fs::File::open(&cache_file)
                    .await
                    .map_err(|e| format!("open cache file: {e}"))?;
                return Ok(BookSource::File(file, metadata.len()));
            }
        }

        // 2. Direct check in book-cache/{book_id}
        let cache_file_raw = data_dir.join("book-cache").join(clean_id);
        if let Ok(metadata) = tokio::fs::metadata(&cache_file_raw).await {
            if metadata.is_file() && metadata.len() > 0 {
                let file = tokio::fs::File::open(&cache_file_raw)
                    .await
                    .map_err(|e| format!("open cache raw file: {e}"))?;
                return Ok(BookSource::File(file, metadata.len()));
            }
        }

        // 3. Check for any file in book-cache starting with book_id (e.g. {clean_id}.pdf, {clean_id}.epub)
        let cache_dir = data_dir.join("book-cache");
        if let Ok(mut entries) = tokio::fs::read_dir(&cache_dir).await {
            while let Ok(Some(entry)) = entries.next_entry().await {
                let file_name = entry.file_name();
                let name_str = file_name.to_string_lossy();
                if name_str.starts_with(clean_id) {
                    if let Ok(meta) = entry.metadata().await {
                        if meta.is_file() && meta.len() > 0 {
                            if let Ok(file) = tokio::fs::File::open(entry.path()).await {
                                return Ok(BookSource::File(file, meta.len()));
                            }
                        }
                    }
                }
            }
        }

        // 4. Query SQLite via spawn_blocking to locate data or paths
        let dir_clone = data_dir.to_path_buf();
        let id_clone = clean_id.to_string();
        let (db_data, candidate_paths) =
            tokio::task::spawn_blocking(move || Self::find_in_db(&dir_clone, &id_clone))
                .await
                .map_err(|e| format!("spawn_blocking: {e}"))?;

        if let Some(data) = db_data {
            if !data.is_empty() {
                return Ok(BookSource::Memory(data));
            }
        }

        for p in candidate_paths {
            if let Ok(metadata) = tokio::fs::metadata(&p).await {
                if metadata.is_file() && metadata.len() > 0 {
                    let file = tokio::fs::File::open(&p)
                        .await
                        .map_err(|e| format!("open book file '{p:?}': {e}"))?;
                    return Ok(BookSource::File(file, metadata.len()));
                }
            }
        }

        Err(format!(
            "book '{clean_id}' not found in book-cache, sqlite blob, or referenced file paths"
        ))
    }
}

impl ProtocolHandler for FileTransferHandler {
    async fn accept(&self, conn: endpoint::Connection) -> Result<(), iroh::protocol::AcceptError> {
        loop {
            let (mut send, mut recv) = match conn.accept_bi().await {
                Ok(s) => s,
                Err(_) => break,
            };

            let mut reader = BufReader::new(&mut recv);
            let mut line = String::new();
            let request = match reader.read_line(&mut line).await {
                Ok(0) | Err(_) => break,
                Ok(_) => line.trim().to_string(),
            };

            eprintln!("[file-transfer] Incoming request for book '{request}'");
            let result = Self::locate_book(&self.data_dir, &request).await;

            match result {
                Ok(BookSource::File(mut file, len)) => {
                    eprintln!("[file-transfer] Serving book '{request}' from file ({len} bytes)");
                    let header = format!("OK {}\n", len);
                    let _ = tokio::io::AsyncWriteExt::write_all(&mut send, header.as_bytes()).await;
                    let _ = tokio::io::copy(&mut file, &mut send).await;
                    let _ = send.finish();
                }
                Ok(BookSource::Memory(data)) => {
                    eprintln!(
                        "[file-transfer] Serving book '{request}' from memory ({} bytes)",
                        data.len()
                    );
                    let header = format!("OK {}\n", data.len());
                    let _ = tokio::io::AsyncWriteExt::write_all(&mut send, header.as_bytes()).await;
                    let _ = tokio::io::AsyncWriteExt::write_all(&mut send, &data).await;
                    let _ = send.finish();
                }
                Err(e) => {
                    eprintln!("[file-transfer] Failed to locate book '{request}': {e}");
                    let msg = format!("ERR {}\n", e);
                    let _ = tokio::io::AsyncWriteExt::write_all(&mut send, msg.as_bytes()).await;
                    let _ = send.finish();
                }
            }
        }
        Ok(())
    }
}

#[tauri::command]
pub async fn request_book_file(
    app: tauri::AppHandle,
    peer_device_id: String,
    book_id: String,
) -> Result<Vec<u8>, String> {
    let (mut reader, size) = connect_and_request(&app, &peer_device_id, &book_id).await?;
    let mut buf = vec![0u8; size];
    tokio::time::timeout(FILE_TRANSFER_TIMEOUT, reader.read_exact(&mut buf))
        .await
        .map_err(|_| "read data timed out".to_string())?
        .map_err(|e| format!("read data: {e}"))?;
    Ok(buf)
}

#[tauri::command]
pub async fn download_book_file(
    app: tauri::AppHandle,
    peer_device_id: String,
    book_id: String,
    dest_path: String,
) -> Result<(), String> {
    let (mut reader, size) = connect_and_request(&app, &peer_device_id, &book_id).await?;
    let dest = PathBuf::from(&dest_path);
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("create dir: {e}"))?;
    }

    let tmp_dest = dest.with_extension("download.tmp");
    let mut file = tokio::fs::File::create(&tmp_dest)
        .await
        .map_err(|e| format!("create tmp file: {e}"))?;

    let total = size;
    let mut remaining = total;
    let mut downloaded: usize = 0;
    let mut buf = vec![0u8; 1_048_576];
    let book_id_for_emit = book_id.clone();
    let mut last_emitted_pct = -1i32;

    if total > 0 {
        let _ = app.emit(
            "download-progress",
            DownloadProgress {
                book_id: book_id_for_emit.clone(),
                progress: 0.0,
                downloaded: 0,
                total,
            },
        );
    }

    while remaining > 0 {
        let to_read = remaining.min(buf.len());
        let read_res = tokio::time::timeout(
            FILE_TRANSFER_TIMEOUT,
            reader.read_exact(&mut buf[..to_read]),
        )
        .await;

        let n = match read_res {
            Ok(Ok(n)) => n,
            Ok(Err(e)) => {
                let _ = tokio::fs::remove_file(&tmp_dest).await;
                return Err(format!("read chunk: {e}"));
            }
            Err(_) => {
                let _ = tokio::fs::remove_file(&tmp_dest).await;
                return Err("read chunk timed out".to_string());
            }
        };

        if let Err(e) = tokio::io::AsyncWriteExt::write_all(&mut file, &buf[..n]).await {
            let _ = tokio::fs::remove_file(&tmp_dest).await;
            return Err(format!("write chunk: {e}"));
        }

        downloaded += n;
        remaining -= n;
        if total > 0 {
            let pct = ((downloaded as f64 / total as f64) * 100.0) as i32;
            if pct != last_emitted_pct {
                last_emitted_pct = pct;
                let _ = app.emit(
                    "download-progress",
                    DownloadProgress {
                        book_id: book_id_for_emit.clone(),
                        progress: (downloaded as f64 / total as f64) * 100.0,
                        downloaded,
                        total,
                    },
                );
            }
        }
    }

    tokio::io::AsyncWriteExt::flush(&mut file)
        .await
        .map_err(|e| format!("flush file: {e}"))?;
    drop(file);

    tokio::fs::rename(&tmp_dest, &dest)
        .await
        .map_err(|e| format!("rename to final dest: {e}"))?;

    Ok(())
}
