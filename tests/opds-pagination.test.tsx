// @vitest-environment jsdom
/**
 * Catalog pagination ("Load more").
 *
 * OPDS catalogs serve long lists a page at a time through `next` links. Pages are appended to the
 * list on screen: a page turn is not a navigation, so it never pushes a step onto the trail, and a
 * misbehaving server (a `next` that repeats or runs dry) must end the list instead of being asked
 * for forever.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import type { OpdsFeed } from "../src/core/types";

const load = vi.fn();
const search = vi.fn();

vi.mock("../src/core/services/OpdsService", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../src/core/services/OpdsService")>();
    return { ...actual, OpdsService: { ...actual.OpdsService, load: (...a: unknown[]) => load(...a), search: (...a: unknown[]) => search(...a), loadDetail: vi.fn(), download: vi.fn() } };
});

import { OpdsError } from "../src/core/services/OpdsService";
import { useOpdsStore } from "../src/core/store";
import { resetOpdsBrowserSession } from "../src/features/catalogs/opds/useOpdsBrowser";
import { CATALOG, clickButton, flush, makeEntry, makeFeed, renderBrowser, shownTitles, stubLayout, unmountAll } from "./helpers/opds-browser-harness";

const URL1 = "https://example.com/opds";
const URL2 = "https://example.com/opds?page=2";
const URL3 = "https://example.com/opds?page=3";

const page = (ids: number[], next?: string, over: Partial<OpdsFeed> = {}) =>
    makeFeed({ entries: ids.map((i) => makeEntry(i)), nextUrl: next, ...over });

/** ids from..to inclusive. */
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
/** A first page long enough that its end is not in view, so loading more needs the button. */
const LONG = range(1, 40);
const count = (c: HTMLElement) => c.querySelector("[data-opds-count]")?.textContent ?? "";

function serve(map: Record<string, OpdsFeed | Error | Promise<unknown>>) {
    load.mockImplementation(async (url: string) => {
        const hit = map[url];
        if (hit === undefined) throw new Error(`unexpected request for ${url}`);
        if (hit instanceof Error) throw hit;
        if (hit instanceof Promise) return hit;
        return { feed: hit, finalUrl: url };
    });
}

const loadMoreButton = (c: HTMLElement) => Array.from(c.querySelectorAll("button")).find((b) => /Load more|Loading…|Try again/.test(b.textContent ?? ""));

