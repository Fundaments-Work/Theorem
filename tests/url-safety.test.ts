import { describe, it, expect } from "vitest";
import { isSafeAttributeUrl, isSafeImageUrl, isSafeLinkUrl } from "../src/core/lib/url-safety";

describe("isSafeLinkUrl", () => {
    it("accepts ordinary link schemes", () => {
        expect(isSafeLinkUrl("https://example.com/post")).toBe(true);
        expect(isSafeLinkUrl("http://example.com/feed.xml")).toBe(true);
        expect(isSafeLinkUrl("mailto:ada@example.com")).toBe(true);
        expect(isSafeLinkUrl("tel:+15551234567")).toBe(true);
    });

    it("accepts relative URLs, fragments, queries and protocol-relative URLs", () => {
        expect(isSafeLinkUrl("/feed.xml")).toBe(true);
        expect(isSafeLinkUrl("feed/atom.xml")).toBe(true);
        expect(isSafeLinkUrl("#section")).toBe(true);
        expect(isSafeLinkUrl("?page=2")).toBe(true);
        expect(isSafeLinkUrl("//cdn.example.com/feed")).toBe(true);
    });

    it("rejects script-bearing schemes", () => {
        expect(isSafeLinkUrl("javascript:alert(1)")).toBe(false);
        expect(isSafeLinkUrl("JaVaScRiPt:alert(1)")).toBe(false);
        expect(isSafeLinkUrl("vbscript:msgbox(1)")).toBe(false);
        expect(isSafeLinkUrl("data:text/html,<script>alert(1)</script>")).toBe(false);
        expect(isSafeLinkUrl("data:image/png;base64,AAAA")).toBe(false);
    });

    it("rejects schemes obfuscated with control characters and whitespace", () => {
        // Browsers strip tabs, newlines and NULs while scanning for a scheme.
        expect(isSafeLinkUrl("java\tscript:alert(1)")).toBe(false);
        expect(isSafeLinkUrl("java\nscript:alert(1)")).toBe(false);
        expect(isSafeLinkUrl("\u0000javascript:alert(1)")).toBe(false);
        expect(isSafeLinkUrl("\u0007vbscript:msgbox(1)")).toBe(false);
        expect(isSafeLinkUrl("  javascript:alert(1)  ")).toBe(false);
    });

    it("rejects other non-web schemes", () => {
        expect(isSafeLinkUrl("file:///etc/passwd")).toBe(false);
        expect(isSafeLinkUrl("ftp://example.com/feed")).toBe(false);
        expect(isSafeLinkUrl("blob:https://example.com/6a1b")).toBe(false);
        expect(isSafeLinkUrl("theorem-cover://localhost/abc")).toBe(false);
    });

    it("rejects empty and non-string values", () => {
        expect(isSafeLinkUrl("")).toBe(false);
        expect(isSafeLinkUrl("   ")).toBe(false);
        expect(isSafeLinkUrl(null)).toBe(false);
        expect(isSafeLinkUrl(undefined)).toBe(false);
    });
});

describe("isSafeImageUrl", () => {
    it("accepts image-capable schemes", () => {
        expect(isSafeImageUrl("https://example.com/cover.jpg")).toBe(true);
        expect(isSafeImageUrl("http://theorem-cover.localhost/abc")).toBe(true);
        expect(isSafeImageUrl("blob:https://example.com/6a1b")).toBe(true);
        expect(isSafeImageUrl("theorem-cover://localhost/abc?v=1")).toBe(true);
        expect(isSafeImageUrl("covers/fallback.png")).toBe(true);
    });

    it("accepts image data URIs", () => {
        expect(isSafeImageUrl("data:image/png;base64,AAAA")).toBe(true);
        expect(isSafeImageUrl("data:image/jpeg;base64,AAAA")).toBe(true);
        expect(isSafeImageUrl("data:image/webp;base64,AAAA")).toBe(true);
        expect(isSafeImageUrl("DATA:IMAGE/WEBP;BASE64,AAAA")).toBe(true);
        expect(isSafeImageUrl("data:image/svg+xml;utf8,<svg/>")).toBe(true);
        expect(isSafeImageUrl("data:image/svg+xml;charset=utf-8,<svg/>")).toBe(true);
    });

    it("rejects non-image data URIs and malformed data URIs", () => {
        expect(isSafeImageUrl("data:text/html,<script>alert(1)</script>")).toBe(false);
        expect(isSafeImageUrl("data:image")).toBe(false);
        expect(isSafeImageUrl("data:image/png")).toBe(false);
        expect(isSafeImageUrl("data:image/png;base64")).toBe(false);
    });

    it("rejects script URLs and unknown schemes", () => {
        expect(isSafeImageUrl("javascript:alert(1)")).toBe(false);
        expect(isSafeImageUrl("java\tscript:alert(1)")).toBe(false);
        expect(isSafeImageUrl("vbscript:msgbox(1)")).toBe(false);
        expect(isSafeImageUrl("file:///etc/passwd")).toBe(false);
        expect(isSafeImageUrl("")).toBe(false);
        expect(isSafeImageUrl(null)).toBe(false);
        expect(isSafeImageUrl(undefined)).toBe(false);
    });
});

describe("isSafeAttributeUrl", () => {
    it("routes href through the link policy", () => {
        expect(isSafeAttributeUrl("href", "https://example.com")).toBe(true);
        expect(isSafeAttributeUrl("HREF", "javascript:alert(1)")).toBe(false);
    });

    it("routes src through the image policy", () => {
        expect(isSafeAttributeUrl("src", "data:image/png;base64,AAAA")).toBe(true);
        expect(isSafeAttributeUrl("SRC", "data:text/html,<script>alert(1)</script>")).toBe(false);
    });

    it("leaves unrelated attributes alone", () => {
        expect(isSafeAttributeUrl("title", "javascript:alert(1)")).toBe(true);
        expect(isSafeAttributeUrl("alt", "onerror=alert(1)")).toBe(true);
    });
});
