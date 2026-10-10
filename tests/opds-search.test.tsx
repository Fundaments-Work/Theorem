// @vitest-environment jsdom
/**
 * OPDS search actually searches.
 *
 * Two real defects are guarded here, both traced from the code rather than
 * inferred:
 *
 * 1. Search was submit-only *and* gated on `feed.searchUrlTemplate`. Catalogs
 *    that do not advertise an OpenSearch endpoint had no search input rendered
 *    at all — typing did nothing.
 * 2. Search results were written back into `feed`, replacing the feed the user
 *    had drilled into, so searching destroyed the browsing context.
 *
 * The fix is a dual path: server search where the feed supports it, and a local
 * title/author filter otherwise, so search works on every catalog.
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

/** virtual-core reads the viewport via offsetWidth/offsetHeight, both 0 in jsdom. */
function stubLayout(width = 1200, height = 800) {
    const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
    const before = ["offsetWidth", "offsetHeight", "clientWidth", "clientHeight"].map((key) => [
        key,
        Object.getOwnPropertyDescriptor(proto, key),
    ] as const);

    for (const key of ["offsetWidth", "offsetHeight", "clientWidth", "clientHeight"]) {
        Object.defineProperty(proto, key, { get: () => width, configurable: true });
    }
    return () => {
        for (const [key, descriptor] of before) {
            if (descriptor) Object.defineProperty(proto, key, descriptor);
        }
    };
}

function makeEntry(index: number, over: Partial<OpdsEntry> = {}): OpdsEntry {
    return {
        id: `urn:book:${index}`,
        title: `Catalogue Volume ${index}`,
        author: `Author ${index}`,
        isNavigation: false,
        downloadUrl: `https://example.com/dl/${index}.epub`,
        ...over,
    } as OpdsEntry;
}

function makeFeed(over: Partial<OpdsFeed> = {}): OpdsFeed {
    return {
        title: "Test Catalog",
        selfUrl: "https://example.com/opds",
        entries: [
            makeEntry(1, { title: "Pride and Prejudice", author: "Jane Austen" }),
            makeEntry(2, { title: "Persuasion", author: "Jane Austen" }),
            makeEntry(3, { title: "Frankenstein", author: "Mary Shelley" }),
            makeEntry(4, { title: "Moby Dick", author: "Herman Melville" }),
        ],
        ...over,
    } as OpdsFeed;
}

async function flush(times = 5) {
    for (let i = 0; i < times; i++) {
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
    }
}

function setQuery(container: HTMLElement, value: string) {
    const input = container.querySelector('input[type="search"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
    )!.set!;
    act(() => {
        setter.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
    });
}

function shownTitles(container: HTMLElement): string[] {
    return Array.from(container.querySelectorAll("[data-opds-card] h3")).map(
        (el) => el.textContent ?? "",
    );
}

