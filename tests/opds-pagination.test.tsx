// @vitest-environment jsdom
/**
 * OPDS feed pagination.
 *
 * The parser always extracted `next`/`previous` links (there is a test in
 * `opds.test.ts` asserting exactly that), but the browser never offered them —
 * everything past page one of a paginated catalog was unreachable. The pager
 * turns pages inside the on-screen feed: a category's pages never push
 * navigation history, and a server-search result's pages never disturb the
 * browsed category underneath.
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
import {
    cardCount,
    clickAriaLabel,
    clickButton,
    flush,
    flushDebounce,
    render,
    setInputValue,
    shownTitles,
    stubLayout,
    unmountAll,
} from "./helpers/opds-browser-harness";

function entry(index: number, over: Partial<OpdsEntry> = {}): OpdsEntry {
    return {
        id: `urn:book:${index}`,
        title: `Volume ${index}`,
        author: `Author ${index}`,
        isNavigation: false,
        downloadUrl: `https://example.com/dl/${index}.epub`,
        ...over,
    } as OpdsEntry;
}

function feed(over: Partial<OpdsFeed> = {}): OpdsFeed {
    return {
        title: "Paged Catalog",
        selfUrl: "https://example.com/opds",
        entries: [entry(1), entry(2)],
        ...over,
    } as OpdsFeed;
}

function page2(): OpdsFeed {
    return feed({
        title: "Paged Catalog",
        entries: [entry(3), entry(4)],
        prevUrl: "https://example.com/opds",
        nextUrl: "https://example.com/opds?page=3",
    });
}

function seedStore() {
    useOpdsStore.setState({
        catalogs: [{ id: "c1", title: "Paged Catalog", url: "https://example.com/opds" }],
        activeCatalogId: "c1",
        currentFeedUrl: null,
        feedHistory: [],
    } as never);
}

describe("OPDS pagination", () => {
    let unstub: () => void = () => {};

    beforeEach(() => {
        vi.clearAllMocks();
        unstub = stubLayout();
        seedStore();
    });

    afterEach(() => {
        unmountAll();
        unstub();
        unstub = () => {};
    });

    it("shows no pager when the feed links neither direction", async () => {
        fetchFeed.mockResolvedValue(feed());

        const container = render(<OPDSBrowserPage />);
        await flush();

        expect(container.querySelector('nav[aria-label="Catalog pages"]')).toBeNull();
    });

    it("turns to the next page and then back", async () => {
        fetchFeed.mockResolvedValue(
            feed({ nextUrl: "https://example.com/opds?page=2" }),
        );

        const container = render(<OPDSBrowserPage />);
        await flush();
        expect(shownTitles(container)).toEqual(["Volume 1", "Volume 2"]);

        // No Previous on the first page, but Next is offered.
        expect(container.textContent).toContain("Next");
        expect(container.textContent).not.toContain("Previous");

        fetchFeed.mockResolvedValue(page2());
        clickButton(container, "Next");
        await flush();

        expect(fetchFeed).toHaveBeenLastCalledWith("https://example.com/opds?page=2");
        expect(shownTitles(container)).toEqual(["Volume 3", "Volume 4"]);
        expect(container.textContent).toContain("Previous");

        fetchFeed.mockResolvedValue(feed({ nextUrl: "https://example.com/opds?page=2" }));
        clickButton(container, "Previous");
        await flush();

        expect(shownTitles(container)).toEqual(["Volume 1", "Volume 2"]);
    });

    it("does not push page turns onto the navigation history", async () => {
        // Drilled one level in, so Back has somewhere to go.
        useOpdsStore.setState({
            currentFeedUrl: "https://example.com/opds/fiction",
            feedHistory: ["https://example.com/opds"],
        } as never);
        fetchFeed.mockResolvedValue(
            feed({
                title: "Fiction",
                selfUrl: "https://example.com/opds/fiction",
                nextUrl: "https://example.com/opds/fiction?page=2",
            }),
        );

        const container = render(<OPDSBrowserPage />);
        await flush();

        fetchFeed.mockResolvedValue(
            feed({
                title: "Fiction",
                entries: [entry(9)],
                prevUrl: "https://example.com/opds/fiction",
            }),
        );
        clickButton(container, "Next");
        await flush();

        // A page turn is not a navigation: history is untouched, so Back leaves
        // the paginated feed instead of stepping to page one.
        expect(useOpdsStore.getState().feedHistory).toEqual(["https://example.com/opds"]);
        expect(shownTitles(container)).toEqual(["Volume 9"]);
    });

    it("keeps the old grid mounted while the next page loads", async () => {
        fetchFeed.mockResolvedValue(feed({ nextUrl: "https://example.com/opds?page=2" }));

        const container = render(<OPDSBrowserPage />);
        await flush();
        expect(cardCount(container)).toBeGreaterThan(0);

        // Hold the next page in flight: the current cards must stay, with the
        // pager spinning, rather than flashing a skeleton.
        let resolvePage: (f: OpdsFeed) => void = () => {};
        fetchFeed.mockReturnValue(
            new Promise<OpdsFeed>((resolve) => {
                resolvePage = resolve;
            }),
        );
        clickButton(container, "Next");
        await flush(2);

        expect(cardCount(container)).toBeGreaterThan(0);
        expect(shownTitles(container)).toEqual(["Volume 1", "Volume 2"]);
        expect(
            container.querySelector('nav[aria-label="Catalog pages"] .animate-spin'),
        ).not.toBeNull();

        resolvePage(page2());
        await flush();

        expect(shownTitles(container)).toEqual(["Volume 3", "Volume 4"]);
    });

    it("scrolls back to the top on a page turn", async () => {
        fetchFeed.mockResolvedValue(feed({ nextUrl: "https://example.com/opds?page=2" }));

        const container = render(<OPDSBrowserPage />);
        await flush();

        const scroller = container.firstElementChild as HTMLElement;
        scroller.scrollTop = 500;
        expect(scroller.scrollTop).toBe(500);

        fetchFeed.mockResolvedValue(page2());
        clickButton(container, "Next");
        await flush();

        expect(scroller.scrollTop).toBe(0);
    });

    it("keeps sort and filter state across a page turn", async () => {
        fetchFeed.mockResolvedValue(
            feed({
                entries: [
                    entry(1, { title: "Zulu", language: "en" }),
                    entry(2, { title: "Alpha", language: "en" }),
                ],
                nextUrl: "https://example.com/opds?page=2",
            }),
        );

        const container = render(<OPDSBrowserPage />);
        await flush();
        expect(shownTitles(container)).toEqual(["Alpha", "Zulu"]);

        fetchFeed.mockResolvedValue(
            feed({
                entries: [
                    entry(3, { title: "Yankee", language: "en" }),
                    entry(4, { title: "Bravo", language: "en" }),
                ],
            }),
        );
        clickButton(container, "Next");
        await flush();

        // Title sort survived the turn: the new page arrives ordered.
        expect(shownTitles(container)).toEqual(["Bravo", "Yankee"]);
    });

    it("turns server-search result pages without touching the browsed feed", async () => {
        fetchFeed.mockResolvedValue(
            feed({ searchUrlTemplate: "https://example.com/search?q={searchTerms}" }),
        );
        search.mockResolvedValue(
            feed({
                title: "Search Results",
                entries: [entry(7, { title: "Result One" })],
                nextUrl: "https://example.com/search?q=x&page=2",
            }),
        );

        const container = render(<OPDSBrowserPage />);
        await flush();

        setInputValue(container, 'input[type="search"]', "x");
        await flushDebounce();
        expect(shownTitles(container)).toEqual(["Result One"]);

        // Result pages are fetched as result pages, not navigations.
        const feedCallsBefore = fetchFeed.mock.calls.length;
        fetchFeed.mockResolvedValue(
            feed({
                title: "Search Results",
                entries: [entry(8, { title: "Result Two" })],
                prevUrl: "https://example.com/search?q=x",
            }),
        );
        clickButton(container, "Next");
        await flush();

        expect(shownTitles(container)).toEqual(["Result Two"]);
        // The browsed category was never re-fetched and no history was pushed.
        expect(fetchFeed.mock.calls.length).toBe(feedCallsBefore + 1);
        expect(useOpdsStore.getState().feedHistory).toEqual([]);

        // Clearing the search still restores the browsed feed with no refetch.
        const callsBeforeClear = fetchFeed.mock.calls.length;
        clickAriaLabel(container, "Clear search");
        await flush();

        expect(fetchFeed).toHaveBeenCalledTimes(callsBeforeClear);
        expect(shownTitles(container)).toEqual(["Volume 1", "Volume 2"]);
    });

    it("surfaces a failed result page turn without losing the current results", async () => {
        fetchFeed.mockResolvedValue(
            feed({ searchUrlTemplate: "https://example.com/search?q={searchTerms}" }),
        );
        search.mockResolvedValue(
            feed({
                entries: [entry(7, { title: "Result One" })],
                nextUrl: "https://example.com/search?q=x&page=2",
            }),
        );

        const container = render(<OPDSBrowserPage />);
        await flush();

        setInputValue(container, 'input[type="search"]', "x");
        await flushDebounce();
        expect(shownTitles(container)).toEqual(["Result One"]);

        fetchFeed.mockRejectedValue(new Error("502 Bad Gateway"));
        clickButton(container, "Next");
        await flush();

        // The current page of results survives the failed turn.
        expect(shownTitles(container)).toEqual(["Result One"]);
    });
});