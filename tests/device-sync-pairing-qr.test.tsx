// @vitest-environment jsdom
/**
 * A pairing request needs the one-time secret of a QR code on screen, and
 * only Device Sync shows one. Closing the QR code or leaving the page
 * withdraws the secret, so a request can never arrive where nobody would see
 * the approval prompt.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const closePairingQr = vi.fn(async () => undefined);
const generatePairingQr = vi.fn(async () => ({ qrSvg: "<svg></svg>", pairingCode: "{}" }));
vi.mock("../src/core/lib/device-sync", () => ({
    generatePairingQr: () => generatePairingQr(),
    closePairingQr: () => closePairingQr(),
    submitPairingCode: vi.fn(),
    getDeviceIdentity: async () => ({ deviceId: "d1", deviceName: "Desk", publicKeyHex: "", fingerprint: "" }),
    getPairedDevices: async () => [],
    unpairDevice: vi.fn(),
    respondPairingRequest: vi.fn(),
    setDeviceName: vi.fn(),
    probePairedDevice: vi.fn(),
}));
vi.mock("../src/core/lib/sync-orchestrator", () => ({
    runDeviceSync: vi.fn(),
    ensureResponderSyncReady: vi.fn(async () => undefined),
}));
vi.mock("../src/core/lib/sqlite-storage", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../src/core/lib/sqlite-storage")>()),
    sqliteListSyncConflicts: async () => [],
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("../src/core/lib/env", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../src/core/lib/env")>()),
    isTauri: () => true,
    isMobile: () => false,
}));

import { DeviceSyncSection } from "../src/features/settings/DeviceSync";

let root: Root | null = null;
let host: HTMLElement | null = null;

async function render() {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root!.render(<DeviceSyncSection />));
}

function buttonWith(text: RegExp): HTMLButtonElement {
    const found = Array.from(document.body.querySelectorAll("button")).find((b) => text.test(b.textContent ?? ""));
    if (!found) throw new Error(`no button ${text}`);
    return found as HTMLButtonElement;
}

beforeEach(() => {
    closePairingQr.mockClear();
    generatePairingQr.mockClear();
});

afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
});

describe("the pairing QR code's secret", () => {
    it("is withdrawn when the page is left with the QR code open", async () => {
        await render();
        await act(async () => buttonWith(/QR/i).click());
        expect(generatePairingQr).toHaveBeenCalledTimes(1);
        closePairingQr.mockClear();
        act(() => root!.unmount());
        root = null;
        expect(closePairingQr).toHaveBeenCalled();
    });
});

describe("entering a pairing code by hand", () => {
    it("the code field and its send button have accessible names", async () => {
        await render();
        const field = document.body.querySelector<HTMLInputElement>('input[placeholder^="Paste code"]');
        expect(field?.getAttribute("aria-label")).toBe("Pairing code");
        const send = field?.parentElement?.querySelector("button");
        expect(send?.getAttribute("aria-label")).toBe("Pair with this code");
    });
});
