use serde::{Deserialize, Serialize};

/// What this version speaks to paired devices. 2: one doc entry per item
/// (no whole-list entries), the hello probe, unpair notices. 3: annotations
/// as one entry per book (`annos:{bookId}`) instead of one per annotation.
/// Devices that never said (0) are older versions and still get the whole
/// lists; devices below 3 still get one entry per annotation as well.
pub const SYNC_PROTOCOL: u8 = 3;

/// The longest device name shown or sent.
pub const MAX_DEVICE_NAME_CHARS: usize = 64;

/// A device name fit to show and send: control characters removed, spaces
/// collapsed, at most [`MAX_DEVICE_NAME_CHARS`]. `None` when nothing is left.
pub fn clean_device_name(raw: &str) -> Option<String> {
    let collapsed = raw
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let name: String = collapsed.chars().take(MAX_DEVICE_NAME_CHARS).collect();
    let name = name.trim_end().to_string();
    (!name.is_empty()).then_some(name)
}

/// What two paired devices tell each other before every sync round (and the
/// answer): the current name, so a rename shows on the other device, and
/// the protocol spoken.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct PeerHello {
    pub name: String,
    #[serde(default)]
    pub protocol: u8,
}

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

    /// [`SYNC_PROTOCOL`] of the scanning device.
    #[serde(default)]
    pub protocol: u8,
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

    /// [`SYNC_PROTOCOL`] of the device that showed the QR code.
    #[serde(default)]
    pub protocol: u8,
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

    /// The [`SYNC_PROTOCOL`] the device last reported; 0 if it never did.
    #[serde(default)]
    pub protocol: u8,
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
    pub protocol: u8,
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
            protocol: device.protocol,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_names_are_cleaned() {
        assert_eq!(
            clean_device_name("  Pixel   7 ").as_deref(),
            Some("Pixel 7")
        );
        assert_eq!(
            clean_device_name("Desk\u{0}top\nPC").as_deref(),
            Some("Desk top PC")
        );
        assert_eq!(clean_device_name(""), None);
        assert_eq!(clean_device_name(" \t\r\n "), None);
        let long = "é".repeat(200);
        let cleaned = clean_device_name(&long).unwrap();
        assert_eq!(cleaned.chars().count(), MAX_DEVICE_NAME_CHARS);
        // Cut at a character, never inside one, and never ending in a space.
        let spaced = format!("{} x", "a".repeat(MAX_DEVICE_NAME_CHARS - 1));
        assert_eq!(
            clean_device_name(&spaced).unwrap(),
            "a".repeat(MAX_DEVICE_NAME_CHARS - 1)
        );
    }

    #[test]
    fn older_records_and_messages_read_as_protocol_zero() {
        let device: PairedDevice = serde_json::from_str(
            r#"{"deviceId":"d","deviceName":"n","lastIp":"","lastPort":0,"pairedAt":"0Z","lastSyncAt":null}"#,
        )
        .unwrap();
        assert_eq!(device.protocol, 0);
        let hello: PeerHello = serde_json::from_str(r#"{"name":"Old"}"#).unwrap();
        assert_eq!(hello.protocol, 0);
        let request: PairingRequest =
            serde_json::from_str(r#"{"deviceId":"d","deviceName":"n"}"#).unwrap();
        assert_eq!(request.protocol, 0);
    }
}
