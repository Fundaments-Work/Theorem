mod doc_merge;
mod doc_ops;
mod pairing;

pub use doc_merge::{ChangedDocEntries, DeletedEntity};
pub use doc_ops::{DocEntryInput, DocWriteResult};

use crate::iroh_sync::{self};
pub use crate::sync_state::SyncState;
use crate::sync_state::*;
use theorem_sync_core::sync_crypto;
use theorem_sync_core::sync_protocol::{DeviceIdentityInfo, PairedDeviceInfo, PairingQrData};

use std::path::PathBuf;
use std::sync::Arc;
use tauri::Emitter;
use tauri::Manager;
use tokio::sync::Mutex;

fn spawn_restart_sync(app: tauri::AppHandle) {
    tokio::spawn(async move {
        let _ = iroh_stop(app.clone()).await;
        if let Err(e) = iroh_start(app).await {
            log::warn!("[iroh-sync] Sync restart after peer unpairing: {e}");
        }
    });
}

pub fn init_sync(app_data_dir: PathBuf, app_handle: tauri::AppHandle) -> Result<SyncState, String> {
    let key_path = app_data_dir.join("iroh-key");
    let secret_key = load_or_create_key(&key_path)?;
    let public_key_bytes = *secret_key.public().as_bytes();
    let device_id = sync_crypto::compute_device_id(&public_key_bytes);
    let fingerprint = sync_crypto::read_machine_fingerprint();

    let device_name = theorem_sync_core::sync_persistence::load_device_name(&app_data_dir)
        .unwrap_or_else(crate::device_name::system_device_name);
    // The name is often the host name: kept out of the log.
    log::info!("[sync] Device name loaded");

    let paired_devices = load_paired_devices_from_disk(&app_data_dir);
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

    Ok(SyncState::new(transport_state, Some(spawn_restart_sync)))
}

/// How long `iroh_start` waits for a running engine before giving up for now.
const ENGINE_START_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(45);

/// Pairing codes carry a one-time secret from version 2 on.
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
            let _ = app.emit("sync-needs-reprovision", ());
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
    let was_running = forget_device_local(app, device_id, removed_by_peer).await?;
    // The gate only checks new connections: restart to close the open ones.
    if was_running {
        iroh_stop(app.clone()).await?;
        if let Err(e) = iroh_start(app.clone()).await {
            log::warn!("[iroh-sync] Sync restart after unpairing: {e}");
        }
    }
    Ok(())
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

#[tauri::command]
pub async fn generate_pairing_qr(app: tauri::AppHandle) -> Result<PairingQrData, String> {
    pairing::generate_pairing_qr(app).await
}

#[tauri::command]
pub async fn submit_pairing_code(
    app: tauri::AppHandle,
    qr_json: String,
) -> Result<PairedDeviceInfo, String> {
    pairing::submit_pairing_code(app, qr_json).await
}

#[cfg(test)]
use doc_merge::{
    combine_doc_values, deletions, fetch_missing_content, hashes_by_key, own_entry_keys,
    purge_entities_in_doc, purge_single_entries, read_docs, read_headers, DocRead, EntryHeader,
    MISSING_CONTENT_BUDGET,
};
#[cfg(test)]
use doc_ops::{newest_deletion, write_entries_to_doc};

#[tauri::command]
pub async fn docs_create_sync_doc(
    app: tauri::AppHandle,
    peer_device_id: String,
) -> Result<String, String> {
    doc_ops::docs_create_sync_doc(app, peer_device_id).await
}

#[tauri::command]
pub async fn docs_import_sync_doc(
    app: tauri::AppHandle,
    peer_device_id: String,
    ticket_str: String,
) -> Result<(), String> {
    doc_ops::docs_import_sync_doc(app, peer_device_id, ticket_str).await
}

#[tauri::command]
pub async fn docs_set_entry(
    app: tauri::AppHandle,
    key: String,
    value: String,
) -> Result<(), String> {
    doc_ops::docs_set_entry(app, key, value).await
}

#[tauri::command]
pub async fn docs_set_entries(
    app: tauri::AppHandle,
    entries: Vec<DocEntryInput>,
    force: Option<bool>,
) -> Result<DocWriteResult, String> {
    doc_ops::docs_set_entries(app, entries, force).await
}

#[tauri::command]
pub async fn docs_retain_own_entries(
    app: tauri::AppHandle,
    prefix: String,
    keep: Vec<String>,
) -> Result<usize, String> {
    doc_ops::docs_retain_own_entries(app, prefix, keep).await
}

#[tauri::command]
pub async fn docs_get_all_entries(
    app: tauri::AppHandle,
) -> Result<std::collections::HashMap<String, String>, String> {
    doc_merge::docs_get_all_entries(app).await
}

#[tauri::command]
pub async fn docs_get_changed_entries(
    app: tauri::AppHandle,
    full: Option<bool>,
) -> Result<ChangedDocEntries, String> {
    doc_merge::docs_get_changed_entries(app, full).await
}

#[tauri::command]
pub async fn docs_ack_entries(token: u64) -> Result<(), String> {
    doc_merge::docs_ack_entries(token).await
}

#[tauri::command]
pub async fn docs_purge_entities(
    app: tauri::AppHandle,
    entities: Vec<DeletedEntity>,
) -> Result<usize, String> {
    doc_merge::docs_purge_entities(app, entities).await
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
    doc_merge::reset_delivery_cache();

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
mod tests;
