import { describe, expect, it } from "vitest";
import { initTheoremCoreWasm, wasmOpdsParse } from "../src/core/lib/theorem-core";
import { DEFAULT_OPDS_PRESETS } from "../src/core/services/OpdsService";
import { useOpdsStore } from "../src/core/store/opdsStore";
import type { OpdsOutcome } from "../src/core/types";

const sampleAtomXml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:dc="http://purl.org/dc/terms/"
      xmlns:opds="http://opds-spec.org/2010/catalog">
  <id>https://example.com/opds</id>
  <title>Sample Catalog</title>
  <subtitle>A test catalog</subtitle>
  <updated>2026-08-29T10:00:00Z</updated>
  <link rel="self" href="https://example.com/opds" type="application/atom+xml;profile=opds-catalog"/>
  <link rel="next" href="https://example.com/opds?page=2" type="application/atom+xml;profile=opds-catalog"/>
  <link rel="search" href="https://example.com/search?q={searchTerms}" type="application/atom+xml"/>

  <!-- Navigation Entry -->
  <entry>
    <id>urn:catalog:fiction</id>
    <title>Fiction Books</title>
    <summary>Explore fiction collection</summary>
    <link rel="subsection" href="/opds/fiction" type="application/atom+xml;profile=opds-catalog"/>
  </entry>

  <!-- Acquisition Entry (Book) -->
  <entry>
    <id>urn:book:12345</id>
    <title>Pride and Prejudice</title>
    <author>
      <name>Jane Austen</name>
    </author>
    <summary>A classic romantic novel.</summary>
    <dc:language>en</dc:language>
    <dc:publisher>Standard Ebooks</dc:publisher>
    <dc:issued>1813-01-28</dc:issued>
    <link rel="http://opds-spec.org/image" href="/covers/pride.jpg" type="image/jpeg"/>
    <link rel="http://opds-spec.org/image/thumbnail" href="/covers/pride-thumb.jpg" type="image/jpeg"/>
    <link rel="http://opds-spec.org/acquisition" href="/downloads/pride.epub" type="application/epub+zip"/>
  </entry>
