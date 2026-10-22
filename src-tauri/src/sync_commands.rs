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

pub fn init_sync(
    app_data_dir: PathBuf,
    device_name: String,
    app_handle: tauri::AppHandle,
) -> Result<SyncState, String> {
    let key_path = app_data_dir.join("iroh-key");
    let secret_key = crate::iroh_sync::load_or_create_key(&key_path)?;
    let public_key_bytes = *secret_key.public().as_bytes();
    let device_id = sync_crypto::compute_device_id(&public_key_bytes);
    let fingerprint = sync_crypto::read_machine_fingerprint();

    let paired_devices = iroh_sync::load_paired_devices_from_disk(&app_data_dir);
    let allowlist = Arc::new(crate::sync_access::PeerAllowlist::from_devices(
        &paired_devices,
    ));

    let transport_state = Arc::new(SyncTransportState {
        app_handle,
        device_id,
        fingerprint,
        device_name,
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
    if let Some(ep) = IROH_ENDPOINT.lock().unwrap().clone() {
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
            sync_state.transport_state.device_name.clone(),
            sync_crypto::get_frontend_fingerprint()
                .unwrap_or_else(|| sync_state.transport_state.fingerprint.clone()),
            sync_state.transport_state.allowlist.clone(),
        )
        .await?,
    );
    let mut guard = IROH_ENDPOINT.lock().unwrap();
    if guard.is_none() {
        *guard = Some(ep);
    }
    // Return the cached endpoint so every caller talks to the same transport
    // the accept loop uses (a concurrently-built endpoint would be orphaned).
    Ok(guard.as_ref().unwrap().clone())
}

pub fn get_iroh_relay_url() -> String {
    IROH_ENDPOINT
        .lock()
        .unwrap()
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
            eprintln!(
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
            eprintln!("[iroh-sync] Sync engine failed to start — retrying with a fresh database");

            let old_ep = IROH_ENDPOINT.lock().unwrap().clone();
            if let Some(ep) = old_ep {
                ep.close().await;
            }
            *IROH_ENDPOINT.lock().unwrap() = None;
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
    let endpoint = IROH_ENDPOINT.lock().unwrap().clone();
    if let Some(ep) = endpoint {
        ep.close().await;
    }
    *IROH_ENDPOINT.lock().unwrap() = None;
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
        device_name: sync_state.transport_state.device_name.clone(),
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
        device_name: sync_state.transport_state.device_name.clone(),
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
            .unwrap_or_else(|e| eprintln!("[sync] Failed to save paired devices: {e}"));
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
                                eprintln!("[sync] Failed to save paired devices: {e}")
                            });
                    }
                }
                Err(e) => eprintln!("[sync] Failed to import docs doc: {e}"),
            },
            Err(e) => eprintln!("[sync] Failed to parse docs ticket: {e}"),
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
        .unwrap()
        .as_ref()
        .map(|ep| ep.public_key_string())
        .unwrap_or_default();
    Ok(DeviceIdentityInfo {
        device_id: sync_state.transport_state.device_id.clone(),
        device_name: sync_state.transport_state.device_name.clone(),
        public_key_hex: public_key,
        fingerprint: sync_crypto::get_frontend_fingerprint()
            .unwrap_or_else(|| sync_state.transport_state.fingerprint.clone()),
    })
}

#[tauri::command]
pub async fn set_device_fingerprint(fingerprint: String) -> Result<(), String> {
    theorem_sync_core::sync_crypto::set_fingerprint_from_frontend(&fingerprint);
    eprintln!("[sync] Device fingerprint set from frontend: {fingerprint}");
    Ok(())
}

#[tauri::command]
pub async fn get_paired_devices(app: tauri::AppHandle) -> Result<Vec<PairedDeviceInfo>, String> {
    let sync_state = get_sync_state(&app)?;
    let devices = sync_state.transport_state.paired_devices.lock().await;
    Ok(devices.values().map(PairedDeviceInfo::from).collect())
}

