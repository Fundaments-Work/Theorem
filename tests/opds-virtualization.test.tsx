// @vitest-environment jsdom
/**
 * OPDS results grid is virtualized.
 *
 * This guards a measured regression, not a hypothetical one: `OPDSBrowser` was
 * the only list in the app that rendered one DOM node per catalog entry, while
 * Library, Shelves, Bookmarks, Annotations, Feeds and Discover's search grid all
 * used `@tanstack/react-virtual`. A feed with a few thousand titles therefore
 * mounted a few thousand cards on every navigation.
 *
 * jsdom performs no layout, so the scroll viewport measures 0×0. That makes the
 * virtualizer's visible range empty and leaves only the overscan window mounted
 * — which is exactly the property under test: mounted cards must stay a small
 * constant regardless of feed size.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { OpdsEntry, OpdsFeed } from "../src/core/types";

const fetchFeed = vi.fn();
const search = vi.fn();

vi.mock("../src/core/services/OpdsService", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../src/core/services/OpdsService")>();
    return {
        ...actual,
        OpdsService: {
            ...actual.OpdsService,
            fetchFeed: (...args: unknown[]) => fetchFeed(...args),
            search: (...args: unknown[]) => search(...args),
            downloadAndImportBook: vi.fn(),
        },
    };
});

import { OPDSBrowserPage } from "../src/features/catalogs/OPDSBrowser";
import { useOpdsStore } from "../src/core/store";

// @ts-expect-error React 19 act environment flag
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Root[] = [];

function render(ui: React.ReactElement) {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push(root);
    act(() => {
        root.render(ui);
    });
    return container;
}

function makeEntry(index: number): OpdsEntry {
    return {
        id: `urn:book:${index}`,
        title: `Catalogue Volume ${index}`,
        author: `Author ${index % 40}`,
        summary: `Entry number ${index}`,
        language: "en",
        publisher: "Test Press",
        published: "2026-01-01",
        isNavigation: false,
        downloadUrl: `https://example.com/dl/${index}.epub`,
        coverUrl: `https://example.com/covers/${index}.jpg`,
        navUrl: undefined,
        updated: new Date(2026, 0, 1).toISOString(),
    } as OpdsEntry;
}

function makeFeed(size: number, over: Partial<OpdsFeed> = {}): OpdsFeed {
    return {
        title: "Huge Catalog",
        entries: Array.from({ length: size }, (_, i) => makeEntry(i)),
        selfUrl: "https://example.com/opds",
        ...over,
    } as OpdsFeed;
}

/** Count the cards actually mounted in the DOM. */
function cardCount(container: HTMLElement): number {
    return container.querySelectorAll("[data-opds-card]").length;
}

async function flush() {
    // The virtualizer attaches its scroll element in a layout effect and then
    // notifies React to re-render, so give several macrotask turns for that
    // attach → measure → render chain to settle.
    for (let i = 0; i < 5; i++) {
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
    }
}

/**
 * jsdom performs no layout, and `@tanstack/react-virtual` reads the viewport via
 * `offsetWidth`/`offsetHeight` (see `getRect` in virtual-core) — both are hard 0
 * in jsdom, and `outerSize === 0` sets the range to `null`, mounting zero rows.
 * Give elements a fixed viewport so the grid actually mounts a window.
 *
 * The row height is computed rather than measured (see `getBookRowSize`), so no
 * other layout stub is needed.
 *
 * Note this also describes the real app's first paint: routes are kept mounted
 * inside a `display:none` wrapper until visited, so the scroll element really
 * does measure 0×0 until the route becomes visible.
 */
function stubLayout(width = 1200, height = 800) {
    const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
    const before = {
        offsetWidth: Object.getOwnPropertyDescriptor(proto, "offsetWidth"),
        offsetHeight: Object.getOwnPropertyDescriptor(proto, "offsetHeight"),
        clientWidth: Object.getOwnPropertyDescriptor(proto, "clientWidth"),
        clientHeight: Object.getOwnPropertyDescriptor(proto, "clientHeight"),
    };

    Object.defineProperty(proto, "offsetWidth", { get: () => width, configurable: true });
    Object.defineProperty(proto, "offsetHeight", { get: () => height, configurable: true });
    Object.defineProperty(proto, "clientWidth", { get: () => width, configurable: true });
    Object.defineProperty(proto, "clientHeight", { get: () => height, configurable: true });

    return () => {
        for (const key of ["offsetWidth", "offsetHeight", "clientWidth", "clientHeight"] as const) {
            const descriptor = before[key];
            if (descriptor) Object.defineProperty(proto, key, descriptor);
        }
    };
}

describe("OPDS results grid virtualization", () => {
    let unstub: () => void = () => {};

    beforeEach(() => {
        vi.clearAllMocks();
        unstub = stubLayout();
        useOpdsStore.setState({
            catalogs: [{ id: "c1", title: "Huge Catalog", url: "https://example.com/opds" }],
            activeCatalogId: "c1",
            currentFeedUrl: null,
            feedHistory: [],
        } as never);
    });

    afterEach(() => {
        while (mounted.length) {
            const root = mounted.pop()!;
            act(() => root.unmount());
        }
        document.body.innerHTML = "";
        unstub();
        unstub = () => {};
    });

    it("mounts a bounded window of cards for a 3000-entry feed", async () => {
        fetchFeed.mockResolvedValue(makeFeed(3000));

        const container = render(<OPDSBrowserPage />);
        await flush();

        const mountedCards = cardCount(container);
        expect(mountedCards).toBeGreaterThan(0);
        // The whole point: a few dozen mounted nodes, not 3000.
        expect(mountedCards).toBeLessThan(100);
    });

    it("scales the mounted window with the viewport, not the feed size", async () => {
        fetchFeed.mockResolvedValue(makeFeed(500));

        const smallContainer = render(<OPDSBrowserPage />);
        await flush();
        const smallMounted = cardCount(smallContainer);
        while (mounted.length) act(() => mounted.pop()!.unmount());
        document.body.innerHTML = "";

        fetchFeed.mockResolvedValue(makeFeed(5000));

        const bigContainer = render(<OPDSBrowserPage />);
        await flush();
        const bigMounted = cardCount(bigContainer);

        // 10x the entries must not mean 10x the DOM.
        expect(bigMounted).toBeLessThan(smallMounted * 4);
    });

    it("still reports the true entry count even though cards are windowed", async () => {
        fetchFeed.mockResolvedValue(makeFeed(3000));

        const container = render(<OPDSBrowserPage />);
        await flush();

        expect(container.textContent).toContain("3,000 titles");
    });

    it("shows skeletons while loading instead of an empty page", async () => {
        // Never resolves: the component stays in its loading state.
        fetchFeed.mockReturnValue(new Promise(() => {}));

        const container = render(<OPDSBrowserPage />);
        await flush();

        expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);
        expect(cardCount(container)).toBe(0);
    });

    it("keeps navigation entries outside the book virtualizer", async () => {
        const navEntry = {
            id: "urn:catalog:fiction",
            title: "Fiction",
            summary: "Fiction collection",
            isNavigation: true,
            navUrl: "https://example.com/opds/fiction",
        } as OpdsEntry;
        fetchFeed.mockResolvedValue(
            makeFeed(40, { entries: [navEntry, ...Array.from({ length: 40 }, (_, i) => makeEntry(i))] }),
        );

        const container = render(<OPDSBrowserPage />);
        await flush();

        // The category tile is still rendered and is not counted as a book card.
        expect(container.textContent).toContain("Fiction");
        expect(cardCount(container)).toBeLessThan(40);
    });
});