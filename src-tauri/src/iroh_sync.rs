use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use iroh::endpoint::{self, presets::N0, RelayMode};
use iroh::protocol::{ProtocolHandler, Router};
use iroh::{PublicKey, SecretKey};
use iroh_docs::engine::LiveEvent;
use iroh_mdns_address_lookup::MdnsAddressLookup;
use tauri::Emitter;
use tokio::sync::Mutex;

use theorem_sync_core::sync_crypto;
use theorem_sync_core::sync_persistence;
use theorem_sync_core::sync_protocol::{PairedDevice, PairingRequest, PairingResponse};

use crate::sync_access::{self, PairingCheck, PairingSessions, PeerAllowlist, PeerGate};

const ALPN: &[u8] = b"theorem-sync/v1";
pub const ALPN_BYTES: &[u8] = ALPN;

/// One remote doc entry delivered over the IPC bridge.
#[derive(serde::Serialize, Clone)]
struct EntryPayload {
    key: String,
    value: String,
}

#[derive(serde::Serialize, Clone)]
struct EntryBatchPayload {
    entries: Vec<EntryPayload>,
}

/// Batches remote doc entries before emitting them over IPC so a bulk sync
/// arrives as a few `docs-entry-batch` events instead of one event per entry.
/// Later values for the same key replace earlier ones, so only the newest
/// state of each record crosses the bridge.
struct EntryBatcher<R: tauri::Runtime> {
    app: tauri::AppHandle<R>,
    entries: std::sync::Mutex<Vec<EntryPayload>>,
    flush_scheduled: std::sync::atomic::AtomicBool,
}

impl<R: tauri::Runtime> EntryBatcher<R> {
    const FLUSH_DELAY_MS: u64 = 300;
    const MAX_BATCH: usize = 64;

    fn new(app: tauri::AppHandle<R>) -> Arc<Self> {
        Arc::new(Self {
            app,
            entries: std::sync::Mutex::new(Vec::new()),
            flush_scheduled: std::sync::atomic::AtomicBool::new(false),
        })
    }

    fn push(self: &Arc<Self>, key: String, value: String) {
        let should_flush = {
            let mut guard = self.entries.lock().unwrap();
            match guard.iter_mut().find(|e| e.key == key) {
                Some(existing) => {
                    existing.value = value;
                }
                None => guard.push(EntryPayload { key, value }),
            }
            guard.len() >= Self::MAX_BATCH
        };
        if should_flush {
            self.flush();
        } else {
            self.schedule_flush();
        }
    }

    fn schedule_flush(self: &Arc<Self>) {
        if !self
            .flush_scheduled
            .swap(true, std::sync::atomic::Ordering::SeqCst)
        {
            let this = Arc::clone(self);
            tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(Self::FLUSH_DELAY_MS)).await;
                this.flush_scheduled
                    .store(false, std::sync::atomic::Ordering::SeqCst);
                this.flush();
            });
        }
    }

    fn flush(&self) {
        let drained = std::mem::take(&mut *self.entries.lock().unwrap());
        if drained.is_empty() {
            return;
        }
        let _ = self
            .app
            .emit("docs-entry-batch", EntryBatchPayload { entries: drained });
    }
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
struct IrohEnvelope {
    #[serde(rename = "t")]
    msg_type: String,
    #[serde(rename = "d")]
    data: serde_json::Value,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct IrohPeerInfo {
    pub public_key: PublicKey,
    pub device_id: String,
    pub device_name: String,
    pub fingerprint: String,
}

/// Generic over the Tauri runtime only so tests can use the mock runtime.
pub struct SyncTransportState<R: tauri::Runtime = tauri::Wry> {
    pub app_handle: tauri::AppHandle<R>,
    pub device_id: String,
    pub fingerprint: String,
    pub device_name: String,
    pub app_data_dir: PathBuf,
    pub paired_devices: Mutex<HashMap<String, PairedDevice>>,
    pub docs_api: Mutex<Option<DocsApiSnapshot>>,
    /// Incremented each time an accept loop spawns; lets readers detect a
    /// snapshot that outlived its engine (stale generation = dead actor).
    pub docs_generation: std::sync::atomic::AtomicU64,
    /// The devices allowed to connect, kept in step with `paired_devices`.
    pub allowlist: Arc<PeerAllowlist>,
    /// The secret of the pairing QR code on screen, if any.
    pub pairing: PairingSessions,
    /// Pairing requests waiting for the user to accept or decline them.
    pub pairing_confirms: std::sync::Mutex<HashMap<String, tokio::sync::oneshot::Sender<bool>>>,
}

impl<R: tauri::Runtime> SyncTransportState<R> {
    /// Saves the paired devices and updates who may connect. Every change to
    /// `paired_devices` goes through here so the two never disagree.
    pub fn persist_paired(&self, devices: &HashMap<String, PairedDevice>) -> Result<(), String> {
        self.allowlist.set_paired(devices);
        sync_persistence::save_paired_devices(&self.app_data_dir, devices)
    }
}

#[derive(Clone)]
pub struct DocsApiSnapshot {
    pub api: iroh_docs::api::DocsApi,
    pub author: iroh_docs::AuthorId,
    pub blobs: iroh_blobs::api::Store,
    /// Generation of the accept loop that produced this snapshot.
    pub generation: u64,
}

pub struct IrohSyncEndpoint {
    pub endpoint: iroh::endpoint::Endpoint,
    pub public_key: PublicKey,
    pub peer_info: IrohPeerInfo,
}

impl IrohSyncEndpoint {
    pub async fn new(
        key_path: &PathBuf,
        device_id: String,
        device_name: String,
        fingerprint: String,
        allowlist: Arc<PeerAllowlist>,
    ) -> Result<Self, String> {
        let secret_key = load_or_create_key(key_path)?;
        let public_key = secret_key.public();
        let builder = iroh::endpoint::Endpoint::builder(N0)
            .secret_key(secret_key)
            .alpns(vec![
                ALPN.to_vec(),
                iroh_blobs::ALPN.to_vec(),
                iroh_docs::ALPN.to_vec(),
                iroh_gossip::ALPN.to_vec(),
            ])
            .relay_mode(RelayMode::Default)
            .hooks(PeerGate::new(allowlist, ALPN));

        let builder = if std::env::var("THEOREM_DISABLE_MDNS").is_err() {
            builder.address_lookup(MdnsAddressLookup::builder())
        } else {
            eprintln!("[iroh-sync] mDNS disabled via THEOREM_DISABLE_MDNS env var");
            builder
        };
        let endpoint = builder
            .bind()
            .await
            .map_err(|e| format!("iroh bind: {e}"))?;
        let peer_info = IrohPeerInfo {
            public_key,
            device_id: device_id.clone(),
            device_name,
            fingerprint,
        };
        Ok(Self {
            endpoint,
            public_key,
            peer_info,
        })
    }

