import { describe, expect, it } from "vitest";
import { DiscoverService } from "../src/core/services/DiscoverService";
import { initTheoremCoreWasm, wasmOpdsParse } from "../src/core/lib/theorem-core";
import { applyCatalogQuirks } from "../src/core/services/opds-quirks";
import type { OpdsOutcome } from "../src/core/types";

const SAMPLE_GUTENBERG_SEARCH = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog">
<id>http://www.gutenberg.org/ebooks/search.opds/?query=pride</id>
<title>Books: pride</title>
<entry>
<id>https://www.gutenberg.org/ebooks/authors/search.opds/?query=pride</id>
<title>Authors</title>
<link type="application/atom+xml;profile=opds-catalog" rel="subsection" href="/ebooks/authors/search.opds/?query=pride"/>
</entry>
<entry>
<id>https://www.gutenberg.org/ebooks/subjects/search.opds/?query=pride</id>
<title>Subjects</title>
<link type="application/atom+xml;profile=opds-catalog" rel="subsection" href="/ebooks/subjects/search.opds/?query=pride"/>
</entry>
<entry>
<id>https://www.gutenberg.org/ebooks/1342.opds</id>
<title>Pride and Prejudice</title>
<content type="text">Jane Austen</content>
<link type="application/atom+xml;profile=opds-catalog" rel="subsection" href="/ebooks/1342.opds"/>
</entry>
<entry>
<id>https://www.gutenberg.org/ebooks/2701.opds</id>
<title>Moby Dick; Or, The Whale by Herman Melville</title>
<content type="text">Herman Melville</content>
<link type="application/atom+xml;profile=opds-catalog" rel="subsection" href="/ebooks/2701.opds"/>
</entry>
</feed>`;

describe("DiscoverService", () => {
    it("should export DiscoverService with core methods", () => {
        expect(typeof DiscoverService.loadCuratedSections).toBe("function");
        expect(typeof DiscoverService.search).toBe("function");
        expect(typeof DiscoverService.downloadBook).toBe("function");
    });

    it("parses Gutenberg search XML into category rows and real, openable books", async () => {
        await initTheoremCoreWasm();
        const url = "https://www.gutenberg.org/ebooks/search.opds/?query=pride";
        const outcome = wasmOpdsParse(new TextEncoder().encode(SAMPLE_GUTENBERG_SEARCH), "application/atom+xml", url) as OpdsOutcome;
        if (outcome.type !== "feed") throw new Error("expected a feed");

        // Straight from the parser, Gutenberg's book rows look exactly like category rows...
        expect(outcome.feed.navigation).toHaveLength(4);

        // ...and the Gutenberg adapter separates them, which is what Discover relies on.
        const feed = applyCatalogQuirks(outcome.feed, url);
        expect(feed.navigation.map((n) => n.title)).toEqual(["Authors", "Subjects"]);
        expect(feed.entries.map((e) => e.title)).toEqual(["Pride and Prejudice", "Moby Dick; Or, The Whale"]);
        expect(feed.entries[0].authors).toEqual(["Jane Austen"]);
        expect(feed.entries[1].authors).toEqual(["Herman Melville"]);
        expect(feed.entries.every((e) => e.detailHref && e.cover?.includes("/cache/epub/"))).toBe(true);
    });
});

describe("Discover's cached sections", () => {
    const KEY = "theorem_discover_cache_v3";
    const good = {
        id: "s1", title: "Section",
        books: [{ id: "b1", title: "A Book", authors: ["Someone"], acquisitions: [] }],
    };

    async function freshService() {
        const { vi } = await import("vitest");
        vi.resetModules();
        return (await import("../src/core/services/DiscoverService")).DiscoverService;
    }

    it("ignores and removes a cache written by the pre-rewrite app instead of crashing the page on it", async () => {
        // Entries of the old shape: `author` string, no `authors`/`acquisitions` arrays.
        localStorage.setItem(
            "theorem_discover_cache_v2",
            JSON.stringify([{ id: "essentials", title: "Timeless Essentials", books: [{ id: "x", title: "Dracula", author: "Bram Stoker", downloadUrl: "https://x/y.epub" }] }]),
        );
        const service = await freshService();
        expect(service.getCachedSections()).toEqual([]);
        expect(localStorage.getItem("theorem_discover_cache_v2")).toBeNull();
    });

    it("never reads an old-shape entry even if it sits under the current key", async () => {
        localStorage.setItem(KEY, JSON.stringify([{ id: "s", title: "S", books: [{ id: "x", title: "Old", author: "A" }] }]));
        const service = await freshService();
        expect(service.getCachedSections()).toEqual([]);
        expect(localStorage.getItem(KEY)).toBeNull();
    });

    it("drops the whole cache when any one section is unusable rather than rendering a half-broken storefront", async () => {
        localStorage.setItem(KEY, JSON.stringify([good, { id: "bad", title: "Bad", books: [{ id: "x" }] }]));
        const service = await freshService();
        expect(service.getCachedSections()).toEqual([]);
    });

    it("keeps a valid cache and survives corrupt JSON", async () => {
        localStorage.setItem(KEY, JSON.stringify([good]));
        let service = await freshService();
        expect(service.getCachedSections()).toEqual([good]);
        localStorage.setItem(KEY, "{not json");
        service = await freshService();
        expect(service.getCachedSections()).toEqual([]);
        localStorage.removeItem(KEY);
    });
});
