// @vitest-environment jsdom
/**
 * OPDS results grid is virtualized.
 *
 * This guards a measured regression, not a hypothetical one: `OPDSBrowser` was
 * the only list in the app that rendered one DOM node per catalog entry, while
 * Library, Shelves, Bookmarks, Annotations, Feeds and Discover's search grid all
 * used `@tanstack/react-virtual`. A feed with a few thousand titles therefore
 * mounted a few thousand cards on every navigation.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React from "react";
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
import { cardCount, flush, render, stubLayout, unmountAll } from "./helpers/opds-browser-harness";

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
        unmountAll();
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
        unmountAll();

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
            makeFeed(40, {
                entries: [navEntry, ...Array.from({ length: 40 }, (_, i) => makeEntry(i))],
            }),
        );

        const container = render(<OPDSBrowserPage />);
        await flush();

        // The category tile is still rendered and is not counted as a book card.
        expect(container.textContent).toContain("Fiction");
        expect(cardCount(container)).toBeLessThan(40);
    });
});