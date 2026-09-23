/**
 * The desktop/Android EPUB loader inflates entries in Rust (`epub_read_entry`)
 * instead of zip.js. Rust is modelled here by fflate over the same fixture;
 * the Rust side has its own tests in `src-tauri/src/epub_entries.rs`. What is
 * checked is the JS glue: the book opened through the native loader must be
 * identical to the one opened through zip.js, and zip.js must not be used.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { unzipSync } from "fflate";

const epubBytes = new Uint8Array(readFileSync(`${process.cwd()}/tests/fixtures/epub/multi-chapter.epub`));
const entries = unzipSync(epubBytes);

function epubFile() {
    return new File([epubBytes], "multi-chapter.epub", { type: "application/epub+zip" });
}

function nativePrefetch() {
    const sizes = new Map(Object.entries(entries).map(([name, data]) => [name, data.length]));
    const readEntry = vi.fn(async (name: string) => {
        const data = entries[name] ?? entries[decodeURIComponent(name)];
        return data ? data.slice().buffer : null;
    });
    return { textCache: new Map<string, string>(), sizes, readEntry };
}

type LoadedBook = {
    metadata: unknown;
    toc?: unknown;
    sections: Array<{ id: string; size: number; linear?: string }>;
    loadText: (href: string) => Promise<string | null>;
    loadBlob: (href: string) => Promise<Blob | null>;
};

describe("EPUB entries inflated natively", () => {
    it("opens the same book as zip.js, without touching zip.js", async () => {
        const { makeBook } = await import("../src/features/reader/foliate-js-runtime/view.js");
        const viaZipJs = await makeBook(epubFile()) as LoadedBook;

        const prefetch = nativePrefetch();
        // A file whose bytes must never be read: the native path may not fall back to zip.js.
        const untouchable = epubFile();
        const arrayBuffer = vi.spyOn(untouchable, "arrayBuffer");
        const slice = vi.spyOn(untouchable, "slice");
        const viaNative = await makeBook(untouchable, Promise.resolve(prefetch)) as LoadedBook;

        expect(viaNative.metadata).toEqual(viaZipJs.metadata);
        expect(JSON.stringify(viaNative.toc)).toBe(JSON.stringify(viaZipJs.toc));
        expect(viaNative.sections.map((s) => [s.id, s.size, s.linear]))
            .toEqual(viaZipJs.sections.map((s) => [s.id, s.size, s.linear]));
        expect(viaNative.sections.length).toBeGreaterThan(1);

        for (const section of viaZipJs.sections) {
            expect(await viaNative.loadText(section.id)).toBe(await viaZipJs.loadText(section.id));
        }
        const blobA = await viaZipJs.loadBlob(viaZipJs.sections[0].id);
        const blobB = await viaNative.loadBlob(viaNative.sections[0].id);
        expect(new Uint8Array(await blobB!.arrayBuffer())).toEqual(new Uint8Array(await blobA!.arrayBuffer()));

        expect(prefetch.readEntry).toHaveBeenCalled();
        // Only the 4-byte format sniff (`isZip`) reads the file itself.
        expect(slice.mock.calls).toEqual([[0, 4]]);
        expect(arrayBuffer).not.toHaveBeenCalled();
    });

    it("returns null for entries the archive does not have", async () => {
        const { makeBook } = await import("../src/features/reader/foliate-js-runtime/view.js");
        const book = await makeBook(epubFile(), Promise.resolve(nativePrefetch())) as LoadedBook;
        expect(await book.loadText("OEBPS/does-not-exist.xhtml")).toBeNull();
    });
});