describe("catalog pagination", () => {
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

    it("offers no Load more when the feed has no next page", async () => {
        serve({ [URL1]: page([1, 2]) });
        const c = renderBrowser();
        await flush();
        expect(loadMoreButton(c)).toBeUndefined();
    });

    it("appends the next page to what is already shown", async () => {
        serve({ [URL1]: page(LONG, URL2), [URL2]: page(range(41, 44)) });
        const c = renderBrowser();
        await flush();
        expect(count(c)).toContain("40 books");
        expect(shownTitles(c)[0]).toBe("Volume 1");
        clickButton(c, "Load more");
        await flush();
        expect(count(c)).toContain("44 books");
        expect(load).toHaveBeenLastCalledWith(URL2, expect.anything());
        // The list is complete, so the button goes away.
        expect(loadMoreButton(c)).toBeUndefined();
    });

    it("does not show the same book twice when pages overlap", async () => {
        serve({ [URL1]: page(LONG, URL2), [URL2]: page([40, 41, 42]) });
        const c = renderBrowser();
        await flush();
        clickButton(c, "Load more");
        await flush();
        // Book 40 was on both pages: 40 + 2 new, not 43.
        expect(count(c)).toContain("42 books");
    });

    it("does not treat a page turn as navigation (no trail, no Back)", async () => {
        serve({ [URL1]: page(LONG, URL2), [URL2]: page(range(41, 80), URL3), [URL3]: page([81]) });
        const c = renderBrowser();
        await flush();
        clickButton(c, "Load more");
        await flush();
        clickButton(c, "Load more");
        await flush();
        expect(count(c)).toContain("81 books");
        expect(c.querySelector('nav[aria-label="Catalog trail"]')).toBeNull();
        expect(c.querySelector('[aria-label="Back"]')).toBeNull();
    });

    it("keeps the current books on screen while the next page loads", async () => {
        let resolvePage2: (v: unknown) => void = () => {};
        serve({ [URL1]: page(LONG, URL2), [URL2]: new Promise((r) => (resolvePage2 = r)) });
        const c = renderBrowser();
        await flush();
        clickButton(c, "Load more");
        await flush();
        expect(shownTitles(c)[0]).toBe("Volume 1");
        expect(count(c)).toContain("40 books");
        expect(c.textContent).toContain("Loading…");
        await act(async () => resolvePage2({ feed: page([41]), finalUrl: URL2 }));
        await flush();
        expect(count(c)).toContain("41 books");
    });

    it("surfaces a failed page without losing the books already loaded, and retries the same page", async () => {
        serve({ [URL1]: page(LONG, URL2), [URL2]: new OpdsError("timeout", "The catalog took too long to respond.") });
        const c = renderBrowser();
        await flush();
        clickButton(c, "Load more");
        await flush();
        expect(c.textContent).toContain("The catalog took too long to respond.");
        expect(count(c)).toContain("40 books");
        serve({ [URL1]: page(LONG, URL2), [URL2]: page([41]) });
        clickButton(c, "Try again");
        await flush();
        expect(count(c)).toContain("41 books");
    });

    it("stops when a server's next link points back at a page it already served", async () => {
        serve({ [URL1]: page(LONG, URL2), [URL2]: page(range(41, 44), URL1) });
        const c = renderBrowser();
        await flush();
        clickButton(c, "Load more");
        await flush();
        expect(count(c)).toContain("44 books");
        expect(loadMoreButton(c)).toBeUndefined();
        const calls = load.mock.calls.length;
        await flush(10);
        expect(load.mock.calls.length).toBe(calls);
    });

    it("stops when a page adds nothing new, instead of requesting forever", async () => {
        // Every page is the same two books and always links to a fresh-looking next page.
        load.mockImplementation(async (url: string) => {
            const n = Number(/page=(\d+)/.exec(url)?.[1] ?? 1);
            return { feed: page([1, 2], `https://example.com/opds?page=${n + 1}`), finalUrl: url };
        });
        const c = renderBrowser();
        await flush(20);
        // Auto-loading near the end asks at most once more, sees nothing new, and ends the list.
        expect(load.mock.calls.length).toBeLessThanOrEqual(3);
        expect(shownTitles(c)).toEqual(["Volume 1", "Volume 2"]);
        expect(loadMoreButton(c)).toBeUndefined();
    });

    it("loads more automatically when the end of a short list is already in view", async () => {
        serve({ [URL1]: page([1, 2], URL2), [URL2]: page([3, 4]) });
        const c = renderBrowser();
        await flush(10);
        expect(count(c)).toContain("4 books");
    });

    it("turns the pages of server-search results without disturbing the browsed list beneath", async () => {
        const searchRef = { href: "https://example.com/search?q={searchTerms}", kind: "template" as const };
        serve({ [URL1]: page([1, 2], undefined, { search: searchRef }), "https://example.com/search?q=dune&page=2": page(range(141, 144)) });
        search.mockResolvedValue({
            feed: page(range(101, 140), "https://example.com/search?q=dune&page=2", { search: searchRef }),
            finalUrl: "https://example.com/search?q=dune",
        });
        const c = renderBrowser();
        await flush();
        const input = c.querySelector('input[type="search"]') as HTMLInputElement;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
        await act(async () => {
            setter.call(input, "dune");
            input.dispatchEvent(new Event("input", { bubbles: true }));
        });
        await act(async () => {
            input.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        });
        await flush();
        expect(shownTitles(c)[0]).toBe("Volume 101");
        expect(count(c)).toContain("40 books");
        clickButton(c, "Load more");
        await flush();
        expect(count(c)).toContain("44 books");
        // Back leaves the search and returns to the list that was open.
        act(() => (c.querySelector('[aria-label="Back"]') as HTMLElement).click());
        await flush();
        expect(shownTitles(c)).toEqual(["Volume 1", "Volume 2"]);
    });
});