</feed>`;

describe("OPDS parsing (the Rust parser, via WebAssembly as the web build runs it)", () => {
    it("parses OPDS 1.2 feed metadata, navigation entries, and acquisition books", async () => {
        await initTheoremCoreWasm();
        const outcome = wasmOpdsParse(new TextEncoder().encode(sampleAtomXml), "application/atom+xml", "https://example.com/opds") as OpdsOutcome;
        if (outcome.type !== "feed") throw new Error(`expected a feed, got ${outcome.type}`);
        const feed = outcome.feed;

        expect(feed.title).toBe("Sample Catalog");
        expect(feed.subtitle).toBe("A test catalog");
        expect(feed.nextUrl).toBe("https://example.com/opds?page=2");
        expect(feed.search).toEqual({ href: "https://example.com/search?q={searchTerms}", kind: "template" });
        expect(feed.kind).toBe("mixed");

        // Navigation entry: its own list, not a pseudo-book.
        expect(feed.navigation).toHaveLength(1);
        expect(feed.navigation[0].title).toBe("Fiction Books");
        expect(feed.navigation[0].href).toBe("https://example.com/opds/fiction");
        expect(feed.navigation[0].summary).toBe("Explore fiction collection");

        // Acquisition entry
        expect(feed.entries).toHaveLength(1);
        const book = feed.entries[0];
        expect(book.title).toBe("Pride and Prejudice");
        expect(book.authors).toEqual(["Jane Austen"]);
        expect(book.language).toBe("en");
        expect(book.publisher).toBe("Standard Ebooks");
        expect(book.cover).toBe("https://example.com/covers/pride.jpg");
        expect(book.thumbnail).toBe("https://example.com/covers/pride-thumb.jpg");
        expect(book.acquisitions[0].href).toBe("https://example.com/downloads/pride.epub");
        expect(book.acquisitions[0].format).toBe("epub");
        expect(book.primary).toBe(0);
    });
});

describe("opdsStore", () => {
    const reset = () => useOpdsStore.setState({ catalogs: DEFAULT_OPDS_PRESETS, activeCatalogId: null });

    it("adds a custom catalog, makes it the active source, and removes it again", () => {
        reset();
        const store = useOpdsStore.getState();
        const id = store.addCatalog({ title: "Custom Calibre", url: "192.168.1.50:8080/opds" });

        const added = useOpdsStore.getState().catalogs.find((c) => c.id === id);
        expect(added?.url).toBe("http://192.168.1.50:8080/opds");
        expect(useOpdsStore.getState().activeCatalogId).toBe(id);

        store.removeCatalog(id);
        expect(useOpdsStore.getState().catalogs.some((c) => c.id === id)).toBe(false);
        // Removing the catalog you were browsing returns you to Discover rather than a dead source.
        expect(useOpdsStore.getState().activeCatalogId).toBeNull();
    });

    it("never removes the built-in sources", () => {
        reset();
        useOpdsStore.getState().removeCatalog("project-gutenberg");
        expect(useOpdsStore.getState().catalogs.map((c) => c.id)).toContain("project-gutenberg");
    });

    it("ignores an attempt to open a source that does not exist", () => {
        reset();
        useOpdsStore.getState().setActiveCatalog("nope");
        expect(useOpdsStore.getState().activeCatalogId).toBeNull();
    });

    it("keeps sign-in details on the catalog and forgets them on request", () => {
        reset();
        const id = useOpdsStore.getState().addCatalog({ title: "Private", url: "https://lib.example/opds" });
        useOpdsStore.getState().setCredentials(id, { username: "reader", password: "pw" });
        expect(useOpdsStore.getState().catalogs.find((c) => c.id === id)?.auth).toEqual({ username: "reader", password: "pw" });
        useOpdsStore.getState().setCredentials(id, undefined);
        expect(useOpdsStore.getState().catalogs.find((c) => c.id === id)?.auth).toBeUndefined();
    });

    it("updating the address normalises it", () => {
        reset();
        const id = useOpdsStore.getState().addCatalog({ title: "x", url: "https://a.example/opds" });
        useOpdsStore.getState().updateCatalog(id, { url: "nas.local/opds" });
        expect(useOpdsStore.getState().catalogs.find((c) => c.id === id)?.url).toBe("http://nas.local/opds");
    });

    it("migrates the old store: user catalogs are kept (they were never browsable), presets are restored, start on Discover", async () => {
        const persist = (useOpdsStore as unknown as { persist: { getOptions: () => { migrate: (s: unknown, v: number) => unknown } } }).persist;
        const migrated = persist.getOptions().migrate(
            {
                catalogs: [
                    { id: "project-gutenberg", title: "Old name", url: "https://m.gutenberg.org/ebooks.opds/", isPreset: true },
                    { id: "catalog-1", title: "My Komga", url: "http://nas:25600/opds/v1.2/catalog" },
                ],
                activeCatalogId: "project-gutenberg",
            },
            1,
        ) as { catalogs: { id: string; title: string; url: string }[]; activeCatalogId: string | null };
        expect(migrated.activeCatalogId).toBeNull();
        expect(migrated.catalogs.map((c) => c.id)).toEqual(["project-gutenberg", "standard-ebooks", "catalog-1"]);
        expect(migrated.catalogs[0].url).toBe("https://www.gutenberg.org/ebooks.opds/");
        expect(migrated.catalogs[2].title).toBe("My Komga");
    });

    it("migrating tolerates garbage", () => {
        const persist = (useOpdsStore as unknown as { persist: { getOptions: () => { migrate: (s: unknown, v: number) => unknown } } }).persist;
        const migrated = persist.getOptions().migrate(null, 0) as { catalogs: unknown[] };
        expect(migrated.catalogs).toHaveLength(2);
        const again = persist.getOptions().migrate({ catalogs: "oops" }, 2) as { catalogs: unknown[] };
        expect(again.catalogs).toHaveLength(2);
    });
});
