use std::path::{Path, PathBuf};

use iroh::endpoint;
use iroh::protocol::ProtocolHandler;
use tauri::Emitter;
use theorem_sync_core::sync_protocol::{PeerHello, SYNC_PROTOCOL};
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

/// A connection to a paired device, and which device it is.
struct PeerConnection {
    conn: endpoint::Connection,
    device_id: String,
}

/// Opens a book-transfer connection to a paired device.
async fn connect_peer(
    app: &tauri::AppHandle,
    peer_device_id: &str,
    timeout: std::time::Duration,
) -> Result<PeerConnection, String> {
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

    let conn = tokio::time::timeout(timeout, ep.endpoint.connect(peer_addr, FILE_TRANSFER_ALPN))
        .await
        .map_err(|_| {
            format!(
                "connect to peer '{canonical_device_id}' timed out after {}s",
                timeout.as_secs()
            )
        })?
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
        if let Some(peer_entry) = devices
            .get_mut(&canonical_device_id)
            .filter(|d| d.last_ip != connected_ip || d.last_port != connected_port)
        {
            peer_entry.last_ip = connected_ip;
            peer_entry.last_port = connected_port;
            let _ = sync_state.transport_state.persist_paired(&devices);
        }
    }

    Ok(PeerConnection {
        conn,
        device_id: canonical_device_id,
    })
}

/// Whether `conn` was closed by the other device because it does not accept us.
fn refused_by_peer(conn: &endpoint::Connection) -> bool {
    matches!(
        conn.close_reason(),
        Some(endpoint::ConnectionError::ApplicationClosed(close))
            if close.error_code == crate::sync_access::NOT_PAIRED.into()
    )
}

/// Message for a device that refused us: it unpaired this device.
pub const PEER_REMOVED_THIS_DEVICE: &str =
    "The other device has removed this device. Pair them again to sync.";

/// How long a probe waits to connect and be answered: a device that does not
/// answer within this is reported offline (and tried again later).
const PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(6);

/// How long unpairing waits to tell the other device before going ahead
/// (connecting included). One that is offline learns it on its next attempt.
const UNPAIR_NOTICE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);

/// Requests that are not book IDs (a book ID never starts with '?').
const HELLO_REQUEST: &str = "?hello";
const LEGACY_PROBE_REQUEST: &str = "?probe";
const UNPAIRED_REQUEST: &str = "?unpaired";
const HELLO_ANSWER: &str = "HELLO ";

fn our_hello(app: &tauri::AppHandle) -> Option<PeerHello> {
    let state = crate::sync_commands::get_sync_state(app).ok()?;
    Some(PeerHello {
        name: state.transport_state.device_name(),
        protocol: SYNC_PROTOCOL,
    })
}

/// The other device rejected this one: it was unpaired there. Forget it here
/// too, so it stops being listed and tried. Runs on its own task (it restarts
/// the sync engine, which may be the one serving the caller).
fn forget_device_that_removed_us(app: &tauri::AppHandle, device_id: &str) {
    let app = app.clone();
    let device_id = device_id.to_string();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = crate::sync_commands::forget_device(&app, &device_id, true).await {
            log::warn!("[iroh-sync] Could not forget a device that removed this one: {e}");
        }
    });
}

fn emit_presence(app: &tauri::AppHandle, peer: &endpoint::Connection, online: bool) {
    let _ = app.emit(
        "sync-peer-presence",
        serde_json::json!({ "peer": peer.remote_id().to_string(), "online": online }),
    );
}

