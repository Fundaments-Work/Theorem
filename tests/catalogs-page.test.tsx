// @vitest-environment jsdom
/**
 * The Discover page. Its home is the built-in Fundaments catalog laid out as a front page; it is
 * the page itself, not a tab. Catalogs the reader adds appear as tabs next to "Discover", and
 * only then is there a tab row at all.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";

const load = vi.fn();
const search = vi.fn();

vi.mock("../src/core/services/OpdsService", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../src/core/services/OpdsService")>();
    return { ...actual, OpdsService: { ...actual.OpdsService, load: (...a: unknown[]) => load(...a), search: (...a: unknown[]) => search(...a), loadDetail: vi.fn(), download: vi.fn(), probe: vi.fn() } };
});

import { DEFAULT_OPDS_PRESETS } from "../src/core/services/OpdsService";
import { useOpdsStore } from "../src/core/store";
import { resetOpdsBrowserSession } from "../src/features/catalogs/opds/useOpdsBrowser";
import { CatalogsPage } from "../src/features/catalogs/CatalogsPage";
import { addRecentSearch, plainSummary, readRecentSearches } from "../src/features/catalogs/DiscoverHome";
import { flush, makeEntry, makeFeed, render, setInputValue, stubLayout, unmountAll } from "./helpers/opds-browser-harness";

const BASE = "https://catalog.fundaments.work/opds";
const HOME = `${BASE}/index.json`;
const MINE = { id: "mine", title: "My Library", url: "http://nas.local/opds", auth: { username: "u", password: "p" } };

const tabs = (c: HTMLElement) => Array.from(c.querySelectorAll('[aria-label="Catalog sources"] [role=tab]')) as HTMLElement[];
const selected = (c: HTMLElement) => tabs(c).filter((t) => t.getAttribute("aria-selected") === "true").map((t) => t.textContent?.trim());
const home = (c: HTMLElement) => c.querySelector("[data-discover-home]");

/** The shape the server's home feed parses into: shelves with books, and subjects as navigation. */
function homeFeed() {
    return makeFeed({
        title: "Fundaments Library",
        subtitle: "Free books, chosen with care.",
        dialect: "opds2",
        entries: [],
        search: { href: "https://catalog.fundaments.work/opds/search{?query}", kind: "template" },
        groups: [
            { title: "New & restored editions", href: `${BASE}/shelf/new-restored`, navigation: [], entries: [1, 2, 3, 4].map((i) => makeEntry(i, { summary: `<p>Story <b>${i}</b> &amp; more</p>` })) },
            { title: "Philosophy & essays", href: `${BASE}/shelf/philosophy`, navigation: [], entries: [5, 6].map((i) => makeEntry(i)) },
            {
                title: "Browse by category",
                href: `${BASE}/categories`,
                entries: [],
                navigation: [
                    { title: "Novels", href: `${BASE}/category/novels`, rel: "subsection", count: 23994 },
                    { title: "Poetry", href: `${BASE}/category/poetry`, rel: "subsection", count: 852 },
                ],
            },
        ],
    } as never);
}

function memoryStorage() {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
    });
    return store;
}

