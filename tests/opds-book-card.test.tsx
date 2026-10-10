// @vitest-environment jsdom
/**
 * OPDS result tiles match the rest of the app and survive bad cover data.
 *
 * Public OPDS servers routinely advertise a `coverUrl` that 404s, or omit one
 * entirely. A bare `<img>` renders a broken-image icon for those; the Library
 * and Discover grids both route through `TheoremBookCover`, which falls back to
 * the deterministic clothbound cover. OPDS now does the same.
 */
import { describe, it, expect } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { OpdsBookCard } from "../src/features/catalogs/components/OpdsBookCard";
import type { OpdsEntry } from "../src/core/types";

// @ts-expect-error React 19 act environment flag
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function entry(over: Partial<OpdsEntry> = {}): OpdsEntry {
    return {
        id: "urn:book:1",
        title: "A Perfectly Ordinary Title",
        author: "Some Author",
        isNavigation: false,
        links: [],
        ...over,
    } as OpdsEntry;
}

function render(over: Partial<OpdsEntry> = {}) {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
        root.render(
            <OpdsBookCard
                entry={entry(over)}
                isDownloading={false}
                onSelect={() => {}}
                onDownload={() => {}}
            />,
        );
    });
    return container;
}

afterEach(() => {
    document.body.innerHTML = "";
});

describe("OpdsBookCard", () => {
    it("renders the feed's cover when one is available", () => {
        const container = render({ coverUrl: "https://example.com/cover.jpg" });
        const img = container.querySelector("img")!;
        expect(img.getAttribute("src")).toBe("https://example.com/cover.jpg");
    });

    it("prefers the thumbnail over the full-size cover", () => {
        // Catalogs commonly serve a full-size image several times larger.
        const container = render({
            coverUrl: "https://example.com/full.jpg",
            thumbnailUrl: "https://example.com/thumb.jpg",
        });
        expect(container.querySelector("img")!.getAttribute("src")).toBe(
            "https://example.com/thumb.jpg",
        );
    });

    it("falls back to a drawn cover when the entry has no image", () => {
        const container = render();
        expect(container.querySelector("img")).toBeNull();
        // The clothbound fallback spells the title out on the cover itself.
        expect(container.querySelector("h3")!.textContent).toBe(
            "A Perfectly Ordinary Title",
        );
        // …and the card's own metadata block still carries it exactly once.
        expect(container.querySelectorAll("[data-opds-card-title]")).toHaveLength(1);
    });

    it("falls back to a drawn cover when the cover URL fails to load", () => {
        const container = render({ coverUrl: "https://example.com/gone.jpg" });
        const img = container.querySelector("img")!;
        expect(img).not.toBeNull();

        act(() => {
            img.dispatchEvent(new Event("error", { bubbles: false }));
        });

        expect(container.querySelector("img")).toBeNull();
        expect(container.textContent).toContain("A Perfectly Ordinary Title");
    });

    it("always shows the title and author as text", () => {
        const container = render({ coverUrl: "https://example.com/cover.jpg" });
        expect(
            container.querySelector("[data-opds-card-title]")!.textContent,
        ).toBe("A Perfectly Ordinary Title");
        expect(
            container.querySelector("[data-opds-card-author]")!.textContent,
        ).toBe("Some Author");
    });

    it("labels an unattributed work rather than rendering a blank line", () => {
        const container = render({ author: undefined });
        expect(container.querySelector("[data-opds-card-author]")!.textContent).toBe(
            "Public Domain",
        );
    });

    it("offers a download button only when the entry is acquirable", () => {
        const withDownload = render({ downloadUrl: "https://example.com/book.epub" });
        expect(withDownload.querySelector("button")).not.toBeNull();
        document.body.innerHTML = "";

        const withoutDownload = render({});
        expect(withoutDownload.querySelector("button")).toBeNull();
    });

    it("gives the download button a distinct accessible name per entry", () => {
        const container = render({
            id: "urn:book:2",
            title: "Second Volume",
            downloadUrl: "https://example.com/b.epub",
        });
        expect(container.querySelector("button")!.getAttribute("aria-label")).toBe(
            "Add Second Volume to Library",
        );
    });

    it("shows a spinner instead of the download icon while downloading", () => {
        const container = document.createElement("div");
        document.body.appendChild(container);
        const root = createRoot(container);
        act(() => {
            root.render(
                <OpdsBookCard
                    entry={entry({ downloadUrl: "https://example.com/book.epub" })}
                    isDownloading
                    onSelect={() => {}}
                    onDownload={() => {}}
                />,
            );
        });

        expect(container.querySelector(".animate-spin")).not.toBeNull();
        expect(container.querySelector("button")!.textContent).not.toContain("Get");
    });
});