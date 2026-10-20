// @vitest-environment jsdom
/**
 * The catalog's book grid is virtualized.
 *
 * Library, Shelves, Bookmarks, Annotations, Feeds and Discover's search all use
 * `@tanstack/react-virtual`; a catalog with a few thousand titles must too, or every navigation
 * mounts a few thousand cards.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { OpdsFeed } from "../src/core/types";

const load = vi.fn();

vi.mock("../src/core/services/OpdsService", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../src/core/services/OpdsService")>();
    return { ...actual, OpdsService: { ...actual.OpdsService, load: (...a: unknown[]) => load(...a), search: vi.fn(), loadDetail: vi.fn(), download: vi.fn() } };
});

import { useOpdsStore } from "../src/core/store";
import { resetOpdsBrowserSession } from "../src/features/catalogs/opds/useOpdsBrowser";
import { CATALOG, cardCount, flush, makeEntry, makeFeed, renderBrowser, stubLayout, unmountAll } from "./helpers/opds-browser-harness";

const big = (size: number, over: Partial<OpdsFeed> = {}) =>
    makeFeed({ entries: Array.from({ length: size }, (_, i) => makeEntry(i, { title: `Catalogue Volume ${i}` })), ...over });
const served = (feed: OpdsFeed) => load.mockResolvedValue({ feed, finalUrl: CATALOG.url });

describe("catalog results grid virtualization", () => {
    let unstub: () => void = () => {};

    beforeEach(() => {
        vi.clearAllMocks();
        resetOpdsBrowserSession();
        unstub = stubLayout();
        useOpdsStore.setState({ catalogs: [CATALOG], activeCatalogId: CATALOG.id });
    });
    afterEach(() => {
        unmountAll();
        unstub();
        unstub = () => {};
    });

    it("mounts a bounded window of cards for a 3000-entry feed", async () => {
        served(big(3000));
        const container = renderBrowser();
        await flush();
        const mounted = cardCount(container);
        expect(mounted).toBeGreaterThan(0);
        // The whole point: a few dozen mounted nodes, not 3000.
        expect(mounted).toBeLessThan(100);
    });

    it("scales the mounted window with the viewport, not the feed size", async () => {
        served(big(500));
        const small = renderBrowser();
        await flush();
        const smallMounted = cardCount(small);
        unmountAll();
        resetOpdsBrowserSession();

        served(big(5000));
        const large = renderBrowser();
        await flush();
        // 10x the entries must not mean 10x the DOM.
        expect(cardCount(large)).toBeLessThan(smallMounted * 4);
    });

    it("still reports the true entry count even though cards are windowed", async () => {
        served(big(3000));
        const container = renderBrowser();
        await flush();
        expect(container.querySelector("[data-opds-count]")!.textContent).toContain("3,000 books");
    });

    it("says how many of the catalog's total are loaded when the server reports a total", async () => {
        served(big(25, { totalResults: 70000, nextUrl: "https://example.com/opds?p=2" }));
        const container = renderBrowser();
        await flush();
        expect(container.querySelector("[data-opds-count]")!.textContent).toContain("25 of 70,000 books");
    });

    it("shows skeletons while loading instead of an empty page", async () => {
        // Never resolves: the component stays in its loading state.
        load.mockReturnValue(new Promise(() => {}));
        const container = renderBrowser();
        await flush();
        expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);
        expect(container.querySelector("[data-opds-skeleton]")).not.toBeNull();
        expect(cardCount(container)).toBe(0);
    });

    it("keeps navigation rows outside the book virtualizer", async () => {
        served(
            big(40, {
                navigation: [{ title: "Fiction", href: "https://example.com/opds/fiction", rel: "subsection", summary: "Fiction collection" }],
            }),
        );
        const container = renderBrowser();
        await flush();
        // The category row is rendered and is not counted as a book card.
        expect(container.textContent).toContain("Fiction");
        expect(container.querySelectorAll("[aria-label=Browse] li")).toHaveLength(1);
        expect(cardCount(container)).toBeLessThan(40);
    });
});
