import { afterEach, describe, expect, it, vi } from "vitest";
import { onRequestGet } from "../functions/api/gutenberg";
import { browserCatalogUrl } from "../src/core/lib/catalog-fetch-url";

const requestFor = (url: string) => new Request(`https://app.theorem.fundaments.work/api/gutenberg?url=${encodeURIComponent(url)}`);

afterEach(() => vi.unstubAllGlobals());

describe("Gutenberg browser proxy", () => {
    it("routes Gutenberg requests through the app while leaving other catalogs alone", () => {
        expect(browserCatalogUrl("https://www.gutenberg.org/ebooks/1342.epub.noimages"))
            .toBe("/api/gutenberg?url=https%3A%2F%2Fwww.gutenberg.org%2Febooks%2F1342.epub.noimages");
        expect(browserCatalogUrl("https://standardebooks.org/feeds/atom/new-releases"))
            .toBe("https://standardebooks.org/feeds/atom/new-releases");
    });

    it("follows Gutenberg redirects and streams the EPUB", async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(new Response(null, {
                status: 302,
                headers: { location: "/cache/epub/1342/pg1342.epub" },
            }))
            .mockResolvedValueOnce(new Response(new Uint8Array([80, 75, 3, 4]), {
                headers: { "content-type": "application/epub+zip" },
            }));
        vi.stubGlobal("fetch", fetchMock);

        const response = await onRequestGet({ request: requestFor("https://www.gutenberg.org/ebooks/1342.epub.noimages") });
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe("application/epub+zip");
        expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual([80, 75, 3, 4]);
        expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
            "https://www.gutenberg.org/ebooks/1342.epub.noimages",
            "https://www.gutenberg.org/cache/epub/1342/pg1342.epub",
        ]);
    });

    it("rejects external URLs and redirects before fetching them", async () => {
        const fetchMock = vi.fn().mockResolvedValue(new Response(null, {
            status: 302,
            headers: { location: "https://example.com/private" },
        }));
        vi.stubGlobal("fetch", fetchMock);

        expect((await onRequestGet({ request: requestFor("https://example.com/private") })).status).toBe(400);
        expect((await onRequestGet({ request: requestFor("http://www.gutenberg.org/ebooks/1342") })).status).toBe(400);
        expect(fetchMock).toHaveBeenCalledTimes(0);

        expect((await onRequestGet({ request: requestFor("https://www.gutenberg.org/ebooks/1342") })).status).toBe(400);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