    pub fn public_key_string(&self) -> String {
        self.public_key.to_string()
    }

    pub async fn close(&self) {
        self.endpoint.close().await;
    }
}

/// The device's sync identity. A new one is made only when there is none, or
/// when the file is not a key at all (then it is kept as `iroh-key.corrupt`):
/// a key that merely failed to read is never replaced, because a new identity
/// silently unpairs every device.
pub fn load_or_create_key(path: &PathBuf) -> Result<SecretKey, String> {
    match std::fs::read(path) {
        Ok(bytes) => match <[u8; 32]>::try_from(bytes) {
            Ok(arr) => {
                // Keys written by older versions were readable by other users.
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
                }
                return Ok(SecretKey::from_bytes(&arr));
            }
            Err(_) => {
                eprintln!("[iroh-sync] Sync key file is malformed; keeping it as iroh-key.corrupt");
                let _ = std::fs::rename(path, path.with_extension("corrupt"));
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("read sync key: {e}")),
    }
    let key = SecretKey::generate();
    if let Some(p) = path.parent() {
        std::fs::create_dir_all(p).ok();
    }
    write_private(path, &key.to_bytes()).map_err(|e| format!("write sync key: {e}"))?;
    Ok(key)
}

/// Writes a file only this user can read.
fn write_private(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

async fn send_on_bi(
    send: &mut iroh::endpoint::SendStream,
    data: &impl serde::Serialize,
) -> Result<(), String> {
    let json = serde_json::to_vec(data).map_err(|e| format!("serialize: {e}"))?;
    let len = (json.len() as u32).to_be_bytes();
    send.write_all(&len)
        .await
        .map_err(|e| format!("write len: {e}"))?;
    send.write_all(&json)
        .await
        .map_err(|e| format!("write body: {e}"))?;
    send.finish().map_err(|e| format!("finish: {e}"))
}

/// Reads one length-prefixed message. The length is checked before anything
/// is allocated, so a peer cannot make us reserve gigabytes.
async fn recv_from_bi(recv: &mut iroh::endpoint::RecvStream) -> Result<Vec<u8>, String> {
    let mut lb = [0u8; 4];
    recv.read_exact(&mut lb)
        .await
        .map_err(|e| format!("read len: {e}"))?;
    let len = u32::from_be_bytes(lb) as usize;
    if len > sync_access::MAX_PAIRING_FRAME {
        return Err(format!("pairing message too large ({len} bytes)"));
    }
    let mut buf = vec![0u8; len];
    recv.read_exact(&mut buf)
        .await
        .map_err(|e| format!("read body: {e}"))?;
    Ok(buf)
}

pub fn subscribe_doc_events<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    doc: iroh_docs::api::Doc,
    blobs: iroh_blobs::api::Store,
) {
    tokio::spawn(async move {
        let batcher = EntryBatcher::new(app.clone());
        let mut subscribe_failures = 0u32;
        let mut stream_deaths = 0u32;
        const MAX_SUBSCRIBE_RETRIES: u32 = 3;
        const MAX_STREAM_DEATHS: u32 = 10;
        let mut backoff_ms: u64 = 1000;
        loop {
            let mut stream = match doc.subscribe().await {
                Ok(s) => s,
                Err(e) => {
                    subscribe_failures += 1;
                    if subscribe_failures > MAX_SUBSCRIBE_RETRIES {
                        eprintln!("[iroh-sync] Failed to subscribe to doc events after {MAX_SUBSCRIBE_RETRIES} retries: {e}. Giving up.");
                        break;
                    }
                    eprintln!(
                        "[iroh-sync] Failed to subscribe to doc events: {e}, retrying in 1s..."
                    );
                    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                    continue;
                }
            };
            subscribe_failures = 0;
            let stream_started = std::time::Instant::now();
            use futures::StreamExt;
            let mut pending: std::collections::HashMap<iroh_blobs::Hash, String> =
                std::collections::HashMap::new();

            while let Some(event) = stream.next().await {
                match event {
                    Ok(LiveEvent::InsertRemote { entry, .. }) => {
                        let key = String::from_utf8_lossy(entry.key()).to_string();
                        let hash = entry.content_hash();
                        // Content already here: deliver it now. Otherwise wait for
                        // ContentReady (delivering on both would send it twice).
                        match blobs.blobs().get_bytes(hash).await {
                            Ok(content) => {
                                if let Ok(value) = String::from_utf8(content.to_vec()) {
                                    batcher.push(key, value);
                                }
                            }
                            Err(_) => {
                                pending.insert(hash, key);
                            }
                        }
                    }
                    Ok(LiveEvent::ContentReady { hash }) => {
                        if let Some(key) = pending.remove(&hash) {
                            if let Ok(content) = blobs.blobs().get_bytes(hash).await {
                                if let Ok(value) = String::from_utf8(content.to_vec()) {
                                    batcher.push(key, value);
                                }
                            }
                        }
                    }
                    Ok(LiveEvent::PendingContentReady) => {
                        let remaining: Vec<(iroh_blobs::Hash, String)> = pending.drain().collect();
                        for (hash, key) in remaining {
                            if let Ok(content) = blobs.blobs().get_bytes(hash).await {
                                if let Ok(value) = String::from_utf8(content.to_vec()) {
                                    batcher.push(key, value);
                                }
                            }
                        }
                        // A bulk transfer may have just filled the queue past the
                        // batch limit without ever hitting the flush timer window.
                        batcher.flush();
                        #[derive(serde::Serialize, Clone)]
                        struct PendingContentPayload {
                            remaining_count: usize,
                        }
                        let _ = app.emit(
                            "docs-pending-content-ready",
                            PendingContentPayload {
                                remaining_count: pending.len(),
                            },
                        );
                    }
                    Ok(LiveEvent::SyncFinished(event)) => {
                        #[derive(serde::Serialize, Clone)]
                        struct SyncFinishedPayload {
                            peer: String,
                            synced: bool,
                            received: usize,
                            sent: usize,
                        }
                        let (synced, received, sent) = sync_outcome(
                            event
                                .result
                                .as_ref()
                                .map(|d| (d.entries_received, d.entries_sent))
                                .map_err(String::as_str),
                        );
                        if !synced {
                            if let Err(e) = &event.result {
                                eprintln!("[iroh-sync] sync with {} failed: {e}", event.peer);
                            }
                        }
                        if synced {
                            record_last_sync(&app, &event.peer).await;
                        }
                        let _ = app.emit(
                            "docs-sync-finished",
                            SyncFinishedPayload {
                                peer: event.peer.to_string(),
                                synced,
                                received,
                                sent,
                            },
                        );
                    }
                    Ok(LiveEvent::NeighborUp(peer)) => {
                        #[derive(serde::Serialize, Clone)]
                        struct PeerStatePayload {
                            peer: String,
                            online: bool,
                        }
                        let _ = app.emit(
                            "docs-peer-online",
                            PeerStatePayload {
                                peer: peer.to_string(),
                                online: true,
                            },
                        );
                    }
                    Ok(LiveEvent::NeighborDown(peer)) => {
                        #[derive(serde::Serialize, Clone)]
                        struct PeerStatePayload {
                            peer: String,
                            online: bool,
                        }
                        let _ = app.emit(
                            "docs-peer-offline",
                            PeerStatePayload {
                                peer: peer.to_string(),
                                online: false,
                            },
                        );
                    }
                    Err(err) => {
                        eprintln!("[iroh-sync] doc event stream error: {err}");

                        let msg = err.to_string();
                        if msg.contains("actor failed") || msg.contains("actor closed") {
                            break;
                        }
                    }
                    _ => {}
                }
            }

            // A stream that ran for a while was healthy: only rapid, repeated
            // failures count towards giving up.
            if stream_started.elapsed() > std::time::Duration::from_secs(60) {
                stream_deaths = 0;
                backoff_ms = 1000;
            }
            stream_deaths += 1;
            if stream_deaths > MAX_STREAM_DEATHS {
                eprintln!(
                    "[iroh-sync] doc event stream died {MAX_STREAM_DEATHS} times. Giving up."
                );
                break;
            }
            eprintln!(
                "[iroh-sync] doc event stream ended ({stream_deaths}/{MAX_STREAM_DEATHS}), re-subscribing in {}ms...",
                backoff_ms
            );
            tokio::time::sleep(std::time::Duration::from_millis(backoff_ms)).await;
            backoff_ms = std::cmp::min(backoff_ms * 2, 30_000);
        }
    });
}

/// Whether a finished iroh-docs exchange actually synced, and its counts.
/// iroh-docs reports an error when only the connection teardown failed
/// ("Failed to close ..."), typically when the other side hangs up first over
/// a relay; the exchange itself completed, so that counts as synced.
/// (`result` is the event's entry counts, received and sent, or its error.)
fn sync_outcome(result: Result<(usize, usize), &str>) -> (bool, usize, usize) {
    match result {
        Ok((received, sent)) => (true, received, sent),
        Err(e) if e.starts_with("Failed to close") => (true, 0, 0),
        Err(_) => (false, 0, 0),
    }
}

/// Marks when this device last completed a sync with `peer`.
async fn record_last_sync<R: tauri::Runtime>(app: &tauri::AppHandle<R>, peer: &PublicKey) {
    use tauri::Manager;
    let Some(sync_state) = app.try_state::<crate::sync_commands::SyncState>() else {
        return;
    };
    let state = &sync_state.transport_state;
    let peer = peer.to_string();
    let mut devices = state.paired_devices.lock().await;
    let mut changed = false;
    for device in devices.values_mut() {
        if device.iroh_node_id == peer {
            device.last_sync_at = Some(sync_crypto::now_iso8601());
            changed = true;
        }
    }
    if changed {
        let _ = state.persist_paired(&devices);
    }
}

pub struct PairingProtocolHandler<R: tauri::Runtime = tauri::Wry> {
    pub state: Arc<SyncTransportState<R>>,
    /// This device's sync identity (part of the verification code).
    pub host_key: PublicKey,
}

impl<R: tauri::Runtime> std::fmt::Debug for PairingProtocolHandler<R> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PairingProtocolHandler").finish()
    }
}

