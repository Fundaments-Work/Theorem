use std::path::{Path, PathBuf};

use iroh::endpoint;
use iroh::protocol::ProtocolHandler;
use tauri::Emitter;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};

const FILE_TRANSFER_ALPN: &[u8] = b"theorem-file/v1";

pub const ALPN_BYTES: &[u8] = FILE_TRANSFER_ALPN;

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

    let (peer_pk, relay_url) = {
        let devices = sync_state.transport_state.paired_devices.lock().await;
        let peer = devices
            .get(peer_device_id)
            .ok_or("peer not found".to_string())?;
        let pk: iroh::PublicKey = peer
            .iroh_node_id
            .parse()
            .map_err(|e| format!("parse peer key: {e}"))?;
        (pk, peer.peer_relay_url.clone())
    };

    let peer_addr = iroh::EndpointAddr::new(peer_pk);

    let peer_addr = if !relay_url.is_empty() {
        if let Ok(url) = relay_url.parse::<iroh::RelayUrl>() {
            peer_addr.with_relay_url(url)
        } else {
            peer_addr
        }
    } else {
        peer_addr
    };

    let conn = tokio::time::timeout(
        FILE_TRANSFER_TIMEOUT,
        ep.endpoint.connect(peer_addr, FILE_TRANSFER_ALPN),
    )
    .await
    .map_err(|_| "connect timed out".to_string())?
    .map_err(|e| format!("connect: {e}"))?;

    let (mut send, recv) = tokio::time::timeout(FILE_TRANSFER_TIMEOUT, conn.open_bi())
        .await
        .map_err(|_| "open bi timed out".to_string())?
        .map_err(|e| format!("open bi: {e}"))?;

    let request = format!("{}\n", book_id);
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
             PRAGMA foreign_keys = ON;",
        )
        .map_err(|e| format!("pragma: {e}"))?;
        Ok(conn)
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
                data = Some(blob);
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
                            paths.push(PathBuf::from(p_str));
                        }
                    }
                }
            }
        }

        // 3. Check kv_store table for 'persist:theorem-library'
        if let Ok(mut stmt) =
            conn.prepare("SELECT value FROM kv_store WHERE key = 'persist:theorem-library'")
        {
            if let Ok(lib_str) = stmt.query_row([], |row| row.get::<_, String>(0)) {
                if let Ok(lib_val) = serde_json::from_str::<serde_json::Value>(&lib_str) {
                    if let Some(books) = lib_val.pointer("/state/books").and_then(|b| b.as_array())
                    {
                        for b in books {
                            if b.get("id").and_then(|v| v.as_str()) == Some(book_id) {
                                for key in &["filePath", "file_path", "storagePath", "storage_path"]
                                {
                                    if let Some(p_str) = b.get(*key).and_then(|v| v.as_str()) {
                                        paths.push(PathBuf::from(p_str));
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
        // 1. Check book-cache/{book_id}.book
        let cache_file = data_dir
            .join("book-cache")
            .join(format!("{}.book", book_id));
        if let Ok(metadata) = tokio::fs::metadata(&cache_file).await {
            if metadata.is_file() {
                let file = tokio::fs::File::open(&cache_file)
                    .await
                    .map_err(|e| format!("open cache file: {e}"))?;
                return Ok(BookSource::File(file, metadata.len()));
            }
        }

        // 2. Check book-cache/{book_id}
        let cache_file_raw = data_dir.join("book-cache").join(book_id);
        if let Ok(metadata) = tokio::fs::metadata(&cache_file_raw).await {
            if metadata.is_file() {
                let file = tokio::fs::File::open(&cache_file_raw)
                    .await
                    .map_err(|e| format!("open cache raw file: {e}"))?;
                return Ok(BookSource::File(file, metadata.len()));
            }
        }

        // 3. Query SQLite via spawn_blocking to keep accept Send-compliant
        let dir_clone = data_dir.to_path_buf();
        let id_clone = book_id.to_string();
        let (db_data, candidate_paths) =
            tokio::task::spawn_blocking(move || Self::find_in_db(&dir_clone, &id_clone))
                .await
                .map_err(|e| format!("spawn_blocking: {e}"))?;

        if let Some(data) = db_data {
            return Ok(BookSource::Memory(data));
        }

        for p in candidate_paths {
            if let Ok(metadata) = tokio::fs::metadata(&p).await {
                if metadata.is_file() {
                    let file = tokio::fs::File::open(&p)
                        .await
                        .map_err(|e| format!("open book file: {e}"))?;
                    return Ok(BookSource::File(file, metadata.len()));
                }
            }
        }

        Err(format!(
            "book '{book_id}' not found in book-cache, sqlite blob, or referenced file paths"
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

            let result = Self::locate_book(&self.data_dir, &request).await;

            match result {
                Ok(BookSource::File(mut file, len)) => {
                    let header = format!("OK {}\n", len);
                    let _ = tokio::io::AsyncWriteExt::write_all(&mut send, header.as_bytes()).await;
                    let _ = tokio::io::copy(&mut file, &mut send).await;
                    let _ = send.finish();
                }
                Ok(BookSource::Memory(data)) => {
                    let header = format!("OK {}\n", data.len());
                    let _ = tokio::io::AsyncWriteExt::write_all(&mut send, header.as_bytes()).await;
                    let _ = tokio::io::AsyncWriteExt::write_all(&mut send, &data).await;
                    let _ = send.finish();
                }
                Err(e) => {
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
    let mut file = tokio::fs::File::create(&dest)
        .await
        .map_err(|e| format!("create file: {e}"))?;
    let total = size;
    let mut remaining = total;
    let mut downloaded: usize = 0;
    let mut buf = vec![0u8; 1_048_576];
    let book_id_for_emit = book_id.clone();
    let start_instant = std::time::Instant::now();
    let mut last_emitted_pct = -1i32;
    while remaining > 0 {
        let to_read = remaining.min(buf.len());
        let n = tokio::time::timeout(
            FILE_TRANSFER_TIMEOUT,
            reader.read_exact(&mut buf[..to_read]),
        )
        .await
        .map_err(|_| "read chunk timed out".to_string())?
        .map_err(|e| format!("read chunk: {e}"))?;
        tokio::io::AsyncWriteExt::write_all(&mut file, &buf[..n])
            .await
            .map_err(|e| format!("write chunk: {e}"))?;
        downloaded += n;
        remaining -= n;
        if total > 0 {
            let pct = ((downloaded as f64 / total as f64) * 100.0) as i32;
            if pct != last_emitted_pct {
                last_emitted_pct = pct;
                let elapsed = start_instant.elapsed().as_secs_f64();
                if elapsed > 0.0 {
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
    }
    Ok(())
}
