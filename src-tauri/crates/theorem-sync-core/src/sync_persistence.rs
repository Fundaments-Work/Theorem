use crate::sync_protocol::PairedDevice;
use std::collections::HashMap;
use std::io::Write;
use std::path::Path;

/// The paired devices on disk. A file that cannot be parsed is set aside as
/// `sync-paired-devices.json.corrupt` (never overwritten by the next save),
/// so the pairings can be recovered by hand.
pub fn load_paired_devices(app_data_dir: &Path) -> HashMap<String, PairedDevice> {
    let path = app_data_dir.join("sync-paired-devices.json");
    match std::fs::read_to_string(&path) {
        Ok(content) => match serde_json::from_str::<Vec<PairedDevice>>(&content) {
            Ok(list) => list.into_iter().map(|d| (d.device_id.clone(), d)).collect(),
            Err(e) => {
                eprintln!("[sync] Paired devices file is unreadable ({e}); keeping it as .corrupt");
                let _ =
                    std::fs::rename(&path, app_data_dir.join("sync-paired-devices.json.corrupt"));
                HashMap::new()
            }
        },
        Err(_) => HashMap::new(),
    }
}

pub fn save_paired_devices(
    app_data_dir: &Path,
    devices: &HashMap<String, PairedDevice>,
) -> Result<(), String> {
    let path = app_data_dir.join("sync-paired-devices.json");
    let tmp_path = app_data_dir.join("sync-paired-devices.json.tmp");
    let json = serde_json::to_string_pretty(&devices.values().collect::<Vec<_>>())
        .map_err(|e| format!("serialize: {e}"))?;

    {
        let mut f = std::fs::File::create(&tmp_path).map_err(|e| format!("create tmp: {e}"))?;
        f.write_all(json.as_bytes())
            .map_err(|e| format!("write tmp: {e}"))?;
        f.sync_all().map_err(|e| format!("sync tmp: {e}"))?;
    }
    std::fs::rename(&tmp_path, &path).map_err(|e| format!("rename tmp: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("theorem-sync-core-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn device(id: &str) -> PairedDevice {
        PairedDevice {
            device_id: id.into(),
            device_name: "Phone".into(),
            iroh_node_id: String::new(),
            last_ip: String::new(),
            last_port: 0,
            paired_at: "0Z".into(),
            last_sync_at: None,
            fingerprint: String::new(),
            peer_relay_url: String::new(),
            sync_doc_id: String::new(),
            sync_doc_ticket: String::new(),
        }
    }

    #[test]
    fn pairings_round_trip() {
        let dir = temp_dir("roundtrip");
        let mut devices = HashMap::new();
        devices.insert("d1".to_string(), device("d1"));
        save_paired_devices(&dir, &devices).unwrap();
        let loaded = load_paired_devices(&dir);
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded["d1"].device_name, "Phone");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_damaged_file_is_kept_aside_not_lost() {
        let dir = temp_dir("corrupt");
        let path = dir.join("sync-paired-devices.json");
        std::fs::write(&path, b"[{\"deviceId\": \"d1\", trunc").unwrap();
        assert!(load_paired_devices(&dir).is_empty());
        let kept = std::fs::read(dir.join("sync-paired-devices.json.corrupt")).unwrap();
        assert!(kept.starts_with(b"[{\"deviceId\""));
        // The next save writes a new file and leaves the damaged copy alone.
        save_paired_devices(&dir, &HashMap::new()).unwrap();
        assert!(dir.join("sync-paired-devices.json.corrupt").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn no_file_means_no_pairings() {
        let dir = temp_dir("missing");
        assert!(load_paired_devices(&dir).is_empty());
        assert!(!dir.join("sync-paired-devices.json.corrupt").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