/// How long a device waits for its pairing request to arrive.
const PAIRING_READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

/// How long the user has to accept a pairing request.
pub const PAIRING_CONFIRM_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(90);

async fn send_envelope(
    send: &mut iroh::endpoint::SendStream,
    msg_type: &str,
    data: serde_json::Value,
) {
    let env = IrohEnvelope {
        msg_type: msg_type.to_string(),
        data,
    };
    let _ = send_on_bi(send, &env).await;
}

impl<R: tauri::Runtime> ProtocolHandler for PairingProtocolHandler<R> {
    /// One pairing request per connection. This protocol is the only one a
    /// device that is not paired may use, so it reads one capped message under
    /// a timeout and closes.
    async fn accept(&self, conn: endpoint::Connection) -> Result<(), iroh::protocol::AcceptError> {
        let Ok((mut send, mut recv)) = conn.accept_bi().await else {
            return Ok(());
        };
        let req_bytes =
            match tokio::time::timeout(PAIRING_READ_TIMEOUT, recv_from_bi(&mut recv)).await {
                Ok(Ok(bytes)) => bytes,
                _ => return Ok(()),
            };
        let env: IrohEnvelope = match serde_json::from_slice::<IrohEnvelope>(&req_bytes) {
            Ok(env) if env.msg_type == "pair" => env,
            _ => {
                send_envelope(
                    &mut send,
                    "pair_resp",
                    serde_json::json!({"error": "not a pairing request"}),
                )
                .await;
                return Ok(());
            }
        };

        let (remote_ip, remote_port) = {
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

        let resp_val = handle_pair_req(
            &self.state,
            &self.host_key,
            conn.remote_id(),
            &env.data,
            remote_ip,
            remote_port,
        )
        .await;
        send_envelope(&mut send, "pair_resp", resp_val).await;
        // Let the response reach the other device before the connection drops.
        let _ = tokio::time::timeout(std::time::Duration::from_secs(5), send.stopped()).await;
        Ok(())
    }
}

/// Handle to a running accept loop: a cancel signal plus the task handle so
/// callers can wait for the loop (and its iroh-docs engine) to actually stop.
pub struct AcceptLoopHandle {
    pub cancel: tokio::sync::watch::Sender<bool>,
    pub join: tokio::task::JoinHandle<()>,
}

pub fn start_accept_loop(
    endpoint: Arc<IrohSyncEndpoint>,
    state: Arc<SyncTransportState>,
) -> AcceptLoopHandle {
    let (cancel_tx, mut cancel_rx) = tokio::sync::watch::channel(false);

    let router_endpoint = endpoint.endpoint.clone();
    let state_clone = state.clone();
    let data_dir = state.app_data_dir.clone();

    let join = tokio::spawn(async move {
        // Invalidate any snapshot left by a previous accept loop so stale
        // handles to a dead iroh-docs engine are never mistaken for ready.
        *state_clone.docs_api.lock().await = None;

        let blobs_path = data_dir.join("iroh-blobs");

        let stale_docs = data_dir.join("iroh-docs").join("db.redb");
        if stale_docs.exists() {
            eprintln!("[iroh-sync] Purging stale databases from pre-1.0.7...");
            let _ = std::fs::remove_dir_all(data_dir.join("iroh-docs"));
            let _ = std::fs::remove_dir_all(&blobs_path);
        }

        // Always initialize the docs engine, even with zero paired devices, so
        // docs_api is ready before the first pairing (otherwise iroh_start
        // times out on fresh devices and first-pair doc creation is blocked).

        let _ = std::fs::create_dir_all(&blobs_path);
        // A store still held by an engine that is shutting down fails to
        // open for a moment; only a store that keeps failing is corrupt.
        let mut blobs_load = iroh_blobs::store::fs::FsStore::load(&blobs_path).await;
        for _ in 0..3 {
            if blobs_load.is_ok() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            blobs_load = iroh_blobs::store::fs::FsStore::load(&blobs_path).await;
        }
        let blobs = match blobs_load {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[iroh-sync] Failed to load blobs store: {e}");

                let _ = std::fs::remove_dir_all(&blobs_path);
                return;
            }
        };
        let blobs_handler = iroh_blobs::BlobsProtocol::new(&blobs, None);

        let gossip = iroh_gossip::net::Gossip::builder().spawn(router_endpoint.clone());

        let docs_path = data_dir.join("iroh-docs");

        let _ = std::fs::create_dir_all(&docs_path);
        let blobs_store: iroh_blobs::api::Store = blobs.into();
        let blobs_for_subscribe = blobs_store.clone();
        let blobs_for_cmds = blobs_store.clone();
        let mut docs_spawn = Err(None);
        for attempt in 0..4 {
            if attempt > 0 {
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            }
            match iroh_docs::protocol::Docs::persistent(docs_path.clone())
                .spawn(router_endpoint.clone(), blobs_store.clone(), gossip.clone())
                .await
            {
                Ok(d) => {
                    docs_spawn = Ok(d);
                    break;
                }
                Err(e) => docs_spawn = Err(Some(e)),
            }
        }
        let docs_handler = match docs_spawn {
            Ok(d) => d,
            Err(e) => {
                eprintln!("[iroh-sync] Failed to spawn iroh-docs: {e:?}");

                eprintln!("[iroh-sync] Removing corrupted databases and retrying...");
                let _ = std::fs::remove_dir_all(&blobs_path);
                let _ = std::fs::remove_dir_all(&docs_path);

                return;
            }
        };

        let api = docs_handler.api().clone();
        let api_for_subscribe = api.clone();
        let author = match api.author_default().await {
            Ok(a) => a,
            Err(_) => match api.author_create().await {
                Ok(a) => a,
                Err(e) => {
                    eprintln!("[iroh-sync] Failed to create docs author: {e}");
                    return;
                }
            },
        };

        let mut docs_api_state = state_clone.docs_api.lock().await;
        let generation = state_clone
            .docs_generation
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
            + 1;
        *docs_api_state = Some(DocsApiSnapshot {
            api,
            author,
            blobs: blobs_for_cmds,
            generation,
        });
        drop(docs_api_state);

        {
            let paired = state_clone.paired_devices.lock().await;
            let docs: Vec<(String, String, String, String, String, u16)> = paired
                .values()
                .filter(|d| !d.sync_doc_id.is_empty())
                .map(|d| {
                    (
                        d.sync_doc_id.clone(),
                        d.sync_doc_ticket.clone(),
                        d.iroh_node_id.clone(),
                        d.peer_relay_url.clone(),
                        d.last_ip.clone(),
                        d.last_port,
                    )
                })
                .collect();
            drop(paired);

            for (doc_id_str, ticket_str, node_id, relay_url, last_ip, last_port) in docs {
                if let Ok(doc_id) = doc_id_str.parse::<iroh_docs::NamespaceId>() {
                    let doc = match api_for_subscribe.open(doc_id).await {
                        Ok(Some(doc)) => Some(doc),
                        Err(e) => {
                            eprintln!(
                                "[iroh-sync] Failed to open sync doc for peer {node_id}: {e}. \
                                 Trying re-import from stored ticket..."
                            );
                            None
                        }
                        Ok(None) => None,
                    };
                    let doc = match doc {
                        Some(doc) => Some(doc),
                        None if !ticket_str.is_empty() => {
                            match ticket_str.parse::<iroh_docs::DocTicket>() {
                                Ok(ticket) => match api_for_subscribe.import(ticket).await {
                                    Ok(doc) => {
                                        eprintln!(
                                            "[iroh-sync] Re-imported sync doc from ticket for peer {node_id}"
                                        );

                                        let _ = state_clone.app_handle.emit("doc-reimported", ());
                                        Some(doc)
                                    }
                                    Err(e) => {
                                        eprintln!(
                                            "[iroh-sync] Failed to import sync doc ticket for peer {node_id}: {e}"
                                        );
                                        None
                                    }
                                },
                                Err(e) => {
                                    eprintln!(
                                        "[iroh-sync] Invalid sync doc ticket for peer {node_id}: {e}"
                                    );
                                    None
                                }
                            }
                        }
                        None => None,
                    };
                    if let Some(doc) = doc {
                        subscribe_doc_events(
                            state_clone.app_handle.clone(),
                            doc.clone(),
                            blobs_for_subscribe.clone(),
                        );

                        if !node_id.is_empty() {
                            if let Ok(peer_pk) = node_id.parse::<iroh::PublicKey>() {
                                let mut peer_addr = iroh::EndpointAddr::new(peer_pk);
                                if !relay_url.is_empty() {
                                    if let Ok(url) = relay_url.parse::<iroh::RelayUrl>() {
                                        peer_addr = peer_addr.with_relay_url(url);
                                    }
                                }
                                if let Ok(ip) = last_ip.parse::<std::net::IpAddr>() {
                                    if last_port > 0 {
                                        peer_addr = peer_addr
                                            .with_ip_addr(std::net::SocketAddr::new(ip, last_port));
                                    }
                                }
                                let _ = doc.start_sync(vec![peer_addr]).await;
                            }
                        }
                    }
                }
            }
        }

        {
            let paired = state_clone.paired_devices.lock().await;
            let broken: Vec<(String, String, String)> = paired
                .values()
                .filter(|d| d.sync_doc_id.is_empty())
                .map(|d| {
                    (
                        d.device_id.clone(),
                        d.sync_doc_ticket.clone(),
                        d.device_name.clone(),
                    )
                })
                .collect();
            drop(paired);

            for (device_id, ticket_str, device_name) in broken {
                if !ticket_str.is_empty() {
                    if let Ok(ticket) = ticket_str.parse::<iroh_docs::DocTicket>() {
                        match api_for_subscribe.import(ticket).await {
                            Ok(doc) => {
                                let doc_id = doc.id().to_string();
                                eprintln!(
                                    "[iroh-sync] Recovered sync doc {doc_id} from ticket for peer {device_name}"
                                );
                                subscribe_doc_events(
                                    state_clone.app_handle.clone(),
                                    doc,
                                    blobs_for_subscribe.clone(),
                                );
                                let mut devices = state_clone.paired_devices.lock().await;
                                if let Some(device) = devices.get_mut(&device_id) {
                                    device.sync_doc_id = doc_id;
                                }
                                let _ = state_clone.persist_paired(&devices);
                            }
                            Err(e) => {
                                eprintln!(
                                    "[iroh-sync] Recovery import failed for {device_name}: {e}"
                                );
                                let _ = state_clone.app_handle.emit(
                                    "sync-doc-missing",
                                    serde_json::json!({
                                        "deviceId": device_id,
                                        "deviceName": device_name,
                                    }),
                                );
                            }
                        }
                    }
                } else {
                    eprintln!(
                        "[iroh-sync] Paired device {device_name} has no sync doc — re-pair required"
                    );
                    let _ = state_clone.app_handle.emit(
                        "sync-doc-missing",
                        serde_json::json!({
                            "deviceId": device_id,
                            "deviceName": device_name,
                        }),
                    );
                }
            }
        }

        let pairing_handler = PairingProtocolHandler {
            state: state_clone.clone(),
            host_key: endpoint.public_key,
        };

        let file_handler = crate::file_transfer::FileTransferHandler {
            data_dir: data_dir.clone(),
            allowlist: state_clone.allowlist.clone(),
        };

        let router = Router::builder(router_endpoint)
            .accept(iroh_blobs::ALPN, blobs_handler)
            .accept(iroh_gossip::ALPN, gossip)
            .accept(iroh_docs::ALPN, docs_handler)
            .accept(ALPN, pairing_handler)
            .accept(crate::file_transfer::ALPN_BYTES, file_handler)
            .spawn();

        let _ = cancel_rx.changed().await;
        eprintln!("[iroh-sync] Router shutdown requested");
        let _ = router.shutdown().await;

        // The engine's actor is now dead; drop the snapshot so no command
        // calls into the shutdown engine.
        *state_clone.docs_api.lock().await = None;
    });

