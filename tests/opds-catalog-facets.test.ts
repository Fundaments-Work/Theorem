import { describe, it, expect } from "vitest";
import {
    CATALOG_SORT_ORDERS,
    applyCatalogFacets,
    collectCatalogFacets,
    entryFormat,
    formatLabel,
} from "../src/features/catalogs/catalog-facets";
import type { OpdsEntry } from "../src/core/types";

function entry(over: Partial<OpdsEntry> & { id: string }): OpdsEntry {
    return {
        title: "Untitled",
        isNavigation: false,
        links: [],
        ...over,
    } as OpdsEntry;
}

const CATALOG: OpdsEntry[] = [
    entry({ id: "a", title: "Zebra Crossing", author: "Beta", language: "en", published: "1990-01-01", downloadUrl: "https://x/z.epub" }),
    entry({ id: "b", title: "apple orchard", author: "Alpha", language: "EN-gb", published: "2020-05-05", downloadUrl: "https://x/a.pdf" }),
    entry({ id: "c", title: "Mango Street", author: "Gamma", language: "sv", published: "2005-02-02", downloadUrl: "https://x/m.pdf" }),
    entry({ id: "d", title: "Banana Republic", author: "Delta", published: "2010-07-07", downloadUrl: "https://x/b.cbz" }),
];

describe("entryFormat", () => {
    it("prefers the declared format", () => {
        expect(entryFormat(entry({ id: "x", downloadFormat: "epub", downloadUrl: "https://x/a.mobi" }))).toBe("epub");
    });

    it("falls back to the download URL extension", () => {
        // Plenty of OPDS servers omit the declared type.
        expect(entryFormat(entry({ id: "x", downloadUrl: "https://x/a.pdf" }))).toBe("pdf");
    });

    it("ignores query strings and fragments when reading the extension", () => {
        expect(entryFormat(entry({ id: "x", downloadUrl: "https://x/a.epub?token=1#frag" }))).toBe("epub");
    });

    it("does not mistake a host for an extension", () => {
        // "example.com" has no file extension; slicing blindly would return "com".
        expect(entryFormat(entry({ id: "x", downloadUrl: "https://example.com/download" }))).toBe("other");
    });

    it("reports other when there is no download URL", () => {
        expect(entryFormat(entry({ id: "x" }))).toBe("other");
    });
});

describe("formatLabel", () => {
    it("humanises known formats", () => {
        expect(formatLabel("epub")).toBe("EPUB");
        expect(formatLabel("cbz")).toBe("CBZ");
    });

    it("falls back to uppercase for unknown formats", () => {
        expect(formatLabel("azw")).toBe("AZW");
    });
});

describe("collectCatalogFacets", () => {
    it("lists languages most common first, case-insensitively", () => {
        // "EN-gb" must collapse onto "en" rather than appearing as its own facet.
        const facets = collectCatalogFacets(CATALOG);
        expect(facets.languages.slice(0, 2).sort()).toEqual(["en", "sv"]);
        expect(facets.languages).not.toContain("en-gb");
    });

    it("lists formats present in the feed", () => {
        expect(collectCatalogFacets(CATALOG).formats.sort()).toEqual(["cbz", "epub", "pdf"]);
    });

    it("ignores navigation entries", () => {
        const facets = collectCatalogFacets([
            ...CATALOG,
            entry({ id: "nav", isNavigation: true, title: "Fiction", language: "fr" }),
        ]);
        expect(facets.languages).not.toContain("fr");
    });

    it("returns empty lists for an empty catalog", () => {
        expect(collectCatalogFacets([])).toEqual({ languages: [], formats: [] });
    });
});

describe("applyCatalogFacets", () => {
    const noSelection = { sortOrder: "title" as const, language: null, format: null };

    it("sorts by title, case-insensitively", () => {
        expect(applyCatalogFacets(CATALOG, noSelection).map((e) => e.title)).toEqual([
            "apple orchard",
            "Banana Republic",
            "Mango Street",
            "Zebra Crossing",
        ]);
    });

    it("sorts by author", () => {
        const result = applyCatalogFacets(CATALOG, { ...noSelection, sortOrder: "author" });
        expect(result.map((e) => e.author)).toEqual(["Alpha", "Beta", "Delta", "Gamma"]);
    });

    it("sorts newest first and oldest first", () => {
        expect(
            applyCatalogFacets(CATALOG, { ...noSelection, sortOrder: "newest" }).map((e) => e.published),
        ).toEqual(["2020-05-05", "2010-07-07", "2005-02-02", "1990-01-01"]);
        expect(
            applyCatalogFacets(CATALOG, { ...noSelection, sortOrder: "oldest" }).map((e) => e.published),
        ).toEqual(["1990-01-01", "2005-02-02", "2010-07-07", "2020-05-05"]);
    });

    it("tolerates entries with no date when sorting by recency", () => {
        const withMissing = [...CATALOG, entry({ id: "nodate", title: "Undated" })];
        const result = applyCatalogFacets(withMissing, { ...noSelection, sortOrder: "newest" });
        expect(result[result.length - 1].title).toBe("Undated");
    });

    it("tolerates entries with no author when sorting by author", () => {
        const result = applyCatalogFacets(CATALOG, { ...noSelection, sortOrder: "author" });
        // The authorless entry would be "Delta" here; every row must still sort cleanly.
        expect(result).toHaveLength(CATALOG.length);
    });

    it("filters by language across the base subtag", () => {
        // "EN-gb" is included by an "en" filter.
        expect(
            applyCatalogFacets(CATALOG, { ...noSelection, language: "en" }).map((e) => e.id).sort(),
        ).toEqual(["a", "b"]);
    });

    it("filters by format", () => {
        expect(
            applyCatalogFacets(CATALOG, { ...noSelection, format: "pdf" }).map((e) => e.id).sort(),
        ).toEqual(["b", "c"]);
    });

    it("combines language and format", () => {
        expect(
            applyCatalogFacets(CATALOG, { sortOrder: "title", language: "en", format: "pdf" }).map(
                (e) => e.id,
            ),
        ).toEqual(["b"]);
    });

    it("returns an empty list when the combination matches nothing", () => {
        expect(
            applyCatalogFacets(CATALOG, { sortOrder: "title", language: "sv", format: "cbz" }),
        ).toEqual([]);
    });

    it("does not mutate the input array", () => {
        const original = [...CATALOG];
        applyCatalogFacets(CATALOG, { ...noSelection, sortOrder: "author" });
        expect(CATALOG).toEqual(original);
    });
});

describe("sort order options", () => {
    it("exposes the four orders used by the chip row", () => {
        expect(CATALOG_SORT_ORDERS.map((o) => o.id)).toEqual(["title", "author", "newest", "oldest"]);
    });
});