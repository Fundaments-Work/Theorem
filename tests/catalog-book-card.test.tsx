// @vitest-environment jsdom
/**
 * Catalog book tiles match the rest of the app and survive bad cover data.
 *
 * Public OPDS servers routinely advertise a cover that 404s, or omit one entirely. A bare `<img>`
 * renders a broken-image icon for those; the Library grid routes through `TheoremBookCover`, which
 * falls back to the deterministic clothbound cover. Discover and every catalog do the same.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { CatalogBookCard } from "../src/features/catalogs/components/CatalogBookCard";
import type { OpdsEntry } from "../src/core/types";

// @ts-expect-error React 19 act environment flag
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function entry(over: Partial<OpdsEntry> = {}): OpdsEntry {
    return {
        id: "urn:book:1",
        title: "A Perfectly Ordinary Title",
        authors: ["Some Author"],
        acquisitions: [],
        ...over,
    };
}

const downloadable = { href: "https://example.com/book.epub", kind: "openAccess", mime: "application/epub+zip", format: "epub", drm: false, downloadable: true } as const;

function render(over: Partial<OpdsEntry> = {}, props: Partial<React.ComponentProps<typeof CatalogBookCard>> = {}) {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
        root.render(
            <CatalogBookCard entry={entry(over)} inLibrary={false} isBusy={false} onSelect={() => {}} onGet={() => {}} {...props} />,
        );
    });
    return container;
}

afterEach(() => {
    document.body.innerHTML = "";
});

describe("CatalogBookCard", () => {
    it("renders the feed's cover when one is available", () => {
        const container = render({ cover: "https://example.com/cover.jpg" });
        expect(container.querySelector("img")!.getAttribute("src")).toBe("https://example.com/cover.jpg");
    });

    it("prefers the thumbnail over the full-size cover", () => {
        // Catalogs commonly serve a full-size image several times larger.
        const container = render({ cover: "https://example.com/full.jpg", thumbnail: "https://example.com/thumb.jpg" });
        expect(container.querySelector("img")!.getAttribute("src")).toBe("https://example.com/thumb.jpg");
    });

    it("falls back to a drawn cover when the entry has no image", () => {
        const container = render();
        expect(container.querySelector("img")).toBeNull();
        // The clothbound fallback spells the title out on the cover itself...
        expect(container.querySelector("h3")!.textContent).toBe("A Perfectly Ordinary Title");
        // ...and the card's own metadata block still carries it exactly once.
        expect(container.querySelectorAll("[data-catalog-card-title]")).toHaveLength(1);
    });

    it("falls back to a drawn cover when the cover URL fails to load", () => {
        const container = render({ cover: "https://example.com/gone.jpg" });
        const img = container.querySelector("img")!;
        act(() => {
            img.dispatchEvent(new Event("error", { bubbles: false }));
        });
        expect(container.querySelector("img")).toBeNull();
        expect(container.textContent).toContain("A Perfectly Ordinary Title");
    });

    it("refuses to load a cover from an unsafe scheme", () => {
        const container = render({ cover: "javascript:alert(1)" });
        expect(container.querySelector("img")).toBeNull();
    });

    it("always shows the title and joins several authors", () => {
        const container = render({ cover: "https://example.com/cover.jpg", authors: ["Ada", "Grace"] });
        expect(container.querySelector("[data-catalog-card-title]")!.textContent).toBe("A Perfectly Ordinary Title");
        expect(container.querySelector("[data-catalog-card-author]")!.textContent).toBe("Ada, Grace");
    });

    it("labels an unattributed work rather than rendering a blank line", () => {
        const container = render({ authors: [] });
        expect(container.querySelector("[data-catalog-card-author]")!.textContent).toBe("Unknown author");
    });

    it("offers a Get button for a direct download and for a partial entry, but not for an informational one", () => {
        expect(render({ acquisitions: [downloadable], primary: 0 }).querySelector("button")).not.toBeNull();
        document.body.innerHTML = "";
        expect(render({ detailHref: "https://example.com/book/1" }).querySelector("button")).not.toBeNull();
        document.body.innerHTML = "";
        expect(render({}).querySelector("button")).toBeNull();
    });

    it("gives the button a distinct accessible name per entry", () => {
        const container = render({ id: "urn:book:2", title: "Second Volume", acquisitions: [downloadable], primary: 0 });
        expect(container.querySelector("button")!.getAttribute("aria-label")).toBe("Add Second Volume to Library");
    });

    it("shows a spinner instead of the download icon while adding", () => {
        const container = render({ acquisitions: [downloadable], primary: 0 }, { isBusy: true });
        expect(container.querySelector(".animate-spin")).not.toBeNull();
        expect(container.querySelector("button")!.textContent).not.toContain("Get");
        expect(container.querySelector("button")!.hasAttribute("disabled")).toBe(true);
    });

    it("says so when the book is already in the Library, and opens it instead of downloading again", () => {
        const onGet = vi.fn();
        const onSelect = vi.fn();
        const container = render({ acquisitions: [downloadable], primary: 0 }, { inLibrary: true, onGet, onSelect });
        const button = container.querySelector("button")!;
        expect(button.textContent).toContain("In Library");
        act(() => button.click());
        expect(onGet).not.toHaveBeenCalled();
        expect(onSelect).toHaveBeenCalledTimes(1);
    });

    it("sends a purchase, loan or DRM book to its details instead of pretending it can download", () => {
        const onGet = vi.fn();
        const onSelect = vi.fn();
        const buy = { ...downloadable, kind: "buy", downloadable: false } as const;
        const container = render({ acquisitions: [buy], webUrl: "https://shop.example/book" }, { onGet, onSelect });
        const button = container.querySelector("button")!;
        expect(button.textContent).toContain("View");
        act(() => button.click());
        expect(onGet).not.toHaveBeenCalled();
        expect(onSelect).toHaveBeenCalledTimes(1);
    });

    it("Get downloads without also opening the details; tapping the card opens the details", () => {
        const onGet = vi.fn();
        const onSelect = vi.fn();
        const container = render({ acquisitions: [downloadable], primary: 0 }, { onGet, onSelect });
        act(() => container.querySelector("button")!.click());
        expect(onGet).toHaveBeenCalledTimes(1);
        expect(onSelect).not.toHaveBeenCalled();
        act(() => (container.querySelector("[data-catalog-card]") as HTMLElement).click());
        expect(onSelect).toHaveBeenCalledTimes(1);
    });
});