    AcceptLoopHandle {
        cancel: cancel_tx,
        join,
    }
}

fn pair_error(message: &str) -> serde_json::Value {
    serde_json::json!({ "error": message })
}

async fn handle_pair_req<R: tauri::Runtime>(
    state: &Arc<SyncTransportState<R>>,
    host_key: &PublicKey,
    joiner_key: PublicKey,
    data: &serde_json::Value,
    remote_ip: String,
    remote_port: u16,
) -> serde_json::Value {
    let pairing_req: PairingRequest = match serde_json::from_value(data.clone()) {
        Ok(r) => r,
        Err(_) => return pair_error("The pairing request could not be read."),
    };

    match state.pairing.redeem(&pairing_req.secret) {
        PairingCheck::Accepted => {}
        PairingCheck::NoSession => {
            return pair_error(
                "This pairing code has expired or was already used. Show a new QR code on the other device.",
            )
        }
        PairingCheck::WrongSecret => return pair_error("This pairing code is not valid."),
    }

    // Ask the user on this device. The same code shows on the other device,
    // so someone who photographed the QR code cannot pair unnoticed.
    let code = sync_access::verification_code(host_key, &joiner_key, &pairing_req.secret);
    let request_id = sync_access::random_id();
    let (tx, rx) = tokio::sync::oneshot::channel();
    state
        .pairing_confirms
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(request_id.clone(), tx);
    let _ = state.app_handle.emit(
        "pairing-confirm-request",
        serde_json::json!({
            "requestId": request_id,
            "deviceName": pairing_req.device_name,
            "code": code,
        }),
    );
    let accepted = matches!(
        tokio::time::timeout(PAIRING_CONFIRM_TIMEOUT, rx).await,
        Ok(Ok(true))
    );
    state
        .pairing_confirms
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&request_id);
    let _ = state.app_handle.emit(
        "pairing-confirm-closed",
        serde_json::json!({ "requestId": request_id }),
    );
    if !accepted {
        return pair_error("Pairing was not accepted on the other device.");
    }

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    // The connection proves who the other device is; the request only claims it.
    let scanner_node_id = joiner_key.to_string();

    let paired = PairedDevice {
        device_id: pairing_req.device_id.clone(),
        device_name: pairing_req.device_name.clone(),
        iroh_node_id: scanner_node_id,

        last_ip: remote_ip.clone(),
        last_port: remote_port,
        paired_at: format!("{}Z", now),
        last_sync_at: None,
        fingerprint: pairing_req.fingerprint.clone(),
        peer_relay_url: pairing_req.relay_url.clone(),
        sync_doc_id: String::new(),
        sync_doc_ticket: String::new(),
    };

    let mut devices = state.paired_devices.lock().await;
    if !paired.iroh_node_id.is_empty() {
        let existing_by_key = devices
            .values()
            .find(|d| d.iroh_node_id == paired.iroh_node_id && d.device_id != paired.device_id)
            .map(|d| d.device_id.clone());
        if let Some(id) = existing_by_key {
            devices.remove(&id);
        }
    }
    if !paired.fingerprint.is_empty() {
        let old_id = devices
            .values()
            .find(|d| d.fingerprint == paired.fingerprint && d.device_id != paired.device_id)
            .map(|d| d.device_id.clone());
        if let Some(id) = old_id {
            devices.remove(&id);
        }
    }
    devices.insert(paired.device_id.clone(), paired);
    let _ = state.persist_paired(&devices);
    drop(devices);

    let sync_doc_ticket = {
        let snapshot_cloned = {
            let guard = state.docs_api.lock().await;
            guard.as_ref().map(|s| (s.api.clone(), s.blobs.clone()))
        };
        match snapshot_cloned {
            Some((api, blobs)) => match api.create().await {
                Ok(doc) => {
                    let doc_id = doc.id();
                    let ticket = doc
                        .share(
                            iroh_docs::api::protocol::ShareMode::Write,
                            Default::default(),
                        )
                        .await
                        .map(|t| t.to_string())
                        .unwrap_or_default();

                    subscribe_doc_events(state.app_handle.clone(), doc.clone(), blobs);

                    {
                        let mut peer_addr = iroh::EndpointAddr::new(joiner_key);
                        if !remote_ip.is_empty() && remote_port > 0 {
                            if let Ok(ip) = remote_ip.parse::<std::net::IpAddr>() {
                                peer_addr = peer_addr
                                    .with_ip_addr(std::net::SocketAddr::new(ip, remote_port));
                            }
                        }
                        if !pairing_req.relay_url.is_empty() {
                            if let Ok(url) = pairing_req.relay_url.parse::<iroh::RelayUrl>() {
                                peer_addr = peer_addr.with_relay_url(url);
                            }
                        }
                        let _ = doc.start_sync(vec![peer_addr]).await;
                    }

                    let mut devices = state.paired_devices.lock().await;
                    if let Some(device) = devices.get_mut(&pairing_req.device_id) {
                        device.sync_doc_id = doc_id.to_string();
                        device.sync_doc_ticket = ticket.clone();
                    }
                    let _ = state.persist_paired(&devices);
                    ticket
                }
                Err(_) => String::new(),
            },
            None => String::new(),
        }
    };

    if !sync_doc_ticket.is_empty() {
        #[derive(serde::Serialize, Clone)]
        struct PairedPayload {
            device_id: String,
            device_name: String,
        }
        let _ = state.app_handle.emit(
            "pairing-completed",
            PairedPayload {
                device_id: pairing_req.device_id.clone(),
                device_name: pairing_req.device_name.clone(),
            },
        );
    }

    let response = PairingResponse {
        device_id: state.device_id.clone(),
        device_name: state.device_name.clone(),
        fingerprint: sync_crypto::get_frontend_fingerprint()
            .unwrap_or_else(|| state.fingerprint.clone()),
        sync_doc_ticket,
        relay_url: crate::sync_commands::get_iroh_relay_url(),
    };

    serde_json::to_value(response)
        .unwrap_or_else(|e| serde_json::json!({"error": format!("to_value: {e}")}))
}

