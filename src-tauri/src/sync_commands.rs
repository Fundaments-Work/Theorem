use crate::iroh_sync::{self, DocsApiSnapshot, IrohSyncEndpoint, SyncTransportState};
use theorem_sync_core::sync_crypto;
use theorem_sync_core::sync_protocol::{
    DeviceIdentityInfo, PairedDevice, PairedDeviceInfo, PairingQrData, PairingQrPayload,
    PairingRequest,
};

use std::path::PathBuf;
use std::sync::Arc;
use tauri::Emitter;
use tauri::Manager;
use tokio::sync::Mutex;

static IROH_ENDPOINT: std::sync::Mutex<Option<Arc<IrohSyncEndpoint>>> = std::sync::Mutex::new(None);

static IROH_START_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

pub struct SyncState {
    pub transport_state: Arc<SyncTransportState>,
    accept_cancel: Mutex<Option<iroh_sync::AcceptLoopHandle>>,
}

pub fn init_sync(app_data_dir: PathBuf, app_handle: tauri::AppHandle) -> Result<SyncState, String> {
    let key_path = app_data_dir.join("iroh-key");
    let secret_key = crate::iroh_sync::load_or_create_key(&key_path)?;
    let public_key_bytes = *secret_key.public().as_bytes();
    let device_id = sync_crypto::compute_device_id(&public_key_bytes);
    let fingerprint = sync_crypto::read_machine_fingerprint();

    let device_name = theorem_sync_core::sync_persistence::load_device_name(&app_data_dir)
        .unwrap_or_else(crate::device_name::system_device_name);
    // The name is often the host name: kept out of the log.
    log::info!("[sync] Device name loaded");

    let paired_devices = iroh_sync::load_paired_devices_from_disk(&app_data_dir);
    let allowlist = Arc::new(crate::sync_access::PeerAllowlist::from_devices(
        &paired_devices,
    ));

    let transport_state = Arc::new(SyncTransportState {
        app_handle,
        device_id,
        fingerprint,
        device_name: std::sync::RwLock::new(device_name),
        app_data_dir,
        paired_devices: Mutex::new(paired_devices),
        docs_api: Mutex::new(None),
        docs_generation: std::sync::atomic::AtomicU64::new(0),
        allowlist,
        pairing: Default::default(),
        pairing_confirms: Default::default(),
    });

    Ok(SyncState {
        transport_state,
        accept_cancel: Mutex::new(None),
    })
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

/// How long `iroh_start` waits for a running engine before giving up for now.
const ENGINE_START_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(45);

/// Pairing codes carry a one-time secret from version 2 on.
const PAIRING_VERSION: u8 = 2;

const PAIRING_CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

#[derive(serde::Serialize)]
pub struct IrohNodeIdResponse {
    pub node_id: String,
    pub device_id: String,
    pub fingerprint: String,
}

#[tauri::command]
pub async fn iroh_start(app: tauri::AppHandle) -> Result<IrohNodeIdResponse, String> {
    let _init_lock = IROH_START_LOCK.lock().await;

    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    let sync_state = get_sync_state(&app)?;

    // iroh-docs 0.101 persists the CRDT replica to `docs.redb`; older releases
    // used `db.redb` (purged separately in iroh_sync.rs). Only the current
    // filename is size-checked so the growth cap actually fires.
    let docs_db_path = data_dir.join("iroh-docs").join("docs.redb");
    const MAX_DB_BYTES: u64 = 100 * 1024 * 1024;
    if let Ok(meta) = std::fs::metadata(&docs_db_path) {
        if meta.len() > MAX_DB_BYTES {
            log::warn!(
                "[iroh-sync] redb database is {} MB — exceeding {} MB threshold. Wiping and recreating...",
                meta.len() / (1024 * 1024),
                MAX_DB_BYTES / (1024 * 1024)
            );
            // Stop a running engine before deleting its files, otherwise the
            // wipe would remove the redb/blobs out from under it.
            if let Some(handle) = sync_state.accept_cancel.lock().await.take() {
                let _ = handle.cancel.send(true);
                let _ = tokio::time::timeout(std::time::Duration::from_secs(10), handle.join).await;
            }
            *sync_state.transport_state.docs_api.lock().await = None;
            let blobs_path = data_dir.join("iroh-blobs");
            let docs_path = data_dir.join("iroh-docs");
            let _ = std::fs::remove_dir_all(&blobs_path);
            let _ = std::fs::remove_dir_all(&docs_path);
        }
    }

    for attempt in 0..2 {
        let ep = get_or_init_iroh(&app).await?;

        {
            let mut cancel_guard = sync_state.accept_cancel.lock().await;
            if cancel_guard.is_none() {
                let transport = sync_state.transport_state.clone();
                let ep_clone = ep.clone();
                let handle = iroh_sync::start_accept_loop(ep_clone, transport);
                *cancel_guard = Some(handle);
            } else if attempt > 0 {
                // The first attempt's loop is still running (it failed to
                // initialize docs_api). Stop it and wait for its engine to
                // fully shut down before starting a fresh loop, so the two
                // loops can't race writing docs_api.
                if let Some(old) = cancel_guard.take() {
                    let _ = old.cancel.send(true);
                    let _ =
                        tokio::time::timeout(std::time::Duration::from_secs(10), old.join).await;
                }
                *sync_state.transport_state.docs_api.lock().await = None;
                let transport = sync_state.transport_state.clone();
                let ep_clone = ep.clone();
                let handle = iroh_sync::start_accept_loop(ep_clone, transport);
                *cancel_guard = Some(handle);
            }
        }

        // Wait for the engine. A slow start (a phone waking the app) is not
        // a broken database: only a loop that exited has given up.
        let mut waited = std::time::Duration::ZERO;
        loop {
            if sync_state
                .transport_state
                .docs_api
                .try_lock()
                .map(|g| g.is_some())
                .unwrap_or(false)
            {
                return Ok(IrohNodeIdResponse {
                    node_id: ep.public_key_string(),
                    device_id: ep.peer_info.device_id.clone(),
                    fingerprint: ep.peer_info.fingerprint.clone(),
                });
            }
            let loop_exited = sync_state
                .accept_cancel
                .lock()
                .await
                .as_ref()
                .is_none_or(|h| h.join.is_finished());
            if loop_exited || waited >= ENGINE_START_TIMEOUT {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            waited += std::time::Duration::from_millis(100);
        }

        let loop_exited = sync_state
            .accept_cancel
            .lock()
            .await
            .as_ref()
            .is_none_or(|h| h.join.is_finished());
        if !loop_exited {
            // Still starting: never delete the sync data of a working engine.
            return Err("Sync is still starting; it will be retried".to_string());
        }

        if attempt == 0 {
            // The accept loop already removed the database it could not open.
            log::warn!("[iroh-sync] Sync engine failed to start — retrying with a fresh database");

            let old_ep = IROH_ENDPOINT
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone();
            if let Some(ep) = old_ep {
                ep.close().await;
            }
            *IROH_ENDPOINT.lock().unwrap_or_else(|e| e.into_inner()) = None;
        }
    }

    Err("iroh-docs not initialized after 5s wait".to_string())
}

#[tauri::command]
pub async fn iroh_stop(app: tauri::AppHandle) -> Result<(), String> {
    let _stop_lock = IROH_START_LOCK.lock().await;
    let sync_state = get_sync_state(&app)?;
    if let Some(handle) = sync_state.accept_cancel.lock().await.take() {
        let _ = handle.cancel.send(true);
        // Wait for the accept loop and its iroh-docs engine to stop before we
        // drop the endpoint, so nothing is left referencing a dead engine.
        let _ = tokio::time::timeout(std::time::Duration::from_secs(10), handle.join).await;
    }
    // The engine is shutting down; drop the docs API snapshot so nothing
    // holds a handle to the now-dead iroh-docs actor (which would otherwise
    // surface as "sending to iroh_docs actor failed" on the next sync).
    *sync_state.transport_state.docs_api.lock().await = None;
    let endpoint = IROH_ENDPOINT
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    if let Some(ep) = endpoint {
        ep.close().await;
    }
    *IROH_ENDPOINT.lock().unwrap_or_else(|e| e.into_inner()) = None;
    Ok(())
}

#[tauri::command]
pub async fn generate_pairing_qr(app: tauri::AppHandle) -> Result<PairingQrData, String> {
    let _pair_lock = IROH_START_LOCK.lock().await;
    let ep = get_or_init_iroh(&app).await?;
    let sync_state = get_sync_state(&app)?;

    {
        let mut cancel_guard = sync_state.accept_cancel.lock().await;
        if cancel_guard.is_none() {
            let transport = sync_state.transport_state.clone();
            let ep_clone = ep.clone();
            let handle = iroh_sync::start_accept_loop(ep_clone, transport);
            *cancel_guard = Some(handle);
        }
    }

    // Give the relay connection a moment, so the code carries a relay URL the
    // other device can use when a direct path fails.
    let _ = tokio::time::timeout(std::time::Duration::from_secs(3), ep.endpoint.online()).await;
    let qr_payload = PairingQrPayload {
        version: PAIRING_VERSION,
        node_id: ep.public_key_string(),
        device_id: sync_state.transport_state.device_id.clone(),
        device_name: sync_state.transport_state.device_name(),
        fingerprint: sync_crypto::get_frontend_fingerprint()
            .unwrap_or_else(|| sync_state.transport_state.fingerprint.clone()),
        // Addresses another device can dial (LAN and public), not the
        // listening sockets (0.0.0.0:port, which only mean "this device").
        lan_addrs: ep
            .endpoint
            .addr()
            .ip_addrs()
            .filter(|a| !a.ip().is_unspecified() && !a.ip().is_loopback())
            .map(|a| a.to_string())
            .collect(),
        relay_url: ep
            .endpoint
            .addr()
            .relay_urls()
            .collect::<Vec<_>>()
            .first()
            .map(|u| u.to_string())
            .unwrap_or_default(),
        secret: sync_state.transport_state.pairing.open(),
    };

    let payload_json = serde_json::to_string(&qr_payload)
        .map_err(|e| format!("Failed to serialize QR payload: {e}"))?;
    let qr_svg = sync_crypto::generate_qr_svg(&payload_json)?;

    Ok(PairingQrData {
        qr_svg,
        pairing_code: payload_json,
    })
}

#[tauri::command]
pub async fn submit_pairing_code(
    app: tauri::AppHandle,
    pairing_code: String,
) -> Result<PairedDeviceInfo, String> {
    let qr_payload: PairingQrPayload =
        serde_json::from_str(&pairing_code).map_err(|e| format!("Invalid pairing code: {e}"))?;

    if qr_payload.version < PAIRING_VERSION || qr_payload.secret.is_empty() {
        return Err(
            "This pairing code is from an older version of Theorem. Update Theorem on the other device and show its QR code again."
                .to_string(),
        );
    }
    if qr_payload.version > PAIRING_VERSION {
        return Err(
            "This pairing code is from a newer version of Theorem. Update Theorem on this device."
                .to_string(),
        );
    }

    let sync_state = get_sync_state(&app)?;
    let ep = get_or_init_iroh(&app).await?;

    let _ = app.emit(
        "pairing-progress",
        serde_json::json!({"step": "connecting", "message": "Connecting to device..."}),
    );

    let peer_pk: iroh::PublicKey = qr_payload
        .node_id
        .parse()
        .map_err(|e| format!("Invalid host node_id: {e}"))?;
    let mut host_addr = iroh::EndpointAddr::new(peer_pk);
    for addr_str in &qr_payload.lan_addrs {
        if let Ok(socket) = addr_str.parse::<std::net::SocketAddr>() {
            host_addr = host_addr.with_ip_addr(socket);
        }
    }

    // The host may connect back for sync before it is saved as paired here.
    // The permission ends with this call, whatever the outcome: once paired,
    // the paired list allows it (and unpairing then revokes it at once).
    let allowlist = sync_state.transport_state.allowlist.clone();
    allowlist.allow_pending(peer_pk, crate::sync_access::PENDING_PEER_TTL);
    struct ForgetPending(Arc<crate::sync_access::PeerAllowlist>, iroh::PublicKey);
    impl Drop for ForgetPending {
        fn drop(&mut self) {
            self.0.forget_pending(&self.1);
        }
    }
    let _forget_pending = ForgetPending(allowlist, peer_pk);

    let conn = tokio::time::timeout(
        PAIRING_CONNECT_TIMEOUT,
        ep.endpoint.connect(host_addr, crate::iroh_sync::ALPN_BYTES),
    )
    .await
    .map_err(|_| {
        "Could not reach the other device. Check that both are online and try again.".to_string()
    })?
    .map_err(|e| format!("Connect to host failed: {e}"))?;

    let code = crate::sync_access::verification_code(&peer_pk, &ep.public_key, &qr_payload.secret);
    let _ = app.emit(
        "pairing-progress",
        serde_json::json!({
            "step": "confirm",
            "code": code,
            "message": format!("Accept on the other device if it shows {code}"),
        }),
    );

    let pairing_request = PairingRequest {
        device_id: sync_state.transport_state.device_id.clone(),
        device_name: sync_state.transport_state.device_name(),
        fingerprint: sync_crypto::get_frontend_fingerprint()
            .unwrap_or_else(|| sync_state.transport_state.fingerprint.clone()),
        node_id: ep.public_key.to_string(),
        relay_url: ep
            .endpoint
            .addr()
            .relay_urls()
            .collect::<Vec<_>>()
            .first()
            .map(|u| u.to_string())
            .unwrap_or_default(),
        secret: qr_payload.secret.clone(),
        protocol: theorem_sync_core::sync_protocol::SYNC_PROTOCOL,
    };

    let pairing_response = iroh_sync::send_pair_request(&conn, &pairing_request).await?;

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let (connected_ip, connected_port, connected_relay) = {
        let paths = conn.paths();
        let mut direct = None;
        let mut relay = None;
        for p in paths.iter() {
            match p.remote_addr() {
                iroh::TransportAddr::Ip(addr) => {
                    direct = Some((addr.ip().to_string(), addr.port()));
                }
                iroh::TransportAddr::Relay(url) => {
                    relay = Some(url.to_string());
                }
                _ => {}
            }
        }
        match direct {
            Some((ip, port)) => (ip, port, relay.unwrap_or_default()),
            None => (String::new(), 0u16, relay.unwrap_or_default()),
        }
    };

    let host_relay = if !pairing_response.relay_url.is_empty() {
        pairing_response.relay_url.clone()
    } else if !connected_relay.is_empty() {
        connected_relay
    } else {
        qr_payload.relay_url.clone()
    };

    let paired_device = PairedDevice {
        device_id: pairing_response.device_id.clone(),
        device_name: pairing_response.device_name.clone(),
        iroh_node_id: qr_payload.node_id.clone(),

        last_ip: connected_ip,
        last_port: connected_port,
        paired_at: format!("{}Z", now),
        last_sync_at: None,
        fingerprint: pairing_response.fingerprint.clone(),
        peer_relay_url: host_relay,
        sync_doc_id: String::new(),
        sync_doc_ticket: pairing_response.sync_doc_ticket.clone(),
        protocol: pairing_response.protocol,
    };

    let paired_info = PairedDeviceInfo::from(&paired_device);

    {
        let mut devices = sync_state.transport_state.paired_devices.lock().await;
        if !paired_device.iroh_node_id.is_empty() {
            let existing_by_key: Option<String> = devices
                .values()
                .find(|d| {
                    d.iroh_node_id == paired_device.iroh_node_id
                        && d.device_id != paired_device.device_id
                })
                .map(|d| d.device_id.clone());
            if let Some(old_device_id) = existing_by_key {
                devices.remove(&old_device_id);
            }
        }
        if !paired_device.fingerprint.is_empty() {
            let old_id: Option<String> = devices
                .values()
                .find(|d| {
                    d.fingerprint == paired_device.fingerprint
                        && d.device_id != paired_device.device_id
                })
                .map(|d| d.device_id.clone());
            if let Some(old_device_id) = old_id {
                devices.remove(&old_device_id);
            }
        }
        devices.insert(paired_device.device_id.clone(), paired_device);
        sync_state
            .transport_state
            .persist_paired(&devices)
            .unwrap_or_else(|e| log::warn!("[sync] Failed to save paired devices: {e}"));
    }

    {
        // Serialize the check-and-spawn with iroh_start / iroh_stop so two
        // accept loops can't be started concurrently.
        let _pair_lock = IROH_START_LOCK.lock().await;
        let mut cancel_guard = sync_state.accept_cancel.lock().await;
        if cancel_guard.is_none() {
            let transport = sync_state.transport_state.clone();
            let ep_clone = ep.clone();
            let handle = iroh_sync::start_accept_loop(ep_clone, transport);
            *cancel_guard = Some(handle);
        }
    }

    let _ = app.emit(
        "pairing-progress",
        serde_json::json!({"step": "setup", "message": "Setting up sync engine..."}),
    );
    let docs_ready = {
        let mut waited = 0;
        loop {
            // Only report ready when the snapshot belongs to the current accept
            // loop (generation match); a stale snapshot from a previous engine
            // is not usable.
            let ready = {
                let guard = sync_state.transport_state.docs_api.lock().await;
                match guard.as_ref() {
                    Some(snapshot) => {
                        snapshot.generation
                            == sync_state
                                .transport_state
                                .docs_generation
                                .load(std::sync::atomic::Ordering::SeqCst)
                    }
                    None => false,
                }
            };
            if ready {
                break true;
            }
            waited += 1;
            if waited > 50 {
                break false;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
    };

    if docs_ready && !pairing_response.sync_doc_ticket.is_empty() {
        let api = get_docs_api(&app).await?;
        match pairing_response
            .sync_doc_ticket
            .parse::<iroh_docs::DocTicket>()
        {
            Ok(ticket) => match api.import(ticket).await {
                Ok(doc) => {
                    let doc_id = doc.id().to_string();

                    if let Ok(host_pk) = qr_payload.node_id.parse::<iroh::PublicKey>() {
                        let host_addr = iroh::EndpointAddr::new(host_pk);
                        let _ = doc.start_sync(vec![host_addr]).await;
                    }

                    if let Ok(blobs) = get_blobs_store(&app).await {
                        iroh_sync::subscribe_doc_events(app.clone(), doc, blobs);
                    }
                    let sync_state = get_sync_state(&app)?;
                    let mut devices = sync_state.transport_state.paired_devices.lock().await;
                    if let Some(device) = devices.get_mut(&pairing_response.device_id) {
                        device.sync_doc_id = doc_id;
                        device.sync_doc_ticket = pairing_response.sync_doc_ticket.clone();
                        sync_state
                            .transport_state
                            .persist_paired(&devices)
                            .unwrap_or_else(|e| {
                                log::warn!("[sync] Failed to save paired devices: {e}")
                            });
                    }
                }
                Err(e) => log::warn!("[sync] Failed to import docs doc: {e}"),
            },
            Err(e) => log::warn!("[sync] Failed to parse docs ticket: {e}"),
        }
    }

    let _ = app.emit(
        "pairing-progress",
        serde_json::json!({"step": "complete", "message": "Device paired!"}),
    );

    Ok(paired_info)
}

#[tauri::command]
pub async fn get_device_identity(app: tauri::AppHandle) -> Result<DeviceIdentityInfo, String> {
    let sync_state = get_sync_state(&app)?;
    let public_key = IROH_ENDPOINT
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .map(|ep| ep.public_key_string())
        .unwrap_or_default();
    Ok(DeviceIdentityInfo {
        device_id: sync_state.transport_state.device_id.clone(),
        device_name: sync_state.transport_state.device_name(),
        public_key_hex: public_key,
        fingerprint: sync_crypto::get_frontend_fingerprint()
            .unwrap_or_else(|| sync_state.transport_state.fingerprint.clone()),
    })
}

#[tauri::command]
pub async fn set_device_fingerprint(fingerprint: String) -> Result<(), String> {
    theorem_sync_core::sync_crypto::set_fingerprint_from_frontend(&fingerprint);
    log::debug!("[sync] Device fingerprint set from frontend");
    Ok(())
}

#[tauri::command]
pub async fn get_paired_devices(app: tauri::AppHandle) -> Result<Vec<PairedDeviceInfo>, String> {
    let sync_state = get_sync_state(&app)?;
    let devices = sync_state.transport_state.paired_devices.lock().await;
    Ok(devices.values().map(PairedDeviceInfo::from).collect())
}

/// Forgets a device. It is told first (so it stops listing this device too;
/// if it is offline, it learns on its next attempt, when it is refused). It
/// is refused from now on, connections already open to it are closed (the
/// sync engine restarts), and the doc shared with it is deleted from this
/// device as the engine starts. Each pairing has its own doc, so the removed
/// device never had the docs shared with other devices.
#[tauri::command]
pub async fn unpair_device(app: tauri::AppHandle, device_id: String) -> Result<(), String> {
    {
        let sync_state = get_sync_state(&app)?;
        if !sync_state
            .transport_state
            .paired_devices
            .lock()
            .await
            .contains_key(&device_id)
        {
            return Err(format!("Device {} not found", device_id));
        }
    }
    if !crate::file_transfer::notify_unpaired(&app, &device_id).await {
        log::warn!("[iroh-sync] {device_id} could not be told it was removed; it learns next time it connects");
    }
    forget_device(&app, &device_id, false).await
}

/// Removes a paired device here (see [`unpair_device`]). `removed_by_peer`:
/// the other device unpaired this one first, which the app is told about
/// (`sync-peer-removed`).
pub(crate) async fn forget_device(
    app: &tauri::AppHandle,
    device_id: &str,
    removed_by_peer: bool,
) -> Result<(), String> {
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
        let mut to_drop = theorem_sync_core::sync_persistence::load_docs_to_drop(dir);
        if !to_drop.contains(&removed.sync_doc_id) {
            to_drop.push(removed.sync_doc_id.clone());
        }
        theorem_sync_core::sync_persistence::save_docs_to_drop(dir, &to_drop)?;
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
    // The gate only checks new connections: restart to close the open ones.
    let was_running = sync_state.accept_cancel.lock().await.is_some();
    if was_running {
        iroh_stop(app.clone()).await?;
        if let Err(e) = iroh_start(app.clone()).await {
            log::warn!("[iroh-sync] Sync restart after unpairing: {e}");
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

/// Renames this device as paired devices see it (they pick up the new name
/// on their next sync round). An empty name goes back to the system's.
/// Returns the name now in use.
#[tauri::command]
pub async fn set_device_name(app: tauri::AppHandle, name: String) -> Result<String, String> {
    let sync_state = get_sync_state(&app)?;
    let state = &sync_state.transport_state;
    let chosen = theorem_sync_core::sync_protocol::clean_device_name(&name);
    theorem_sync_core::sync_persistence::save_device_name(&state.app_data_dir, chosen.as_deref())?;
    let name = chosen.unwrap_or_else(crate::device_name::system_device_name);
    *state.device_name.write().unwrap_or_else(|e| e.into_inner()) = name.clone();
    Ok(name)
}

/// Whether a paired device answers now (see `file_transfer::probe_peer`:
/// names are exchanged, and a device that removed this one is forgotten).
/// An error means the device removed this one.
#[tauri::command]
pub async fn sync_probe_device(
    app: tauri::AppHandle,
    peer_device_id: String,
) -> Result<bool, String> {
    match crate::file_transfer::probe_peer(&app, &peer_device_id).await {
        Ok(()) => Ok(true),
        Err(e) if e == crate::file_transfer::PEER_REMOVED_THIS_DEVICE => Err(e),
        Err(_) => Ok(false),
    }
}

/// The user's answer to a `pairing-confirm-request`.
#[tauri::command]
pub async fn respond_pairing_request(
    app: tauri::AppHandle,
    request_id: String,
    accept: bool,
) -> Result<(), String> {
    let sync_state = get_sync_state(&app)?;
    let sender = sync_state
        .transport_state
        .pairing_confirms
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&request_id)
        .ok_or_else(|| "This pairing request has expired.".to_string())?;
    let _ = sender.send(accept);
    Ok(())
}

/// The QR code was closed: its secret stops working.
#[tauri::command]
pub async fn close_pairing_qr(app: tauri::AppHandle) -> Result<(), String> {
    get_sync_state(&app)?.transport_state.pairing.close();
    Ok(())
}

async fn get_docs_api(app: &tauri::AppHandle) -> Result<iroh_docs::api::DocsApi, String> {
    let snapshot = get_docs_snapshot(app).await?;
    Ok(snapshot.api)
}

async fn get_docs_author(app: &tauri::AppHandle) -> Result<iroh_docs::AuthorId, String> {
    let snapshot = get_docs_snapshot(app).await?;
    Ok(snapshot.author)
}

async fn get_blobs_store(app: &tauri::AppHandle) -> Result<iroh_blobs::api::Store, String> {
    let snapshot = get_docs_snapshot(app).await?;
    Ok(snapshot.blobs)
}

async fn get_docs_snapshot(app: &tauri::AppHandle) -> Result<DocsApiSnapshot, String> {
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

#[tauri::command]
pub async fn docs_create_sync_doc(
    app: tauri::AppHandle,
    peer_device_id: String,
) -> Result<String, String> {
    let api = get_docs_api(&app).await?;
    let _author = get_docs_author(&app).await?;
    let doc = api.create().await.map_err(|e| format!("create doc: {e}"))?;
    let doc_id = doc.id();
    let ticket = doc
        .share(
            iroh_docs::api::protocol::ShareMode::Write,
            Default::default(),
        )
        .await
        .map_err(|e| format!("share doc: {e}"))?;

    if let Ok(blobs) = get_blobs_store(&app).await {
        iroh_sync::subscribe_doc_events(app.clone(), doc, blobs);
    }

    let sync_state = get_sync_state(&app)?;
    let mut devices = sync_state.transport_state.paired_devices.lock().await;
    if let Some(device) = devices.get_mut(&peer_device_id) {
        device.sync_doc_id = doc_id.to_string();
        let _ = sync_state.transport_state.persist_paired(&devices);
    }

    Ok(ticket.to_string())
}

#[tauri::command]
pub async fn docs_import_sync_doc(
    app: tauri::AppHandle,
    peer_device_id: String,
    ticket_str: String,
) -> Result<(), String> {
    let api = get_docs_api(&app).await?;
    let ticket: iroh_docs::DocTicket = ticket_str
        .parse()
        .map_err(|e| format!("parse ticket: {e}"))?;
    let doc = api
        .import(ticket)
        .await
        .map_err(|e| format!("import doc: {e}"))?;
    let doc_id = doc.id();

    if let Ok(blobs) = get_blobs_store(&app).await {
        iroh_sync::subscribe_doc_events(app.clone(), doc, blobs);
    }

    let sync_state = get_sync_state(&app)?;
    let mut devices = sync_state.transport_state.paired_devices.lock().await;
    if let Some(device) = devices.get_mut(&peer_device_id) {
        device.sync_doc_id = doc_id.to_string();
        let _ = sync_state.transport_state.persist_paired(&devices);
    }

    Ok(())
}

/// Whole-list entries from before one entry per item (`SYNC_PROTOCOL` 2).
/// They are written only to docs shared with devices on older versions,
/// which read nothing else, and removed from the others.
const LEGACY_LIST_KEYS: &[&str] = &[
    "annotations",
    "collections",
    "deletion_tombstones",
    "vocabulary",
    "rss_feeds",
    "rss_articles",
];

fn is_legacy_list_key(key: &str) -> bool {
    LEGACY_LIST_KEYS.contains(&key)
}

/// Whether a device on `protocol` still reads whole-list entries.
fn reads_legacy_lists(protocol: u8) -> bool {
    protocol < 2
}

/// The paired docs, each with the protocol of the device it is shared with.
async fn sync_doc_targets(
    app: &tauri::AppHandle,
) -> Result<Vec<(iroh_docs::NamespaceId, u8)>, String> {
    let sync_state = get_sync_state(app)?;
    let devices = sync_state.transport_state.paired_devices.lock().await;
    Ok(devices
        .values()
        .filter_map(|d| {
            d.sync_doc_id
                .parse::<iroh_docs::NamespaceId>()
                .ok()
                .map(|doc_id| (doc_id, d.protocol))
        })
        .collect())
}

/// Writes entries as this device to every paired doc and returns how many
/// were written. An entry equal to what this device last wrote under its key
/// is skipped: rewriting it would date it now, as if just edited, which
/// would bring back an item another device deleted meanwhile (and send it
/// again for nothing). Whole-list entries go only where they are still read.
async fn write_own_entries(
    app: &tauri::AppHandle,
    entries: &[(String, String)],
    respect_deletions: bool,
) -> Result<DocWriteResult, String> {
    let snapshot = get_docs_snapshot(app).await?;
    let targets = sync_doc_targets(app).await?;

    // Surface write failures instead of silently dropping data, so the
    // frontend knows the sync doc wasn't updated and can retry.
    let mut first_error: Option<String> = None;
    let mut written = 0usize;
    let mut deleted: Vec<DeletedDocKey> = Vec::new();
    for (doc_id, protocol) in &targets {
        let doc = match snapshot.api.open(*doc_id).await {
            Ok(Some(doc)) => doc,
            Ok(None) => {
                first_error.get_or_insert_with(|| format!("sync doc not found: {doc_id}"));
                continue;
            }
            Err(e) => {
                first_error.get_or_insert_with(|| format!("open doc {doc_id}: {e}"));
                continue;
            }
        };
        fold_single_deletions_once(&doc, &snapshot.blobs, snapshot.author).await;
        let (n, found, error) = write_entries_to_doc(
            &doc,
            &snapshot.blobs,
            snapshot.author,
            *protocol,
            entries,
            respect_deletions,
        )
        .await;
        written += n;
        for d in found {
            if !deleted.iter().any(|x| x.key == d.key) {
                deleted.push(d);
            }
        }
        if let Some(e) = error {
            let msg = format!("{doc_id}: {e}");
            log::warn!("[iroh-sync] {msg}");
            first_error.get_or_insert(msg);
        }
    }

    match first_error {
        Some(err) => Err(err),
        None => Ok(DocWriteResult { written, deleted }),
    }
}

#[derive(serde::Serialize, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DocWriteResult {
    pub written: usize,
    /// Items not written because another device deleted them since this
    /// device last wrote them (see [`write_own_entries`]).
    pub deleted: Vec<DeletedDocKey>,
}

/// [`write_own_entries`] for one doc, shared with a device on `protocol`.
/// Returns how many entries were written, the items left unwritten because
/// their newest entry is a deletion (with `respect_deletions`), and the
/// first failure. Annotations go into this device's group of their book
/// (see `sync_annotations`).
async fn write_entries_to_doc(
    doc: &iroh_docs::api::Doc,
    blobs: &iroh_blobs::api::Store,
    author: iroh_docs::AuthorId,
    protocol: u8,
    entries: &[(String, String)],
    respect_deletions: bool,
) -> (usize, Vec<DeletedDocKey>, Option<String>) {
    let mut written = 0usize;
    let mut deleted = Vec::new();
    let mut error = None;
    let mut annotations: Vec<(&str, &str)> = Vec::new();
    for (key, value) in entries {
        if crate::sync_annotations::is_annotation_key(key) {
            // Groups are built here, never taken whole from the app.
            if crate::sync_annotations::parse_single_key(key).is_some() {
                annotations.push((key, value));
            }
            continue;
        }
        if is_legacy_list_key(key) && !reads_legacy_lists(protocol) {
            continue;
        }
        let unchanged = matches!(
            doc.get_exact(author, key.as_bytes(), false).await,
            Ok(Some(own)) if own.content_hash() == iroh_blobs::Hash::new(value.as_bytes())
        );
        if unchanged {
            continue;
        }
        if respect_deletions && is_deletable_key(key) {
            if let Some(at) = newest_deletion(doc, key).await {
                // Deleted since this device last wrote it (or before it ever
                // did): writing now would undo that. The app decides.
                deleted.push(DeletedDocKey {
                    key: key.clone(),
                    at: at / 1000,
                });
                continue;
            }
        }
        match doc
            .set_bytes(author, key.clone().into_bytes(), value.clone().into_bytes())
            .await
        {
            Ok(_) => written += 1,
            Err(e) => {
                error.get_or_insert(format!("set_bytes {key}: {e}"));
            }
        }
    }
    if !annotations.is_empty() {
        let (n, held, e) = crate::sync_annotations::write_annotations(
            doc,
            blobs,
            author,
            protocol,
            &annotations,
            respect_deletions,
        )
        .await;
        written += n;
        deleted.extend(held);
        if let Some(e) = e {
            error.get_or_insert(e);
        }
    }
    (written, deleted, error)
}

/// Docs whose single annotation deletions from this device were copied into
/// its groups since start (`sync_annotations::fold_single_deletions`).
type DocSet = std::collections::HashSet<iroh_docs::NamespaceId>;
static SINGLE_DELETIONS_FOLDED: std::sync::Mutex<Option<DocSet>> = std::sync::Mutex::new(None);

/// [`crate::sync_annotations::fold_single_deletions`] once per doc and
/// start; retried while it fails.
async fn fold_single_deletions_once(
    doc: &iroh_docs::api::Doc,
    blobs: &iroh_blobs::api::Store,
    author: iroh_docs::AuthorId,
) {
    let id = doc.id();
    let done = SINGLE_DELETIONS_FOLDED
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .is_some_and(|set| set.contains(&id));
    if done {
        return;
    }
    match crate::sync_annotations::fold_single_deletions(doc, blobs, author).await {
        Ok(n) => {
            if n > 0 {
                log::info!("[iroh-sync] {n} annotation deletions copied into per-book entries");
            }
            SINGLE_DELETIONS_FOLDED
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get_or_insert_with(Default::default)
                .insert(id);
        }
        Err(e) => log::warn!("[iroh-sync] annotation deletions not copied yet: {e}"),
    }
}

/// When `key`'s newest entry in `doc` (by any device) is a deletion, when
/// that deletion was made (microseconds).
async fn newest_deletion(doc: &iroh_docs::api::Doc, key: &str) -> Option<u64> {
    let newest = doc
        .get_one(
            iroh_docs::store::Query::single_latest_per_key()
                .key_exact(key.as_bytes())
                .include_empty()
                .build(),
        )
        .await
        .ok()??;
    (newest.content_hash() == iroh_blobs::Hash::EMPTY).then(|| newest.timestamp())
}

#[tauri::command]
pub async fn docs_set_entry(
    app: tauri::AppHandle,
    key: String,
    value: String,
) -> Result<(), String> {
    // A change made on this device just now: newer than any deletion.
    write_own_entries(&app, &[(key, value)], false)
        .await
        .map(|_| ())
}

#[derive(serde::Deserialize)]
pub struct DocEntryInput {
    pub key: String,
    pub value: String,
}

/// Several entries in one call (provisioning sends every item at once);
/// see [`write_own_entries`]. Provisioning writes what this device holds,
/// which may predate a deletion made elsewhere: an item whose newest entry is
/// a deletion is not written but returned in `deleted`, for the app to apply
/// the deletion, or (the item changed here since) to write it with `force`.
#[tauri::command]
pub async fn docs_set_entries(
    app: tauri::AppHandle,
    entries: Vec<DocEntryInput>,
    force: Option<bool>,
) -> Result<DocWriteResult, String> {
    let entries: Vec<(String, String)> = entries.into_iter().map(|e| (e.key, e.value)).collect();
    write_own_entries(&app, &entries, !force.unwrap_or(false)).await
}

/// Removes this device's entries under `prefix` whose keys are not in `keep`
/// (deletion records that expired, for one). Returns how many were removed.
#[tauri::command]
pub async fn docs_retain_own_entries(
    app: tauri::AppHandle,
    prefix: String,
    keep: Vec<String>,
) -> Result<usize, String> {
    use futures::pin_mut;
    use futures::StreamExt;
    if prefix.is_empty() {
        return Err("a prefix is required".to_string());
    }
    let snapshot = get_docs_snapshot(&app).await?;
    let keep: std::collections::HashSet<String> = keep.into_iter().collect();
    let mut removed = 0usize;
    for (doc_id, _) in sync_doc_targets(&app).await? {
        let Ok(Some(doc)) = snapshot.api.open(doc_id).await else {
            continue;
        };
        let mut own_keys = Vec::new();
        if let Ok(stream) = doc
            .get_many(
                iroh_docs::store::Query::author(snapshot.author)
                    .key_prefix(prefix.as_bytes())
                    .build(),
            )
            .await
        {
            pin_mut!(stream);
            while let Some(Ok(entry)) = stream.next().await {
                own_keys.push(String::from_utf8_lossy(entry.key()).to_string());
            }
        }
        for key in own_keys.iter().filter(|k| !keep.contains(*k)) {
            if shadows_other_key(key, &own_keys, &keep) {
                continue;
            }
            match doc.del(snapshot.author, key.clone().into_bytes()).await {
                Ok(n) => removed += n,
                Err(e) => log::warn!("[iroh-sync] could not remove {key}: {e}"),
            }
        }
    }
    Ok(removed)
}

/// A doc deletion is by prefix: deleting `key` would also delete any longer
/// key starting with it (book:12 takes book:123). True when such a key is
/// one to keep.
fn shadows_other_key(
    key: &str,
    own_keys: &[String],
    keep: &std::collections::HashSet<String>,
) -> bool {
    own_keys
        .iter()
        .any(|other| other.len() > key.len() && other.starts_with(key) && keep.contains(other))
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
        // Only where one is there: a deletion is itself an entry that syncs.
        if !matches!(
            doc.get_exact(snapshot.author, key.as_bytes(), false).await,
            Ok(Some(_))
        ) {
            continue;
        }
        // `vocabulary` is a prefix of the old per-word `vocabulary:{id}` keys:
        // delete exactly this key's entries, never theirs.
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

#[tauri::command]
pub async fn docs_get_all_entries(
    app: tauri::AppHandle,
) -> Result<std::collections::HashMap<String, String>, String> {
    Ok(read_doc_entries(&app, None).await?.entries)
}

/// An item whose newest doc entry is a deletion, and when it was deleted
/// (ms since the epoch, by the deleting device's clock).
#[derive(serde::Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeletedDocKey {
    pub key: String,
    pub at: u64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedDocEntries {
    pub entries: std::collections::HashMap<String, String>,
    /// Items deleted on another device. Doc deletions never expire, unlike
    /// the app's deletion records (90 days), so a device that was away for
    /// longer still learns about them instead of sending the items back.
    pub deleted: Vec<DeletedDocKey>,
    /// Pass to `docs_ack_entries` once `entries` are applied.
    pub token: u64,
}

/// The doc contents the app has applied, per key (the content hashes of
/// every device's copy), and the read waiting to be acknowledged.
#[derive(Default)]
struct Delivery {
    applied: std::collections::HashMap<String, Vec<iroh_blobs::Hash>>,
    pending: Option<(
        u64,
        std::collections::HashMap<String, Vec<iroh_blobs::Hash>>,
    )>,
    next_token: u64,
}

static DELIVERY: std::sync::Mutex<Option<Delivery>> = std::sync::Mutex::new(None);

/// Like `docs_get_all_entries`, but only keys whose content changed since
/// the last read the app acknowledged. Comparing content, not timestamps,
/// means a device with a wrong clock is never skipped; an unacknowledged
/// read (the merge failed) is simply sent again.
/// With `full`, every entry is returned (a periodic safety net), and the
/// acknowledgement still records them for the reads after it.
#[tauri::command]
pub async fn docs_get_changed_entries(
    app: tauri::AppHandle,
    full: Option<bool>,
) -> Result<ChangedDocEntries, String> {
    let applied = DELIVERY
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get_or_insert_with(Default::default)
        .applied
        .clone();
    let baseline = (!full.unwrap_or(false)).then_some(&applied);
    let read = read_doc_entries(&app, baseline).await?;
    let mut guard = DELIVERY.lock().unwrap_or_else(|e| e.into_inner());
    let delivery = guard.get_or_insert_with(Default::default);
    delivery.next_token += 1;
    let token = delivery.next_token;
    delivery.pending = Some((token, read.seen));
    Ok(ChangedDocEntries {
        entries: read.entries,
        deleted: read.deleted,
        token,
    })
}

/// The entries of read `token` are applied: later reads skip them.
#[tauri::command]
pub async fn docs_ack_entries(token: u64) -> Result<(), String> {
    let mut guard = DELIVERY.lock().unwrap_or_else(|e| e.into_inner());
    let delivery = guard.get_or_insert_with(Default::default);
    match delivery.pending.take() {
        Some((pending_token, seen)) if pending_token == token => {
            delivery.applied = seen;
            Ok(())
        }
        other => {
            delivery.pending = other;
            Err("stale sync read".to_string())
        }
    }
}

struct DocRead {
    entries: std::collections::HashMap<String, String>,
    deleted: Vec<DeletedDocKey>,
    /// Every key's copies as now read, for the next diff.
    seen: std::collections::HashMap<String, Vec<iroh_blobs::Hash>>,
    /// Content of entries that are here without it (left out of the read).
    missing: Vec<iroh_blobs::Hash>,
}

/// The newest entry header of one key in one doc: when it was written
/// (microseconds) and its content hash (`Hash::EMPTY` for a deletion).
type EntryHeader = (String, u64, iroh_blobs::Hash);

/// Reads the paired docs. With `applied`, returns only keys whose copies
/// differ from it; always also returns what is now there, for the next diff.
/// A copy whose content has not arrived yet is left out of both, so it is
/// read again next time. Deletions are read too: a key whose newest copy (in
/// any doc) is a deletion comes back in `deleted`, not `entries`.
async fn read_doc_entries(
    app: &tauri::AppHandle,
    applied: Option<&std::collections::HashMap<String, Vec<iroh_blobs::Hash>>>,
) -> Result<DocRead, String> {
    let api = get_docs_api(app).await?;
    let sync_state = get_sync_state(app)?;
    let (blobs, own) = {
        let guard = sync_state.transport_state.docs_api.lock().await;
        let snapshot = guard
            .as_ref()
            .ok_or_else(|| "iroh-docs not initialized".to_string())?;
        (snapshot.blobs.clone(), Some(snapshot.own_deletions.clone()))
    };
    // Copy the doc IDs and let go of the lock: reading the docs takes a while,
    // and pairing, writes and book transfers all need it meanwhile.
    let (doc_ids, peers): (Vec<iroh_docs::NamespaceId>, Vec<iroh::EndpointId>) = {
        let devices = sync_state.transport_state.paired_devices.lock().await;
        let doc_ids = devices
            .values()
            .filter(|d| !d.sync_doc_id.is_empty())
            .map(|d| d.sync_doc_id.parse())
            .collect::<Result<_, _>>()
            .map_err(|e| format!("parse doc id: {e}"))?;
        let peers = devices
            .values()
            .filter_map(|d| d.iroh_node_id.parse().ok())
            .collect();
        (doc_ids, peers)
    };

    let mut docs = Vec::with_capacity(doc_ids.len());
    for doc_id in doc_ids {
        if let Ok(Some(doc)) = api.open(doc_id).await {
            docs.push(doc);
        }
    }
    let read = read_docs(&docs, &blobs, applied, own.as_deref()).await;
    if read.missing.is_empty() {
        return Ok(read);
    }
    let Ok(endpoint) = get_or_init_iroh(app).await else {
        return Ok(read);
    };
    let fetched = fetch_missing_content(
        &blobs,
        &endpoint.endpoint,
        &peers,
        &read.missing,
        MISSING_CONTENT_BUDGET,
    )
    .await;
    if fetched == 0 {
        return Ok(read);
    }
    Ok(read_docs(&docs, &blobs, applied, own.as_deref()).await)
}

/// How long a read spends fetching content that never arrived.
const MISSING_CONTENT_BUDGET: std::time::Duration = std::time::Duration::from_secs(3);

/// Fetches from the paired devices the content of doc entries that are here
/// without it, within `budget`; returns how many arrived. iroh-docs asks for
/// an entry's content once, when the entry arrives (again only when a
/// neighbour announces it, and it forgets what is missing on restart). An
/// exchange cut off after the entries but before their content, or an app
/// closed meanwhile, left those entries without content for good: later
/// exchanges bring no new entries, so nothing asked again, and the items
/// never reached this device.
async fn fetch_missing_content(
    blobs: &iroh_blobs::api::Store,
    endpoint: &iroh::Endpoint,
    peers: &[iroh::EndpointId],
    hashes: &[iroh_blobs::Hash],
    budget: std::time::Duration,
) -> usize {
    use futures::StreamExt;
    if hashes.is_empty() || peers.is_empty() {
        return 0;
    }
    let downloader = blobs.downloader(endpoint);
    let fetched = std::sync::atomic::AtomicUsize::new(0);
    let mut unique: Vec<iroh_blobs::Hash> = hashes.to_vec();
    unique.sort();
    unique.dedup();
    let total = unique.len();
    let work = futures::stream::iter(unique)
        .map(|hash| {
            let (downloader, peers) = (downloader.clone(), peers.to_vec());
            async move { downloader.download(hash, peers).await.is_ok() }
        })
        .buffer_unordered(32)
        .for_each(|ok| {
            if ok {
                fetched.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            }
            std::future::ready(())
        });
    let _ = tokio::time::timeout(budget, work).await;
    let fetched = fetched.load(std::sync::atomic::Ordering::Relaxed);
    log::info!("[iroh-sync] fetched {fetched} of {total} missing doc contents");
    fetched
}

/// [`read_doc_entries`] over open docs (one per paired device) and the blob
/// store holding their content. Annotations are combined per annotation
/// across every copy (see `sync_annotations`) and delivered as `anno:` items.
async fn read_docs(
    docs: &[iroh_docs::api::Doc],
    blobs: &iroh_blobs::api::Store,
    applied: Option<&std::collections::HashMap<String, Vec<iroh_blobs::Hash>>>,
    own: Option<&crate::sync_deletions::OwnDeletions>,
) -> DocRead {
    use crate::sync_annotations as annos;
    // First the entry headers (cheap), then content only for keys that changed.
    let mut headers: Vec<EntryHeader> = Vec::new();
    for doc in docs {
        headers.extend(read_headers(doc, own).await);
    }
    let current = hashes_by_key(&headers);
    let item_headers: Vec<EntryHeader> = headers
        .iter()
        .filter(|(key, _, _)| !annos::is_annotation_key(key))
        .cloned()
        .collect();
    let changed: std::collections::HashSet<&String> = current
        .iter()
        .filter(|(key, hashes)| {
            !annos::is_annotation_key(key) && applied.is_none_or(|a| a.get(*key) != Some(*hashes))
        })
        .map(|(key, _)| key)
        .collect();
    let (mut deleted, gone) = deletions(&item_headers, &changed);
    let wanted: Vec<&EntryHeader> = item_headers
        .iter()
        .filter(|(key, _, hash)| {
            changed.contains(key) && !gone.contains(key) && *hash != iroh_blobs::Hash::EMPTY
        })
        .collect();

    // Books whose annotations changed: all their copies are read.
    let books = annos::changed_books(&current, applied);
    let mut book_headers: std::collections::HashMap<&str, Vec<&EntryHeader>> =
        std::collections::HashMap::new();
    for header in &headers {
        if let Some(book) = annos::book_of(&header.0) {
            if books.contains_key(book) {
                book_headers.entry(book).or_default().push(header);
            }
        }
    }

    let contents = load_contents(
        blobs,
        wanted
            .iter()
            .map(|h| h.2)
            .chain(book_headers.values().flatten().map(|h| h.2)),
    )
    .await;

    let mut per_key: std::collections::HashMap<String, Vec<(u64, String)>> =
        std::collections::HashMap::new();
    let mut incomplete: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut missing_hashes = Vec::new();
    for (key, at, hash) in wanted {
        match contents.get(hash) {
            Some(v) => per_key
                .entry(key.clone())
                .or_default()
                .push((*at, v.clone())),
            None => {
                incomplete.insert(key.clone());
                missing_hashes.push(*hash);
            }
        }
    }

    let mut annotation_entries: Vec<(String, String)> = Vec::new();
    for (book, change) in &books {
        let copies_of = book_headers
            .get(book.as_str())
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        let absent: Vec<iroh_blobs::Hash> = copies_of
            .iter()
            .map(|h| h.2)
            .filter(|hash| *hash != iroh_blobs::Hash::EMPTY && !contents.contains_key(hash))
            .collect();
        if !absent.is_empty() {
            // Read again next time, whole: a copy not here yet may hold a
            // newer change (a deletion) of any of the book's annotations.
            incomplete.extend(copies_of.iter().map(|h| h.0.clone()));
            missing_hashes.extend(absent);
            continue;
        }
        let copies: Vec<annos::Copy> = copies_of
            .iter()
            .filter_map(|(key, at, hash)| {
                let content = (*hash != iroh_blobs::Hash::EMPTY)
                    .then(|| contents.get(hash).map(String::as_str))
                    .flatten();
                annos::copy_from_entry(key, *at, *hash, content)
            })
            .collect();
        let ids = annos::ids_to_deliver(change, &copies);
        annos::deliver(
            book,
            &annos::resolve(&copies),
            ids.as_ref(),
            &mut annotation_entries,
            &mut deleted,
        );
    }
    deleted.sort_by(|a, b| a.key.cmp(&b.key));
    log::debug!(
        "[iroh-sync] read {} changed doc keys and {} books' annotations of {} keys ({} deleted, {} waiting for content)",
        changed.len(),
        books.len(),
        current.len(),
        deleted.len(),
        incomplete.len()
    );

    let mut seen = current;
    for key in &incomplete {
        // Keep what was applied before, so the key counts as changed again.
        match applied.and_then(|a| a.get(key)) {
            Some(previous) => {
                seen.insert(key.clone(), previous.clone());
            }
            None => {
                seen.remove(key);
            }
        }
    }
    let mut entries = combine_doc_values(per_key);
    entries.extend(annotation_entries);
    DocRead {
        entries,
        deleted,
        seen,
        missing: missing_hashes,
    }
}

/// The content of each of `hashes` that is here. Content usually arrives
/// with the exchange; what is still missing gets one short wait in all
/// (never one per entry: after an exchange cut off midway, thousands of
/// entries can be waiting for content that is not coming, and the read
/// stalled for minutes). Anything still missing is read again next time.
async fn load_contents(
    blobs: &iroh_blobs::api::Store,
    hashes: impl Iterator<Item = iroh_blobs::Hash>,
) -> std::collections::HashMap<iroh_blobs::Hash, String> {
    let mut unique: Vec<iroh_blobs::Hash> = hashes
        .filter(|hash| *hash != iroh_blobs::Hash::EMPTY)
        .collect();
    unique.sort();
    unique.dedup();
    let mut contents = std::collections::HashMap::with_capacity(unique.len());
    let mut missing = Vec::new();
    for hash in unique {
        match content_of(blobs, hash).await {
            Some(v) => {
                contents.insert(hash, v);
            }
            None => missing.push(hash),
        }
    }
    if !missing.is_empty() {
        tokio::time::sleep(CONTENT_GRACE).await;
        for hash in missing {
            if let Some(v) = content_of(blobs, hash).await {
                contents.insert(hash, v);
            }
        }
    }
    contents
}

/// How long a read waits, once, for content still on its way.
const CONTENT_GRACE: std::time::Duration = std::time::Duration::from_millis(150);

/// A doc entry's content, when it is here (complete and text).
pub(crate) async fn content_of(
    blobs: &iroh_blobs::api::Store,
    hash: iroh_blobs::Hash,
) -> Option<String> {
    // Asking for a blob that is not here costs ~10 ms; its status, ~50 µs.
    if !matches!(
        blobs.blobs().status(hash).await,
        Ok(iroh_blobs::api::blobs::BlobStatus::Complete { .. })
    ) {
        return None;
    }
    let content = blobs.blobs().get_bytes(hash).await.ok()?;
    String::from_utf8(content.to_vec()).ok()
}

/// Every device's newest entry of every key in `doc` (each author keeps one
/// per key), deletions included. Not only the newest entry per key: the copy
/// written last is not always the newest change (see [`combine_doc_values`]),
/// and reading only it hid the newer one for good.
async fn read_headers(
    doc: &iroh_docs::api::Doc,
    own: Option<&crate::sync_deletions::OwnDeletions>,
) -> Vec<EntryHeader> {
    use futures::StreamExt;
    let mut headers = Vec::new();
    let mut replaced = Vec::new();
    if let Ok(stream) = doc
        .get_many(iroh_docs::store::Query::all().include_empty().build())
        .await
    {
        futures::pin_mut!(stream);
        while let Some(Ok(entry)) = stream.next().await {
            let key = String::from_utf8_lossy(entry.key()).to_string();
            let deleted_at = own.and_then(|o| {
                o.replaced_deletion(
                    doc.id(),
                    entry.author(),
                    &key,
                    entry.timestamp(),
                    entry.content_hash(),
                )
            });
            match deleted_at {
                // An older copy of an entry this device deleted replaced the
                // deletion (see `sync_deletions`): read as the deletion, and
                // put back below.
                Some(at) => {
                    headers.push((key.clone(), at, iroh_blobs::Hash::EMPTY));
                    replaced.push((key, at));
                }
                None => headers.push((key, entry.timestamp(), entry.content_hash())),
            }
        }
    }
    if let Some(own) = own {
        for (key, at) in replaced {
            own.restore(doc, &key, at).await;
        }
    }
    headers
}

/// Among the `changed` keys, those whose newest copy across the docs is a
/// deletion: the items to report deleted, and every such key (items or not),
/// whose older copies must not be delivered as if current.
fn deletions(
    headers: &[EntryHeader],
    changed: &std::collections::HashSet<&String>,
) -> (Vec<DeletedDocKey>, std::collections::HashSet<String>) {
    let mut newest: std::collections::HashMap<&String, (u64, iroh_blobs::Hash)> =
        std::collections::HashMap::new();
    for (key, at, hash) in headers {
        if !changed.contains(key) {
            continue;
        }
        let slot = newest.entry(key).or_insert((*at, *hash));
        if *at > slot.0 {
            *slot = (*at, *hash);
        }
    }
    let mut deleted = Vec::new();
    let mut gone = std::collections::HashSet::new();
    for (key, (at, hash)) in newest {
        if hash != iroh_blobs::Hash::EMPTY {
            continue;
        }
        gone.insert(key.clone());
        if is_deletable_key(key) {
            deleted.push(DeletedDocKey {
                key: key.clone(),
                at: at / 1000,
            });
        }
    }
    deleted.sort_by(|a, b| a.key.cmp(&b.key));
    (deleted, gone)
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

/// Every device's copy of each key, as content hashes in a stable order.
fn hashes_by_key(
    headers: &[EntryHeader],
) -> std::collections::HashMap<String, Vec<iroh_blobs::Hash>> {
    let mut by_key: std::collections::HashMap<String, Vec<iroh_blobs::Hash>> =
        std::collections::HashMap::new();
    for (key, _, hash) in headers {
        by_key.entry(key.clone()).or_default().push(*hash);
    }
    for hashes in by_key.values_mut() {
        hashes.sort();
    }
    by_key
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletedEntity {
    pub entity_type: String,
    pub entity_id: String,
}

/// Which of `keys` hold a record of a deleted entity: a book's entry, cover
/// and annotations, an annotation, collection, article or word.
fn keys_of_deleted(entities: &[DeletedEntity], keys: &[String]) -> Vec<String> {
    let mut books = std::collections::HashSet::new();
    let mut by_kind: std::collections::HashMap<&str, std::collections::HashSet<&str>> =
        std::collections::HashMap::new();
    for e in entities {
        if e.entity_id.is_empty() {
            continue;
        }
        if e.entity_type == "book" {
            books.insert(e.entity_id.as_str());
        }
        by_kind
            .entry(e.entity_type.as_str())
            .or_default()
            .insert(e.entity_id.as_str());
    }
    let is = |kind: &str, id: &str| by_kind.get(kind).is_some_and(|ids| ids.contains(id));
    keys.iter()
        .filter(|key| {
            if let Some(id) = key
                .strip_prefix("book:")
                .or_else(|| key.strip_prefix("cover:"))
            {
                return books.contains(id);
            }
            if let Some(rest) = key.strip_prefix("anno:") {
                // anno:{bookId}:{annotationId}
                return match rest.split_once(':') {
                    Some((book, ann)) => books.contains(book) || is("annotation", ann),
                    None => false,
                };
            }
            if let Some(id) = key.strip_prefix("annotation:") {
                return is("annotation", id);
            }
            if let Some(id) = key.strip_prefix("collection:") {
                return is("collection", id);
            }
            if let Some(id) = key.strip_prefix("rss_article:") {
                return is("rss_article", id);
            }
            if let Some(id) = key
                .strip_prefix("vocab:")
                .or_else(|| key.strip_prefix("vocabulary:"))
            {
                return is("vocabulary", id);
            }
            false
        })
        .cloned()
        .collect()
}

/// Removes this device's doc entries for deleted entities. Doc entries
/// outlive deletions, so once the deletion record expired (90 days) every
/// device used to bring the item back from them. Each device removes its own
/// copies (a doc deletion only covers its author), as tombstones reach it.
/// Returns how many entries were removed.
#[tauri::command]
pub async fn docs_purge_entities(
    app: tauri::AppHandle,
    entities: Vec<DeletedEntity>,
) -> Result<usize, String> {
    if entities.is_empty() {
        return Ok(0);
    }
    let snapshot = get_docs_snapshot(&app).await?;
    let sync_state = get_sync_state(&app)?;
    let doc_ids: Vec<iroh_docs::NamespaceId> = {
        let devices = sync_state.transport_state.paired_devices.lock().await;
        devices
            .values()
            .filter_map(|d| d.sync_doc_id.parse().ok())
            .collect()
    };
    let mut removed = 0usize;
    for doc_id in doc_ids {
        let Ok(Some(doc)) = snapshot.api.open(doc_id).await else {
            continue;
        };
        removed += purge_entities_in_doc(
            &doc,
            &snapshot.blobs,
            snapshot.author,
            &entities,
            Some(&snapshot.own_deletions),
        )
        .await;
    }
    Ok(removed)
}

/// [`docs_purge_entities`] for one doc: this device's entries of deleted
/// items are removed, and in its annotation groups the records of deleted
/// annotations (and of every annotation of a deleted book) become deletion
/// markers. Returns how many entries were removed or records marked.
async fn purge_entities_in_doc(
    doc: &iroh_docs::api::Doc,
    blobs: &iroh_blobs::api::Store,
    author: iroh_docs::AuthorId,
    entities: &[DeletedEntity],
    own: Option<&crate::sync_deletions::OwnDeletions>,
) -> usize {
    let own_keys = own_entry_keys(doc, author).await;
    let removed = purge_single_entries(doc, author, entities, &own_keys, own).await;
    let of_kind = |kind: &str| -> std::collections::HashSet<&str> {
        entities
            .iter()
            .filter(|e| e.entity_type == kind && !e.entity_id.is_empty())
            .map(|e| e.entity_id.as_str())
            .collect()
    };
    let now = chrono::Utc::now().timestamp_millis();
    removed
        + crate::sync_annotations::purge_groups(
            doc,
            blobs,
            author,
            &own_keys,
            &of_kind("book"),
            &of_kind("annotation"),
            now,
        )
        .await
}

/// This device's keys in `doc` (deletions left out).
async fn own_entry_keys(doc: &iroh_docs::api::Doc, author: iroh_docs::AuthorId) -> Vec<String> {
    use futures::pin_mut;
    use futures::StreamExt;
    let mut own_keys = Vec::new();
    if let Ok(stream) = doc
        .get_many(iroh_docs::store::Query::author(author).build())
        .await
    {
        pin_mut!(stream);
        while let Some(Ok(entry)) = stream.next().await {
            own_keys.push(String::from_utf8_lossy(entry.key()).to_string());
        }
    }
    own_keys
}

/// Removes this device's entries (`own_keys`) that hold a deleted entity,
/// noting each deletion in `own` (see `sync_deletions`).
async fn purge_single_entries(
    doc: &iroh_docs::api::Doc,
    author: iroh_docs::AuthorId,
    entities: &[DeletedEntity],
    own_keys: &[String],
    own: Option<&crate::sync_deletions::OwnDeletions>,
) -> usize {
    let mut removed = 0usize;
    for key in keys_of_deleted(entities, own_keys) {
        // A doc deletion is by prefix: never remove a longer key that is
        // not itself deleted (book:12 would take book:123 with it).
        let shadows_live_key = own_keys
            .iter()
            .any(|other| other.len() > key.len() && other.starts_with(&key));
        if shadows_live_key {
            continue;
        }
        match doc.del(author, key.clone().into_bytes()).await {
            Ok(n) => {
                removed += n;
                if let Some(own) = own {
                    own.record(doc, &key).await;
                }
            }
            Err(e) => log::warn!("[iroh-sync] could not remove {key}: {e}"),
        }
    }
    removed
}

/// Keys that hold one record each: with several paired devices, the copy
/// written last wins whole.
fn is_per_entity_key(key: &str) -> bool {
    [
        "book:",
        "anno:",
        "annotation:",
        "collection:",
        "cover:",
        "rss_article:",
        "rss_feed:",
        "tomb:",
        "vocab:",
        "vocabulary:",
    ]
    .iter()
    .any(|prefix| key.starts_with(prefix))
}

/// When a record last changed, by the stamps the app keeps in it (ms since
/// the epoch; ISO dates or numbers): the newest of them.
fn record_stamp(value: &str) -> Option<i64> {
    let record: serde_json::Value = serde_json::from_str(value).ok()?;
    stamp_of(&record)
}

fn stamp_of(record: &serde_json::Value) -> Option<i64> {
    const STAMPS: [&str; 6] = [
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

/// A record's own `id` (when it is a string) and its stamp ([`record_stamp`]);
/// `None` when it is not a JSON object.
pub(crate) fn record_meta(value: &str) -> Option<(Option<String>, Option<i64>)> {
    let record: serde_json::Value = serde_json::from_str(value).ok()?;
    if !record.is_object() {
        return None;
    }
    let id = record.get("id").and_then(|v| v.as_str()).map(String::from);
    Some((id, stamp_of(&record)))
}

/// One value per key from the copies in each paired device's doc (each with
/// the time it was written). Records: the copy with the newest change (by
/// the record's own stamps; by when it was written when they tie or are
/// missing). The time of writing alone misleads: a device that passes on an
/// item it received writes its copy when it provisions, which can be after
/// another device's newer edit it has not read yet; that stale copy then hid
/// the edit from it, and from every device behind it, for good. Objects
/// (settings, stats): merged field by field, newer copies winning. Lists:
/// concatenated oldest first, for the app's merge to deduplicate. Anything
/// else: newest.
fn combine_doc_values(
    per_key: std::collections::HashMap<String, Vec<(u64, String)>>,
) -> std::collections::HashMap<String, String> {
    let mut results = std::collections::HashMap::new();
    for (key, mut values) in per_key {
        values.sort_by_key(|(at, _)| *at);
        let newest = || values.last().map(|(_, v)| v.clone()).unwrap_or_default();
        if values.len() == 1 {
            results.insert(key, newest());
            continue;
        }
        if is_per_entity_key(&key) {
            let latest = values
                .iter()
                .map(|(at, v)| ((record_stamp(v).unwrap_or(i64::MIN), *at), v))
                .max_by_key(|(order, _)| *order)
                .map(|(_, v)| v.clone())
                .unwrap_or_default();
            results.insert(key, latest);
            continue;
        }
        let parsed: Vec<serde_json::Value> = values
            .iter()
            .filter_map(|(_, v)| serde_json::from_str(v).ok())
            .collect();
        let all_parsed = parsed.len() == values.len();
        let all_objects = all_parsed && parsed.iter().all(|v| v.is_object());
        let all_arrays = all_parsed && parsed.iter().all(|v| v.is_array());
        let combined = if all_objects {
            let mut merged = serde_json::Map::new();
            for obj in parsed.iter().filter_map(|v| v.as_object()) {
                for (k, val) in obj {
                    merged.insert(k.clone(), val.clone());
                }
            }
            // A shallow replacement would discard another author's offline reading.
            // Merge the optional extension independently; old peers still send legacy stats.
            if key == "reading_stats" {
                let mut rhythm = None;
                for value in &parsed {
                    if let Some(raw) = value.get("rhythm").filter(|v| !v.is_null()) {
                        if let Ok(incoming) = serde_json::from_value(raw.clone()) {
                            let request = theorem_core::reading_rhythm::RhythmRequest {
                                today: chrono::Local::now()
                                    .format("%Y-%m-%d")
                                    .to_string()
                                    .into_boxed_str(),
                                state: rhythm.clone(),
                                incoming: Some(incoming),
                                goal: None,
                                reading: None,
                            };
                            if let Ok(progress) = theorem_core::reading_rhythm::evaluate(request) {
                                rhythm = Some(progress.state);
                            }
                        }
                    }
                }
                if let Some(rhythm) = rhythm {
                    if let Ok(value) = serde_json::to_value(rhythm) {
                        merged.insert("rhythm".into(), value);
                    }
                }
            }
            serde_json::to_string(&merged).ok()
        } else if all_arrays {
            let merged: Vec<serde_json::Value> = parsed
                .iter()
                .filter_map(|v| v.as_array())
                .flatten()
                .cloned()
                .collect();
            serde_json::to_string(&merged).ok()
        } else {
            None
        };
        let value = combined.unwrap_or_else(newest);
        results.insert(key, value);
    }
    results
}

async fn get_docs_api_or_init(app: &tauri::AppHandle) -> Result<iroh_docs::api::DocsApi, String> {
    match get_docs_api(app).await {
        Ok(api) => Ok(api),
        Err(e) => {
            log::warn!("[iroh-sync] {e} — restarting sync endpoint with database cleanup");

            let _ = iroh_start(app.clone()).await;

            get_docs_api(app).await
        }
    }
}

#[tauri::command]
pub async fn docs_sync_now(app: tauri::AppHandle, peer_device_id: String) -> Result<(), String> {
    let api = get_docs_api_or_init(&app).await?;
    let sync_state = get_sync_state(&app)?;
    let (doc_id, peer_pk, relay_url, ip, port) = {
        let devices = sync_state.transport_state.paired_devices.lock().await;
        let device = devices
            .get(&peer_device_id)
            .ok_or_else(|| "Peer not paired".to_string())?;
        let sync_doc_id = device.sync_doc_id.clone();
        let sync_doc_ticket = device.sync_doc_ticket.clone();
        let iroh_node_id = device.iroh_node_id.clone();
        let peer_relay_url = device.peer_relay_url.clone();
        let last_ip = device.last_ip.clone();
        let last_port = device.last_port;
        drop(devices);

        let doc_id: iroh_docs::NamespaceId = if sync_doc_id.is_empty() {
            if !sync_doc_ticket.is_empty() {
                log::warn!(
                    "[iroh-sync] sync_doc_id empty for {peer_device_id} — \
                     attempting recovery from stored ticket"
                );
                if let Ok(ticket) = sync_doc_ticket.parse::<iroh_docs::DocTicket>() {
                    match api.import(ticket).await {
                        Ok(doc) => {
                            let new_doc_id_str = doc.id().to_string();
                            {
                                let mut devices =
                                    sync_state.transport_state.paired_devices.lock().await;
                                if let Some(d) = devices.get_mut(&peer_device_id) {
                                    d.sync_doc_id = new_doc_id_str.clone();
                                    let _ = sync_state.transport_state.persist_paired(&devices);
                                }
                            }
                            // The paired_devices guard is released above before
                            // get_blobs_store (which awaits the docs_api lock); holding
                            // both would invert the docs_api -> paired_devices lock order
                            // and deadlock against docs_get_all_entries.
                            if let Ok(blobs) = get_blobs_store(&app).await {
                                iroh_sync::subscribe_doc_events(app.clone(), doc.clone(), blobs);
                            }
                            new_doc_id_str
                                .parse()
                                .map_err(|e| format!("parse recovered doc id: {e}"))?
                        }
                        Err(e) => {
                            return Err(format!("Sync doc recovery from ticket failed: {e}"));
                        }
                    }
                } else {
                    return Err("No sync doc for this peer — re-pair required".to_string());
                }
            } else {
                return Err("No sync doc for this peer — re-pair required".to_string());
            }
        } else {
            sync_doc_id
                .parse()
                .map_err(|e| format!("parse doc id: {e}"))?
        };
        let pk: iroh::PublicKey = iroh_node_id
            .parse()
            .map_err(|e| format!("parse peer key: {e}"))?;
        (doc_id, pk, peer_relay_url, last_ip, last_port)
    };

    let doc = match api.open(doc_id).await {
        Ok(Some(d)) => d,
        Ok(None) | Err(_) => {
            let ticket_str = {
                let devices = sync_state.transport_state.paired_devices.lock().await;
                devices
                    .get(&peer_device_id)
                    .map(|d| d.sync_doc_ticket.clone())
                    .unwrap_or_default()
            };

            if let Ok(ticket) = ticket_str.parse::<iroh_docs::DocTicket>() {
                log::info!("[iroh-sync] Re-importing doc from stored ticket...");
                match api.import(ticket).await {
                    Ok(imported) => {
                        let new_doc_id = imported.id().to_string();
                        {
                            let mut devices =
                                sync_state.transport_state.paired_devices.lock().await;
                            if let Some(d) = devices.get_mut(&peer_device_id) {
                                d.sync_doc_id = new_doc_id;
                                let _ = sync_state.transport_state.persist_paired(&devices);
                            }
                        }
                        // Release paired_devices before get_blobs_store (docs_api) to
                        // keep the global docs_api -> paired_devices lock order.
                        if let Ok(blobs) = get_blobs_store(&app).await {
                            iroh_sync::subscribe_doc_events(app.clone(), imported.clone(), blobs);
                        }
                        imported
                    }
                    Err(e) => {
                        log::warn!("[iroh-sync] Re-import from ticket failed: {e}. Ticket preserved for retry.");
                        return Err(format!("Sync doc recovery failed — will retry: {e}"));
                    }
                }
            } else {
                return Err("Sync doc not available — will retry".to_string());
            }
        }
    };

    let mut peer_addr = iroh::EndpointAddr::new(peer_pk);
    if !relay_url.is_empty() {
        if let Ok(url) = relay_url.parse::<iroh::RelayUrl>() {
            peer_addr = peer_addr.with_relay_url(url);
        }
    }

    if let Ok(ip_addr) = ip.parse::<std::net::IpAddr>() {
        if port > 0 {
            peer_addr = peer_addr.with_ip_addr(std::net::SocketAddr::new(ip_addr, port));
        }
    }

    // Reachable, and still pairs with us? (A refused sync cannot be told
    // from a completed one afterwards; see file_transfer::probe_peer.)
    crate::file_transfer::probe_peer(&app, &peer_device_id).await?;

    tokio::time::timeout(
        std::time::Duration::from_secs(15),
        doc.start_sync(vec![peer_addr]),
    )
    .await
    .map_err(|_| "Peer is offline or unreachable (timeout after 15s)".to_string())?
    .map_err(|e| format!("start_sync: {e}"))?;

    // start_sync only queues the peer; lastSyncAt is recorded when the sync
    // actually finishes (iroh_sync::record_last_sync).
    Ok(())
}

#[tauri::command]
pub async fn clear_sync_databases(app: tauri::AppHandle) -> Result<(), String> {
    iroh_stop(app.clone()).await?;
    // The docs are gone: the next read is a full one.
    *DELIVERY.lock().unwrap_or_else(|e| e.into_inner()) = None;

    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;

    let blobs_path = data_dir.join("iroh-blobs");
    let docs_path = data_dir.join("iroh-docs");
    let key_path = data_dir.join("iroh-key");
    let paired_path = data_dir.join("sync-paired-devices.json");

    let _ = std::fs::remove_dir_all(&blobs_path);
    let _ = std::fs::remove_dir_all(&docs_path);
    let _ = std::fs::remove_file(&key_path);
    let _ = std::fs::remove_file(&paired_path);

    log::info!("[iroh-sync] Cleared sync databases, identity key, and paired devices");
    Ok(())
}

#[cfg(test)]
#[path = "sync_scenarios.rs"]
mod scenarios;

#[cfg(test)]
mod tests {
    use super::*;

    fn combine(entries: &[(&str, u64, &str)]) -> std::collections::HashMap<String, String> {
        let mut per_key: std::collections::HashMap<String, Vec<(u64, String)>> =
            std::collections::HashMap::new();
        for (key, at, value) in entries {
            per_key
                .entry(key.to_string())
                .or_default()
                .push((*at, value.to_string()));
        }
        combine_doc_values(per_key)
    }

    #[test]
    fn the_newest_copy_of_a_record_wins_whatever_the_order() {
        for order in [[0, 1, 2], [2, 1, 0], [1, 2, 0]] {
            let copies = [
                ("anno:b:a", 10, r#"{"note":"old"}"#),
                ("anno:b:a", 30, r#"{"note":"newest"}"#),
                ("anno:b:a", 20, r#"{"note":"middle"}"#),
            ];
            let ordered: Vec<_> = order.iter().map(|&i| copies[i]).collect();
            assert_eq!(combine(&ordered)["anno:b:a"], r#"{"note":"newest"}"#);
        }
    }

    #[test]
    fn the_copy_with_the_newest_change_wins_not_the_one_written_last() {
        // B wrote its stale copy into the doc after A's edit (B had not read
        // it yet): the copy written last is not the newest change.
        let edited = r#"{"title":"Dune (edited)","metadataUpdatedAt":"2026-10-25T10:00:05.000Z"}"#;
        let stale = r#"{"title":"Dune","metadataUpdatedAt":"2026-10-25T09:00:00.000Z"}"#;
        let out = combine(&[("book:1", 10, edited), ("book:1", 20, stale)]);
        assert_eq!(out["book:1"], edited);
        // Annotations: updatedAt; epoch numbers as well as ISO dates.
        let out = combine(&[
            (
                "anno:b:a",
                10,
                r#"{"note":"new","updatedAt":1700000005000}"#,
            ),
            (
                "anno:b:a",
                20,
                r#"{"note":"old","updatedAt":1700000000000}"#,
            ),
        ]);
        assert_eq!(
            out["anno:b:a"],
            r#"{"note":"new","updatedAt":1700000005000}"#
        );
        // A book read later on one device and edited earlier on another: the
        // later change (reading) wins the copy; the app merges the rest.
        let read = r#"{"title":"Dune","metadataUpdatedAt":"2026-10-25T09:00:00.000Z","lastReadAt":"2026-10-25T11:00:00.000Z"}"#;
        let out = combine(&[("book:1", 30, edited), ("book:1", 20, read)]);
        assert_eq!(out["book:1"], read);
        // Copies without stamps (or with equal ones): the one written last.
        let out = combine(&[("vocab:v", 10, r#"{"t":1}"#), ("vocab:v", 20, r#"{"t":2}"#)]);
        assert_eq!(out["vocab:v"], r#"{"t":2}"#);
        let out = combine(&[
            ("anno:b:a", 20, r#"{"n":2,"updatedAt":5}"#),
            ("anno:b:a", 10, r#"{"n":1,"updatedAt":5}"#),
        ]);
        assert_eq!(out["anno:b:a"], r#"{"n":2,"updatedAt":5}"#);
        // A stamped copy beats an unstamped or unreadable one.
        let out = combine(&[
            (
                "collection:c",
                10,
                r#"{"updatedAt":"2026-01-01T00:00:00Z"}"#,
            ),
            ("collection:c", 20, "{}"),
        ]);
        assert_eq!(
            out["collection:c"],
            r#"{"updatedAt":"2026-01-01T00:00:00Z"}"#
        );
    }

    #[test]
    fn every_record_kind_is_taken_whole_never_mixed() {
        for key in [
            "book:1",
            "anno:1:2",
            "annotation:2",
            "collection:c",
            "cover:1",
            "rss_article:a",
            "vocab:v",
        ] {
            let out = combine(&[(key, 2, r#"{"a":2}"#), (key, 1, r#"{"a":1,"b":1}"#)]);
            assert_eq!(out[key], r#"{"a":2}"#, "{key}");
        }
    }

    #[test]
    fn shared_objects_merge_with_newer_fields_winning() {
        let out = combine(&[
            ("settings", 2, r#"{"theme":"dark"}"#),
            ("settings", 1, r#"{"theme":"light","fontSize":18}"#),
        ]);
        let merged: serde_json::Value = serde_json::from_str(&out["settings"]).unwrap();
        assert_eq!(merged["theme"], "dark");
        assert_eq!(merged["fontSize"], 18);
    }

    fn deleted(kind: &str, id: &str) -> DeletedEntity {
        DeletedEntity {
            entity_type: kind.into(),
            entity_id: id.into(),
        }
    }

    #[test]
    fn a_deleted_entity_takes_all_its_doc_keys_and_nothing_else() {
        let keys: Vec<String> = [
            "book:b1",
            "cover:b1",
            "anno:b1:a1",
            "anno:b1:a2",
            "book:b2",
            "cover:b2",
            "anno:b2:a3",
            "anno:b2:a4",
            "annotation:a4",
            "collection:c1",
            "collection:c2",
            "rss_article:r1",
            "vocab:v1",
            "vocabulary:v1",
            "settings",
            "book:b10",
        ]
        .iter()
        .map(|k| k.to_string())
        .collect();
        let mut purged = keys_of_deleted(
            &[
                deleted("book", "b1"),
                deleted("annotation", "a4"),
                deleted("collection", "c1"),
                deleted("rss_article", "r1"),
                deleted("vocabulary", "v1"),
                deleted("book", ""),
                deleted("feed", "settings"),
            ],
            &keys,
        );
        purged.sort();
        assert_eq!(
            purged,
            vec![
                "anno:b1:a1",
                "anno:b1:a2",
                "anno:b2:a4",
                "annotation:a4",
                "book:b1",
                "collection:c1",
                "cover:b1",
                "rss_article:r1",
                "vocab:v1",
                "vocabulary:v1",
            ]
        );
    }

    #[test]
    fn copies_are_compared_by_content_in_any_order() {
        let (a, b) = (iroh_blobs::Hash::new(b"a"), iroh_blobs::Hash::new(b"b"));
        let one = hashes_by_key(&[("k".into(), 1, a), ("k".into(), 2, b), ("j".into(), 1, a)]);
        let other = hashes_by_key(&[("k".into(), 9, b), ("k".into(), 3, a), ("j".into(), 7, a)]);
        // Same content, other timestamps and order: nothing changed.
        assert_eq!(one, other);
        let changed = hashes_by_key(&[("k".into(), 1, a), ("j".into(), 1, b)]);
        assert_ne!(one.get("j"), changed.get("j"));
        assert_ne!(one.get("k"), changed.get("k"));
    }

    #[test]
    fn lists_are_joined_and_odd_values_fall_back_to_newest() {
        let out = combine(&[("collections", 1, "[1]"), ("collections", 2, "[2]")]);
        assert_eq!(out["collections"], "[1,2]");
        let out = combine(&[("reading_stats", 1, "{}"), ("reading_stats", 2, "not json")]);
        assert_eq!(out["reading_stats"], "not json");
        let out = combine(&[("x", 5, "[1]"), ("x", 4, r#"{"a":1}"#)]);
        assert_eq!(out["x"], "[1]");
    }

    fn header(key: &str, at: u64, deletion: bool) -> EntryHeader {
        let hash = if deletion {
            iroh_blobs::Hash::EMPTY
        } else {
            iroh_blobs::Hash::new(format!("{key}@{at}"))
        };
        (key.to_string(), at, hash)
    }

    fn deleted_keys(headers: &[EntryHeader]) -> (Vec<String>, std::collections::HashSet<String>) {
        let keys: Vec<String> = headers.iter().map(|(k, _, _)| k.clone()).collect();
        let changed: std::collections::HashSet<&String> = keys.iter().collect();
        let (deleted, gone) = deletions(headers, &changed);
        (deleted.into_iter().map(|d| d.key).collect(), gone)
    }

    #[test]
    fn an_item_is_deleted_when_its_newest_copy_in_any_doc_is_a_deletion() {
        // Deleted in one pairing's doc after the copy in another pairing's doc.
        let (deleted, _) = deleted_keys(&[
            header("book:1", 20_000, true),
            header("book:1", 10_000, false),
        ]);
        assert_eq!(deleted, vec!["book:1".to_string()]);
        // Written again after the deletion (re-added, or edited later): kept.
        let (deleted, gone) = deleted_keys(&[
            header("book:1", 20_000, true),
            header("book:1", 30_000, false),
        ]);
        assert!(deleted.is_empty());
        assert!(gone.is_empty());
    }

    #[test]
    fn deletion_times_are_reported_in_milliseconds() {
        let keys = ["anno:b:a".to_string()];
        let changed: std::collections::HashSet<&String> = keys.iter().collect();
        let (deleted, _) = deletions(&[header("anno:b:a", 1_700_000_000_123_456, true)], &changed);
        assert_eq!(
            deleted,
            vec![DeletedDocKey {
                key: "anno:b:a".into(),
                at: 1_700_000_000_123
            }]
        );
    }

    #[test]
    fn only_items_are_reported_deleted_but_no_deleted_key_is_delivered() {
        let (deleted, gone) = deleted_keys(&[
            header("annotations", 5, true),
            header("annotations", 1, false),
            header("tomb:book:9", 5, true),
            header("cover:1", 5, true),
            header("settings", 5, false),
            header("rss_feed:f", 5, true),
            header("vocab:v", 5, true),
        ]);
        assert_eq!(
            deleted,
            vec!["rss_feed:f".to_string(), "vocab:v".to_string()]
        );
        for key in [
            "annotations",
            "tomb:book:9",
            "cover:1",
            "rss_feed:f",
            "vocab:v",
        ] {
            assert!(gone.contains(key), "{key} must not be delivered as current");
        }
        assert!(!gone.contains("settings"));
    }

    #[test]
    fn keys_outside_the_changed_set_are_left_alone() {
        let headers = [header("book:1", 5, true), header("book:2", 5, true)];
        let only = "book:2".to_string();
        let changed: std::collections::HashSet<&String> = [&only].into_iter().collect();
        let (deleted, _) = deletions(&headers, &changed);
        assert_eq!(deleted.len(), 1);
        assert_eq!(deleted[0].key, "book:2");
    }

    #[test]
    fn whole_lists_are_for_older_versions_only() {
        for key in LEGACY_LIST_KEYS {
            assert!(is_legacy_list_key(key));
        }
        for key in [
            "book:1",
            "anno:b:a",
            "vocab:v",
            "tomb:book:1",
            "settings",
            "reading_stats",
        ] {
            assert!(!is_legacy_list_key(key), "{key}");
        }
        assert!(reads_legacy_lists(0));
        assert!(reads_legacy_lists(1));
        assert!(!reads_legacy_lists(
            theorem_sync_core::sync_protocol::SYNC_PROTOCOL
        ));
    }

    #[test]
    fn a_prefix_deletion_never_takes_a_key_that_is_kept() {
        let own = vec!["tomb:book:1".to_string(), "tomb:book:12".to_string()];
        let keep: std::collections::HashSet<String> = ["tomb:book:12".to_string()].into();
        assert!(shadows_other_key("tomb:book:1", &own, &keep));
        let keep_none = std::collections::HashSet::new();
        assert!(!shadows_other_key("tomb:book:1", &own, &keep_none));
    }

    /// A real iroh-docs engine in memory, with one doc that two authors
    /// write to: "here" (this device) and "there" (the other device, whose
    /// entries arrived by sync).
    mod with_a_doc {
        use super::*;

        struct Fixture {
            doc: iroh_docs::api::Doc,
            blobs: iroh_blobs::api::Store,
            here: iroh_docs::AuthorId,
            there: iroh_docs::AuthorId,
            _router: iroh::protocol::Router,
            _docs: iroh_docs::protocol::Docs,
        }

        async fn fixture() -> Fixture {
            let ep = iroh::Endpoint::builder(iroh::endpoint::presets::Minimal)
                .bind()
                .await
                .unwrap();
            let blobs = iroh_blobs::store::mem::MemStore::new();
            let gossip = iroh_gossip::net::Gossip::builder().spawn(ep.clone());
            let docs = iroh_docs::protocol::Docs::memory()
                .spawn(ep.clone(), (*blobs).clone(), gossip.clone())
                .await
                .unwrap();
            let router = iroh::protocol::Router::builder(ep)
                .accept(iroh_gossip::ALPN, gossip)
                .accept(iroh_docs::ALPN, docs.clone())
                .spawn();
            let api = docs.api().clone();
            let doc = api.create().await.unwrap();
            let here = api.author_create().await.unwrap();
            let there = api.author_create().await.unwrap();
            Fixture {
                doc,
                blobs: (*blobs).clone(),
                here,
                there,
                _router: router,
                _docs: docs,
            }
        }

        /// Writes as provisioning does; how many were written (none failing).
        async fn written(
            f: &Fixture,
            author: iroh_docs::AuthorId,
            protocol: u8,
            entries: &[(String, String)],
        ) -> usize {
            let (n, _, error) =
                write_entries_to_doc(&f.doc, &f.blobs, author, protocol, entries, true).await;
            assert_eq!(error, None);
            n
        }

        fn entry(key: &str, value: &str) -> (String, String) {
            (key.to_string(), value.to_string())
        }

        async fn deleted_now(doc: &iroh_docs::api::Doc) -> Vec<String> {
            deleted_keys(&read_headers(doc, None).await).0
        }

        #[tokio::test]
        async fn an_unchanged_value_is_not_written_again() {
            let f = fixture().await;
            let book = [entry("book:1", r#"{"title":"Dune"}"#)];
            assert_eq!(written(&f, f.here, 2, &book).await, 1);
            assert_eq!(written(&f, f.here, 2, &book).await, 0);
            let edited = [entry("book:1", r#"{"title":"Dune Messiah"}"#)];
            assert_eq!(written(&f, f.here, 2, &edited).await, 1);
            // The same value from the other device is a different entry: ours is written.
            let theirs = [entry("book:2", "x")];
            assert_eq!(written(&f, f.there, 2, &theirs).await, 1);
            assert_eq!(written(&f, f.here, 2, &theirs).await, 1);
        }

        #[tokio::test]
        async fn whole_lists_go_only_to_devices_on_older_versions() {
            let f = fixture().await;
            let lists = [entry("annotations", "[]"), entry("anno:b:a", "{}")];
            assert_eq!(written(&f, f.here, 2, &lists).await, 1);
            assert!(f
                .doc
                .get_exact(f.here, "annotations", false)
                .await
                .unwrap()
                .is_none());
            assert_eq!(written(&f, f.here, 0, &lists).await, 1);
            assert!(f
                .doc
                .get_exact(f.here, "annotations", false)
                .await
                .unwrap()
                .is_some());
        }

        #[tokio::test]
        async fn a_device_back_after_months_does_not_bring_back_what_was_deleted() {
            let f = fixture().await;
            let book = [entry("book:1", r#"{"title":"Dune"}"#)];
            written(&f, f.here, 2, &book).await;
            assert!(deleted_now(&f.doc).await.is_empty());

            // Deleted on the other device while this one was away.
            tokio::time::sleep(std::time::Duration::from_millis(2)).await;
            f.doc.del(f.there, "book:1").await.unwrap();
            assert_eq!(deleted_now(&f.doc).await, vec!["book:1".to_string()]);

            // This device starts again and provisions its unchanged copy: not
            // rewritten, so the deletion stays the newest entry.
            assert_eq!(written(&f, f.here, 2, &book).await, 0);
            assert_eq!(deleted_now(&f.doc).await, vec!["book:1".to_string()]);

            // A changed copy is not written over the deletion either: it is
            // reported, for the app to decide.
            tokio::time::sleep(std::time::Duration::from_millis(2)).await;
            let edited = [entry("book:1", r#"{"title":"Dune","rating":5}"#)];
            let (n, reported, error) =
                write_entries_to_doc(&f.doc, &f.blobs, f.here, 2, &edited, true).await;
            assert_eq!((n, error), (0, None));
            assert_eq!(reported.len(), 1);
            assert_eq!(reported[0].key, "book:1");
            assert_eq!(deleted_now(&f.doc).await, vec!["book:1".to_string()]);

            // Edited here after the deletion: the app writes it anyway and it stays.
            let (n, _, error) =
                write_entries_to_doc(&f.doc, &f.blobs, f.here, 2, &edited, false).await;
            assert_eq!((n, error), (1, None));
            assert!(deleted_now(&f.doc).await.is_empty());
        }

        #[tokio::test]
        async fn a_device_that_never_sent_an_item_does_not_bring_it_back() {
            let f = fixture().await;
            // Written and deleted by the other device before this one wrote it.
            written(&f, f.there, 2, &[entry("book:7", r#"{"title":"Old"}"#)]).await;
            tokio::time::sleep(std::time::Duration::from_millis(2)).await;
            f.doc.del(f.there, "book:7").await.unwrap();

            let copy = [entry("book:7", r#"{"title":"Old"}"#), entry("book:8", "{}")];
            let (n, reported, error) =
                write_entries_to_doc(&f.doc, &f.blobs, f.here, 2, &copy, true).await;
            assert_eq!((n, error), (1, None));
            assert_eq!(
                reported.iter().map(|d| d.key.as_str()).collect::<Vec<_>>(),
                vec!["book:7"]
            );
            assert!(reported[0].at > 0);
            assert_eq!(deleted_now(&f.doc).await, vec!["book:7".to_string()]);
            // Settings and the like are never held back.
            let (n, reported, _) = write_entries_to_doc(
                &f.doc,
                &f.blobs,
                f.here,
                2,
                &[entry("settings", "{}")],
                true,
            )
            .await;
            assert_eq!((n, reported.len()), (1, 0));
        }

        fn anno(id: &str, updated: i64, note: &str) -> String {
            format!(r#"{{"id":"{id}","bookId":"b1","updatedAt":{updated},"note":"{note}"}}"#)
        }

        async fn own_group(f: &Fixture, author: iroh_docs::AuthorId, book: &str) -> Option<String> {
            let entry = f
                .doc
                .get_exact(author, format!("annos:{book}:").into_bytes(), false)
                .await
                .unwrap()?;
            content_of(&f.blobs, entry.content_hash()).await
        }

        async fn read(f: &Fixture) -> DocRead {
            read_docs(std::slice::from_ref(&f.doc), &f.blobs, None, None).await
        }

        #[tokio::test]
        async fn annotations_go_into_one_group_per_book_rewritten_only_when_changed() {
            let f = fixture().await;
            let entries = [
                entry("anno:b1:x", &anno("x", 10, "x")),
                entry("anno:b1:y", &anno("y", 10, "y")),
                entry("anno:b2:z", &anno("z", 10, "z")),
                entry("book:b1", "{}"),
            ];
            assert_eq!(written(&f, f.here, 3, &entries).await, 4);
            // Two groups and the book; no single entries for a device on 3.
            let keys: Vec<String> = read_headers(&f.doc, None)
                .await
                .into_iter()
                .map(|(k, _, _)| k)
                .collect();
            assert_eq!(keys.len(), 3, "{keys:?}");
            assert!(keys.contains(&"annos:b1:".to_string()));
            assert!(keys.contains(&"annos:b2:".to_string()));
            let before = f
                .doc
                .get_exact(f.here, "annos:b1:", false)
                .await
                .unwrap()
                .unwrap();
            // Nothing changed: nothing written, the group keeps its date.
            assert_eq!(written(&f, f.here, 3, &entries).await, 0);
            let after = f
                .doc
                .get_exact(f.here, "annos:b1:", false)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(before.timestamp(), after.timestamp());
            // One annotation changed: only its book's group is written.
            let edit = [entry("anno:b1:y", &anno("y", 20, "y2"))];
            assert_eq!(written(&f, f.here, 3, &edit).await, 1);
            let group =
                crate::sync_annotations::Group::parse(&own_group(&f, f.here, "b1").await.unwrap())
                    .unwrap();
            assert_eq!(group.annotations["x"].get(), anno("x", 10, "x"));
            assert_eq!(group.annotations["y"].get(), anno("y", 20, "y2"));
            // Read back as one item per annotation, as the app knows them.
            let r = read(&f).await;
            assert_eq!(r.entries["anno:b1:y"], anno("y", 20, "y2"));
            assert_eq!(r.entries["anno:b2:z"], anno("z", 10, "z"));
            assert!(!r.entries.keys().any(|k| k.starts_with("annos:")));
            // A group is never taken from the app.
            assert_eq!(written(&f, f.here, 3, &[entry("annos:b9:", "{}")]).await, 0);
        }

        #[tokio::test]
        async fn devices_on_older_versions_also_get_one_entry_per_annotation() {
            let f = fixture().await;
            let entries = [entry("anno:b1:x", &anno("x", 10, "x"))];
            assert_eq!(written(&f, f.here, 2, &entries).await, 1);
            assert!(f
                .doc
                .get_exact(f.here, "anno:b1:x", false)
                .await
                .unwrap()
                .is_some());
            assert!(own_group(&f, f.here, "b1").await.is_some());
            assert_eq!(written(&f, f.here, 2, &entries).await, 0);
            // A newer edit goes into both.
            let edit = [entry("anno:b1:x", &anno("x", 20, "x2"))];
            assert_eq!(written(&f, f.here, 2, &edit).await, 1);
            let single = f
                .doc
                .get_exact(f.here, "anno:b1:x", false)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(
                content_of(&f.blobs, single.content_hash()).await.unwrap(),
                anno("x", 20, "x2")
            );
            // Emptied since (a deletion by an older version): held back like
            // any deletion newer than the record, unless the app insists.
            tokio::time::sleep(std::time::Duration::from_millis(2)).await;
            f.doc.del(f.here, "anno:b1:x").await.unwrap();
            let (n, held, _) = write_entries_to_doc(&f.doc, &f.blobs, f.here, 2, &edit, true).await;
            assert_eq!((n, held.len()), (0, 1));
            let (n, _, _) = write_entries_to_doc(&f.doc, &f.blobs, f.here, 2, &edit, false).await;
            assert_eq!(n, 1);
        }

        #[tokio::test]
        async fn a_highlight_deleted_elsewhere_is_held_back_unless_changed_after() {
            let f = fixture().await;
            // The other device deleted x at 50 ms (a marker in its group).
            let mut theirs = crate::sync_annotations::Group::default();
            theirs.put_deleted("x", 50);
            f.doc
                .set_bytes(
                    f.there,
                    b"annos:b1:".to_vec(),
                    theirs.to_json().into_bytes(),
                )
                .await
                .unwrap();
            // This device's copy predates it: held back, for the app to decide.
            let old = [entry("anno:b1:x", &anno("x", 40, "old"))];
            let (n, held, error) =
                write_entries_to_doc(&f.doc, &f.blobs, f.here, 3, &old, true).await;
            assert_eq!((n, error), (0, None));
            assert_eq!(
                held,
                vec![DeletedDocKey {
                    key: "anno:b1:x".into(),
                    at: 50
                }]
            );
            assert!(own_group(&f, f.here, "b1").await.is_none());
            // Edited after the deletion: written, and it stays.
            let newer = [entry("anno:b1:x", &anno("x", 60, "kept"))];
            let (n, held, _) =
                write_entries_to_doc(&f.doc, &f.blobs, f.here, 3, &newer, true).await;
            assert_eq!((n, held.len()), (1, 0));
            let r = read(&f).await;
            assert_eq!(r.entries["anno:b1:x"], anno("x", 60, "kept"));
            assert!(r.deleted.is_empty());
        }

        #[tokio::test]
        async fn a_deleted_book_or_highlight_becomes_a_marker_in_the_group() {
            let f = fixture().await;
            let entries = [
                entry("anno:b1:x", &anno("x", 10, "x")),
                entry("anno:b1:y", &anno("y", 10, "y")),
                entry("anno:b2:z", &anno("z", 10, "z")),
                entry("anno:b12:w", &anno("w", 10, "w")),
            ];
            written(&f, f.here, 3, &entries).await;
            let deleted_entity = |kind: &str, id: &str| DeletedEntity {
                entity_type: kind.into(),
                entity_id: id.into(),
            };
            let n = purge_entities_in_doc(
                &f.doc,
                &f.blobs,
                f.here,
                &[
                    deleted_entity("annotation", "x"),
                    deleted_entity("book", "b2"),
                ],
                None,
            )
            .await;
            assert_eq!(n, 2);
            // Purging again changes nothing (the markers keep their time).
            let again = purge_entities_in_doc(
                &f.doc,
                &f.blobs,
                f.here,
                &[
                    deleted_entity("annotation", "x"),
                    deleted_entity("book", "b2"),
                ],
                None,
            )
            .await;
            assert_eq!(again, 0);
            let r = read(&f).await;
            let mut gone: Vec<&str> = r.deleted.iter().map(|d| d.key.as_str()).collect();
            gone.sort();
            assert_eq!(gone, vec!["anno:b1:x", "anno:b2:z"]);
            assert!(r.entries.contains_key("anno:b1:y"));
            assert!(r.entries.contains_key("anno:b12:w"), "book b12 is not b1");
            // The groups are still there: no empty entries.
            let empties = read_headers(&f.doc, None)
                .await
                .into_iter()
                .filter(|(_, _, h)| *h == iroh_blobs::Hash::EMPTY)
                .count();
            assert_eq!(empties, 0);
        }

        #[tokio::test]
        async fn old_deletions_are_copied_into_the_group_as_markers() {
            let f = fixture().await;
            // Before protocol 3: x and y written one entry each, x deleted.
            written(&f, f.here, 2, &[entry("anno:b1:x", &anno("x", 10, "x"))]).await;
            written(&f, f.here, 2, &[entry("anno:b1:y", &anno("y", 10, "y"))]).await;
            tokio::time::sleep(std::time::Duration::from_millis(2)).await;
            f.doc.del(f.here, "anno:b1:x").await.unwrap();
            let deleted_at = f
                .doc
                .get_exact(f.here, "anno:b1:x", true)
                .await
                .unwrap()
                .unwrap()
                .timestamp()
                / 1000;
            let before = read(&f).await;
            assert_eq!(before.deleted.len(), 1);

            let added = crate::sync_annotations::fold_single_deletions(&f.doc, &f.blobs, f.here)
                .await
                .unwrap();
            assert_eq!(added, 1);
            let group =
                crate::sync_annotations::Group::parse(&own_group(&f, f.here, "b1").await.unwrap())
                    .unwrap();
            assert_eq!(group.deleted.get("x").copied(), Some(deleted_at as i64));
            assert!(group.annotations.contains_key("y"));
            // Nothing a read decides changes; doing it again adds nothing.
            let after = read(&f).await;
            assert_eq!(after.deleted, before.deleted);
            assert_eq!(after.entries, before.entries);
            assert_eq!(
                crate::sync_annotations::fold_single_deletions(&f.doc, &f.blobs, f.here)
                    .await
                    .unwrap(),
                0
            );
        }

        #[tokio::test]
        async fn live_updates_deliver_the_combined_state_of_what_an_entry_mentions() {
            let f = fixture().await;
            written(
                &f,
                f.here,
                3,
                &[entry("anno:b1:x", &anno("x", 30, "mine, newer"))],
            )
            .await;
            let mut theirs = crate::sync_annotations::Group::default();
            theirs
                .put_record("x", &anno("x", 20, "theirs, older"))
                .unwrap();
            theirs.put_record("y", &anno("y", 20, "theirs")).unwrap();
            theirs.put_deleted("z", 25);
            let raw = theirs.to_json();
            f.doc
                .set_bytes(f.there, b"annos:b1:".to_vec(), raw.clone().into_bytes())
                .await
                .unwrap();
            let (mut entries, deleted) = crate::sync_annotations::live_annotations(
                &f.doc,
                &f.blobs,
                "annos:b1:",
                Some(&raw),
            )
            .await;
            entries.sort();
            assert_eq!(
                entries,
                vec![
                    ("anno:b1:x".to_string(), anno("x", 30, "mine, newer")),
                    ("anno:b1:y".to_string(), anno("y", 20, "theirs")),
                ]
            );
            assert_eq!(
                deleted,
                vec![DeletedDocKey {
                    key: "anno:b1:z".into(),
                    at: 25
                }]
            );
            // An older device's single entry: only that annotation.
            let (entries, _) = crate::sync_annotations::live_annotations(
                &f.doc,
                &f.blobs,
                "anno:b1:y",
                Some("{}"),
            )
            .await;
            assert_eq!(entries.len(), 1);
            // Keys that name no annotation deliver nothing.
            let (entries, deleted) =
                crate::sync_annotations::live_annotations(&f.doc, &f.blobs, "anno:", None).await;
            assert!(entries.is_empty() && deleted.is_empty());
        }
    }
}
