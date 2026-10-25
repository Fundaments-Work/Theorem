//! `theorem sync`: status, pairing and syncing through a headless app.

use super::*;

#[derive(Subcommand)]
pub(super) enum SyncCommand {
    /// Show device identity and paired devices
    Status,
    /// Pair with another device using its pairing code
    Pair { code: String },
    /// Unpair a device by id
    Unpair { device_id: String },
    /// Run a sync round now (all paired devices, or one)
    Now {
        #[arg(long)]
        device: Option<String>,
    },
}

const SYNC_COMMAND_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);
const SYNC_ROUND_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);

pub(super) fn run_sync(output: &Output, app: &tauri::AppHandle, command: SyncCommand) -> i32 {
    match command {
        SyncCommand::Status => sync_status(output, app),
        SyncCommand::Pair { code } => sync_pair(output, app, &code),
        SyncCommand::Unpair { device_id } => sync_unpair(output, app, &device_id),
        SyncCommand::Now { device } => sync_now(output, app, device.as_deref()),
    }
}

fn sync_status(output: &Output, app: &tauri::AppHandle) -> i32 {
    let identity = match block_on(|| {
        tokio::time::timeout(
            SYNC_COMMAND_TIMEOUT,
            crate::sync_commands::get_device_identity(app.clone()),
        )
    }) {
        Ok(Ok(identity)) => identity,
        Ok(Err(e)) => return output.error(&e),
        Err(_) => return output.error("device identity lookup timed out"),
    };
    let devices = match block_on(|| {
        tokio::time::timeout(
            SYNC_COMMAND_TIMEOUT,
            crate::sync_commands::get_paired_devices(app.clone()),
        )
    }) {
        Ok(Ok(devices)) => devices,
        Ok(Err(e)) => return output.error(&e),
        Err(_) => return output.error("paired device lookup timed out"),
    };

    if output.json {
        return output.print_json(&serde_json::json!({
            "identity": identity,
            "pairedDevices": devices,
        }));
    }
    println!(
        "{}: {} ({})",
        output.dim("this device"),
        output.bold(&identity.device_name),
        output.dim(&identity.fingerprint)
    );
    for device in &devices {
        println!(
            "  {}  {}  {}",
            output.dim(&device.device_id),
            output.bold(&device.device_name),
            output.dim(&device.fingerprint)
        );
    }
    output.note(&format!("# {} paired devices", devices.len()));
    0
}

fn sync_pair(output: &Output, app: &tauri::AppHandle, code: &str) -> i32 {
    let future = crate::sync_commands::submit_pairing_code(app.clone(), code.to_string());
    match block_on(|| tokio::time::timeout(SYNC_COMMAND_TIMEOUT, future)) {
        Ok(Ok(device)) => {
            if output.json {
                output.print_json(&device)
            } else {
                println!(
                    "{} {}",
                    output.green("paired with"),
                    output.bold(&device.device_name)
                );
                0
            }
        }
        Ok(Err(e)) => output.error(&e),
        Err(_) => output.error("pairing timed out (is the other device online and pairing?)"),
    }
}

fn sync_unpair(output: &Output, app: &tauri::AppHandle, device_id: &str) -> i32 {
    let future = crate::sync_commands::unpair_device(app.clone(), device_id.to_string());
    match block_on(|| tokio::time::timeout(SYNC_COMMAND_TIMEOUT, future)) {
        Ok(Ok(())) => {
            if output.json {
                output.print_json(&serde_json::json!({ "unpaired": device_id }))
            } else {
                println!("{} {device_id}", output.green("unpaired"));
                0
            }
        }
        Ok(Err(e)) => output.error(&e),
        Err(_) => output.error("unpair timed out"),
    }
}

fn sync_now(output: &Output, app: &tauri::AppHandle, device: Option<&str>) -> i32 {
    let devices = match block_on(|| {
        tokio::time::timeout(
            SYNC_COMMAND_TIMEOUT,
            crate::sync_commands::get_paired_devices(app.clone()),
        )
    }) {
        Ok(Ok(devices)) => devices,
        Ok(Err(e)) => return output.error(&e),
        Err(_) => return output.error("paired device lookup timed out"),
    };

    let targets: Vec<String> = match device {
        Some(id) => {
            if !devices.iter().any(|d| d.device_id == id) {
                return output.error(&format!("device '{id}' is not paired"));
            }
            vec![id.to_string()]
        }
        None => devices.iter().map(|d| d.device_id.clone()).collect(),
    };
    if targets.is_empty() {
        output.note("no paired devices to sync with");
        return 0;
    }

    let started = std::time::Instant::now();
    let mut results = Vec::new();
    for device_id in targets {
        let future = crate::sync_commands::docs_sync_now(app.clone(), device_id.clone());
        let outcome = match block_on(|| tokio::time::timeout(SYNC_ROUND_TIMEOUT, future)) {
            Ok(Ok(())) => "ok".to_string(),
            Ok(Err(e)) => format!("failed: {e}"),
            Err(_) => "timed out".to_string(),
        };
        results.push(serde_json::json!({
            "deviceId": device_id,
            "result": outcome,
        }));
    }

    let ok_count = results.iter().filter(|r| r["result"] == "ok").count();
    if output.json {
        return output.print_json(&serde_json::json!({
            "elapsedMs": started.elapsed().as_secs_f64() * 1000.0,
            "devices": results,
        }));
    }
    for r in &results {
        let status = if r["result"] == "ok" {
            output.green("ok")
        } else {
            output.red(r["result"].as_str().unwrap_or("?"))
        };
        println!(
            "{}  {}",
            output.dim(r["deviceId"].as_str().unwrap_or("?")),
            status
        );
    }
    if ok_count == results.len() {
        0
    } else {
        1
    }
}
