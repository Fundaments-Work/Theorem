// @vitest-environment jsdom
/**
 * OPDS catalog sort and filter chips.
 *
 * OPDS had no sorting and no filtering at all, so a mixed catalog could only be
 * scanned top to bottom. The chips reuse the Library filter panel's shared
 * treatment, and facet options are collected from the *unfiltered* set so
 * selecting one never makes the others unreachable.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import type { OpdsEntry, OpdsFeed } from "../src/core/types";

const fetchFeed = vi.fn();

vi.mock("../src/core/services/OpdsService", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../src/core/services/OpdsService")>();
    return {
        ...actual,
        OpdsService: {
            ...actual.OpdsService,
            fetchFeed: (...args: unknown[]) => fetchFeed(...args),
            search: vi.fn(),
            downloadAndImportBook: vi.fn(),
        },
    };
});

import { OPDSBrowserPage } from "../src/features/catalogs/OPDSBrowser";
import { useOpdsStore } from "../src/core/store";
import {
    clickButton,
    flush,
    render,
    shownTitles,
    stubLayout,
    unmountAll,
} from "./helpers/opds-browser-harness";

function entry(over: Partial<OpdsEntry> & { id: string }): OpdsEntry {
    return { isNavigation: false, links: [], ...over } as OpdsEntry;
}

const CATALOG: OpdsEntry[] = [
    entry({ id: "a", title: "Zebra Crossing", author: "Beta", language: "en", downloadUrl: "https://x/z.epub" }),
    entry({ id: "b", title: "apple orchard", author: "Alpha", language: "en", downloadUrl: "https://x/a.pdf" }),
    entry({ id: "c", title: "Mango Street", author: "Gamma", language: "sv", downloadUrl: "https://x/m.pdf" }),
    entry({ id: "d", title: "Banana Republic", author: "Delta", language: "sv", downloadUrl: "https://x/b.cbz" }),
];

describe("OPDS sort and filters", () => {
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
        fetchFeed.mockResolvedValue({ title: "Test Catalog", selfUrl: "https://example.com/opds", entries: CATALOG } as OpdsFeed);
    });

    afterEach(() => {
        unmountAll();
        unstub();
        unstub = () => {};
    });

    it("sorts by title by default", async () => {
        const container = render(<OPDSBrowserPage />);
        await flush();

        expect(shownTitles(container)).toEqual([
            "apple orchard",
            "Banana Republic",
            "Mango Street",
            "Zebra Crossing",
        ]);
    });

    it("reorders the grid when a sort chip is clicked", async () => {
        const container = render(<OPDSBrowserPage />);
        await flush();

        clickButton(container, "Author A–Z");
        await flush();

        expect(shownTitles(container)).toEqual([
            "apple orchard",
            "Zebra Crossing",
            "Banana Republic",
            "Mango Street",
        ]);
    });

    it("narrows to a language and reports the narrowed count", async () => {
        const container = render(<OPDSBrowserPage />);
        await flush();
        expect(container.textContent).toContain("4 titles");

        clickButton(container, "sv");
        await flush();

        expect(shownTitles(container).sort()).toEqual(["Banana Republic", "Mango Street"]);
        expect(container.textContent).toContain("2 titles");
    });

    it("keeps every facet option reachable while a filter is active", async () => {
        const container = render(<OPDSBrowserPage />);
        await flush();

        clickButton(container, "sv");
        await flush();

        // Otherwise selecting a language would remove the other language chip and
        // there would be no way back.
        expect(container.textContent).toContain("en");
    });

    it("toggles a filter off when its chip is clicked again", async () => {
        const container = render(<OPDSBrowserPage />);
        await flush();

        clickButton(container, "sv");
        await flush();
        expect(shownTitles(container)).toHaveLength(2);

        clickButton(container, "sv");
        await flush();
        expect(shownTitles(container)).toHaveLength(4);
    });

    it("filters by format", async () => {
        const container = render(<OPDSBrowserPage />);
        await flush();

        clickButton(container, "EPUB");
        await flush();

        expect(shownTitles(container)).toEqual(["Zebra Crossing"]);
    });

    it("combines language and format", async () => {
        const container = render(<OPDSBrowserPage />);
        await flush();

        clickButton(container, "en");
        await flush();
        clickButton(container, "PDF");
        await flush();

        expect(shownTitles(container)).toEqual(["apple orchard"]);
    });

    it("clears every active filter at once", async () => {
        const container = render(<OPDSBrowserPage />);
        await flush();

        clickButton(container, "en");
        await flush();
        clickButton(container, "EPUB");
        await flush();
        expect(shownTitles(container)).toHaveLength(1);

        clickButton(container, "Clear filters");
        await flush();
        expect(shownTitles(container)).toHaveLength(4);
    });

    it("offers a recovery state when the filters hide everything", async () => {
        // No entry is both "fr" and "cbz".
        fetchFeed.mockResolvedValue({
            title: "Test Catalog",
            entries: [
                entry({ id: "e", title: "Le Petit Prince", language: "fr", downloadUrl: "https://x/e.pdf" }),
                entry({ id: "f", title: "Akira", language: "ja", downloadUrl: "https://x/f.cbz" }),
            ],
        } as OpdsFeed);

        const container = render(<OPDSBrowserPage />);
        await flush();

        clickButton(container, "fr");
        await flush();
        clickButton(container, "CBZ");
        await flush();

        expect(shownTitles(container)).toHaveLength(0);
        expect(container.textContent).toContain("No titles match these filters");
    });

    it("hides the facet row when there is nothing to sort or filter", async () => {
        // A single entry exposes neither a language nor a format choice.
        fetchFeed.mockResolvedValue({
            title: "Test Catalog",
            entries: [entry({ id: "only", title: "Only Book", downloadUrl: "https://x/only.epub" })],
        } as OpdsFeed);

        const container = render(<OPDSBrowserPage />);
        await flush();

        expect(container.textContent).not.toContain("Clear filters");
        expect(shownTitles(container)).toEqual(["Only Book"]);
    });

    it("resets a filter that no longer applies when the feed changes", async () => {
        const container = render(<OPDSBrowserPage />);
        await flush();

        clickButton(container, "sv");
        await flush();
        expect(shownTitles(container)).toHaveLength(2);

        // Navigating into a sub-feed where nothing is Swedish must not leave the
        // grid permanently empty with no visible chip to turn off.
        fetchFeed.mockResolvedValue({
            title: "English Only",
            entries: CATALOG.filter((e) => e.language === "en"),
        } as OpdsFeed);
        act(() => {
            useOpdsStore.setState({ currentFeedUrl: "https://example.com/opds/sub" } as never);
        });
        await flush();

        expect(shownTitles(container)).toHaveLength(2);
    });
});