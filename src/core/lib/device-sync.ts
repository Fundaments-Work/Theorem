
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./env";
import type {
    PairedDevice,
    DeviceIdentityInfo,
    PairingQrData,
} from "../types";

function requireTauri(label: string): void {
    if (!isTauri()) {
        throw new Error(`[DeviceSync] ${label} requires Tauri runtime`);
    }
}

export interface IrohNodeIdResponse {
    nodeId: string;
    deviceId: string;
    fingerprint: string;
}

export async function irohStart(): Promise<IrohNodeIdResponse> {
    requireTauri("irohStart");
    return invoke<IrohNodeIdResponse>("iroh_start");
}

export async function irohStop(): Promise<void> {
    requireTauri("irohStop");
    return invoke("iroh_stop");
}

export async function generatePairingQr(): Promise<PairingQrData> {
    requireTauri("generatePairingQr");
    return invoke<PairingQrData>("generate_pairing_qr");
}

export async function submitPairingCode(
    pairingCode: string,
): Promise<PairedDevice> {
    requireTauri("submitPairingCode");
    const raw = await invoke<PairedDevice>("submit_pairing_code", { pairingCode });
    return raw;
}

/** Accepts or declines a device asking to pair (`pairing-confirm-request`). */
export async function respondPairingRequest(requestId: string, accept: boolean): Promise<void> {
    requireTauri("respondPairingRequest");
    return invoke("respond_pairing_request", { requestId, accept });
}

/** The QR code was closed: its one-time secret stops working. */
export async function closePairingQr(): Promise<void> {
    if (!isTauri()) return;
    return invoke("close_pairing_qr");
}

export async function getDeviceIdentity(): Promise<DeviceIdentityInfo> {
    requireTauri("getDeviceIdentity");
    return invoke<DeviceIdentityInfo>("get_device_identity");
}

export async function setDeviceFingerprint(
    fingerprint: string,
): Promise<void> {
    requireTauri("setDeviceFingerprint");
    return invoke("set_device_fingerprint", { fingerprint });
}

export async function getPairedDevices(): Promise<PairedDevice[]> {
    requireTauri("getPairedDevices");
    const raw = await invoke<PairedDevice[]>("get_paired_devices");
    return raw;
}

/** Removes a paired device here, and tells it so it removes this one too. */
export async function unpairDevice(deviceId: string): Promise<void> {
    requireTauri("unpairDevice");
    return invoke("unpair_device", { deviceId });
}

/**
 * Renames this device as paired devices see it (they pick the name up on
 * their next sync). An empty name goes back to the system's. Returns the
 * name now in use.
 */
export async function setDeviceName(name: string): Promise<string> {
    requireTauri("setDeviceName");
    return invoke<string>("set_device_name", { name });
}

/**
 * Whether a paired device answers now (it also learns this device's name
 * and tells its own). Rejects when the device has removed this one.
 */
export async function probePairedDevice(deviceId: string): Promise<boolean> {
    requireTauri("probePairedDevice");
    return invoke<boolean>("sync_probe_device", { peerDeviceId: deviceId });
}

/** Downloads a book from a peer into this device's book cache; returns where it was saved. */
export async function downloadBookFile(peerDeviceId: string, bookId: string): Promise<string> {
    requireTauri("downloadBookFile");
    return invoke<string>("download_book_file", { peerDeviceId, bookId });
}