pub async fn send_pair_request(
    conn: &endpoint::Connection,
    req: &PairingRequest,
) -> Result<PairingResponse, String> {
    let (mut send, mut recv) = tokio::time::timeout(PAIRING_READ_TIMEOUT, conn.open_bi())
        .await
        .map_err(|_| "The other device did not respond.".to_string())?
        .map_err(|e| format!("open_bi: {e}"))?;
    let env = IrohEnvelope {
        msg_type: "pair".to_string(),
        data: serde_json::to_value(req).map_err(|e| format!("serialize req: {e}"))?,
    };
    send_on_bi(&mut send, &env).await?;
    // The other device's user has PAIRING_CONFIRM_TIMEOUT to accept.
    let resp_bytes = tokio::time::timeout(
        PAIRING_CONFIRM_TIMEOUT + PAIRING_READ_TIMEOUT,
        recv_from_bi(&mut recv),
    )
    .await
    .map_err(|_| "Pairing was not accepted in time.".to_string())??;
    let resp_env: IrohEnvelope =
        serde_json::from_slice(&resp_bytes).map_err(|e| format!("parse resp: {e}"))?;
    if let Some(err) = resp_env.data.get("error") {
        return Err(err.as_str().unwrap_or("pair error").to_string());
    }
    serde_json::from_value(resp_env.data).map_err(|e| format!("parse pair resp: {e}"))
}

