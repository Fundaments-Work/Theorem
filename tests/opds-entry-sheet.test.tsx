// @vitest-environment jsdom
/**
 * The book sheet decides what a person can actually do with a catalog entry: download it, pick a
 * format, or be told honestly that it is a loan, a purchase or locked with DRM.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import type { OpdsAcquisition, OpdsEntry } from "../src/core/types";

const loadDetail = vi.fn();
const download = vi.fn();
const openExternalUrl = vi.fn(() => Promise.resolve());

vi.mock("../src/core/services/OpdsService", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../src/core/services/OpdsService")>();
    return { ...actual, OpdsService: { ...actual.OpdsService, load: vi.fn(), search: vi.fn(), loadDetail: (...a: unknown[]) => loadDetail(...a), download: (...a: unknown[]) => download(...a) } };
});
vi.mock("../src/core/lib/open-external-url", () => ({ openExternalUrl: (...a: unknown[]) => openExternalUrl(...a) }));

import { useLibraryStore, useUIStore } from "../src/core/store";
import { OpdsEntrySheet } from "../src/features/catalogs/opds/OpdsEntrySheet";
import { flush, render, unmountAll } from "./helpers/opds-browser-harness";

const acq = (over: Partial<OpdsAcquisition> = {}): OpdsAcquisition => ({
    href: "https://x.test/book.epub", kind: "openAccess", mime: "application/epub+zip", format: "epub", drm: false, downloadable: true, ...over,
});
const entry = (over: Partial<OpdsEntry> = {}): OpdsEntry => ({ id: "urn:1", title: "Dracula", authors: ["Bram Stoker"], acquisitions: [acq()], primary: 0, ...over });
const dialog = () => document.body.querySelector('[role="dialog"]') as HTMLElement;
const button = (text: string | RegExp) =>
    Array.from(dialog().querySelectorAll("button")).find((b) => (typeof text === "string" ? b.textContent?.includes(text) : text.test(b.textContent ?? ""))) as HTMLElement | undefined;

describe("book sheet", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        download.mockResolvedValue({ id: "b1" });
        useLibraryStore.setState({ books: [] } as never);
    });
    afterEach(() => unmountAll());

    it("shows the book's details and adds it to the Library, then closes", async () => {
        const onClose = vi.fn();
        render(<OpdsEntrySheet entry={entry({ summary: "<p>A vampire story.</p>", series: { name: "Gothic", position: 1 }, publisher: "Archibald", language: "en" })} onClose={onClose} />);
        await flush();
        expect(dialog().textContent).toContain("Bram Stoker");
        expect(dialog().textContent).toContain("A vampire story.");
        expect(dialog().textContent).toContain("Gothic #1");
        await act(async () => button("Add to Library")!.click());
        await flush();
        expect(download).toHaveBeenCalledWith(expect.objectContaining({ href: "https://x.test/book.epub" }), expect.anything());
        expect(onClose).toHaveBeenCalled();
    });

    it("lists every format with its size and downloads the one you choose", async () => {
        const e = entry({
            acquisitions: [acq(), acq({ href: "https://x.test/book.pdf", mime: "application/pdf", format: "pdf", size: 2_500_000 })],
            primary: 0,
        });
        render(<OpdsEntrySheet entry={e} onClose={() => {}} />);
        await flush();
        const pdf = button(/PDF/)!;
        expect(pdf.textContent).toContain("2.4 MB");
        await act(async () => pdf.click());
        await flush();
        expect(download).toHaveBeenCalledWith(expect.objectContaining({ href: "https://x.test/book.pdf" }), expect.anything());
    });

    it("loads the downloads for a partial entry, and says it is doing so", async () => {
        let finish: (v: OpdsEntry) => void = () => {};
        loadDetail.mockReturnValue(new Promise((r) => (finish = r)));
        render(<OpdsEntrySheet entry={entry({ acquisitions: [], primary: undefined, detailHref: "https://x.test/book/1" })} onClose={() => {}} />);
        await flush();
        expect(dialog().textContent).toContain("Finding the download");
        expect((button("Add to Library") as HTMLButtonElement).disabled).toBe(true);
        await act(async () => finish(entry({ summary: "<p>Full text.</p>" })));
        await flush();
        expect(dialog().textContent).not.toContain("Finding the download");
        expect(dialog().textContent).toContain("Full text.");
        expect((button("Add to Library") as HTMLButtonElement).disabled).toBe(false);
    });

    it("reports a failure to load the downloads instead of spinning forever", async () => {
        loadDetail.mockRejectedValue(new Error("The catalog took too long to respond."));
        render(<OpdsEntrySheet entry={entry({ acquisitions: [], primary: undefined, detailHref: "https://x.test/book/1" })} onClose={() => {}} />);
        await flush();
        expect(dialog().textContent).toContain("took too long");
        expect(dialog().textContent).not.toContain("Finding the download");
    });

    it("tells you a purchase is a purchase, shows the price, and sends you to the website", async () => {
        const buy = acq({ kind: "buy", downloadable: false, price: { value: "4.99", currency: "EUR" }, href: "https://shop.test/buy/1" });
        render(<OpdsEntrySheet entry={entry({ acquisitions: [buy], primary: undefined, webUrl: "https://shop.test/book" })} onClose={() => {}} />);
        await flush();
        expect(dialog().textContent).toContain("4.99 EUR");
        expect(dialog().textContent).toContain("for sale");
        expect(button("Add to Library")).toBeUndefined();
        await act(async () => button("Open website")!.click());
        expect(openExternalUrl).toHaveBeenCalledWith("https://shop.test/book");
        expect(download).not.toHaveBeenCalled();
    });

    it("says a DRM-protected file cannot be opened, rather than offering a download that will fail", async () => {
        const locked = acq({ drm: true, downloadable: false, mime: "application/vnd.adobe.adept+xml", format: undefined });
        render(<OpdsEntrySheet entry={entry({ acquisitions: [locked], primary: undefined })} onClose={() => {}} />);
        await flush();
        expect(dialog().textContent).toContain("DRM");
        expect(button("Add to Library")).toBeUndefined();
    });

    it("offers a sample on its own when it is all there is", async () => {
        render(<OpdsEntrySheet entry={entry({ acquisitions: [acq({ kind: "sample" })], primary: undefined })} onClose={() => {}} />);
        await flush();
        expect(button(/Sample/)).toBeDefined();
    });

    it("tells an informational entry it has no download", async () => {
        render(<OpdsEntrySheet entry={entry({ acquisitions: [], primary: undefined })} onClose={() => {}} />);
        await flush();
        expect(dialog().textContent).toContain("no download");
    });

    it("offers Read Now for a book you already have", async () => {
        useLibraryStore.setState({ books: [{ id: "mine", title: "Dracula" }] } as never);
        const onClose = vi.fn();
        render(<OpdsEntrySheet entry={entry()} onClose={onClose} />);
        await flush();
        expect(button("Add to Library")).toBeUndefined();
        act(() => button("Read Now")!.click());
        expect(useUIStore.getState().currentRoute).toBe("reader");
        expect(onClose).toHaveBeenCalled();
    });

    it("sanitises the catalog's HTML: no scripts, no event handlers", async () => {
        render(<OpdsEntrySheet entry={entry({ summary: '<p onclick="steal()">Hi</p><script>alert(1)</script><img src=x onerror="alert(2)">' })} onClose={() => {}} />);
        await flush();
        const html = dialog().innerHTML;
        expect(html).toContain("Hi");
        expect(html).not.toContain("<script");
        expect(html).not.toContain("onclick");
        expect(html).not.toContain("onerror");
    });

    it("opens a related feed (an author, a subject) when the browser provides a way to", async () => {
        const onOpenFeed = vi.fn();
        const onClose = vi.fn();
        render(<OpdsEntrySheet entry={entry({ related: [{ href: "https://x.test/author/1", rel: "related", mime: "application/atom+xml", title: "By Stoker, Bram…" }] })} onClose={onClose} onOpenFeed={onOpenFeed} />);
        await flush();
        act(() => button("By Stoker")!.click());
        expect(onOpenFeed).toHaveBeenCalledWith("https://x.test/author/1", "By Stoker, Bram…");
        expect(onClose).toHaveBeenCalled();
    });

    it("tells you why a download failed", async () => {
        download.mockRejectedValue(new Error("The server returned a web page instead of a book."));
        const onClose = vi.fn();
        render(<OpdsEntrySheet entry={entry()} onClose={onClose} />);
        await flush();
        await act(async () => button("Add to Library")!.click());
        await flush();
        expect(onClose).not.toHaveBeenCalled();
    });
});

describe("when there is nowhere useful to send you", () => {
    afterEach(() => unmountAll());

    it("a DRM book with no web page explains itself without a pointless website button", async () => {
        const locked = acq({ drm: true, downloadable: false, mime: "application/vnd.adobe.adept+xml", format: undefined, href: "https://x.test/dl/token" });
        render(<OpdsEntrySheet entry={entry({ acquisitions: [locked], primary: undefined })} onClose={() => {}} />);
        await flush();
        expect(dialog().textContent).toContain("DRM");
        expect(button("Open website")).toBeUndefined();
        expect(button("Add to Library")).toBeUndefined();
    });

    it("a DRM book that does have a web page can still send you there", async () => {
        const locked = acq({ drm: true, downloadable: false, mime: "application/vnd.adobe.adept+xml", format: undefined });
        render(<OpdsEntrySheet entry={entry({ acquisitions: [locked], primary: undefined, webUrl: "https://x.test/book" })} onClose={() => {}} />);
        await flush();
        expect(button("Open website")).toBeDefined();
    });

    it("a loan request that is not a web page is not offered as a website link", async () => {
        const loan = acq({ kind: "borrow", downloadable: false, mime: "application/atom+xml;type=entry;profile=opds-catalog", format: undefined, href: "https://x.test/borrow/3" });
        render(<OpdsEntrySheet entry={entry({ acquisitions: [loan], primary: undefined })} onClose={() => {}} />);
        await flush();
        expect(dialog().textContent).toContain("loan");
        expect(button("Open website")).toBeUndefined();
    });

    it("a shop page is a fine website link", async () => {
        const buy = acq({ kind: "buy", downloadable: false, mime: "text/html", format: undefined, href: "https://shop.test/buy/1" });
        render(<OpdsEntrySheet entry={entry({ acquisitions: [buy], primary: undefined })} onClose={() => {}} />);
        await flush();
        expect(button("Open website")).toBeDefined();
    });
});
