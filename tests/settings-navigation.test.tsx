// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SettingsPage } from "../src/features/settings/Settings";
import { useSettingsStore } from "../src/core/store";
import { BottomNav } from "../src/shell/layout/BottomNav";
import "./test-utils/render-hook";

const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36";
const DESKTOP = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
    useSettingsStore.setState({ showDiscover: true, showFeeds: true });
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

describe("Settings → navigation visibility", () => {
    it.each([["desktop", DESKTOP], ["Android", ANDROID]])("hides and restores tabs through the controls on %s", (_name, ua) => {
        vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ua);
        act(() => root.render(<><SettingsPage /><BottomNav /></>));
        const choose = (name: string, value: "On" | "Off") => {
            const group = container.querySelector(`[role="group"][aria-label="${name}"]`)!;
            const button = Array.from(group.querySelectorAll("button")).find(b => b.textContent === value)!;
            act(() => button.click());
            expect(button.getAttribute("aria-pressed")).toBe("true");
        };
        const destinations = () => Array.from(container.querySelectorAll('nav[aria-label="Primary navigation"] button')).map(b => b.textContent?.trim());
        choose("Show Discover", "Off");
        expect(destinations()).toEqual(["Library", "Shelves", "Feeds", "Workbench"]);
        choose("Show Feeds", "Off");
        expect(destinations()).toEqual(["Library", "Shelves", "Workbench"]);
        choose("Show Discover", "On");
        choose("Show Feeds", "On");
        expect(destinations()).toEqual(["Library", "Shelves", "Discover", "Feeds", "Workbench"]);
    });
});
