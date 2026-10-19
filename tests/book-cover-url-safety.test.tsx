// @vitest-environment jsdom
/**
 * `TheoremBookCover` renders image URLs that come from catalogs, book
 * metadata and local file picks. Only known-safe schemes may reach the
 * `<img>`; everything else falls back to the drawn cover.
 */
import { describe, it, expect } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { TheoremBookCover } from "../src/ui/TheoremBookCover";

// @ts-expect-error React 19 act environment flag
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function render(coverUrl: string | null | undefined) {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
        root.render(<TheoremBookCover title="A Book" author="An Author" coverUrl={coverUrl} />);
    });
    return container;
}

afterEach(() => {
    document.body.innerHTML = "";
});

describe("TheoremBookCover URL safety", () => {
    it("renders https, image data, blob and theorem-cover sources", () => {
        const pngCover = "data:image/png;base64," + "A".repeat(6000);
        for (const url of [
            "https://example.com/cover.jpg",
            pngCover,
            "data:image/svg+xml;utf8,<svg/>",
            "blob:https://example.com/6a1b",
            "theorem-cover://localhost/abc?v=1",
        ]) {
            const img = render(url).querySelector("img");
            expect(img).not.toBeNull();
            expect(img!.getAttribute("src")).toBe(url);
        }
    });

    it("falls back to the drawn cover for script URLs", () => {
        for (const url of [
            "javascript:alert(1)",
            "java\tscript:alert(1)",
            "vbscript:msgbox(1)",
            "data:text/html,<script>alert(1)</script>",
            "file:///etc/passwd",
        ]) {
            const container = render(url);
            expect(container.querySelector("img")).toBeNull();
            expect(container.textContent).toContain("A Book");
        }
    });

    it("falls back for empty and missing sources", () => {
        expect(render("").querySelector("img")).toBeNull();
        expect(render("   ").querySelector("img")).toBeNull();
        expect(render(null).querySelector("img")).toBeNull();
        expect(render(undefined).querySelector("img")).toBeNull();
    });

    it("keeps filtering Gutenberg's tiny placeholder icons", () => {
        const tiny = "data:image/png;base64," + "A".repeat(100);
        const container = render(tiny);
        expect(container.querySelector("img")).toBeNull();
        expect(container.textContent).toContain("A Book");
    });
});