pub fn load_paired_devices_from_disk(
    app_data_dir: &std::path::Path,
) -> HashMap<String, PairedDevice> {
    sync_persistence::load_paired_devices(app_data_dir)
}

#[cfg(test)]
mod pairing_tests {
    //! The pairing protocol between two real endpoints over loopback, with the
    //! user's answer on the host scripted.
    use super::*;
    use iroh::endpoint::presets;
    use tauri::Listener;

    struct Host {
        state: Arc<SyncTransportState<tauri::test::MockRuntime>>,
        router: Router,
        _dir: tempfile::TempDir,
        _app: tauri::App<tauri::test::MockRuntime>,
    }

    async fn host() -> Host {
        let app = tauri::test::mock_app();
        let dir = tempfile::tempdir().unwrap();
        let state = Arc::new(SyncTransportState {
            app_handle: app.handle().clone(),
            device_id: "host-device".into(),
            fingerprint: String::new(),
            device_name: "Host".into(),
            app_data_dir: dir.path().to_path_buf(),
            paired_devices: Mutex::new(HashMap::new()),
            docs_api: Mutex::new(None),
            docs_generation: std::sync::atomic::AtomicU64::new(0),
            allowlist: Arc::new(PeerAllowlist::default()),
            pairing: PairingSessions::default(),
            pairing_confirms: Default::default(),
        });
        let ep = iroh::Endpoint::builder(presets::Minimal)
            .hooks(PeerGate::new(state.allowlist.clone(), ALPN))
            .bind()
            .await
            .unwrap();
        let handler = PairingProtocolHandler {
            state: state.clone(),
            host_key: ep.id(),
        };
        let router = Router::builder(ep).accept(ALPN, handler).spawn();
        Host {
            state,
            router,
            _dir: dir,
            _app: app,
        }
    }