describe("OPDS search", () => {
    let unstub: () => void = () => {};

    beforeEach(() => {
        vi.clearAllMocks();
        unstub = stubLayout();
        useOpdsStore.setState({
            catalogs: [{ id: "c1", title: "Test Catalog", url: "https://example.com/opds" }],
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

    it("renders a search input even when the feed has no search template", async () => {
        // No `searchUrlTemplate` — previously the input was not rendered at all.
        fetchFeed.mockResolvedValue(makeFeed());

        const container = render(<OPDSBrowserPage />);
        await flush();

        expect(container.querySelector('input[type="search"]')).not.toBeNull();
    });

    it("filters locally as you type when the feed has no search template", async () => {
        fetchFeed.mockResolvedValue(makeFeed());

        const container = render(<OPDSBrowserPage />);
        await flush();
        expect(shownTitles(container)).toHaveLength(4);

        setQuery(container, "austen");
        await flush();

        expect(shownTitles(container).sort()).toEqual(["Persuasion", "Pride and Prejudice"]);
        expect(search).not.toHaveBeenCalled();
    });

    it("matches on title as well as author", async () => {
        fetchFeed.mockResolvedValue(makeFeed());

        const container = render(<OPDSBrowserPage />);
        await flush();

        setQuery(container, "moby");
        await flush();

        expect(shownTitles(container)).toEqual(["Moby Dick"]);
    });

    it("matches case-insensitively", async () => {
        fetchFeed.mockResolvedValue(makeFeed());

        const container = render(<OPDSBrowserPage />);
        await flush();

        setQuery(container, "FRANKENSTEIN");
        await flush();

        expect(shownTitles(container)).toEqual(["Frankenstein"]);
    });

    it("uses server search when the feed advertises a template", async () => {
        fetchFeed.mockResolvedValue(
            makeFeed({
                searchUrlTemplate: "https://example.com/search?q={searchTerms}",
            }),
        );
        search.mockResolvedValue(
            makeFeed({
                title: "Search Results",
                entries: [makeEntry(9, { title: "Remote Result", author: "Someone Else" })],
            }),
        );

        const container = render(<OPDSBrowserPage />);
        await flush();

        setQuery(container, "remote");
        // Debounce is 250ms, so let the timer fire.
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 400));
        });
        await flush();

        expect(search).toHaveBeenCalledTimes(1);
        expect(search.mock.calls[0][1]).toBe("remote");
        expect(shownTitles(container)).toEqual(["Remote Result"]);
    });

    it("falls back to local filtering when server search fails", async () => {
        fetchFeed.mockResolvedValue(
            makeFeed({ searchUrlTemplate: "https://example.com/search?q={searchTerms}" }),
        );
        search.mockRejectedValue(new Error("502 Bad Gateway"));

        const container = render(<OPDSBrowserPage />);
        await flush();

        setQuery(container, "shelley");
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 400));
        });
        await flush();

        // A broken endpoint must not dead-end the search.
        expect(shownTitles(container)).toEqual(["Frankenstein"]);
        expect(container.textContent).toContain("On this page");
    });

    it("ignores a stale response that resolves after a newer one", async () => {
        fetchFeed.mockResolvedValue(
            makeFeed({ searchUrlTemplate: "https://example.com/search?q={searchTerms}" }),
        );

        let resolveSlow: (feed: OpdsFeed) => void = () => {};
        search.mockImplementation((_t: string, query: string) => {
            if (query === "aus") {
                return new Promise<OpdsFeed>((resolve) => {
                    resolveSlow = resolve;
                });
            }
            return Promise.resolve(
                makeFeed({
                    entries: [makeEntry(8, { title: "Austen Collected", author: "Jane Austen" })],
                }),
            );
        });

        const container = render(<OPDSBrowserPage />);
        await flush();

        setQuery(container, "aus");
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 400));
        });
        setQuery(container, "austen");
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 400));
        });
        await flush();
        expect(shownTitles(container)).toEqual(["Austen Collected"]);

        // The abandoned "aus" request now lands last. It must be discarded.
        await act(async () => {
            resolveSlow(
                makeFeed({
                    entries: [makeEntry(7, { title: "Stale Result", author: "Nobody" })],
                }),
            );
            await new Promise((resolve) => setTimeout(resolve, 20));
        });
        await flush();

        expect(shownTitles(container)).toEqual(["Austen Collected"]);
    });

    it("shows a specific empty state and restores the feed on clear", async () => {
        fetchFeed.mockResolvedValue(makeFeed());

        const container = render(<OPDSBrowserPage />);
        await flush();

        setQuery(container, "zzzz-nothing-matches");
        await flush();

        expect(container.textContent).toContain("No results for");
        expect(shownTitles(container)).toHaveLength(0);

        const clear = container.querySelector('button[aria-label="Clear search"]') as HTMLElement;
        act(() => clear.click());
        await flush();

        expect(shownTitles(container)).toHaveLength(4);
    });

    it("keeps the feed it drilled into instead of replacing it with results", async () => {
        fetchFeed.mockResolvedValue(
            makeFeed({ searchUrlTemplate: "https://example.com/search?q={searchTerms}" }),
        );
        search.mockResolvedValue(
            makeFeed({ entries: [makeEntry(5, { title: "Only Result", author: "Nobody" })] }),
        );

        const container = render(<OPDSBrowserPage />);
        await flush();

        setQuery(container, "only");
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 400));
        });
        await flush();
        expect(shownTitles(container)).toEqual(["Only Result"]);

        // Previously the result feed had overwritten the browsed one, so clearing
        // the query required a network refetch. Clearing must be client-side and
        // must not issue another request.
        const callsBefore = fetchFeed.mock.calls.length;
        const clear = container.querySelector('button[aria-label="Clear search"]') as HTMLElement;
        act(() => clear.click());
        await flush();

        expect(fetchFeed).toHaveBeenCalledTimes(callsBefore);
        expect(shownTitles(container)).toHaveLength(4);
    });
});