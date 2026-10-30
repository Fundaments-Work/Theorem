import { describe, expect, it } from "vitest";
import { isAndroid } from "../src/core/lib/env";

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
