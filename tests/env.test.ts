import { describe, expect, it, vi } from "vitest";
import { isAndroid, isWebKitGTK } from "../src/core/lib/env";

describe("isAndroid", () => {
    it("identifies Android user agents and nothing else", () => {
        const originalUserAgent = navigator.userAgent;
        const setUserAgent = (value: string) =>
            Object.defineProperty(navigator, "userAgent", { value, configurable: true });

        try {
            setUserAgent("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36");
            expect(isAndroid()).toBe(true);

            setUserAgent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36");
            expect(isAndroid()).toBe(false);

            setUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15");
            expect(isAndroid()).toBe(false);
        } finally {
            setUserAgent(originalUserAgent);
        }
    });
});

describe("isWebKitGTK", () => {
    it("is true only in the Linux desktop app, whose webview is always WebKitGTK", () => {
        const originalUserAgent = navigator.userAgent;
        const setUserAgent = (value: string) =>
            Object.defineProperty(navigator, "userAgent", { value, configurable: true });

        try {
            setUserAgent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)");
            expect(isWebKitGTK()).toBe(false); // a browser in web mode, not the app

            vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
            expect(isWebKitGTK()).toBe(true);

            setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko)");
            expect(isWebKitGTK()).toBe(false);

            setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0");
            expect(isWebKitGTK()).toBe(false);

            setUserAgent("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36");
            expect(isWebKitGTK()).toBe(false);
        } finally {
            vi.unstubAllGlobals();
            setUserAgent(originalUserAgent);
        }
    });
});
