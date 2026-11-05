// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SettingsPage } from "../src/features/settings/Settings";
import "./test-utils/render-hook";

const h = vi.hoisted(() => ({ native: true }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("../src/core/lib/env", async (original) => ({
    ...await original<typeof import("../src/core/lib/env")>(),
    isTauri: () => h.native,
    isTauriDesktop: () => h.native && !/Android/.test(navigator.userAgent),
    isTauriMobile: () => h.native && /Android/.test(navigator.userAgent),
}));

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
    h.native = true;
    sessionStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
});
afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
});

describe("Settings help", () => {
    it.each(["Android", "Linux"])('offers a dedicated help section on %s', async (platform) => {
        vi.spyOn(navigator, "userAgent", "get").mockReturnValue(platform);
        sessionStorage.setItem("theorem-settings:active-tab", "help");
        await act(async () => root.render(<SettingsPage />));
        expect(container.textContent).toContain("Help & Diagnostics");
        expect(container.textContent).toContain("Export Logs");
        expect(container.textContent?.includes("Check for Updates")).toBe(platform === "Linux");
        expect(container.textContent).toContain("Report an Issue");
        if (platform === "Android") {
            expect(new Set(Array.from(container.querySelectorAll("button[aria-pressed]")).map(b => b.textContent)).size).toBe(6);
        }
    });

    it("offers release downloads and issue reporting without native controls in a browser", async () => {
        h.native = false;
        sessionStorage.setItem("theorem-settings:active-tab", "help");
        await act(async () => root.render(<SettingsPage />));
        expect(container.textContent).toContain("Download Latest Release");
        expect(container.textContent).toContain("Report an Issue");
        expect(container.textContent).not.toContain("Export Logs");
        expect(container.textContent).not.toContain("Check for Updates");
    });
});
