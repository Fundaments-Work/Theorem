import { describe, expect, it } from "vitest";
import { normalizeCatalogUrl } from "../src/core/services/OpdsService";

describe("normalizeCatalogUrl", () => {
    it("keeps real URLs untouched", () => {
        expect(normalizeCatalogUrl("https://standardebooks.org/feeds/opds")).toBe("https://standardebooks.org/feeds/opds");
        expect(normalizeCatalogUrl("http://192.168.1.10:8080/opds")).toBe("http://192.168.1.10:8080/opds");
    });

    it("defaults public hosts to https and personal servers to http", () => {
        expect(normalizeCatalogUrl("books.example.org/opds")).toBe("https://books.example.org/opds");
        expect(normalizeCatalogUrl("192.168.1.10:8080/opds")).toBe("http://192.168.1.10:8080/opds");
        expect(normalizeCatalogUrl("localhost:8083/opds")).toBe("http://localhost:8083/opds");
        expect(normalizeCatalogUrl("nas.local/opds")).toBe("http://nas.local/opds");
        expect(normalizeCatalogUrl("raspberrypi:5000")).toBe("http://raspberrypi:5000");
    });

    it("accepts the opds:// links reading apps share", () => {
        expect(normalizeCatalogUrl("opds://books.example.org/opds")).toBe("https://books.example.org/opds");
        expect(normalizeCatalogUrl("opds+http://192.168.1.2/opds")).toBe("http://192.168.1.2/opds");
    });

    it("strips whitespace and newlines from pasted text", () => {
        expect(normalizeCatalogUrl("  https://x.org/opds \n")).toBe("https://x.org/opds");
        expect(normalizeCatalogUrl("https://x.org/ opds")).toBe("https://x.org/opds");
    });

    it("leaves empty input alone", () => {
        expect(normalizeCatalogUrl("")).toBe("");
        expect(normalizeCatalogUrl("   ")).toBe("");
    });
});

// ── web path: fetch + the real Rust parser (WebAssembly), with real catalog documents ─────────

import { afterEach, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { OpdsError, OpdsService, clearOpdsCache, describeOpdsError } from "../src/core/services/OpdsService";

const fixture = (name: string) => readFileSync(resolvePath("src-tauri/crates/theorem-core/tests/fixtures/opds", name));

type Route = { status?: number; type?: string; body?: Uint8Array | string; headers?: Record<string, string>; throws?: boolean };
let routes: Record<string, Route> = {};
let requests: { url: string; headers: Record<string, string> }[] = [];

function installFetch() {
    vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            let url = String(input);
            // The web build proxies Gutenberg through the app; undo that to find the route.
            const proxied = /\/api\/gutenberg\?url=(.+)$/.exec(url);
            if (proxied) url = decodeURIComponent(proxied[1]);
            requests.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
            const route = routes[url];
            if (!route || route.throws) throw new TypeError("Failed to fetch");
            const body = typeof route.body === "string" ? new TextEncoder().encode(route.body) : route.body ?? new Uint8Array();
            return new Response(body as BodyInit, {
                status: route.status ?? 200,
                headers: { "content-type": route.type ?? "application/atom+xml", ...route.headers },
            });
        }),
    );
}

