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
struct EntryBatcher {
    app: tauri::AppHandle,
    entries: std::sync::Mutex<Vec<EntryPayload>>,
    flush_scheduled: std::sync::atomic::AtomicBool,
}

impl EntryBatcher {
    const FLUSH_DELAY_MS: u64 = 300;
    const MAX_BATCH: usize = 64;

    fn new(app: tauri::AppHandle) -> Arc<Self> {
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

pub struct SyncTransportState {
    pub app_handle: tauri::AppHandle,
    pub device_id: String,
    pub fingerprint: String,
    pub device_name: String,
    pub app_data_dir: PathBuf,
    pub paired_devices: Mutex<HashMap<String, PairedDevice>>,
    pub docs_api: Mutex<Option<DocsApiSnapshot>>,
    /// Incremented each time an accept loop spawns; lets readers detect a
    /// snapshot that outlived its engine (stale generation = dead actor).
    pub docs_generation: std::sync::atomic::AtomicU64,
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
    peers: Mutex<HashMap<String, IrohPeerInfo>>,
}

impl IrohSyncEndpoint {
    pub async fn new(
        key_path: &PathBuf,
        device_id: String,
        device_name: String,
        fingerprint: String,
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
            .relay_mode(RelayMode::Default);

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
            peers: Mutex::new(HashMap::new()),
        })
    }

    pub fn public_key_string(&self) -> String {
        self.public_key.to_string()
    }

    pub async fn add_peer(&self, peer: IrohPeerInfo) {
        self.peers.lock().await.insert(peer.device_id.clone(), peer);
    }

    pub async fn close(&self) {
        self.endpoint.close().await;
    }
}

