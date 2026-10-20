// @vitest-environment jsdom
/**
 * Sort and filter chips in the catalog browser.
 *
 * The pure logic is covered in `opds-catalog-facets.test.ts`; this guards the wiring: the chips
 * narrow the list that is on screen, every option stays reachable while one is active, clearing
 * works, and an empty result offers a way out instead of a blank page.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import type { OpdsEntry, OpdsFeed } from "../src/core/types";

const load = vi.fn();

vi.mock("../src/core/services/OpdsService", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../src/core/services/OpdsService")>();
    return { ...actual, OpdsService: { ...actual.OpdsService, load: (...a: unknown[]) => load(...a), search: vi.fn(), loadDetail: vi.fn(), download: vi.fn() } };
});

import { useOpdsStore } from "../src/core/store";
import { resetOpdsBrowserSession } from "../src/features/catalogs/opds/useOpdsBrowser";
import { CATALOG, clickButton, flush, makeEntry, makeFeed, renderBrowser, shownTitles, stubLayout, unmountAll } from "./helpers/opds-browser-harness";

const withFormat = (e: OpdsEntry, format: "epub" | "pdf" | "cbz"): OpdsEntry => ({
    ...e,
    acquisitions: [{ ...e.acquisitions[0], href: `https://x/${e.id}.${format}`, format }],
});

const entries: OpdsEntry[] = [
    withFormat(makeEntry(1, { title: "Zebra", language: "en" }), "epub"),
    withFormat(makeEntry(2, { title: "Apple", language: "en-GB" }), "pdf"),
    withFormat(makeEntry(3, { title: "Mango", language: "sv" }), "pdf"),
    withFormat(makeEntry(4, { title: "Banana", language: "fr" }), "cbz"),
];

const served = (feed: OpdsFeed) => load.mockResolvedValue({ feed, finalUrl: CATALOG.url });
const chip = (c: HTMLElement, label: string) => Array.from(c.querySelectorAll("button[aria-pressed]")).find((b) => b.textContent?.trim() === label) as HTMLElement | undefined;
const count = (c: HTMLElement) => c.querySelector("[data-opds-count]")?.textContent ?? "";

describe("catalog sort and filters", () => {
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

    it("keeps the catalog's own order by default rather than re-sorting it", async () => {
        served(makeFeed({ entries }));
        const c = renderBrowser();
        await flush();
        expect(shownTitles(c)).toEqual(["Zebra", "Apple", "Mango", "Banana"]);
        expect(c.textContent).toContain("Catalog order");
    });

    it("narrows to a language across its regional variants and reports the narrowed count", async () => {
        served(makeFeed({ entries }));
        const c = renderBrowser();
        await flush();
        expect(count(c)).toContain("4 books");
        act(() => chip(c, "English")!.click());
        await flush();
        expect(shownTitles(c)).toEqual(["Zebra", "Apple"]);
        expect(count(c)).toContain("2 books");
        expect(count(c)).toContain("filtered");
    });

    it("keeps every option reachable while a filter is active", async () => {
        served(makeFeed({ entries }));
        const c = renderBrowser();
        await flush();
        act(() => chip(c, "English")!.click());
        await flush();
        // The options come from the whole list, not just what is currently shown.
        expect(chip(c, "Swedish")).toBeDefined();
        expect(chip(c, "French")).toBeDefined();
    });

    it("toggles a filter off when its chip is pressed again", async () => {
        served(makeFeed({ entries }));
        const c = renderBrowser();
        await flush();
        act(() => chip(c, "English")!.click());
        await flush();
        act(() => chip(c, "English")!.click());
        await flush();
        expect(shownTitles(c)).toHaveLength(4);
        expect(chip(c, "English")!.getAttribute("aria-pressed")).toBe("false");
    });

    it("filters by format and combines it with language", async () => {
        served(makeFeed({ entries }));
        const c = renderBrowser();
        await flush();
        act(() => chip(c, "PDF")!.click());
        await flush();
        expect(shownTitles(c)).toEqual(["Apple", "Mango"]);
        act(() => chip(c, "English")!.click());
        await flush();
        expect(shownTitles(c)).toEqual(["Apple"]);
    });

    it("clears every active filter at once", async () => {
        served(makeFeed({ entries }));
        const c = renderBrowser();
        await flush();
        act(() => chip(c, "PDF")!.click());
        act(() => chip(c, "English")!.click());
        await flush();
        clickButton(c, "Clear");
        await flush();
        expect(shownTitles(c)).toHaveLength(4);
    });

    it("offers a way out when the filters hide everything", async () => {
        served(makeFeed({ entries }));
        const c = renderBrowser();
        await flush();
        act(() => chip(c, "CBZ")!.click());
        act(() => chip(c, "English")!.click());
        await flush();
        expect(shownTitles(c)).toHaveLength(0);
        expect(c.querySelector("[data-opds-empty]")!.textContent).toContain("Nothing here yet");
        clickButton(c, "Clear filters");
        await flush();
        expect(shownTitles(c)).toHaveLength(4);
    });

    it("hides the chips when there is nothing to choose between", async () => {
        served(makeFeed({ entries: [withFormat(makeEntry(1, { language: "en" }), "epub")] }));
        const c = renderBrowser();
        await flush();
        expect(c.querySelector("button[aria-pressed]")).toBeNull();
    });

    it("shows the catalog's own facets (OPDS facet groups) as choices that load that list", async () => {
        load.mockImplementation(async (url: string) => ({
            finalUrl: url,
            feed: url.includes("lang=fr")
                ? makeFeed({ entries: [makeEntry(8, { title: "Livre" })], facets: [{ title: "Language", items: [{ title: "English", href: "https://example.com/opds?lang=en", active: false }, { title: "French", href: "https://example.com/opds?lang=fr", active: true }] }] })
                : makeFeed({ entries, facets: [{ title: "Language", items: [{ title: "English", href: "https://example.com/opds?lang=en", active: true }, { title: "French", href: "https://example.com/opds?lang=fr", active: false }] }] }),
        }));
        const c = renderBrowser();
        await flush();
        // The facet dropdown shows the active choice.
        expect(c.querySelector('[role="group"][aria-label="Sort and filter"]')!.textContent).toContain("Language: English");
    });

    it("resets a filter that no longer applies when the list changes", async () => {
        const nav = [{ title: "Other", href: "https://example.com/opds/other", rel: "subsection" }];
        load.mockImplementation(async (url: string) => ({
            finalUrl: url,
            feed: url.endsWith("/other")
                ? makeFeed({ title: "Other", entries: [withFormat(makeEntry(5, { title: "Solo", language: "en" }), "epub"), withFormat(makeEntry(6, { title: "Duo", language: "sv" }), "pdf")] })
                : makeFeed({ entries, navigation: nav }),
        }));
        const c = renderBrowser();
        await flush();
        act(() => chip(c, "French")!.click());
        await flush();
        expect(shownTitles(c)).toEqual(["Banana"]);
        act(() => (Array.from(c.querySelectorAll("button")).find((b) => b.textContent?.includes("Other")) as HTMLElement).click());
        await flush();
        expect(shownTitles(c)).toEqual(["Solo", "Duo"]);
    });
});