describe("OpdsService in the browser (WebAssembly parser)", () => {
    beforeEach(() => {
        routes = {};
        requests = [];
        clearOpdsCache();
        installFetch();
    });
    afterEach(() => vi.unstubAllGlobals());

    it("loads Project Gutenberg's root and applies the Gutenberg adapter to search results", async () => {
        routes["https://www.gutenberg.org/ebooks.opds/"] = { body: fixture("gutenberg-root.atom") };
        const root = await OpdsService.load("https://www.gutenberg.org/ebooks.opds/");
        expect(root.feed.kind).toBe("navigation");
        expect(root.feed.navigation.map((n) => n.title)).toContain("Popular");
        expect(root.feed.search?.kind).toBe("description");

        routes["https://www.gutenberg.org/ebooks/search.opds/?query=dracula"] = { body: fixture("gutenberg-search.atom") };
        const results = await OpdsService.load("https://www.gutenberg.org/ebooks/search.opds/?query=dracula");
        const dracula = results.feed.entries.find((e) => e.title === "Dracula");
        expect(dracula?.detailHref).toBe("https://www.gutenberg.org/ebooks/345.opds");
        expect(dracula?.cover).toContain("/cache/epub/345/");
        // The "Subjects" category row stays navigation.
        expect(results.feed.navigation.some((n) => n.title === "Subjects")).toBe(true);
    });

    it("resolves an OpenSearch description, expands the query and loads the results", async () => {
        routes["https://www.gutenberg.org/catalog/osd-books.xml"] = { type: "application/xml", body: fixture("gutenberg-opensearch.xml") };
        routes["http://m.gutenberg.org/ebooks/search.opds/?query=bram%20stoker"] = { body: fixture("gutenberg-search.atom") };
        const { feed } = await OpdsService.search({ href: "https://www.gutenberg.org/catalog/osd-books.xml", kind: "description" }, "bram stoker");
        expect(feed.entries.length + feed.navigation.length).toBeGreaterThan(0);
        expect(requests.map((r) => r.url)).toContain("http://m.gutenberg.org/ebooks/search.opds/?query=bram%20stoker");
    });

    it("loads an OPDS 2.0 catalog and keeps its sample, buy and borrow entries out of one-tap downloads", async () => {
        routes["https://test.opds.io/2.0/publications.json"] = { type: "application/opds+json", body: fixture("opds2-publications.json") };
        const { feed } = await OpdsService.load("https://test.opds.io/2.0/publications.json");
        expect(feed.dialect).toBe("opds2");
        expect(feed.entries.filter((e) => e.primary !== undefined)).toHaveLength(10);
        for (const title of ["Buy", "Borrow", "Subscribe", "Sample"]) {
            expect(feed.entries.find((e) => e.title === title)?.primary).toBeUndefined();
        }
    });

    it("sends HTTP Basic credentials only when given, and reports the challenge otherwise", async () => {
        routes["https://lib.example/opds"] = { status: 401, headers: { "www-authenticate": 'Basic realm="Home Library"' }, body: "" };
        await expect(OpdsService.load("https://lib.example/opds")).rejects.toMatchObject({ kind: "authRequired", realm: "Home Library" });
        expect(requests[0].headers.Authorization).toBeUndefined();

        routes["https://lib.example/opds"] = {
            body: '<feed xmlns="http://www.w3.org/2005/Atom"><id>i</id><title>Home</title></feed>',
        };
        const loaded = await OpdsService.load("https://lib.example/opds", { auth: { username: "reader", password: "s3cret" }, force: true });
        expect(loaded.feed.title).toBe("Home");
        // base64("reader:s3cret")
        expect(requests[requests.length - 1].headers.Authorization).toBe("Basic cmVhZGVyOnMzY3JldA==");
    });

    it("encodes non-Latin credentials as UTF-8 instead of throwing", async () => {
        routes["https://lib.example/opds"] = { body: '<feed xmlns="http://www.w3.org/2005/Atom"><id>i</id><title>x</title></feed>' };
        await OpdsService.load("https://lib.example/opds", { auth: { username: "léa", password: "пароль" } });
        const header = requests[0].headers.Authorization;
        expect(header.startsWith("Basic ")).toBe(true);
        const decoded = new TextDecoder().decode(Uint8Array.from(atob(header.slice(6)), (c) => c.charCodeAt(0)));
        expect(decoded).toBe("léa:пароль");
    });

    it("follows an HTML page's advertised OPDS link", async () => {
        routes["https://books.example/"] = {
            type: "text/html",
            body: '<html><head><link rel="alternate" type="application/atom+xml;profile=opds-catalog" href="/opds"></head></html>',
        };
        routes["https://books.example/opds"] = { body: '<feed xmlns="http://www.w3.org/2005/Atom"><id>i</id><title>Found</title></feed>' };
        const { feed, finalUrl } = await OpdsService.load("https://books.example/");
        expect(feed.title).toBe("Found");
        expect(finalUrl).toBe("https://books.example/opds");
    });

    it("maps failures to typed errors with plain messages", async () => {
        routes["https://x.test/404"] = { status: 404 };
        routes["https://x.test/403"] = { status: 403 };
        routes["https://x.test/500"] = { status: 500 };
        routes["https://x.test/429"] = { status: 429, headers: { "retry-after": "9" } };
        routes["https://x.test/html"] = { type: "text/html", body: "<html><body>hi</body></html>" };
        routes["https://x.test/junk"] = { type: "text/plain", body: "not a catalog" };
        await expect(OpdsService.load("https://x.test/404")).rejects.toMatchObject({ kind: "notFound" });
        await expect(OpdsService.load("https://x.test/403")).rejects.toMatchObject({ kind: "forbidden" });
        await expect(OpdsService.load("https://x.test/500")).rejects.toMatchObject({ kind: "http", status: 500 });
        await expect(OpdsService.load("https://x.test/429")).rejects.toMatchObject({ kind: "rateLimited", retryAfter: 9 });
        await expect(OpdsService.load("https://x.test/html")).rejects.toMatchObject({ kind: "unsupported" });
        await expect(OpdsService.load("https://x.test/junk")).rejects.toMatchObject({ kind: "unsupported" });
        // A cross-origin block and an unreachable host both surface as a thrown TypeError from fetch.
        const blocked = await OpdsService.load("https://nowhere.test/opds").catch((e) => e);
        expect(blocked).toBeInstanceOf(OpdsError);
        expect(blocked.kind).toBe("cors");
        expect(describeOpdsError(blocked)).toMatch(/desktop or mobile app/);
    });

    it("rejects non-http addresses before any request is made", async () => {
        await expect(OpdsService.load("ftp://example.org/x")).rejects.toMatchObject({ kind: "invalidUrl" });
        expect(requests).toHaveLength(0);
    });

    it("caches a loaded feed briefly, and `force` bypasses the cache", async () => {
        routes["https://c.test/opds"] = { body: '<feed xmlns="http://www.w3.org/2005/Atom"><id>i</id><title>One</title></feed>' };
        await OpdsService.load("https://c.test/opds");
        await OpdsService.load("https://c.test/opds");
        expect(requests).toHaveLength(1);
        await OpdsService.load("https://c.test/opds", { force: true });
        expect(requests).toHaveLength(2);
    });

    it("does not cache an authentication challenge", async () => {
        routes["https://c.test/private"] = { status: 401 };
        await OpdsService.load("https://c.test/private").catch(() => undefined);
        await OpdsService.load("https://c.test/private").catch(() => undefined);
        expect(requests).toHaveLength(2);
    });

    it("loads the full entry behind a partial one and merges its editions", async () => {
        routes["https://www.gutenberg.org/ebooks/345.opds"] = { body: fixture("gutenberg-book.atom") };
        const partial = {
            id: "urn:gutenberg:345", title: "Dracula", authors: ["Bram Stoker"], acquisitions: [],
            detailHref: "https://www.gutenberg.org/ebooks/345.opds",
        };
        const full = await OpdsService.loadDetail(partial);
        // Both editions' files, once each: epub3/epub/kf8/kindle with images, epub/kindle without.
        expect(full.acquisitions.length).toBe(6);
        expect(full.acquisitions[full.primary!].href).toBe("https://www.gutenberg.org/ebooks/345.epub3.images");
        expect(full.summary).toContain("Gothic horror");
        expect(full.detailHref).toBeUndefined();
    });
});