/// Checks that a paired device is reachable and still accepts this one, before
/// a sync round. (iroh-docs cannot say: a refused sync and a completed one
/// both end with "Failed to close connection" when the other side hangs up.)
/// The two devices also swap names and protocols ([`PeerHello`]), so a rename
/// on one shows on the other. Any answer means "allowed" (versions before the
/// hello answer with an error line); a refusal means this device was removed
/// there, and it is forgotten here too; silence means offline.
pub async fn probe_peer(app: &tauri::AppHandle, peer_device_id: &str) -> Result<(), String> {
    let deadline = tokio::time::Instant::now() + PROBE_TIMEOUT;
    let peer = match connect_peer(app, peer_device_id, PROBE_TIMEOUT).await {
        Ok(peer) => peer,
        Err(e) => {
            emit_presence_by_id(app, peer_device_id, false).await;
            return Err(format!("Peer is offline or unreachable ({e})"));
        }
    };
    let hello = our_hello(app)
        .and_then(|h| serde_json::to_string(&h).ok())
        .unwrap_or_default();
    let answered = async {
        let (mut send, recv) = peer.conn.open_bi().await.ok()?;
        send.write_all(format!("{HELLO_REQUEST} {hello}\n").as_bytes())
            .await
            .ok()?;
        send.finish().ok()?;
        let mut line = String::new();
        BufReader::new(recv.take(1024))
            .read_line(&mut line)
            .await
            .ok()?;
        (!line.is_empty()).then_some(line)
    };
    // One budget for connecting and answering, with a little left for the
    // answer when the connection took most of it.
    let answer_by = deadline.max(tokio::time::Instant::now() + std::time::Duration::from_secs(2));
    let answer = tokio::time::timeout_at(answer_by, answered)
        .await
        .ok()
        .flatten();
    if let Some(answer) = answer {
        emit_presence(app, &peer.conn, true);
        if let Some(theirs) = answer
            .trim()
            .strip_prefix(HELLO_ANSWER)
            .and_then(|json| serde_json::from_str::<PeerHello>(json).ok())
        {
            crate::sync_commands::note_peer_hello(app, &peer.device_id, &theirs).await;
        }
        return Ok(());
    }
    if refused_by_peer(&peer.conn) {
        forget_device_that_removed_us(app, &peer.device_id);
        return Err(PEER_REMOVED_THIS_DEVICE.to_string());
    }
    emit_presence(app, &peer.conn, false);
    Err("Peer is offline or unreachable".to_string())
}

async fn emit_presence_by_id(app: &tauri::AppHandle, peer_device_id: &str, online: bool) {
    let Ok(state) = crate::sync_commands::get_sync_state(app) else {
        return;
    };
    let node = state
        .transport_state
        .paired_devices
        .lock()
        .await
        .get(peer_device_id)
        .map(|d| d.iroh_node_id.clone());
    if let Some(node) = node {
        let _ = app.emit(
            "sync-peer-presence",
            serde_json::json!({ "peer": node, "online": online }),
        );
    }
}

/// Tells a paired device that this one is removing it, so it stops listing
/// this device too. Best effort: an offline device learns it on its next
/// attempt (it is refused, see [`probe_peer`]).
pub async fn notify_unpaired(app: &tauri::AppHandle, peer_device_id: &str) -> bool {
    let told = async {
        let peer = connect_peer(app, peer_device_id, UNPAIR_NOTICE_TIMEOUT)
            .await
            .ok()?;
        let (mut send, recv) = peer.conn.open_bi().await.ok()?;
        send.write_all(format!("{UNPAIRED_REQUEST}\n").as_bytes())
            .await
            .ok()?;
        send.finish().ok()?;
        let mut line = String::new();
        BufReader::new(recv.take(256))
            .read_line(&mut line)
            .await
            .ok()?;
        Some(line.starts_with("OK"))
    };
    tokio::time::timeout(UNPAIR_NOTICE_TIMEOUT, told)
        .await
        .ok()
        .flatten()
        .unwrap_or(false)
}

