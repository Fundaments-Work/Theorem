import { describe, it, expect } from "vitest";
import { resolveAbsoluteUrl } from "../src/core/services/RssService";

describe("resolveAbsoluteUrl", () => {
    it("resolves relative and absolute web URLs against the page base", () => {
        expect(resolveAbsoluteUrl("/feed.xml", "https://example.com/blog/")).toBe(
            "https://example.com/feed.xml",
        );
        expect(resolveAbsoluteUrl("atom.xml", "https://example.com/blog/")).toBe(
            "https://example.com/blog/atom.xml",
        );
        expect(resolveAbsoluteUrl("https://cdn.example.com/rss", "https://example.com/")).toBe(
            "https://cdn.example.com/rss",
        );
    });

    it("drops script and data schemes instead of passing them through", () => {
        expect(resolveAbsoluteUrl("javascript:alert(1)", "https://example.com/")).toBe("");
        expect(resolveAbsoluteUrl("JaVaScRiPt:alert(1)", "https://example.com/")).toBe("");
        expect(resolveAbsoluteUrl("vbscript:msgbox(1)", "https://example.com/")).toBe("");
        expect(
            resolveAbsoluteUrl("data:text/html,<script>alert(1)</script>", "https://example.com/"),
        ).toBe("");
        expect(resolveAbsoluteUrl("file:///etc/passwd", "https://example.com/")).toBe("");
    });

    it("rejects schemes hidden behind control characters", () => {
        expect(resolveAbsoluteUrl("java\tscript:alert(1)", "https://example.com/")).toBe("");
        expect(resolveAbsoluteUrl("  javascript:alert(1)", "https://example.com/")).toBe("");
        expect(resolveAbsoluteUrl("\u0000vbscript:msgbox(1)", "https://example.com/")).toBe("");
    });

    it("returns empty for empty input", () => {
        expect(resolveAbsoluteUrl("", "https://example.com/")).toBe("");
        expect(resolveAbsoluteUrl("   ", "https://example.com/")).toBe("");
    });
});
