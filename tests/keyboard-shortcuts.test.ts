import { afterEach, describe, expect, it, vi } from "vitest";
import {
    formatShortcutKeys,
    isApplePlatform,
    registerShortcuts,
    useKeyboardShortcuts,
} from "../src/core/lib/keyboard-shortcuts";
import { renderHook } from "./test-utils/render-hook";

const setPlatform = (platform: string) => {
    Object.defineProperty(navigator, "platform", { value: platform, configurable: true });
    Object.defineProperty(navigator, "userAgentData", { value: undefined, configurable: true });
};

const press = (init: KeyboardEventInit & { key: string }) => {
    const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    window.dispatchEvent(e);
    return e;
};

describe("platform-aware keyboard shortcuts", () => {
    const original = navigator.platform;
    afterEach(() => {
        setPlatform(original);
    });

    it("detects Apple platforms", () => {
        setPlatform("MacIntel");
        expect(isApplePlatform()).toBe(true);
        setPlatform("iPhone");
        expect(isApplePlatform()).toBe(true);
        setPlatform("Win32");
        expect(isApplePlatform()).toBe(false);
        setPlatform("Linux x86_64");
        expect(isApplePlatform()).toBe(false);
    });

    function withShortcut(keys: string) {
        const handler = vi.fn();
        const off = registerShortcuts("test", [{ label: "t", keys, category: "x", handler }]);
        const hook = renderHook(() => useKeyboardShortcuts());
        return { handler, cleanup: () => { hook.unmount(); off(); } };
    }

    it("Ctrl+1 is Command+1 on a Mac, and plain Control+1 no longer fires there", () => {
        setPlatform("MacIntel");
        const { handler, cleanup } = withShortcut("Ctrl+1");
        press({ key: "1", code: "Digit1", metaKey: true });
        expect(handler).toHaveBeenCalledTimes(1);
        press({ key: "1", code: "Digit1", ctrlKey: true });
        expect(handler).toHaveBeenCalledTimes(1);
        press({ key: "1", code: "Digit1" });
        expect(handler).toHaveBeenCalledTimes(1);
        cleanup();
    });

    it("Ctrl+1 stays Control+1 on Windows and Linux, and Windows/Super does not trigger it", () => {
        setPlatform("Win32");
        const { handler, cleanup } = withShortcut("Ctrl+1");
        press({ key: "1", code: "Digit1", ctrlKey: true });
        expect(handler).toHaveBeenCalledTimes(1);
        press({ key: "1", code: "Digit1", metaKey: true });
        expect(handler).toHaveBeenCalledTimes(1);
        cleanup();
    });

    it("extra modifiers do not match: Shift+Cmd+1 is not Cmd+1", () => {
        setPlatform("MacIntel");
        const { handler, cleanup } = withShortcut("Ctrl+1");
        press({ key: "1", metaKey: true, shiftKey: true });
        press({ key: "1", metaKey: true, altKey: true });
        expect(handler).not.toHaveBeenCalled();
        cleanup();
    });

    it("punctuation shortcuts work on a Mac (Cmd+,)", () => {
        setPlatform("MacIntel");
        const { handler, cleanup } = withShortcut("Ctrl+,");
        press({ key: ",", code: "Comma", metaKey: true });
        expect(handler).toHaveBeenCalledTimes(1);
        cleanup();
    });

    it("Option+letter on a Mac matches by physical key even though the character changes", () => {
        setPlatform("MacIntel");
        const { handler, cleanup } = withShortcut("Alt+O");
        press({ key: "ø", code: "KeyO", altKey: true });
        expect(handler).toHaveBeenCalledTimes(1);
        cleanup();
    });

    it("a literal Meta shortcut ignores the platform", () => {
        setPlatform("Win32");
        const { handler, cleanup } = withShortcut("Meta+K");
        press({ key: "k", code: "KeyK", metaKey: true });
        expect(handler).toHaveBeenCalledTimes(1);
        cleanup();
    });

    it("unmodified shortcuts (Shift+?) and typing in inputs", () => {
        setPlatform("MacIntel");
        const { handler, cleanup } = withShortcut("Shift+?");
        press({ key: "?", code: "Slash", shiftKey: true });
        expect(handler).toHaveBeenCalledTimes(1);
        const input = document.createElement("input");
        document.body.appendChild(input);
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "?", shiftKey: true, bubbles: true }));
        expect(handler).toHaveBeenCalledTimes(1);
        input.remove();
        cleanup();
    });

    it("labels follow the platform and no longer shout (the old precedence bug)", () => {
        setPlatform("MacIntel");
        expect(formatShortcutKeys("Ctrl+1")).toBe("⌘ + 1");
        expect(formatShortcutKeys("Ctrl+Shift+k")).toBe("⌘ + ⇧ + K");
        expect(formatShortcutKeys("Alt+ArrowLeft")).toBe("⌥ + ←");
        setPlatform("Win32");
        expect(formatShortcutKeys("Ctrl+1")).toBe("Ctrl + 1");
        expect(formatShortcutKeys("Ctrl+Shift+k")).toBe("Ctrl + Shift + K");
        expect(formatShortcutKeys("Escape")).toBe("Esc");
        expect(formatShortcutKeys("Shift+?")).toBe("Shift + ?");
    });
});