async fn connect_and_request(
    app: &tauri::AppHandle,
    peer_device_id: &str,
    book_id: &str,
) -> Result<(tokio::io::BufReader<iroh::endpoint::RecvStream>, usize), String> {
    let peer = connect_peer(app, peer_device_id, CONNECT_TIMEOUT).await?;
    let conn = &peer.conn;
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
    let read = tokio::time::timeout(FILE_TRANSFER_TIMEOUT, reader.read_line(&mut status_line))
        .await
        .map_err(|_| "read status timed out".to_string())?;
    if read.is_err() && refused_by_peer(conn) {
        forget_device_that_removed_us(app, &peer.device_id);
        return Err(PEER_REMOVED_THIS_DEVICE.to_string());
    }
    read.map_err(|e| format!("read status: {e}"))?;
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
    /// Its allowlist is checked again here, behind the endpoint's gate,
    /// before any file is read; its paired devices learn names and removals.
    pub state: std::sync::Arc<crate::iroh_sync::SyncTransportState>,
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

enum ResolvedBook {
    Path(PathBuf),
    Memory(Vec<u8>),
}

enum BookLookup {
    Found(Option<Vec<u8>>, Vec<PathBuf>),
    Deleted,
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

    fn find_in_db(data_dir: &Path, book_id: &str) -> BookLookup {
        let conn = match Self::open_read_db(data_dir) {
            Ok(c) => c,
            Err(_) => return BookLookup::Found(None, Vec::new()),
        };

        // 0. Check deletion tombstones first
        if let Ok(mut stmt) =
            conn.prepare("SELECT value FROM kv_store WHERE key = 'deletion_tombstones'")
        {
            if let Ok(val) = stmt.query_row([], |row| row.get::<_, String>(0)) {
                if let Ok(tombstones) = serde_json::from_str::<Vec<serde_json::Value>>(&val) {
                    for ts in tombstones {
                        let id = ts.get("id").and_then(|v| v.as_str()).unwrap_or("");
                        let entity_type =
                            ts.get("entityType").and_then(|v| v.as_str()).unwrap_or("");
                        if id == book_id && (entity_type.is_empty() || entity_type == "book") {
                            return BookLookup::Deleted;
                        }
                    }
                }
            }
        }

        let mut data = None;
        let mut paths = Vec::new();

        // Check deletion tombstones in library state
        if let Ok(mut stmt) = conn.prepare(
            "SELECT value FROM kv_store WHERE key IN ('zustand:theorem-library', 'persist:theorem-library') OR key LIKE '%theorem-library'"
        ) {
            let rows = stmt.query_map([], |row| row.get::<_, String>(0));
            if let Ok(rows) = rows {
                for row in rows.flatten() {
                    if let Ok(lib_val) = serde_json::from_str::<serde_json::Value>(&row) {
                        if let Some(ts_arr) = lib_val
                            .pointer("/state/deletionTombstones")
                            .and_then(|t| t.as_array())
                            .or_else(|| lib_val.get("deletionTombstones").and_then(|t| t.as_array()))
                        {
                            for ts in ts_arr {
                                if ts.get("id").and_then(|v| v.as_str()) == Some(book_id) {
                                    return BookLookup::Deleted;
                                }
                            }
                        }

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

        BookLookup::Found(data, paths)
    }

    /// Finds the file to send for `book_id`. The ID must look like a book ID,
    /// and every path, whether in `book-cache` or recorded in the library,
    /// passes [`servable_book_path`]: a request can only ever return a book.
    ///
    /// [`servable_book_path`]: crate::sync_access::servable_book_path
    fn resolve_book(data_dir: &Path, book_id: &str) -> Result<ResolvedBook, String> {
        use crate::sync_access::{is_valid_book_id, servable_book_path};

        if !is_valid_book_id(book_id) {
            return Err("invalid book id".to_string());
        }

        let cache_dir = data_dir.join("book-cache");
        let mut candidates = vec![
            cache_dir.join(format!("{book_id}.book")),
            cache_dir.join(book_id),
        ];
        // Also {book_id}.epub, {book_id}.pdf, ...
        let prefix = format!("{book_id}.");
        if let Ok(entries) = std::fs::read_dir(&cache_dir) {
            for entry in entries.flatten() {
                if entry.file_name().to_string_lossy().starts_with(&prefix) {
                    candidates.push(entry.path());
                }
            }
        }
        for candidate in &candidates {
            if let Some(path) = servable_book_path(candidate, data_dir) {
                return Ok(ResolvedBook::Path(path));
            }
        }

        match Self::find_in_db(data_dir, book_id) {
            BookLookup::Deleted => Err(format!(
                "PEER_BOOK_DELETED: book '{book_id}' has been deleted on this device"
            )),
            BookLookup::Found(Some(data), _) if !data.is_empty() => Ok(ResolvedBook::Memory(data)),
            BookLookup::Found(_, paths) => paths
                .iter()
                .find_map(|p| servable_book_path(p, data_dir))
                .map(ResolvedBook::Path)
                .ok_or_else(|| {
                    format!("book '{book_id}' not found in book-cache, sqlite blob, or referenced file paths")
                }),
        }
    }

    async fn locate_book(data_dir: &Path, book_id: &str) -> Result<BookSource, String> {
        let dir = data_dir.to_path_buf();
        let id = book_id.trim().to_string();
        let resolved = tokio::task::spawn_blocking(move || Self::resolve_book(&dir, &id))
            .await
            .map_err(|e| format!("spawn_blocking: {e}"))??;
        match resolved {
            ResolvedBook::Memory(data) => Ok(BookSource::Memory(data)),
            ResolvedBook::Path(path) => {
                let file = tokio::fs::File::open(&path)
                    .await
                    .map_err(|e| format!("open book file: {e}"))?;
                let len = file
                    .metadata()
                    .await
                    .map_err(|e| format!("stat book file: {e}"))?
                    .len();
                Ok(BookSource::File(file, len))
            }
        }
    }
}

impl FileTransferHandler {
    async fn device_id_of(&self, node: &iroh::PublicKey) -> Option<String> {
        let node = node.to_string();
        self.state
            .paired_devices
            .lock()
            .await
            .values()
            .find(|d| d.iroh_node_id == node)
            .map(|d| d.device_id.clone())
    }

    async fn note_hello(&self, node: &iroh::PublicKey, hello: &PeerHello) {
        if let Some(device_id) = self.device_id_of(node).await {
            crate::sync_commands::note_peer_hello(&self.state.app_handle, &device_id, hello).await;
        }
    }

    /// The other device unpaired this one: forget it here too.
    async fn forget_remote(&self, node: &iroh::PublicKey) {
        if let Some(device_id) = self.device_id_of(node).await {
            forget_device_that_removed_us(&self.state.app_handle, &device_id);
        }
    }
}

impl ProtocolHandler for FileTransferHandler {
    async fn accept(&self, conn: endpoint::Connection) -> Result<(), iroh::protocol::AcceptError> {
        if !self.state.allowlist.is_allowed(&conn.remote_id()) {
            conn.close(crate::sync_access::NOT_PAIRED.into(), b"not paired");
            return Ok(());
        }
        loop {
            let (mut send, mut recv) = match conn.accept_bi().await {
                Ok(s) => s,
                Err(_) => break,
            };

            // A book ID is under 200 bytes; never buffer an endless line.
            let mut reader = BufReader::new((&mut recv).take(512));
            let mut line = String::new();
            let request =
                match tokio::time::timeout(CONNECT_TIMEOUT, reader.read_line(&mut line)).await {
                    Ok(Ok(0)) | Ok(Err(_)) | Err(_) => break,
                    Ok(Ok(_)) => line.trim().to_string(),
                };

            if request == LEGACY_PROBE_REQUEST || request.starts_with(HELLO_REQUEST) {
                if let Some(theirs) = request
                    .strip_prefix(HELLO_REQUEST)
                    .and_then(|json| serde_json::from_str::<PeerHello>(json.trim()).ok())
                {
                    self.note_hello(&conn.remote_id(), &theirs).await;
                }
                let ours = PeerHello {
                    name: self.state.device_name(),
                    protocol: SYNC_PROTOCOL,
                };
                let answer = format!(
                    "{HELLO_ANSWER}{}\n",
                    serde_json::to_string(&ours).unwrap_or_default()
                );
                let _ = tokio::io::AsyncWriteExt::write_all(&mut send, answer.as_bytes()).await;
                let _ = send.finish();
                continue;
            }
            if request == UNPAIRED_REQUEST {
                let _ = tokio::io::AsyncWriteExt::write_all(&mut send, b"OK\n").await;
                let _ = send.finish();
                // Let the answer leave before the engine restarts.
                let _ =
                    tokio::time::timeout(std::time::Duration::from_secs(2), send.stopped()).await;
                self.forget_remote(&conn.remote_id()).await;
                break;
            }

            log::debug!("[file-transfer] Incoming request for book '{request}'");
            let result = Self::locate_book(&self.data_dir, &request).await;

            match result {
                Ok(BookSource::File(mut file, len)) => {
                    log::debug!("[file-transfer] Serving book '{request}' from file ({len} bytes)");
                    let header = format!("OK {}\n", len);
                    let _ = tokio::io::AsyncWriteExt::write_all(&mut send, header.as_bytes()).await;
                    let _ = tokio::io::copy(&mut file, &mut send).await;
                    let _ = send.finish();
                }
                Ok(BookSource::Memory(data)) => {
                    log::debug!(
                        "[file-transfer] Serving book '{request}' from memory ({} bytes)",
                        data.len()
                    );
                    let header = format!("OK {}\n", data.len());
                    let _ = tokio::io::AsyncWriteExt::write_all(&mut send, header.as_bytes()).await;
                    let _ = tokio::io::AsyncWriteExt::write_all(&mut send, &data).await;
                    let _ = send.finish();
                }
                Err(e) => {
                    log::warn!("[file-transfer] Failed to locate book '{request}': {e}");
                    let msg = format!("ERR {}\n", e);
                    let _ = tokio::io::AsyncWriteExt::write_all(&mut send, msg.as_bytes()).await;
                    let _ = send.finish();
                }
            }
        }
        Ok(())
    }
}

/// The largest book a peer may send (comics can be large; nothing is this big).
const MAX_BOOK_BYTES: usize = 4 * 1024 * 1024 * 1024;

/// Downloads a book from a peer into `book-cache/{book_id}.book` and returns
/// that path. The path is derived here from a validated ID, never passed in,
/// so a synced book ID cannot direct the download elsewhere.
#[tauri::command]
pub async fn download_book_file(
    app: tauri::AppHandle,
    peer_device_id: String,
    book_id: String,
) -> Result<String, String> {
    if !crate::sync_access::is_valid_book_id(&book_id) {
        return Err("invalid book id".to_string());
    }
    let dest = crate::database::materialized_book_path(&app, &book_id)?;
    let (mut reader, size) = connect_and_request(&app, &peer_device_id, &book_id).await?;
    if size > MAX_BOOK_BYTES {
        return Err(format!("peer offered a {size}-byte file; refusing"));
    }
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

    Ok(dest.to_string_lossy().into_owned())
}