/// Forgets a device. It is refused from now on, connections already open to
/// it are closed (the sync engine restarts), and the doc shared with it is
/// deleted from this device as the engine starts. Each pairing has its own
/// doc, so the removed device never had the docs shared with other devices.
#[tauri::command]
pub async fn unpair_device(app: tauri::AppHandle, device_id: String) -> Result<(), String> {
    let sync_state = get_sync_state(&app)?;
    let removed = {
        let mut devices = sync_state.transport_state.paired_devices.lock().await;
        let removed = devices
            .remove(&device_id)
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
    // The gate only checks new connections: restart to close the open ones.
    let was_running = sync_state.accept_cancel.lock().await.is_some();
    if was_running {
        iroh_stop(app.clone()).await?;
        if let Err(e) = iroh_start(app).await {
            eprintln!("[iroh-sync] Sync restart after unpairing: {e}");
        }
    }
    Ok(())
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

#[tauri::command]
pub async fn docs_set_entry(
    app: tauri::AppHandle,
    key: String,
    value: String,
) -> Result<(), String> {
    let api = get_docs_api(&app).await?;
    let author = get_docs_author(&app).await?;
    let sync_state = get_sync_state(&app)?;

    let targets: Vec<(iroh_docs::NamespaceId,)> = {
        let devices = sync_state.transport_state.paired_devices.lock().await;
        devices
            .values()
            .filter(|d| !d.sync_doc_id.is_empty())
            .filter_map(|d| {
                d.sync_doc_id
                    .parse::<iroh_docs::NamespaceId>()
                    .ok()
                    .map(|doc_id| (doc_id,))
            })
            .collect()
    };

    // Surface write failures instead of silently dropping data, so the
    // frontend knows the sync doc wasn't updated and can retry.
    let mut first_error: Option<String> = None;
    for (doc_id,) in &targets {
        let outcome: Result<(), String> = async {
            let doc = api
                .open(*doc_id)
                .await
                .map_err(|e| format!("open doc {doc_id}: {e}"))?
                .ok_or_else(|| format!("sync doc not found: {doc_id}"))?;
            doc.set_bytes(author, key.clone().into_bytes(), value.clone().into_bytes())
                .await
                .map(|_| ())
                .map_err(|e| format!("set_bytes for {doc_id}: {e}"))
        }
        .await;
        if let Err(msg) = outcome {
            eprintln!("[iroh-sync] {msg}");
            if first_error.is_none() {
                first_error = Some(msg);
            }
        }
    }

    match first_error {
        Some(err) => Err(err),
        None => Ok(()),
    }
}

#[tauri::command]
pub async fn docs_get_all_entries(
    app: tauri::AppHandle,
) -> Result<std::collections::HashMap<String, String>, String> {
    Ok(read_doc_entries(&app, None).await?.0)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedDocEntries {
    pub entries: std::collections::HashMap<String, String>,
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
    let (entries, seen) = read_doc_entries(&app, baseline).await?;
    let mut guard = DELIVERY.lock().unwrap_or_else(|e| e.into_inner());
    let delivery = guard.get_or_insert_with(Default::default);
    delivery.next_token += 1;
    let token = delivery.next_token;
    delivery.pending = Some((token, seen));
    Ok(ChangedDocEntries { entries, token })
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

/// Reads the paired docs. With `applied`, returns only keys whose copies
/// differ from it; always also returns what is now there, for the next diff.
/// A copy whose content has not arrived yet is left out of both, so it is
/// read again next time.
async fn read_doc_entries(
    app: &tauri::AppHandle,
    applied: Option<&std::collections::HashMap<String, Vec<iroh_blobs::Hash>>>,
) -> Result<
    (
        std::collections::HashMap<String, String>,
        std::collections::HashMap<String, Vec<iroh_blobs::Hash>>,
    ),
    String,
> {
    use futures::pin_mut;
    use futures::StreamExt;
    let api = get_docs_api(app).await?;
    let sync_state = get_sync_state(app)?;
    let blobs = {
        let guard = sync_state.transport_state.docs_api.lock().await;
        guard
            .as_ref()
            .ok_or_else(|| "iroh-docs not initialized".to_string())?
            .blobs
            .clone()
    };
    // Copy the doc IDs and let go of the lock: reading the docs takes a while,
    // and pairing, writes and book transfers all need it meanwhile.
    let doc_ids: Vec<iroh_docs::NamespaceId> = {
        let devices = sync_state.transport_state.paired_devices.lock().await;
        devices
            .values()
            .filter(|d| !d.sync_doc_id.is_empty())
            .map(|d| d.sync_doc_id.parse())
            .collect::<Result<_, _>>()
            .map_err(|e| format!("parse doc id: {e}"))?
    };

    // First the entry headers (cheap), then content only for keys that changed.
    let mut headers: Vec<(String, u64, iroh_blobs::Hash)> = Vec::new();
    for doc_id in doc_ids {
        if let Ok(Some(doc)) = api.open(doc_id).await {
            if let Ok(stream) = doc
                .get_many(iroh_docs::store::Query::single_latest_per_key().build())
                .await
            {
                pin_mut!(stream);
                while let Some(entry_res) = stream.next().await {
                    if let Ok(entry) = entry_res {
                        headers.push((
                            String::from_utf8_lossy(entry.key()).to_string(),
                            entry.timestamp(),
                            entry.content_hash(),
                        ));
                    }
                }
            }
        }
    }
    let current = hashes_by_key(&headers);
    let changed: std::collections::HashSet<&String> = current
        .iter()
        .filter(|(key, hashes)| applied.is_none_or(|a| a.get(*key) != Some(*hashes)))
        .map(|(key, _)| key)
        .collect();

    let mut per_key: std::collections::HashMap<String, Vec<(u64, String)>> =
        std::collections::HashMap::new();
    let mut incomplete: std::collections::HashSet<String> = std::collections::HashSet::new();
    for (key, at, hash) in &headers {
        if !changed.contains(key) {
            continue;
        }
        let mut value = None;
        // Blobs usually arrive with docs_sync_now; a short wait covers
        // near-term arrivals, and anything still missing is picked up via the
        // live ContentReady path or the next round.
        for _ in 0..2 {
            if let Ok(content) = blobs.blobs().get_bytes(*hash).await {
                value = String::from_utf8(content.to_vec()).ok();
                if value.is_some() {
                    break;
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(80)).await;
        }
        match value {
            Some(v) => per_key.entry(key.clone()).or_default().push((*at, v)),
            None => {
                incomplete.insert(key.clone());
            }
        }
    }
    eprintln!(
        "[iroh-sync] read {} changed doc keys of {} ({} waiting for content)",
        changed.len(),
        current.len(),
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
    Ok((combine_doc_values(per_key), seen))
}

/// Every device's copy of each key, as content hashes in a stable order.
fn hashes_by_key(
    headers: &[(String, u64, iroh_blobs::Hash)],
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
    use futures::pin_mut;
    use futures::StreamExt;
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
        let mut own_keys = Vec::new();
        if let Ok(stream) = doc
            .get_many(iroh_docs::store::Query::author(snapshot.author).build())
            .await
        {
            pin_mut!(stream);
            while let Some(Ok(entry)) = stream.next().await {
                own_keys.push(String::from_utf8_lossy(entry.key()).to_string());
            }
        }
        for key in keys_of_deleted(&entities, &own_keys) {
            // A doc deletion is by prefix: never remove a longer key that is
            // not itself deleted (book:12 would take book:123 with it).
            let shadows_live_key = own_keys
                .iter()
                .any(|other| other.len() > key.len() && other.starts_with(&key));
            if shadows_live_key {
                continue;
            }
            match doc.del(snapshot.author, key.clone().into_bytes()).await {
                Ok(n) => removed += n,
                Err(e) => eprintln!("[iroh-sync] could not remove {key}: {e}"),
            }
        }
    }
    Ok(removed)
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
        "vocab:",
        "vocabulary:",
    ]
    .iter()
    .any(|prefix| key.starts_with(prefix))
}

/// One value per key from the copies in each paired device's doc (each with
/// the time it was written). Records: the newest copy. Objects (settings,
/// stats): merged field by field, newer copies winning. Lists: concatenated
/// oldest first, for the app's merge to deduplicate. Anything else: newest.
fn combine_doc_values(
    per_key: std::collections::HashMap<String, Vec<(u64, String)>>,
) -> std::collections::HashMap<String, String> {
    let mut results = std::collections::HashMap::new();
    for (key, mut values) in per_key {
        values.sort_by_key(|(at, _)| *at);
        let newest = || values.last().map(|(_, v)| v.clone()).unwrap_or_default();
        if values.len() == 1 || is_per_entity_key(&key) {
            results.insert(key, newest());
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
            eprintln!("[iroh-sync] {e} — restarting sync endpoint with database cleanup");

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
                eprintln!(
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
                eprintln!("[iroh-sync] Re-importing doc from stored ticket...");
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
                        eprintln!("[iroh-sync] Re-import from ticket failed: {e}. Ticket preserved for retry.");
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

    eprintln!("[iroh-sync] Cleared sync databases, identity key, and paired devices");
    Ok(())
}

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
}