describe("offline copy of the built-in catalog", () => {
    const HOME = "https://catalog.fundaments.work/opds/index.json";
    let storage: Map<string, string>;
    beforeEach(() => {
        routes = {};
        requests = [];
        clearOpdsCache();
        installFetch();
        storage = new Map();
        vi.stubGlobal("localStorage", {
            getItem: (k: string) => storage.get(k) ?? null,
            setItem: (k: string, v: string) => void storage.set(k, v),
            removeItem: (k: string) => void storage.delete(k),
        });
    });
    afterEach(() => vi.unstubAllGlobals());

    it("shows the last good home feed when the server cannot be reached", async () => {
        routes[HOME] = { type: "application/opds+json", body: fixture("opds2-home.json") };
        const online = await OpdsService.load(HOME);
        routes[HOME] = { throws: true };
        const offline = await OpdsService.load(HOME, { force: true });
        expect(offline.feed.title).toBe(online.feed.title);
        expect(offline.feed.groups.length).toBe(online.feed.groups.length);
    });

    it("also covers server errors, but still reports them when there is no copy", async () => {
        routes[HOME] = { status: 503, body: "down" };
        await expect(OpdsService.load(HOME, { force: true })).rejects.toBeInstanceOf(OpdsError);
        routes[HOME] = { type: "application/opds+json", body: fixture("opds2-home.json") };
        await OpdsService.load(HOME, { force: true });
        routes[HOME] = { status: 503, body: "down" };
        expect((await OpdsService.load(HOME, { force: true })).feed.groups.length).toBeGreaterThan(0);
    });

    it("never stores a catalog the user added (it may be private)", async () => {
        const mine = "https://my.library.example/opds";
        routes[mine] = { type: "application/opds+json", body: fixture("opds2-home.json") };
        await OpdsService.load(mine);
        expect([...storage.keys()].some((k) => k.includes("my.library"))).toBe(false);
        routes[mine] = { throws: true };
        await expect(OpdsService.load(mine, { force: true })).rejects.toBeInstanceOf(OpdsError);
    });

    it("ignores a corrupted copy instead of showing it", async () => {
        storage.set(`theorem-opds-offline:${HOME}`, "{not json");
        routes[HOME] = { throws: true };
        await expect(OpdsService.load(HOME, { force: true })).rejects.toBeInstanceOf(OpdsError);
        storage.set(`theorem-opds-offline:${HOME}`, JSON.stringify({ outcome: { type: "authentication" }, finalUrl: HOME }));
        await expect(OpdsService.load(HOME, { force: true })).rejects.toBeInstanceOf(OpdsError);
    });

    it("works without any storage at all", async () => {
        vi.stubGlobal("localStorage", undefined);
        routes[HOME] = { type: "application/opds+json", body: fixture("opds2-home.json") };
        await expect(OpdsService.load(HOME)).resolves.toBeTruthy();
        routes[HOME] = { throws: true };
        await expect(OpdsService.load(HOME, { force: true })).rejects.toBeInstanceOf(OpdsError);
    });
});

