//! Shared bottom-layer sync transport state and metadata helpers.
//!
//! Kept free of upward dependencies on `sync_annotations`, `file_transfer`,
//! `iroh_sync`, and `sync_commands` so the sync subsystem forms an acyclic
//! dependency graph.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use iroh::endpoint::{presets::N0, RelayMode};
use iroh::{PublicKey, SecretKey};
use iroh_mdns_address_lookup::MdnsAddressLookup;
use tauri::{Emitter, Manager};
use theorem_sync_core::sync_crypto;
use theorem_sync_core::sync_persistence;
use theorem_sync_core::sync_protocol::PairedDevice;
use tokio::sync::Mutex;

use crate::sync_access::{PairingSessions, PeerAllowlist, PeerGate};

pub const ALPN: &[u8] = b"theorem-sync/v1";
pub const ALPN_BYTES: &[u8] = ALPN;

/// How long a connection may go silent before it counts as gone. iroh sends
/// a keep-alive every 5 s, so a live device never gets near this; a device
/// that vanished (app killed, out of range) is reported offline after it,
/// instead of after QUIC's default 30 s.
pub const CONNECTION_IDLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(12);

/// Whole-list entries from before one entry per item (`SYNC_PROTOCOL` 2).
/// They are written only to docs shared with devices on older versions,
/// which read nothing else, and removed from the others.
pub(crate) const LEGACY_LIST_KEYS: &[&str] = &[
    "annotations",
    "collections",
    "deletion_tombstones",
    "vocabulary",
    "rss_feeds",
    "rss_articles",
];

pub(crate) fn is_legacy_list_key(key: &str) -> bool {
    LEGACY_LIST_KEYS.contains(&key)
}

/// Whether a device on `protocol` still reads whole-list entries.
pub(crate) fn reads_legacy_lists(protocol: u8) -> bool {
    protocol < 2
}

