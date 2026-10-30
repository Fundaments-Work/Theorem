// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Fake Tauri: events, IPC, device list ───────────────────────────────────
type Handler = (event: { payload: unknown }) => void;
const listeners = new Map<string, Set<Handler>>();
function emit(name: string, payload: unknown = null): void {
    for (const h of [...(listeners.get(name) ?? [])]) h({ payload });
}
vi.mock("@tauri-apps/api/event", () => ({
    listen: async (name: string, cb: Handler) => {
        if (!listeners.has(name)) listeners.set(name, new Set());
        listeners.get(name)!.add(cb);
        return () => { listeners.get(name)?.delete(cb); };
    },
}));
vi.mock("@tauri-apps/api/core", () => ({
    invoke: vi.fn(async (cmd: string) => {
        if (cmd === "sqlite_get_kv") return "true";
        return null;
    }),
    convertFileSrc: (p: string) => p,
}));

// Each round starts by listing the paired devices; an empty list ends it there.
const getPairedDevices = vi.fn(async () => [] as Array<{ deviceId: string; irohNodeId: string }>);
vi.mock("../src/core/lib/device-sync", () => ({
    irohStart: async () => undefined,
    getPairedDevices: () => getPairedDevices(),
    downloadBookFile: async () => null,
}));
vi.mock("../src/core/lib/env", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../src/core/lib/env")>()),
    isTauri: () => true,
}));

type Orchestrator = typeof import("../src/core/lib/sync-orchestrator");
type Stores = typeof import("../src/core/store");
let orch: Orchestrator;
let stores: Stores;
const NOW = Date.UTC(2026, 9, 22, 9, 0, 0);

function setAutoSync(enabled: boolean) {
    const settings = stores.useSettingsStore.getState().settings;
    stores.useSettingsStore.setState({
        settings: { ...settings, deviceSync: { ...settings.deviceSync, autoSyncEnabled: enabled } as typeof settings.deviceSync },
    });
}

beforeEach(async () => {
    vi.resetModules();
    listeners.clear();
    getPairedDevices.mockClear();
    vi.useFakeTimers({ now: NOW, toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval", "Date"] });
    stores = await import("../src/core/store");
    orch = await import("../src/core/lib/sync-orchestrator");
    setAutoSync(true);
});

afterEach(() => {
    orch.stopAutoSync();
    vi.clearAllTimers();
    vi.useRealTimers();
});

describe("sync on resume", () => {
    it("runs a round when the last one is older than the threshold", async () => {
        orch.__setLastAutoSyncRoundAtForTests(NOW - orch.RESUME_SYNC_STALE_MS - 1);
        expect(orch.syncAfterResume(NOW)).toBe(true);
        await vi.advanceTimersByTimeAsync(0);
        expect(getPairedDevices).toHaveBeenCalledTimes(1);
    });

    it("skips when a round finished recently", async () => {
        orch.__setLastAutoSyncRoundAtForTests(NOW - 5_000);
        expect(orch.syncAfterResume(NOW)).toBe(false);
        await vi.advanceTimersByTimeAsync(0);
        expect(getPairedDevices).not.toHaveBeenCalled();
    });

    it("skips when auto sync is off", async () => {
        setAutoSync(false);
        orch.__setLastAutoSyncRoundAtForTests(0);
        expect(orch.syncAfterResume(NOW)).toBe(false);
        await vi.advanceTimersByTimeAsync(0);
        expect(getPairedDevices).not.toHaveBeenCalled();
    });

    it("never-synced app (no round yet) syncs on the first resume", () => {
        orch.__setLastAutoSyncRoundAtForTests(0);
        expect(orch.syncAfterResume(NOW)).toBe(true);
    });

    it("a burst of resume signals starts one round", async () => {
        orch.__setLastAutoSyncRoundAtForTests(0);
        expect(orch.syncAfterResume(NOW)).toBe(true);
        expect(orch.syncAfterResume(NOW + 10)).toBe(false);
        expect(orch.syncAfterResume(NOW + 1_000)).toBe(false);
        await vi.advanceTimersByTimeAsync(0);
        expect(getPairedDevices).toHaveBeenCalledTimes(1);
    });

    it("Tauri's resumed event and the page becoming visible together start one round", async () => {
        await orch.startAutoSync();
        orch.__setLastAutoSyncRoundAtForTests(Date.now() - orch.RESUME_SYNC_STALE_MS - 1);
        getPairedDevices.mockClear();

        emit("tauri://resumed");
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
        document.dispatchEvent(new Event("visibilitychange"));
        await vi.advanceTimersByTimeAsync(0);
        expect(getPairedDevices).toHaveBeenCalledTimes(1);

        // A later resume, past the threshold, syncs again.
        await vi.advanceTimersByTimeAsync(orch.RESUME_SYNC_STALE_MS + 1);
        getPairedDevices.mockClear();
        emit("tauri://resumed");
        await vi.advanceTimersByTimeAsync(0);
        expect(getPairedDevices).toHaveBeenCalledTimes(1);
    });

    it("stops listening once auto sync stops", async () => {
        await orch.startAutoSync();
        orch.stopAutoSync();
        orch.__setLastAutoSyncRoundAtForTests(0);
        emit("tauri://resumed");
        await vi.advanceTimersByTimeAsync(0);
        expect(getPairedDevices).not.toHaveBeenCalled();
    });
});
