// @vitest-environment jsdom
/**
 * The Shortcuts tab lists keyboard shortcuts, so it is shown only where there is a keyboard:
 * desktop and desktop web. Phones and tablets never see it, not even when a session
 * remembered it as the open tab.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SettingsPage } from "../src/features/settings/Settings";
import "./test-utils/render-hook";

const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36";
const IPAD = "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const DESKTOP = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

let container: HTMLDivElement;
let root: Root;

function render(userAgent: string) {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent);
    act(() => root.render(<SettingsPage />));
}

const tabLabels = () =>
    Array.from(new Set(Array.from(container.querySelectorAll("button, option")).map((b) => b.textContent?.trim() ?? "")));

beforeEach(() => {
    window.sessionStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
});
afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
});

describe("Settings → Shortcuts tab", () => {
    it("is offered on desktop, and opens from a remembered session", () => {
        window.sessionStorage.setItem("theorem-settings:active-tab", "shortcuts");
        render(DESKTOP);
        expect(tabLabels()).toContain("Shortcuts");
        expect(container.textContent).toContain("Keyboard Shortcuts");
    });

    it.each([["an Android phone", ANDROID], ["an iPad", IPAD]])("is not offered on %s", (_name, ua) => {
        render(ua);
        expect(tabLabels()).not.toContain("Shortcuts");
        expect(container.textContent).not.toContain("Keyboard Shortcuts");
    });

    it("falls back to General on a phone when the session remembered Shortcuts", () => {
        window.sessionStorage.setItem("theorem-settings:active-tab", "shortcuts");
        render(ANDROID);
        expect(container.textContent).not.toContain("Keyboard Shortcuts");
        expect(container.textContent).not.toContain("Available shortcuts throughout the app");
    });
});
