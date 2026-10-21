// @vitest-environment jsdom
/**
 * Searching inside a catalog.
 *
 * Three situations: the catalog advertises a search (its own results are fetched on submit), it
 * does not (the loaded list is filtered as you type), or its search fails (we fall back to the
 * loaded list rather than showing nothing). Whichever it is, an older answer must never overwrite
 * a newer one, and the list you drilled into must survive a search.
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
import { CATALOG, flush, flushDebounce, makeEntry, makeFeed, renderBrowser, setInputValue, shownTitles, stubLayout, unmountAll } from "./helpers/opds-browser-harness";

const SEARCH = { href: "https://example.com/search?q={searchTerms}", kind: "template" as const };

const books = [
    makeEntry(1, { title: "Dune", authors: ["Frank Herbert"] }),
    makeEntry(2, { title: "Emma", authors: ["Jane Austen"] }),
    makeEntry(3, { title: "Persuasion", authors: ["Jane Austen"] }),
    makeEntry(4, { title: "Neuromancer", authors: ["William Gibson"] }),
];

const served = (feed: OpdsFeed) => load.mockResolvedValue({ feed, finalUrl: CATALOG.url });
const submit = async (c: HTMLElement, text: string) => {
    const input = setInputValue(c, 'input[type="search"]', text);
    await act(async () => {
        input.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flush();
};

describe("catalog search", () => {
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

    describe("a catalog without search", () => {
        it("still offers an input, labelled for what it does", async () => {
            served(makeFeed({ entries: books }));
            const c = renderBrowser();
            await flush();
            const input = c.querySelector('input[type="search"]') as HTMLInputElement;
            expect(input.placeholder).toBe("Filter this list");
        });

        it("filters the list as you type, on title and on author, ignoring case", async () => {
            served(makeFeed({ entries: books }));
            const c = renderBrowser();
            await flush();
            setInputValue(c, 'input[type="search"]', "DUNE");
            await flush();
            expect(shownTitles(c)).toEqual(["Dune"]);
            setInputValue(c, 'input[type="search"]', "austen");
            await flush();
            expect(shownTitles(c).sort()).toEqual(["Emma", "Persuasion"]);
        });

        it("tolerates a typo, like the Library's search", async () => {
            served(makeFeed({ entries: books }));
            const c = renderBrowser();
            await flush();
            setInputValue(c, 'input[type="search"]', "neuromancr");
            await flush();
            expect(shownTitles(c)).toEqual(["Neuromancer"]);
        });

        it("says nothing matches, and clearing restores the list", async () => {
            served(makeFeed({ entries: books }));
            const c = renderBrowser();
            await flush();
            setInputValue(c, 'input[type="search"]', "zzzzqqq");
            await flush();
            expect(c.querySelector("[data-opds-empty]")!.textContent).toContain("Nothing matches");
            act(() => (c.querySelector('[aria-label="Clear search"]') as HTMLElement).click());
            await flush();
            expect(shownTitles(c)).toHaveLength(4);
        });
    });

    describe("a catalog with search", () => {
        it("advertises it in the input and uses it on submit", async () => {
            served(makeFeed({ entries: books, search: SEARCH }));
            search.mockResolvedValue({ feed: makeFeed({ entries: [makeEntry(9, { title: "Dune Messiah" })], search: SEARCH }), finalUrl: "https://example.com/search?q=dune" });
            const c = renderBrowser();
            await flush();
            expect((c.querySelector('input[type="search"]') as HTMLInputElement).placeholder).toBe(`Search ${CATALOG.title}`);
            await submit(c, "dune");
            expect(search).toHaveBeenCalledWith(SEARCH, "dune", undefined);
            expect(shownTitles(c)).toEqual(["Dune Messiah"]);
            // The trail names the search, so it is clear where Back goes.
            expect(c.querySelector('nav[aria-label="Catalog trail"]')!.textContent).toContain("Search: dune");
        });

        it("does not search as you type, only on submit (no request per keystroke)", async () => {
            served(makeFeed({ entries: books, search: SEARCH }));
            const c = renderBrowser();
            await flush();
            setInputValue(c, 'input[type="search"]', "d");
            setInputValue(c, 'input[type="search"]', "du");
            setInputValue(c, 'input[type="search"]', "dun");
            await flushDebounce();
            expect(search).not.toHaveBeenCalled();
            // The list on screen is untouched until the user submits.
            expect(shownTitles(c)).toHaveLength(4);
        });

        it("falls back to filtering the loaded list when the catalog's search fails", async () => {
            served(makeFeed({ entries: books, search: SEARCH }));
            search.mockRejectedValue(new OpdsError("http", "boom", { status: 500 }));
            const c = renderBrowser();
            await flush();
            await submit(c, "emma");
            expect(search).toHaveBeenCalledTimes(1);
            expect(shownTitles(c)).toEqual(["Emma"]);
            expect((c.querySelector('input[type="search"]') as HTMLInputElement).placeholder).toBe("Filter this list");
        });

        it("ignores a stale answer that arrives after a newer one", async () => {
            served(makeFeed({ entries: books, search: SEARCH }));
            let resolveOld: (v: unknown) => void = () => {};
            search
                .mockImplementationOnce(() => new Promise((r) => (resolveOld = r)))
                .mockResolvedValueOnce({ feed: makeFeed({ entries: [makeEntry(2, { title: "New Answer" })], search: SEARCH }), finalUrl: "https://example.com/search?q=new" });
            const c = renderBrowser();
            await flush();
            await submit(c, "old");
            await submit(c, "new");
            expect(shownTitles(c)).toEqual(["New Answer"]);
            await act(async () => resolveOld({ feed: makeFeed({ entries: [makeEntry(1, { title: "Old Answer" })] }), finalUrl: "https://example.com/search?q=old" }));
            await flush();
            expect(shownTitles(c)).toEqual(["New Answer"]);
        });

        it("shows a specific empty state for no results, and clearing returns to the list", async () => {
            served(makeFeed({ entries: books, search: SEARCH }));
            search.mockResolvedValue({ feed: makeFeed({ entries: [], search: SEARCH }), finalUrl: "https://example.com/search?q=nope" });
            const c = renderBrowser();
            await flush();
            await submit(c, "nope");
            expect(c.querySelector("[data-opds-empty]")!.textContent).toContain("No results for “nope”");
            act(() => (c.querySelector('[aria-label="Clear search"]') as HTMLElement).click());
            await flush();
            expect(shownTitles(c)).toHaveLength(4);
            expect(c.querySelector("[data-opds-empty]")).toBeNull();
        });

        it("keeps the list you drilled into: Back from a search returns to it, not to the catalog root", async () => {
            const nav = [{ title: "Fiction", href: "https://example.com/opds/fiction", rel: "subsection" }];
            load.mockImplementation(async (url: string) => ({
                finalUrl: url,
                feed: url.endsWith("/fiction")
                    ? makeFeed({ title: "Fiction", entries: [makeEntry(7, { title: "Fiction Book" })], search: SEARCH })
                    : makeFeed({ entries: [], navigation: nav, search: SEARCH }),
            }));
            search.mockResolvedValue({ feed: makeFeed({ entries: [makeEntry(9, { title: "Hit" })] }), finalUrl: "https://example.com/search?q=x" });
            const c = renderBrowser();
            await flush();
            act(() => (Array.from(c.querySelectorAll("button")).find((b) => b.textContent?.includes("Fiction")) as HTMLElement).click());
            await flush();
            expect(shownTitles(c)).toEqual(["Fiction Book"]);
            await submit(c, "x");
            expect(shownTitles(c)).toEqual(["Hit"]);
            act(() => (c.querySelector('[aria-label="Back"]') as HTMLElement).click());
            await flush();
            expect(shownTitles(c)).toEqual(["Fiction Book"]);
        });

        it("searching from a search replaces it instead of stacking results on results", async () => {
            served(makeFeed({ entries: books, search: SEARCH }));
            search
                .mockResolvedValueOnce({ feed: makeFeed({ entries: [makeEntry(5, { title: "First Hit" })], search: SEARCH }), finalUrl: "https://example.com/search?q=a" })
                .mockResolvedValueOnce({ feed: makeFeed({ entries: [makeEntry(6, { title: "Second Hit" })], search: SEARCH }), finalUrl: "https://example.com/search?q=b" });
            const c = renderBrowser();
            await flush();
            await submit(c, "a");
            await submit(c, "b");
            const trail = c.querySelector('nav[aria-label="Catalog trail"]')!.textContent!;
            expect(trail).toContain("Search: b");
            expect(trail).not.toContain("Search: a");
        });

        it("a sign-in challenge during search shows the sign-in panel instead of failing quietly", async () => {
            served(makeFeed({ entries: books, search: SEARCH }));
            search.mockRejectedValue(new OpdsError("authRequired", "This catalog requires a sign-in."));
            const c = renderBrowser();
            await flush();
            await submit(c, "emma");
            expect(c.textContent).toContain("Sign in to");
        });
    });
});