pub(crate) fn transport_config() -> iroh::endpoint::QuicTransportConfig {
    let builder = iroh::endpoint::QuicTransportConfig::builder();
    match CONNECTION_IDLE_TIMEOUT.try_into() {
        Ok(idle) => builder.max_idle_timeout(Some(idle)),
        Err(_) => builder,
    }
    .build()
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct IrohPeerInfo {
    pub public_key: PublicKey,
    pub device_id: String,
    pub device_name: String,
    pub fingerprint: String,
}

#[derive(Clone)]
pub struct DocsApiSnapshot {
    pub api: iroh_docs::api::DocsApi,
    pub author: iroh_docs::AuthorId,
    pub blobs: iroh_blobs::api::Store,
    /// This device's deletions in its docs (`sync_deletions`).
    pub own_deletions: Arc<crate::sync_deletions::OwnDeletions>,
    /// Generation of the accept loop that produced this snapshot.
    pub generation: u64,
}

/// Generic over the Tauri runtime only so tests can use the mock runtime.
pub struct SyncTransportState<R: tauri::Runtime = tauri::Wry> {
    pub app_handle: tauri::AppHandle<R>,
    pub device_id: String,
    pub fingerprint: String,
    /// What paired devices see; the user can rename it (`set_device_name`).
    pub device_name: std::sync::RwLock<String>,
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
    pub fn device_name(&self) -> String {
        self.device_name
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// Saves the paired devices and updates who may connect. Every change to
    /// `paired_devices` goes through here so the two never disagree.
    pub fn persist_paired(&self, devices: &HashMap<String, PairedDevice>) -> Result<(), String> {
        self.allowlist.set_paired(devices);
        sync_persistence::save_paired_devices(&self.app_data_dir, devices)
    }

    /// Insert or replace a paired device, removing superseded node-key/fingerprint
    /// records and queueing any replaced/unused `sync_doc_id`s for cleanup.
    pub fn upsert_paired_device(
        &self,
        devices: &mut HashMap<String, PairedDevice>,
        paired: PairedDevice,
    ) {
        let mut dropped_doc_ids: Vec<String> = Vec::new();
        if !paired.iroh_node_id.is_empty() {
            let existing_by_key = devices
                .values()
                .find(|d| d.iroh_node_id == paired.iroh_node_id && d.device_id != paired.device_id)
                .map(|d| d.device_id.clone());
            if let Some(id) = existing_by_key {
                if let Some(old) = devices.remove(&id) {
                    if !old.sync_doc_id.is_empty() {
                        dropped_doc_ids.push(old.sync_doc_id);
                    }
                }
            }
        }
        if !paired.fingerprint.is_empty() {
            let old_id = devices
                .values()
                .find(|d| d.fingerprint == paired.fingerprint && d.device_id != paired.device_id)
                .map(|d| d.device_id.clone());
            if let Some(id) = old_id {
                if let Some(old) = devices.remove(&id) {
                    if !old.sync_doc_id.is_empty() {
                        dropped_doc_ids.push(old.sync_doc_id);
                    }
                }
            }
        }
        let next_doc_id = paired.sync_doc_id.clone();
        if let Some(prev) = devices.insert(paired.device_id.clone(), paired) {
            if !prev.sync_doc_id.is_empty() && prev.sync_doc_id != next_doc_id {
                dropped_doc_ids.push(prev.sync_doc_id);
            }
        }
        if !dropped_doc_ids.is_empty() {
            let mut to_drop = sync_persistence::load_docs_to_drop(&self.app_data_dir);
            let mut changed = false;
            for old_doc_id in dropped_doc_ids {
                if !devices.values().any(|d| d.sync_doc_id == old_doc_id)
                    && !to_drop.contains(&old_doc_id)
                {
                    to_drop.push(old_doc_id);
                    changed = true;
                }
            }
            if changed {
                let _ = sync_persistence::save_docs_to_drop(&self.app_data_dir, &to_drop);
            }
        }
    }
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
            .transport_config(transport_config())
            .hooks(PeerGate::new(allowlist, ALPN));

        let builder = if std::env::var("THEOREM_DISABLE_MDNS").is_err() {
            builder.address_lookup(MdnsAddressLookup::builder())
        } else {
            log::info!("[iroh-sync] mDNS disabled via THEOREM_DISABLE_MDNS env var");
            builder
        };
        let endpoint = builder
            .bind()
            .await
            .map_err(|e| format!("iroh bind: {e}"))?;
        let peer_info = IrohPeerInfo {
            public_key,
            device_id,
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
                log::warn!(
                    "[iroh-sync] Sync key file is malformed; keeping it as iroh-key.corrupt"
                );
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

pub fn load_paired_devices_from_disk(
    app_data_dir: &std::path::Path,
) -> HashMap<String, PairedDevice> {
    sync_persistence::load_paired_devices(app_data_dir)
}

/// Handle to a running accept loop: a cancel signal plus the task handle so
/// callers can wait for the loop (and its iroh-docs engine) to actually stop.
pub struct AcceptLoopHandle {
    pub cancel: tokio::sync::watch::Sender<bool>,
    pub join: tokio::task::JoinHandle<()>,
}

pub(crate) static IROH_ENDPOINT: std::sync::Mutex<Option<Arc<IrohSyncEndpoint>>> =
    std::sync::Mutex::new(None);
pub(crate) static IROH_START_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

pub struct SyncState {
    pub transport_state: Arc<SyncTransportState>,
    pub(crate) accept_cancel: Mutex<Option<AcceptLoopHandle>>,
    pub(crate) restart_sync: Option<fn(tauri::AppHandle)>,
}

impl SyncState {
    pub fn new(
        transport_state: Arc<SyncTransportState>,
        restart_sync: Option<fn(tauri::AppHandle)>,
    ) -> Self {
        Self {
            transport_state,
            accept_cancel: Mutex::new(None),
            restart_sync,
        }
    }
}

pub(crate) fn get_sync_state(
    app: &tauri::AppHandle,
) -> Result<tauri::State<'_, SyncState>, String> {
    app.try_state::<SyncState>().ok_or_else(|| {
        "Sync subsystem is not initialized. Sync features are unavailable on this device."
            .to_string()
    })
}

pub(crate) async fn get_or_init_iroh(
    app: &tauri::AppHandle,
) -> Result<Arc<IrohSyncEndpoint>, String> {
    if let Some(ep) = IROH_ENDPOINT
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
    {
        return Ok(ep);
    }

    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    let key_path = data_dir.join("iroh-key");
    let sync_state = get_sync_state(app)?;
    let ep = Arc::new(
        IrohSyncEndpoint::new(
            &key_path,
            sync_state.transport_state.device_id.clone(),
            sync_state.transport_state.device_name(),
            sync_crypto::get_frontend_fingerprint()
                .unwrap_or_else(|| sync_state.transport_state.fingerprint.clone()),
            sync_state.transport_state.allowlist.clone(),
        )
        .await?,
    );
    let mut guard = IROH_ENDPOINT.lock().unwrap_or_else(|e| e.into_inner());
    // Return the cached endpoint so every caller talks to the same transport
    // the accept loop uses (a concurrently-built endpoint would be orphaned).
    Ok(guard.get_or_insert(ep).clone())
}

pub fn get_iroh_relay_url() -> String {
    IROH_ENDPOINT
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .and_then(|ep| {
            ep.endpoint
                .addr()
                .relay_urls()
                .collect::<Vec<_>>()
                .first()
                .map(|u| u.to_string())
        })
        .unwrap_or_default()
}

pub(crate) async fn get_docs_snapshot(app: &tauri::AppHandle) -> Result<DocsApiSnapshot, String> {
    let sync_state = get_sync_state(app)?;
    for i in 0..50 {
        {
            let guard = sync_state.transport_state.docs_api.lock().await;
            if let Some(ref snapshot) = *guard {
                // The snapshot belongs to the current accept loop; a stale
                // generation means its engine has been shut down. Fail fast so
                // get_docs_api_or_init restarts the engine instead of waiting.
                if snapshot.generation
                    != sync_state
                        .transport_state
                        .docs_generation
                        .load(std::sync::atomic::Ordering::SeqCst)
                {
                    return Err("iroh-docs engine is stale — restarting".to_string());
                }
                return Ok(snapshot.clone());
            }
        }
        if i < 49 {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
    }
    Err("iroh-docs not initialized after 5s wait".to_string())
}

pub(crate) async fn get_docs_api(
    app: &tauri::AppHandle,
) -> Result<iroh_docs::api::DocsApi, String> {
    Ok(get_docs_snapshot(app).await?.api)
}

pub(crate) async fn get_docs_author(app: &tauri::AppHandle) -> Result<iroh_docs::AuthorId, String> {
    Ok(get_docs_snapshot(app).await?.author)
}

pub(crate) async fn get_blobs_store(
    app: &tauri::AppHandle,
) -> Result<iroh_blobs::api::Store, String> {
    Ok(get_docs_snapshot(app).await?.blobs)
}

/// Removes this device's whole-list entries from the doc shared with a device
/// that no longer reads them (it reported `SYNC_PROTOCOL` 2 or later).
pub(crate) async fn drop_legacy_lists(app: &tauri::AppHandle, device_id: &str) {
    let doc_id = {
        let Ok(sync_state) = get_sync_state(app) else {
            return;
        };
        let devices = sync_state.transport_state.paired_devices.lock().await;
        match devices
            .get(device_id)
            .and_then(|d| d.sync_doc_id.parse::<iroh_docs::NamespaceId>().ok())
        {
            Some(id) => id,
            None => return,
        }
    };
    let Ok(snapshot) = get_docs_snapshot(app).await else {
        return;
    };
    let Ok(Some(doc)) = snapshot.api.open(doc_id).await else {
        return;
    };
    for key in LEGACY_LIST_KEYS {
        if !matches!(
            doc.get_exact(snapshot.author, key.as_bytes(), false).await,
            Ok(Some(_))
        ) {
            continue;
        }
        if *key == "vocabulary" {
            let mut longer = false;
            if let Ok(stream) = doc
                .get_many(
                    iroh_docs::store::Query::author(snapshot.author)
                        .key_prefix(b"vocabulary:")
                        .limit(1)
                        .build(),
                )
                .await
            {
                use futures::StreamExt;
                futures::pin_mut!(stream);
                longer = stream.next().await.is_some();
            }
            if longer {
                continue;
            }
        }
        if let Err(e) = doc.del(snapshot.author, key.as_bytes().to_vec()).await {
            log::warn!("[iroh-sync] could not remove the old {key} list: {e}");
        }
    }
}

/// Removes a paired device locally and returns whether the accept loop was running.
pub(crate) async fn forget_device_local(
    app: &tauri::AppHandle,
    device_id: &str,
    removed_by_peer: bool,
) -> Result<bool, String> {
    let sync_state = get_sync_state(app)?;
    let removed = {
        let mut devices = sync_state.transport_state.paired_devices.lock().await;
        let removed = devices
            .remove(device_id)
            .ok_or_else(|| format!("Device {} not found", device_id))?;
        sync_state.transport_state.persist_paired(&devices)?;
        removed
    };
    if let Ok(node) = removed.iroh_node_id.parse::<iroh::PublicKey>() {
        sync_state.transport_state.allowlist.forget_pending(&node);
    }
    if !removed.sync_doc_id.is_empty() {
        let dir = &sync_state.transport_state.app_data_dir;
        let mut to_drop = sync_persistence::load_docs_to_drop(dir);
        if !to_drop.contains(&removed.sync_doc_id) {
            to_drop.push(removed.sync_doc_id.clone());
        }
        sync_persistence::save_docs_to_drop(dir, &to_drop)?;
    }
    if removed_by_peer {
        log::info!(
            "[iroh-sync] {} removed this device; forgetting it here too",
            removed.device_id
        );
        let _ = app.emit(
            "sync-peer-removed",
            serde_json::json!({
                "deviceId": removed.device_id,
                "deviceName": removed.device_name,
            }),
        );
    }
    let _ = app.emit("paired-devices-changed", ());
    let was_running = sync_state.accept_cancel.lock().await.is_some();
    Ok(was_running)
}

pub(crate) async fn forget_device_from_peer(
    app: &tauri::AppHandle,
    device_id: &str,
) -> Result<(), String> {
    let was_running = forget_device_local(app, device_id, true).await?;
    if was_running {
        if let Some(restart) = get_sync_state(app)?.restart_sync {
            restart(app.clone());
        }
    }
    Ok(())
}

/// What a paired device said about itself in a hello: its current name and
/// protocol. Saved when they changed.
pub(crate) async fn note_peer_hello(
    app: &tauri::AppHandle,
    device_id: &str,
    hello: &theorem_sync_core::sync_protocol::PeerHello,
) {
    let Ok(sync_state) = get_sync_state(app) else {
        return;
    };
    let name = theorem_sync_core::sync_protocol::clean_device_name(&hello.name);
    let mut upgraded = false;
    let changed = {
        let mut devices = sync_state.transport_state.paired_devices.lock().await;
        let Some(device) = devices.get_mut(device_id) else {
            return;
        };
        let mut changed = false;
        if let Some(name) = name.filter(|n| *n != device.device_name) {
            device.device_name = name;
            changed = true;
        }
        if hello.protocol != device.protocol {
            upgraded = reads_legacy_lists(device.protocol) && !reads_legacy_lists(hello.protocol);
            device.protocol = hello.protocol;
            changed = true;
        }
        if changed {
            let _ = sync_state.transport_state.persist_paired(&devices);
        }
        changed
    };
    if upgraded {
        drop_legacy_lists(app, device_id).await;
    }
    if changed {
        let _ = app.emit("paired-devices-changed", ());
    }
}

/// An item whose newest doc entry is a deletion, and when it was deleted
/// (ms since the epoch, by the deleting device's clock).
#[derive(serde::Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeletedDocKey {
    pub key: String,
    pub at: u64,
}

/// A doc entry's content, when it is here (complete and text).
pub(crate) async fn content_of(
    blobs: &iroh_blobs::api::Store,
    hash: iroh_blobs::Hash,
) -> Option<String> {
    if !matches!(
        blobs.blobs().status(hash).await,
        Ok(iroh_blobs::api::blobs::BlobStatus::Complete { .. })
    ) {
        return None;
    }
    let content = blobs.blobs().get_bytes(hash).await.ok()?;
    String::from_utf8(content.to_vec()).ok()
}

/// Keys of items the app deletes when another device deleted them. (Covers
/// go with their book; deletion records and lists are not items.)
pub(crate) fn is_deletable_key(key: &str) -> bool {
    [
        "book:",
        "anno:",
        "annotation:",
        "collection:",
        "rss_article:",
        "rss_feed:",
        "vocab:",
        "vocabulary:",
    ]
    .iter()
    .any(|prefix| key.starts_with(prefix))
}

pub(crate) fn stamp_of(record: &serde_json::Value) -> Option<i64> {
    const STAMPS: [&str; 7] = [
        "coverUpdatedAt",
        "metadataUpdatedAt",
        "updatedAt",
        "lastReadAt",
        "deletedAt",
        "addedAt",
        "createdAt",
    ];
    STAMPS
        .iter()
        .filter_map(|field| match record.get(*field)? {
            serde_json::Value::Number(n) => n.as_i64(),
            serde_json::Value::String(s) => chrono::DateTime::parse_from_rfc3339(s)
                .ok()
                .map(|d| d.timestamp_millis()),
            _ => None,
        })
        .max()
}

pub(crate) fn record_stamp(value: &str) -> Option<i64> {
    let record: serde_json::Value = serde_json::from_str(value).ok()?;
    stamp_of(&record)
}

/// A record's own `id` (when it is a string) and its stamp (`stamp_of`);
/// `None` when it is not a JSON object.
pub(crate) fn record_meta(value: &str) -> Option<(Option<String>, Option<i64>)> {
    let record: serde_json::Value = serde_json::from_str(value).ok()?;
    if !record.is_object() {
        return None;
    }
    let id = record.get("id").and_then(|v| v.as_str()).map(String::from);
    Some((id, stamp_of(&record)))
}