    /// Answers every approval prompt on the host with `accept`, and records
    /// the codes it was shown.
    fn answer_prompts(host: &Host, accept: bool) -> Arc<std::sync::Mutex<Vec<String>>> {
        let shown = Arc::new(std::sync::Mutex::new(Vec::new()));
        let (state, shown_in) = (host.state.clone(), shown.clone());
        host.state
            .app_handle
            .listen("pairing-confirm-request", move |event| {
                let payload: serde_json::Value = serde_json::from_str(event.payload()).unwrap();
                shown_in
                    .lock()
                    .unwrap()
                    .push(payload["code"].as_str().unwrap().to_string());
                let id = payload["requestId"].as_str().unwrap().to_string();
                if let Some(tx) = state.pairing_confirms.lock().unwrap().remove(&id) {
                    let _ = tx.send(accept);
                }
            });
        shown
    }

    async fn pair(
        joiner: &iroh::Endpoint,
        host: &Host,
        secret: &str,
        claimed_node_id: &str,
    ) -> Result<PairingResponse, String> {
        let conn = joiner
            .connect(host.router.endpoint().addr(), ALPN)
            .await
            .map_err(|e| e.to_string())?;
        let request = PairingRequest {
            device_id: "joiner-device".into(),
            device_name: "Joiner".into(),
            fingerprint: String::new(),
            node_id: claimed_node_id.into(),
            relay_url: String::new(),
            secret: secret.into(),
        };
        send_pair_request(&conn, &request).await
    }

