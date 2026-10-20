import { describe, expect, it } from "vitest";
import { applyCatalogQuirks, mergeEditions, pickPrimaryAcquisition } from "../src/core/services/opds-quirks";
import type { OpdsAcquisition, OpdsEntry, OpdsFeed } from "../src/core/types";

const nav = (title: string, href: string, summary?: string) => ({ title, href, rel: "subsection", summary });
const feed = (over: Partial<OpdsFeed>): OpdsFeed => ({
    id: "f", title: "t", dialect: "atom", kind: "navigation", facets: [], navigation: [], groups: [], entries: [], ...over,
});

describe("Gutenberg quirk", () => {
    const url = "https://www.gutenberg.org/ebooks/search.opds/?query=dracula";

    it("turns book rows into partial books with real cover addresses and keeps category rows as navigation", () => {
        const out = applyCatalogQuirks(
            feed({
                navigation: [
                    nav("Authors", "https://www.gutenberg.org/ebooks/authors/search.opds/?query=dracula"),
                    nav("Dracula", "https://www.gutenberg.org/ebooks/345.opds", "Bram Stoker"),
                    nav("Moby Dick; Or, The Whale by Herman Melville", "https://www.gutenberg.org/ebooks/2701.opds", "Herman Melville"),
                ],
            }),
            url,
        );
        expect(out.navigation.map((n) => n.title)).toEqual(["Authors"]);
        expect(out.entries.map((e) => e.title)).toEqual(["Dracula", "Moby Dick; Or, The Whale"]);
        expect(out.entries[0].authors).toEqual(["Bram Stoker"]);
        expect(out.entries[0].detailHref).toBe("https://www.gutenberg.org/ebooks/345.opds");
        expect(out.entries[0].cover).toBe("https://www.gutenberg.org/cache/epub/345/pg345.cover.medium.jpg");
        expect(out.kind).toBe("mixed");
    });

    it("recognises the http and mobile hosts it links to, and a feed with only books becomes an acquisition feed", () => {
        const out = applyCatalogQuirks(feed({ navigation: [nav("A Book", "http://m.gutenberg.org/ebooks/12.opds", "Someone")] }), url);
        expect(out.entries).toHaveLength(1);
        expect(out.kind).toBe("acquisition");
    });

    it("takes the author from a 'by' title when the row has no summary", () => {
        const out = applyCatalogQuirks(feed({ navigation: [nav("Emma by Jane Austen", "https://www.gutenberg.org/ebooks/158.opds")] }), url);
        expect(out.entries[0].title).toBe("Emma");
        expect(out.entries[0].authors).toEqual(["Jane Austen"]);
    });

    it("leaves other catalogs and non-book links alone", () => {
        const other = feed({ navigation: [nav("Dracula", "https://example.com/ebooks/345.opds")] });
        expect(applyCatalogQuirks(other, "https://example.com/opds")).toBe(other);
        const gut = feed({ navigation: [nav("Popular", "https://www.gutenberg.org/ebooks/search.opds/?sort_order=downloads")] });
        expect(applyCatalogQuirks(gut, "https://www.gutenberg.org/ebooks.opds/")).toBe(gut);
    });
});

const acq = (over: Partial<OpdsAcquisition>): OpdsAcquisition => ({
    href: "https://x/a.epub", kind: "openAccess", mime: "application/epub+zip", format: "epub", drm: false, downloadable: true, ...over,
});

describe("pickPrimaryAcquisition", () => {
    it("prefers EPUB, never a sample, and the illustrated edition", () => {
        expect(pickPrimaryAcquisition([acq({ format: "pdf", href: "https://x/a.pdf" }), acq({})])).toBe(1);
        expect(pickPrimaryAcquisition([acq({ kind: "sample" }), acq({ format: "pdf", href: "https://x/b.pdf" })])).toBe(1);
        expect(pickPrimaryAcquisition([acq({ href: "https://x/a.epub.noimages" }), acq({ href: "https://x/a.epub.images" })])).toBe(1);
    });
    it("ignores DRM and non-downloadable files, and returns undefined when nothing is left", () => {
        expect(pickPrimaryAcquisition([acq({ downloadable: false, drm: true }), acq({ kind: "buy", downloadable: false })])).toBeUndefined();
        expect(pickPrimaryAcquisition([])).toBeUndefined();
    });
    it("uses Kobo and 'advanced' variants only when nothing plainer exists", () => {
        const plain = acq({ href: "https://x/a.epub" });
        const kobo = acq({ href: "https://x/a.kepub.epub", title: "Kobo Kepub epub" });
        expect(pickPrimaryAcquisition([kobo, plain])).toBe(1);
        expect(pickPrimaryAcquisition([kobo])).toBe(0);
    });
});

describe("mergeEditions", () => {
    const edition = (href: string): OpdsEntry => ({
        id: href, title: "Dracula", authors: ["Bram Stoker"], acquisitions: [acq({ href })],
    });
    it("combines several editions into one book with every download once", () => {
        const merged = mergeEditions([edition("https://x/1.epub.noimages"), edition("https://x/1.epub.images"), edition("https://x/1.epub.noimages")])!;
        expect(merged.acquisitions.map((a) => a.href)).toEqual(["https://x/1.epub.noimages", "https://x/1.epub.images"]);
        expect(merged.primary).toBe(1);
    });
    it("handles zero and one entries", () => {
        expect(mergeEditions([])).toBeUndefined();
        const one = edition("https://x/1.epub");
        expect(mergeEditions([one])).toBe(one);
    });
});
