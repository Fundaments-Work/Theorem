// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SettingsPage } from "../src/features/settings/Settings";
import "./test-utils/render-hook";

const h = vi.hoisted(() => ({ native: true, flatpak: false, buildInfoFails: false }));
vi.mock("@tauri-apps/api/core", () => ({
    invoke: vi.fn(async (cmd: string) => {
        if (cmd === "app_build_info") {
            if (h.buildInfoFails) throw new Error("no build info");
            return { build_date: "2026-11-24", git_hash: "abc", flatpak: h.flatpak };
        }
        if (cmd === "cli_setup_status") return { installed: false, linkPath: "", isAppImage: false };
        return [];
    }),
}));
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
    h.flatpak = false;
    h.buildInfoFails = false;
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

    it("leaves updates to the software centre inside Flatpak", async () => {
        vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Linux");
        h.flatpak = true;
        sessionStorage.setItem("theorem-settings:active-tab", "help");
        await act(async () => root.render(<SettingsPage />));
        expect(container.textContent).toContain("software centre");
        expect(container.textContent).not.toContain("Check for Updates");
        expect(container.textContent).not.toContain("Download Latest Release");
        expect(container.textContent).toContain("Report an Issue");
        expect(container.textContent).toContain("Export Logs");
    });

    it.each([
        { flatpak: false, buildInfoFails: false, offered: true },
        { flatpak: true, buildInfoFails: false, offered: false },
        { flatpak: false, buildInfoFails: true, offered: true },
    ])("offers the terminal command outside Flatpak: %o", async ({ flatpak, buildInfoFails, offered }) => {
        vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Linux");
        Object.assign(h, { flatpak, buildInfoFails });
        sessionStorage.setItem("theorem-settings:active-tab", "integrations");
        await act(async () => root.render(<SettingsPage />));
        expect(container.textContent?.includes("Terminal CLI")).toBe(offered);
    });
});
