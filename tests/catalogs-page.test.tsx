// @vitest-environment jsdom
/**
 * The Discover page: one row of sources (the curated storefront plus every catalog), a pinned way
 * to add another, and the selected source shown below it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";

const loadCuratedSections = vi.fn();
const load = vi.fn();

vi.mock("../src/core/services/DiscoverService", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../src/core/services/DiscoverService")>();
    return { ...actual, DiscoverService: { ...actual.DiscoverService, getCachedSections: () => [], loadCuratedSections: (...a: unknown[]) => loadCuratedSections(...a), search: vi.fn() } };
});
vi.mock("../src/core/services/OpdsService", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../src/core/services/OpdsService")>();
    return { ...actual, OpdsService: { ...actual.OpdsService, load: (...a: unknown[]) => load(...a), search: vi.fn(), loadDetail: vi.fn(), download: vi.fn(), probe: vi.fn() } };
});

import { DEFAULT_OPDS_PRESETS } from "../src/core/services/OpdsService";
import { useOpdsStore } from "../src/core/store";
import { resetOpdsBrowserSession } from "../src/features/catalogs/opds/useOpdsBrowser";
import { CatalogsPage } from "../src/features/catalogs/CatalogsPage";
import { flush, makeFeed, render, stubLayout, unmountAll } from "./helpers/opds-browser-harness";

const tabs = (c: HTMLElement) => Array.from(c.querySelectorAll('[aria-label="Catalog sources"] [role=tab]')) as HTMLElement[];
const selected = (c: HTMLElement) => tabs(c).filter((t) => t.getAttribute("aria-selected") === "true").map((t) => t.textContent?.trim());

describe("Discover page sources", () => {
    let unstub: () => void = () => {};
    beforeEach(() => {
        vi.clearAllMocks();
        resetOpdsBrowserSession();
        unstub = stubLayout();
        loadCuratedSections.mockResolvedValue([]);
        load.mockResolvedValue({ finalUrl: "https://x/opds", feed: makeFeed({ title: "Mock" }) });
        useOpdsStore.setState({
            catalogs: [...DEFAULT_OPDS_PRESETS, { id: "mine", title: "My Library", url: "http://nas.local/opds", auth: { username: "u", password: "p" } }],
            activeCatalogId: null,
        });
    });
    afterEach(() => {
        unmountAll();
        unstub();
        unstub = () => {};
    });

    it("lists Discover first, then every catalog, and starts on Discover", async () => {
        const c = render(<CatalogsPage />);
        await flush();
        expect(tabs(c).map((t) => t.textContent?.trim())).toEqual(["Discover", "Project Gutenberg", "Standard Ebooks", "My Library"]);
        expect(selected(c)).toEqual(["Discover"]);
    });

    it("marks a catalog you are signed in to", async () => {
        const c = render(<CatalogsPage />);
        await flush();
        const mine = tabs(c).find((t) => t.textContent?.includes("My Library"))!;
        expect(mine.querySelector('[aria-label="Signed in"]')).not.toBeNull();
        expect(tabs(c)[1].querySelector('[aria-label="Signed in"]')).toBeNull();
    });

    it("opens a catalog in place and returns to Discover", async () => {
        const c = render(<CatalogsPage />);
        await flush();
        act(() => tabs(c)[3].click());
        await flush();
        expect(selected(c)).toEqual(["My Library"]);
        expect(useOpdsStore.getState().activeCatalogId).toBe("mine");
        expect(load).toHaveBeenCalledWith("http://nas.local/opds", expect.objectContaining({ auth: { username: "u", password: "p" } }));
        act(() => tabs(c)[0].click());
        await flush();
        expect(selected(c)).toEqual(["Discover"]);
        expect(useOpdsStore.getState().activeCatalogId).toBeNull();
    });

    it("keeps Add outside the scrolling row so it is always reachable", async () => {
        const c = render(<CatalogsPage />);
        await flush();
        const add = c.querySelector('[aria-label="Add a catalog"]')!;
        expect(add).not.toBeNull();
        expect(c.querySelector('[aria-label="Catalog sources"]')!.contains(add)).toBe(false);
    });

    it("opens the add dialog", async () => {
        const c = render(<CatalogsPage />);
        await flush();
        act(() => (c.querySelector('[aria-label="Add a catalog"]') as HTMLElement).click());
        await flush();
        expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain("Add a catalog");
    });

    it("falls back to Discover if the remembered catalog was removed", async () => {
        useOpdsStore.setState({ activeCatalogId: "gone" });
        const c = render(<CatalogsPage />);
        await flush();
        expect(selected(c)).toEqual(["Discover"]);
    });
});
