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

    let transport_state = Arc::new(SyncTransportState {
        app_handle,
        device_id,
        fingerprint,
        device_name,
        app_data_dir,
        paired_devices: Mutex::new(paired_devices),
        docs_api: Mutex::new(None),
        docs_generation: std::sync::atomic::AtomicU64::new(0),
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

        for _ in 0..150 {
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
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }

        if attempt == 0 {
            eprintln!("[iroh-sync] Database corrupted — wiping and retrying");

            let blobs_path = data_dir.join("iroh-blobs");
            let docs_path = data_dir.join("iroh-docs");
            let _ = std::fs::remove_dir_all(&blobs_path);
            let _ = std::fs::remove_dir_all(&docs_path);

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
pub async fn iroh_pair(
    app: tauri::AppHandle,
    peer_device_id: String,
    peer_node_id: String,
    peer_device_name: String,
    peer_fingerprint: String,
) -> Result<(), String> {
    let ep = get_or_init_iroh(&app).await?;
    let peer = iroh_sync::IrohPeerInfo {
        public_key: peer_node_id
            .parse()
            .map_err(|e| format!("invalid public key: {e}"))?,
        device_id: peer_device_id,
        device_name: peer_device_name,
        fingerprint: peer_fingerprint,
    };
    ep.add_peer(peer).await;
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

    let qr_payload = PairingQrPayload {
        version: 1,
        node_id: ep.public_key_string(),
        device_id: sync_state.transport_state.device_id.clone(),
        device_name: sync_state.transport_state.device_name.clone(),
        fingerprint: sync_crypto::get_frontend_fingerprint()
            .unwrap_or_else(|| sync_state.transport_state.fingerprint.clone()),
        lan_addrs: ep
            .endpoint
            .bound_sockets()
            .into_iter()
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

    if qr_payload.version != 1 {
        return Err(format!(
            "Unsupported pairing protocol version: {}",
            qr_payload.version
        ));
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

    let conn = ep
        .endpoint
        .connect(host_addr, crate::iroh_sync::ALPN_BYTES)
        .await
        .map_err(|e| format!("Connect to host failed: {e}"))?;

    let _ = app.emit(
        "pairing-progress",
        serde_json::json!({"step": "handshake", "message": "Connected, exchanging keys..."}),
    );

    let my_info = iroh_sync::IrohPeerInfo {
        public_key: ep.public_key,
        device_id: sync_state.transport_state.device_id.clone(),
        device_name: sync_state.transport_state.device_name.clone(),
        fingerprint: sync_crypto::get_frontend_fingerprint()
            .unwrap_or_else(|| sync_state.transport_state.fingerprint.clone()),
    };
    {
        let (mut send, mut recv) = conn.open_bi().await.map_err(|e| format!("open_bi: {e}"))?;
        let json = serde_json::to_vec(&my_info).map_err(|e| format!("serialize: {e}"))?;
        let len = (json.len() as u32).to_be_bytes();
        send.write_all(&len)
            .await
            .map_err(|e| format!("write: {e}"))?;
        send.write_all(&json)
            .await
            .map_err(|e| format!("write: {e}"))?;
        send.finish().map_err(|e| format!("finish: {e}"))?;
        let mut lb = [0u8; 4];
        recv.read_exact(&mut lb)
            .await
            .map_err(|e| format!("read: {e}"))?;
        let _peer_len = u32::from_be_bytes(lb) as usize;
    }

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
        iroh_sync::save_paired_devices_to_disk(&sync_state.transport_state.app_data_dir, &devices)
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
                        iroh_sync::save_paired_devices_to_disk(
                            &sync_state.transport_state.app_data_dir,
                            &devices,
                        )
                        .unwrap_or_else(|e| eprintln!("[sync] Failed to save paired devices: {e}"));
                    }
                }
                Err(e) => eprintln!("[sync] Failed to import docs doc: {e}"),
            },
            Err(e) => eprintln!("[sync] Failed to parse docs ticket: {e}"),
        }
    }

    let peer_info = iroh_sync::IrohPeerInfo {
        public_key: peer_pk,
        device_id: paired_info.device_id.clone(),
        device_name: paired_info.device_name.clone(),
        fingerprint: paired_info.fingerprint.clone(),
    };
    ep.add_peer(peer_info).await;

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

#[tauri::command]
pub async fn unpair_device(app: tauri::AppHandle, device_id: String) -> Result<(), String> {
    let sync_state = get_sync_state(&app)?;
    let mut devices = sync_state.transport_state.paired_devices.lock().await;
    if devices.remove(&device_id).is_none() {
        return Err(format!("Device {} not found", device_id));
    }
    iroh_sync::save_paired_devices_to_disk(&sync_state.transport_state.app_data_dir, &devices)?;
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
        let _ = iroh_sync::save_paired_devices_to_disk(
            &sync_state.transport_state.app_data_dir,
            &devices,
        );
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
        let _ = iroh_sync::save_paired_devices_to_disk(
            &sync_state.transport_state.app_data_dir,
            &devices,
        );
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
    use futures::pin_mut;
    use futures::StreamExt;
    let api = get_docs_api(&app).await?;
    let sync_state = get_sync_state(&app)?;
    let (blobs, devices) = {
        let guard = sync_state.transport_state.docs_api.lock().await;
        let snapshot = guard
            .as_ref()
            .ok_or_else(|| "iroh-docs not initialized".to_string())?;
        let devices = sync_state.transport_state.paired_devices.lock().await;
        (snapshot.blobs.clone(), devices)
    };

    let mut per_key: std::collections::HashMap<String, Vec<String>> =
        std::collections::HashMap::new();

    for device in devices.values() {
        if device.sync_doc_id.is_empty() {
            continue;
        }
        let doc_id: iroh_docs::NamespaceId = device
            .sync_doc_id
            .parse()
            .map_err(|e| format!("parse doc id: {e}"))?;
        if let Ok(Some(doc)) = api.open(doc_id).await {
            if let Ok(stream) = doc
                .get_many(iroh_docs::store::Query::single_latest_per_key().build())
                .await
            {
                pin_mut!(stream);
                let mut doc_entries_seen = 0u64;
                let mut doc_entries_read = 0u64;
                'entries: while let Some(entry_res) = stream.next().await {
                    doc_entries_seen += 1;
                    if let Ok(entry) = entry_res {
                        let key = String::from_utf8_lossy(entry.key()).to_string();
                        let hash = entry.content_hash();
                        let value = 'retry: {
                            // Blobs usually arrive with docs_sync_now; a short
                            // wait covers near-term arrivals, and anything still
                            // missing is picked up via the live ContentReady path
                            // or the next round.
                            for _ in 0..2 {
                                if let Ok(content) = blobs.blobs().get_bytes(hash).await {
                                    if let Ok(v) = String::from_utf8(content.to_vec()) {
                                        doc_entries_read += 1;
                                        break 'retry v;
                                    }
                                }
                                tokio::time::sleep(std::time::Duration::from_millis(80)).await;
                            }
                            eprintln!(
                                "[iroh-sync] docs_get_all_entries: blob not available for key={key}"
                            );
                            continue 'entries;
                        };
                        per_key.entry(key).or_default().push(value);
                    }
                }
                eprintln!(
                    "[iroh-sync] docs_get_all_entries: {doc_entries_read}/{doc_entries_seen} entries read from doc {doc_id}"
                );
            }
        }
    }

    let mut results = std::collections::HashMap::new();
    for (key, values) in per_key {
        let is_per_entity = key.starts_with("book:")
            || key.starts_with("annotation:")
            || key.starts_with("collection:");
        if values.len() == 1 || is_per_entity {
            results.insert(key, values.into_iter().last().unwrap());
        } else {
            let parsed: Vec<serde_json::Value> = values
                .iter()
                .filter_map(|v| serde_json::from_str(v).ok())
                .collect();

            let all_objects = parsed.iter().all(|v| v.is_object());
            let all_arrays = parsed.iter().all(|v| v.is_array());

            if all_objects {
                let mut merged = serde_json::Map::new();
                for v in &parsed {
                    if let Some(obj) = v.as_object() {
                        for (k, val) in obj {
                            merged.insert(k.clone(), val.clone());
                        }
                    }
                }
                results.insert(
                    key,
                    serde_json::to_string(&merged).unwrap_or_else(|_| values.join("\n")),
                );
            } else if all_arrays {
                let mut merged: Vec<serde_json::Value> = Vec::new();
                for v in &parsed {
                    if let Some(arr) = v.as_array() {
                        merged.extend(arr.iter().cloned());
                    }
                }
                results.insert(
                    key,
                    serde_json::to_string(&merged).unwrap_or_else(|_| values.join("\n")),
                );
            } else {
                results.insert(key, values.into_iter().last().unwrap());
            }
        }
    }

    Ok(results)
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
                                    let _ = iroh_sync::save_paired_devices_to_disk(
                                        &sync_state.transport_state.app_data_dir,
                                        &devices,
                                    );
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
                                let _ = iroh_sync::save_paired_devices_to_disk(
                                    &sync_state.transport_state.app_data_dir,
                                    &devices,
                                );
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

    tokio::time::timeout(
        std::time::Duration::from_secs(15),
        doc.start_sync(vec![peer_addr]),
    )
    .await
    .map_err(|_| "Peer is offline or unreachable (timeout after 15s)".to_string())?
    .map_err(|e| format!("start_sync: {e}"))?;

    {
        let mut devices = sync_state.transport_state.paired_devices.lock().await;
        if let Some(d) = devices.get_mut(&peer_device_id) {
            d.last_sync_at = Some(sync_crypto::now_iso8601());
            let _ = iroh_sync::save_paired_devices_to_disk(
                &sync_state.transport_state.app_data_dir,
                &devices,
            );
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn clear_sync_databases(app: tauri::AppHandle) -> Result<(), String> {
    iroh_stop(app.clone()).await?;

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
