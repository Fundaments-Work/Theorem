use crate::iroh_sync;
use crate::sync_state::*;
use std::sync::Arc;
use tauri::Emitter;
use theorem_sync_core::sync_crypto;
use theorem_sync_core::sync_protocol::{
    PairedDevice, PairedDeviceInfo, PairingQrData, PairingQrPayload, PairingRequest,
};

/// Pairing codes carry a one-time secret from version 2 on.
const PAIRING_VERSION: u8 = 2;

const PAIRING_CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

pub(super) async fn generate_pairing_qr(app: tauri::AppHandle) -> Result<PairingQrData, String> {
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

pub(super) async fn submit_pairing_code(
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
    if !qr_payload.relay_url.trim().is_empty() {
        if let Ok(relay_url) = qr_payload.relay_url.trim().parse::<iroh::RelayUrl>() {
            host_addr = host_addr.with_relay_url(relay_url);
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
        sync_state
            .transport_state
            .upsert_paired_device(&mut devices, paired_device);
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