describe("downloading in the browser", () => {
    beforeEach(() => {
        routes = {};
        requests = [];
        installFetch();
    });
    afterEach(() => vi.unstubAllGlobals());

    it("recognises a web page by type and by content", async () => {
        const { looksLikeHtml } = await import("../src/core/services/OpdsService");
        expect(await looksLikeHtml(new Blob(["<p>hi</p>"], { type: "text/html" }))).toBe(true);
        expect(await looksLikeHtml(new Blob(["  <!DOCTYPE html><html>"], { type: "application/octet-stream" }))).toBe(true);
        expect(await looksLikeHtml(new Blob(["<?xml version='1.0'?><html xmlns='x'>"], { type: "application/xml" }))).toBe(true);
        expect(await looksLikeHtml(new Blob([new Uint8Array([0x50, 0x4b, 3, 4])], { type: "application/epub+zip" }))).toBe(false);
        expect(await looksLikeHtml(new Blob(["%PDF-1.7"], { type: "application/pdf" }))).toBe(false);
        expect(await looksLikeHtml(new Blob([], { type: "" }))).toBe(false);
    });

    it("refuses a login page that answers where a book should be, and imports nothing", async () => {
        routes["https://x.test/dl/book.epub"] = { type: "text/html", body: "<html><body>Please log in</body></html>" };
        const err = await OpdsService.download({ href: "https://x.test/dl/book.epub", kind: "openAccess", mime: "application/epub+zip", format: "epub", drm: false, downloadable: true }).catch((e) => e);
        expect(err).toBeInstanceOf(OpdsError);
        expect(err.kind).toBe("unsupported");
        expect(err.message).toMatch(/web page instead of a book/);
    });

    it("maps a sign-in challenge on a download to an auth error", async () => {
        routes["https://x.test/dl/private.epub"] = { status: 401, headers: { "www-authenticate": 'Basic realm="Shelf"' } };
        await expect(
            OpdsService.download({ href: "https://x.test/dl/private.epub", kind: "generic", mime: "application/epub+zip", format: "epub", drm: false, downloadable: true }),
        ).rejects.toMatchObject({ kind: "authRequired", realm: "Shelf" });
    });
});
