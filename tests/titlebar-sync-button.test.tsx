// @vitest-environment jsdom
/**
 * The titlebar's sync button: with nothing to sync with (no paired device,
 * or the browser build) it opens Settings → Devices, where pairing lives,
 * instead of doing nothing visible.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { tauri, paired, syncAll } = vi.hoisted(() => ({
    tauri: { value: true },
    paired: { value: [] as Array<{ deviceId: string }> },
    syncAll: vi.fn(async () => undefined),
}));

vi.mock("../src/core/lib/env", () => ({
    isMobile: () => false,
    isTauri: () => tauri.value,
    isTauriMobile: () => false,
    isTauriDesktop: () => false,
}));
vi.mock("../src/core/lib/device-sync", () => ({
    getPairedDevices: async () => paired.value,
}));
vi.mock("../src/core/lib/sync-orchestrator", () => ({
    syncAllPairedDevices: syncAll,
}));

import { AppTitlebar } from "../src/shell/AppTitlebar";
import { useUIStore } from "../src/core/store";

let root: Root | null = null;

async function render() {
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root!.render(<AppTitlebar />));
}

async function clickSync() {
    const button = document.querySelector<HTMLButtonElement>('button[aria-label="Sync devices"]');
    expect(button).not.toBeNull();
    await act(async () => button!.click());
}

beforeEach(() => {
    tauri.value = true;
    paired.value = [];
    syncAll.mockClear();
    sessionStorage.clear();
    useUIStore.getState().setRoute("library");
});

afterEach(() => {
    act(() => root?.unmount());
    root = null;
    document.body.innerHTML = "";
});

describe("titlebar sync button", () => {
    it("opens Settings → Devices when no device is paired", async () => {
        await render();
        await clickSync();
        expect(useUIStore.getState().currentRoute).toBe("settings");
        expect(sessionStorage.getItem("theorem-settings:active-tab")).toBe("integrations");
        expect(sessionStorage.getItem("theorem-settings:focus-section")).toBe("device-sync");
        expect(syncAll).not.toHaveBeenCalled();
    });

    it("opens Settings → Devices in the browser build", async () => {
        tauri.value = false;
        await render();
        await clickSync();
        expect(useUIStore.getState().currentRoute).toBe("settings");
    });

    it("syncs every paired device and stays on the page", async () => {
        paired.value = [{ deviceId: "a" }, { deviceId: "b" }];
        await render();
        await clickSync();
        expect(syncAll).toHaveBeenCalledWith(["a", "b"], true);
        expect(useUIStore.getState().currentRoute).toBe("library");
    });

    it("applies compact right padding when empty and reserves space only when query exists", async () => {
        await render();
        const input = document.querySelector<HTMLInputElement>("#app-search");
        expect(input).not.toBeNull();
        expect(input?.className).toContain("pr-3");
        expect(input?.className).not.toContain("pr-8");
        expect(input?.className).not.toContain("pr-9");

        await act(async () => {
            useUIStore.getState().setSearchQuery("tolstoy");
        });

        expect(input?.className).toContain("pr-8");
        const clearBtn = document.querySelector('button[aria-label="Clear search"]');
        expect(clearBtn).not.toBeNull();
    });
});