    async fn paired_node_ids(host: &Host) -> Vec<String> {
        host.state
            .paired_devices
            .lock()
            .await
            .values()
            .map(|d| d.iroh_node_id.clone())
            .collect()
    }

    #[test]
    fn only_a_failed_teardown_still_counts_as_synced() {
        assert_eq!(sync_outcome(Ok((3, 2))), (true, 3, 2));
        assert!(sync_outcome(Err("Failed to close connection1")).0);
        assert!(sync_outcome(Err("Failed to close Some(ns) with Some(peer)")).0);
        for failure in [
            "Failed to establish connection",
            "Failed to sync",
            "Remote peer aborted sync: NotFound",
            "Failed to open replica with peer",
        ] {
            assert!(!sync_outcome(Err(failure)).0, "{failure}");
        }
    }

    #[tokio::test]
    async fn the_right_secret_and_an_accept_pair_the_real_identity() {
        let host = host().await;
        let shown = answer_prompts(&host, true);
        let joiner = iroh::Endpoint::bind(presets::Minimal).await.unwrap();
        let secret = host.state.pairing.open();

        // The joiner claims another device's identity; the host ignores it.
        let impostor = iroh::SecretKey::from_bytes(&[9; 32]).public().to_string();
        let response = pair(&joiner, &host, &secret, &impostor).await.unwrap();
        assert_eq!(response.device_id, "host-device");
        assert_eq!(paired_node_ids(&host).await, vec![joiner.id().to_string()]);
        assert!(host.state.allowlist.is_allowed(&joiner.id()));

        // The host showed the code the joiner computes on its side.
        let expected =
            sync_access::verification_code(&host.router.endpoint().id(), &joiner.id(), &secret);
        assert_eq!(*shown.lock().unwrap(), vec![expected]);

        // The secret is used up.
        let other = iroh::Endpoint::bind(presets::Minimal).await.unwrap();
        let err = pair(&other, &host, &secret, "").await.unwrap_err();
        assert!(err.contains("expired or was already used"), "{err}");
        assert!(!host.state.allowlist.is_allowed(&other.id()));
        host.router.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn a_declined_request_pairs_nothing() {
        let host = host().await;
        answer_prompts(&host, false);
        let joiner = iroh::Endpoint::bind(presets::Minimal).await.unwrap();
        let secret = host.state.pairing.open();
        let err = pair(&joiner, &host, &secret, "").await.unwrap_err();
        assert!(err.contains("not accepted"), "{err}");
        assert!(paired_node_ids(&host).await.is_empty());
        assert!(!host.state.allowlist.is_allowed(&joiner.id()));
        host.router.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn wrong_or_missing_secrets_never_reach_the_user() {
        let host = host().await;
        let shown = answer_prompts(&host, true);
        let joiner = iroh::Endpoint::bind(presets::Minimal).await.unwrap();

        // No QR code on screen.
        let err = pair(&joiner, &host, &"0".repeat(64), "").await.unwrap_err();
        assert!(err.contains("expired"), "{err}");

        let secret = host.state.pairing.open();
        for guess in ["", "nothex", &"0".repeat(64)] {
            let err = pair(&joiner, &host, guess, "").await.unwrap_err();
            assert!(err.contains("not valid"), "{err}");
        }
        assert!(shown.lock().unwrap().is_empty());
        assert!(paired_node_ids(&host).await.is_empty());

        // Still within the attempt limit, the real secret works.
        pair(&joiner, &host, &secret, "").await.unwrap();
        assert_eq!(shown.lock().unwrap().len(), 1);
        host.router.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn an_oversized_message_is_refused_without_allocating_it() {
        let host = host().await;
        let joiner = iroh::Endpoint::bind(presets::Minimal).await.unwrap();
        let conn = joiner
            .connect(host.router.endpoint().addr(), ALPN)
            .await
            .unwrap();
        let (mut send, mut recv) = conn.open_bi().await.unwrap();
        // Claims 4 GiB, then sends a little.
        send.write_all(&u32::MAX.to_be_bytes()).await.unwrap();
        send.write_all(b"{}").await.unwrap();
        let _ = send.finish();
        // The host drops the stream without answering.
        let reply = tokio::time::timeout(std::time::Duration::from_secs(5), recv.read_to_end(1024))
            .await
            .expect("host answered or hung");
        assert!(reply.map(|r| r.is_empty()).unwrap_or(true));
        assert!(paired_node_ids(&host).await.is_empty());
        host.router.shutdown().await.unwrap();
    }
}