describe("Discover page", () => {
    let unstub: () => void = () => {};
    beforeEach(() => {
        vi.clearAllMocks();
        resetOpdsBrowserSession();
        unstub = stubLayout();
        memoryStorage();
        load.mockImplementation(async (url: string) => (url === HOME ? { finalUrl: HOME, feed: homeFeed() } : { finalUrl: url, feed: makeFeed({ title: "Mock" }) }));
        search.mockResolvedValue({ finalUrl: `${BASE}/search?query=x`, feed: makeFeed({ title: "Results", entries: [makeEntry(9)] }) });
        useOpdsStore.setState({ catalogs: [...DEFAULT_OPDS_PRESETS], activeCatalogId: null });
    });
    afterEach(() => {
        unmountAll();
        unstub();
        unstub = () => {};
        vi.unstubAllGlobals();
    });

    describe("with no catalogs added", () => {
        it("is the Discover home itself: no tab row, the built-in catalog loads underneath", async () => {
            const c = render(<CatalogsPage />);
            await flush();
            expect(c.querySelector('[aria-label="Catalog sources"]')).toBeNull();
            expect(home(c)).not.toBeNull();
            expect(c.querySelector("h1")?.textContent).toBe("Discover");
            expect(c.textContent).not.toContain("Fundaments Library");
            expect(load).toHaveBeenCalledWith(HOME, expect.anything());
        });

        it("lays out the front page: hero cards, the rest of the lead shelf, other shelves, subjects, bring your library", async () => {
            const c = render(<CatalogsPage />);
            await flush();
            const heroes = Array.from(c.querySelectorAll("[data-discover-hero]"));
            expect(heroes).toHaveLength(2);
            expect(heroes[0].textContent).toContain("Volume 1");
            // Summaries are shown as plain text, never as HTML.
            expect(heroes[0].textContent).toContain("Story 1 & more");
            expect(heroes[0].querySelector("b")).toBeNull();
            expect(c.textContent).toContain("More new editions");
            expect(c.textContent).toContain("Philosophy & essays");
            const subjects = Array.from(c.querySelectorAll("[data-discover-subject]")).map((s) => s.textContent);
            expect(subjects).toEqual(["Novels24kbooks", "Poetry852books"]);
            expect(c.querySelector("[data-discover-bring]")).not.toBeNull();
        });

        it("opens a subject in the regular browser, with Discover in the trail and Back to the home", async () => {
            const c = render(<CatalogsPage />);
            await flush();
            act(() => (c.querySelector("[data-discover-subject]") as HTMLElement).click());
            await flush();
            expect(load).toHaveBeenCalledWith(`${BASE}/category/novels`, expect.anything());
            expect(home(c)).toBeNull();
            expect(c.querySelector('[aria-label="Catalog trail"]')?.textContent).toContain("Discover");
            act(() => (c.querySelector('[aria-label="Back"]') as HTMLElement).click());
            await flush();
            expect(home(c)).not.toBeNull();
        });

        it("searches the catalog, remembers the search on this device, and shows it in the results box", async () => {
            const c = render(<CatalogsPage />);
            await flush();
            setInputValue(c, 'input[aria-label="Search free books"]', "  dune  ");
            await act(async () => {
                (c.querySelector('form[role="search"]') as HTMLFormElement).requestSubmit();
            });
            await flush();
            expect(search).toHaveBeenCalledWith(expect.objectContaining({ href: expect.stringContaining("/opds/search") }), "dune", undefined);
            expect(home(c)).toBeNull();
            expect((c.querySelector('input[type="search"]') as HTMLInputElement).value).toBe("dune");
            expect(readRecentSearches()).toEqual(["dune"]);
        });

        it("lists recent searches as chips that can be run, removed one by one, or cleared", async () => {
            localStorage.setItem("theorem-discover-recent-searches", JSON.stringify(["tolstoy", "poetry", "muna madan"]));
            const c = render(<CatalogsPage />);
            await flush();
            const chips = () => Array.from(c.querySelectorAll("[data-discover-recent] li")).map((li) => li.textContent);
            expect(chips()).toEqual(["tolstoy", "poetry", "muna madan"]);

            act(() => (c.querySelector('[aria-label="Remove “poetry” from recent searches"]') as HTMLElement).click());
            expect(chips()).toEqual(["tolstoy", "muna madan"]);
            expect(readRecentSearches()).toEqual(["tolstoy", "muna madan"]);

            const clear = Array.from(c.querySelectorAll("button")).find((b) => b.textContent === "Clear all")!;
            act(() => clear.click());
            expect(c.querySelector("[data-discover-recent]")).toBeNull();
            expect(localStorage.getItem("theorem-discover-recent-searches")).toBeNull();
        });

        it("survives corrupt or missing storage for recent searches", async () => {
            localStorage.setItem("theorem-discover-recent-searches", "{nope");
            expect(readRecentSearches()).toEqual([]);
            localStorage.setItem("theorem-discover-recent-searches", JSON.stringify([1, null, "", "ok"]));
            expect(readRecentSearches()).toEqual(["ok"]);
            vi.stubGlobal("localStorage", undefined);
            expect(readRecentSearches()).toEqual([]);
            const c = render(<CatalogsPage />);
            await flush();
            expect(home(c)).not.toBeNull();
        });

        it("keeps recent searches newest first, without duplicates, at most eight", () => {
            let list: string[] = [];
            for (const q of ["a", "b", "A", "c", "d", "e", "f", "g", "h", "i", "  ", ""]) list = addRecentSearch(list, q);
            expect(list).toEqual(["i", "h", "g", "f", "e", "d", "c", "A"]);
        });

        it("strips HTML and decodes entities in summary without double unescaping", () => {
            expect(plainSummary("<p>Fish &amp; chips</p>")).toBe("Fish & chips");
            expect(plainSummary("<b>&quot;Quotes&quot;</b> &amp; &#39;Apostrophes&#39;")).toBe('"Quotes" & ’Apostrophes’');
            expect(plainSummary("&amp;quot;not unescaped quote&amp;quot;")).toBe("&quot;not unescaped quote&quot;");
            expect(plainSummary(undefined)).toBe("");
        });

        it("offers Add a catalog in the header and in the bring-your-library card, with no built-in suggestions", async () => {
            const c = render(<CatalogsPage />);
            await flush();
            const adds = c.querySelectorAll('[aria-label="Add a catalog"]');
            expect(adds).toHaveLength(1);
            act(() => (adds[0] as HTMLElement).click());
            await flush();
            const dialog = document.body.querySelector('[role="dialog"]') as HTMLElement;
            expect(dialog.textContent).toContain("Add a catalog");
            expect(dialog.textContent).not.toContain("Project Gutenberg");
            expect(dialog.textContent).not.toContain("Standard Ebooks");
        });
    });

    describe("with catalogs added", () => {
        beforeEach(() => {
            useOpdsStore.setState({ catalogs: [...DEFAULT_OPDS_PRESETS, MINE], activeCatalogId: null });
        });

        it("shows a tab row: Discover, then the reader's catalogs; the built-in catalog is never a tab", async () => {
            const c = render(<CatalogsPage />);
            await flush();
            expect(tabs(c).map((t) => t.textContent?.trim())).toEqual(["Discover", "My Library"]);
            expect(selected(c)).toEqual(["Discover"]);
            expect(home(c)).not.toBeNull();
        });

        it("marks a catalog you are signed in to", async () => {
            const c = render(<CatalogsPage />);
            await flush();
            expect(tabs(c)[1].querySelector('[aria-label="Signed in"]')).not.toBeNull();
            expect(tabs(c)[0].querySelector('[aria-label="Signed in"]')).toBeNull();
        });

        it("opens a catalog in place and goes back to Discover", async () => {
            const c = render(<CatalogsPage />);
            await flush();
            act(() => tabs(c)[1].click());
            await flush();
            expect(selected(c)).toEqual(["My Library"]);
            expect(useOpdsStore.getState().activeCatalogId).toBe("mine");
            expect(load).toHaveBeenCalledWith("http://nas.local/opds", expect.objectContaining({ auth: { username: "u", password: "p" } }));
            expect(home(c)).toBeNull();
            act(() => tabs(c)[0].click());
            await flush();
            expect(selected(c)).toEqual(["Discover"]);
            expect(useOpdsStore.getState().activeCatalogId).toBeNull();
            expect(home(c)).not.toBeNull();
        });

        it("keeps Add outside the scrolling row, and only one Add control in the header area", async () => {
            const c = render(<CatalogsPage />);
            await flush();
            const adds = c.querySelectorAll('[aria-label="Add a catalog"]');
            expect(adds).toHaveLength(1);
            expect(c.querySelector('[aria-label="Catalog sources"]')!.contains(adds[0])).toBe(false);
            // The card at the bottom of the home still invites adding another.
            expect(c.querySelector("[data-discover-bring]")).not.toBeNull();
        });

        it("falls back to Discover if the remembered catalog was removed", async () => {
            useOpdsStore.setState({ activeCatalogId: "gone" });
            const c = render(<CatalogsPage />);
            await flush();
            expect(selected(c)).toEqual(["Discover"]);
        });
    });

    it("shows the regular error with Try again when the built-in catalog cannot load and has no copy", async () => {
        load.mockRejectedValue(Object.assign(new Error("offline"), { kind: "network" }));
        const c = render(<CatalogsPage />);
        await flush();
        expect(home(c)).toBeNull();
        expect(c.textContent).toContain("Try again");
    });
});