pub fn load_or_create_key(path: &PathBuf) -> Result<SecretKey, String> {
    if let Ok(bytes) = std::fs::read(path) {
        if let Ok(arr) = <[u8; 32]>::try_from(bytes) {
            return Ok(SecretKey::from_bytes(&arr));
        }
    }
    let key = SecretKey::generate();
    if let Some(p) = path.parent() {
        std::fs::create_dir_all(p).ok();
    }
    std::fs::write(path, key.to_bytes()).map_err(|e| e.to_string())?;
    Ok(key)
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

async fn recv_from_bi(recv: &mut iroh::endpoint::RecvStream) -> Result<Vec<u8>, String> {
    let mut lb = [0u8; 4];
    recv.read_exact(&mut lb)
        .await
        .map_err(|e| format!("read len: {e}"))?;
    let len = u32::from_be_bytes(lb) as usize;
    let mut buf = vec![0u8; len];
    recv.read_exact(&mut buf)
        .await
        .map_err(|e| format!("read body: {e}"))?;
    Ok(buf)
}

pub fn subscribe_doc_events(
    app: tauri::AppHandle,
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
            use futures::StreamExt;
            let mut pending: std::collections::HashMap<iroh_blobs::Hash, String> =
                std::collections::HashMap::new();

            while let Some(event) = stream.next().await {
                match event {
                    Ok(LiveEvent::InsertRemote { entry, .. }) => {
                        let key = String::from_utf8_lossy(entry.key()).to_string();
                        let hash = entry.content_hash();
                        if let Ok(content) = blobs.blobs().get_bytes(hash).await {
                            if let Ok(value) = String::from_utf8(content.to_vec()) {
                                batcher.push(key.clone(), value);
                                pending.insert(hash, key);
                            }
                        } else {
                            pending.insert(hash, key);
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
                        }
                        let _ = app.emit(
                            "docs-sync-finished",
                            SyncFinishedPayload {
                                peer: event.peer.to_string(),
                                synced: true,
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

#[derive(Clone)]
pub struct PairingProtocolHandler {
    pub state: Arc<SyncTransportState>,
}

impl std::fmt::Debug for PairingProtocolHandler {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PairingProtocolHandler").finish()
    }
}

impl ProtocolHandler for PairingProtocolHandler {
    async fn accept(&self, conn: endpoint::Connection) -> Result<(), iroh::protocol::AcceptError> {
        loop {
            let stream = conn.accept_bi().await;
            let (mut send, mut recv) = match stream {
                Ok(s) => s,
                Err(_) => break,
            };

            let req_bytes = match recv_from_bi(&mut recv).await {
                Ok(b) => b,
                Err(_) => break,
            };

            let env: IrohEnvelope = match serde_json::from_slice(&req_bytes) {
                Ok(e) => e,
                Err(_) => {
                    let empty = serde_json::json!({});
                    if let Ok(json) = serde_json::to_vec(&empty) {
                        let len = (json.len() as u32).to_be_bytes();
                        let _ = send.write_all(&len).await;
                        let _ = send.write_all(&json).await;
                        let _ = send.finish();
                    }
                    continue;
                }
            };

            if env.msg_type != "pair" {
                continue;
            }

            let resp_val = handle_pair_req(&self.state, &env.data).await;
            let resp_env = IrohEnvelope {
                msg_type: "pair_resp".to_string(),
                data: resp_val,
            };
            if let Ok(resp_json) = serde_json::to_vec(&resp_env) {
                let len = (resp_json.len() as u32).to_be_bytes();
                let _ = send.write_all(&len).await;
                let _ = send.write_all(&resp_json).await;
                let _ = send.finish();
            }
        }
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
        let blobs = match iroh_blobs::store::fs::FsStore::load(&blobs_path).await {
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
        let docs_handler = match iroh_docs::protocol::Docs::persistent(docs_path.clone())
            .spawn(router_endpoint.clone(), blobs_store, gossip.clone())
            .await
        {
            Ok(d) => d,
            Err(e) => {
                eprintln!("[iroh-sync] Failed to spawn iroh-docs: {e}");

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
                                let _ = save_paired_devices_to_disk(
                                    &state_clone.app_data_dir,
                                    &devices,
                                );
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
        };

        let file_handler = crate::file_transfer::FileTransferHandler {
            data_dir: data_dir.clone(),
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

async fn handle_pair_req(
    state: &Arc<SyncTransportState>,
    data: &serde_json::Value,
) -> serde_json::Value {
    let pairing_req: PairingRequest = match serde_json::from_value(data.clone()) {
        Ok(r) => r,
        Err(e) => return serde_json::json!({"error": format!("parse pair req: {e}")}),
    };

    if pairing_req.node_id.is_empty() {
        return serde_json::json!({"error": "pairing request missing node_id"});
    }

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let scanner_node_id = pairing_req.node_id.clone();

    let paired = PairedDevice {
        device_id: pairing_req.device_id.clone(),
        device_name: pairing_req.device_name.clone(),
        iroh_node_id: scanner_node_id,

        last_ip: String::new(),
        last_port: 0,
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
    let _ = save_paired_devices_to_disk(&state.app_data_dir, &devices);
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

                    if let Ok(peer_pk) = pairing_req.node_id.parse::<iroh::PublicKey>() {
                        let peer_addr = iroh::EndpointAddr::new(peer_pk);
                        let _ = doc.start_sync(vec![peer_addr]).await;
                    }

                    let mut devices = state.paired_devices.lock().await;
                    if let Some(device) = devices.get_mut(&pairing_req.device_id) {
                        device.sync_doc_id = doc_id.to_string();
                        device.sync_doc_ticket = ticket.clone();
                    }
                    let _ = save_paired_devices_to_disk(&state.app_data_dir, &devices);
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
    let (mut send, mut recv) = conn.open_bi().await.map_err(|e| format!("open_bi: {e}"))?;
    let env = IrohEnvelope {
        msg_type: "pair".to_string(),
        data: serde_json::to_value(req).map_err(|e| format!("serialize req: {e}"))?,
    };
    send_on_bi(&mut send, &env).await?;
    let resp_bytes = recv_from_bi(&mut recv).await?;
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

pub fn save_paired_devices_to_disk(
    app_data_dir: &std::path::Path,
    devices: &HashMap<String, PairedDevice>,
) -> Result<(), String> {
    sync_persistence::save_paired_devices(app_data_dir, devices)
}
