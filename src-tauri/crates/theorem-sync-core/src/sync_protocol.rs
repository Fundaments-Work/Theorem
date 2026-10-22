use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DeviceIdentityInfo {
    pub device_id: String,
    pub device_name: String,
    pub public_key_hex: String,

    #[serde(default)]
    pub fingerprint: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PairingQrPayload {
    pub version: u8,
    pub node_id: String,
    pub device_id: String,
    pub device_name: String,
    #[serde(default)]
    pub fingerprint: String,

    #[serde(default)]
    pub lan_addrs: Vec<String>,

    #[serde(default)]
    pub relay_url: String,

    /// One-time pairing secret (version 2 and later), hex. Valid for one
    /// pairing within minutes of the code being shown.
    #[serde(default)]
    pub secret: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PairingQrData {
    pub qr_svg: String,

    pub pairing_code: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PairingRequest {
    pub device_id: String,
    pub device_name: String,
    #[serde(default)]
    pub fingerprint: String,
    #[serde(default)]
    pub node_id: String,

    #[serde(default)]
    pub relay_url: String,

    /// The secret from the host's QR code.
    #[serde(default)]
    pub secret: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PairingResponse {
    pub device_id: String,
    pub device_name: String,
    #[serde(default)]
    pub fingerprint: String,
    #[serde(default)]
    pub sync_doc_ticket: String,

    #[serde(default)]
    pub relay_url: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PairedDevice {
    pub device_id: String,

    pub device_name: String,

    #[serde(default)]
    pub iroh_node_id: String,
    pub last_ip: String,

    pub last_port: u16,

    pub paired_at: String,

    pub last_sync_at: Option<String>,

    #[serde(default)]
    pub fingerprint: String,

    #[serde(default)]
    pub peer_relay_url: String,

    #[serde(default)]
    pub sync_doc_id: String,

    #[serde(default)]
    pub sync_doc_ticket: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PairedDeviceInfo {
    pub device_id: String,
    pub device_name: String,

    #[serde(default)]
    pub iroh_node_id: String,

    pub last_ip: String,
    pub last_port: u16,
    pub paired_at: String,
    pub last_sync_at: Option<String>,

    #[serde(default)]
    pub fingerprint: String,

    #[serde(default)]
    pub peer_relay_url: String,

    #[serde(default)]
    pub sync_doc_id: String,

    #[serde(default)]
    pub sync_doc_ticket: String,
}

impl From<&PairedDevice> for PairedDeviceInfo {
    fn from(device: &PairedDevice) -> Self {
        Self {
            device_id: device.device_id.clone(),
            device_name: device.device_name.clone(),
            iroh_node_id: device.iroh_node_id.clone(),
            last_ip: device.last_ip.clone(),
            last_port: device.last_port,
            paired_at: device.paired_at.clone(),
            last_sync_at: device.last_sync_at.clone(),
            fingerprint: device.fingerprint.clone(),
            peer_relay_url: device.peer_relay_url.clone(),
            sync_doc_id: device.sync_doc_id.clone(),
            sync_doc_ticket: device.sync_doc_ticket.clone(),
        }
    }
}
