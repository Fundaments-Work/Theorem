import { invoke } from "@tauri-apps/api/core";

/** Tauri raw responses are ArrayBuffers; older bridges may return byte arrays. */
export async function readCbrAsCbz(path: string): Promise<ArrayBuffer> {
    const raw = await invoke<ArrayBuffer | Uint8Array | number[]>("read_cbr_as_cbz", { path });
    let buffer: ArrayBuffer;
    if (raw instanceof ArrayBuffer) {
        buffer = raw;
    } else if (ArrayBuffer.isView(raw)) {
        const copy = new Uint8Array(raw.byteLength);
        copy.set(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength));
        buffer = copy.buffer;
    } else if (Array.isArray(raw)) {
        buffer = new Uint8Array(raw).buffer;
    } else {
        throw new Error("CBR conversion returned invalid binary data");
    }
    const bytes = new Uint8Array(buffer);
    if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 3 || bytes[3] !== 4) {
        throw new Error("CBR conversion did not produce a readable comic archive");
    }
    return buffer;
}
