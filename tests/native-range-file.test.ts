import { beforeEach, describe, expect, it, vi } from "vitest";

const FILE = new Uint8Array(Array.from({ length: 100 }, (_, i) => i));
const reads: Array<{ offset: number; length: number }> = [];
vi.mock("@tauri-apps/api/core", () => ({
    invoke: vi.fn(async (cmd: string, args: { offset?: number; length?: number; path?: string }) => {
        if (cmd === "read_pdf_file_size") return args.path === "/missing" ? Promise.reject(new Error("ENOENT")) : FILE.length;
        if (cmd === "read_pdf_range") {
            reads.push({ offset: args.offset!, length: args.length! });
            return FILE.slice(args.offset!, args.offset! + args.length!).buffer;
        }
        throw new Error("unexpected " + cmd);
    }),
}));

import { isNativeRangeFile, openNativeRangeFile, NativeRangeFile } from "../src/core/lib/native-range-file";

beforeEach(() => { reads.length = 0; });

describe("NativeRangeFile", () => {
    it("reads only the requested range, never the whole file", async () => {
        const file = (await openNativeRangeFile("/book.epub", "book.epub", "application/epub+zip"))!;
        expect(file.size).toBe(100);
        const bytes = new Uint8Array(await file.slice(90, 100).arrayBuffer());
        expect([...bytes]).toEqual([90, 91, 92, 93, 94, 95, 96, 97, 98, 99]);
        expect(reads).toEqual([{ offset: 90, length: 10 }]);
    });

    it("follows Blob.slice semantics: nested, negative, clamped, inverted", async () => {
        const file = new NativeRangeFile("/b", "b", "t", 0, 100);
        const inner = file.slice(10, 50).slice(5, 10);
        expect([...new Uint8Array(await inner.arrayBuffer())]).toEqual([15, 16, 17, 18, 19]);
        expect(file.slice(-4).size).toBe(4);
        expect([...new Uint8Array(await file.slice(-4).arrayBuffer())]).toEqual([96, 97, 98, 99]);
        expect(file.slice(95, 500).size).toBe(5);
        expect(file.slice(60, 40).size).toBe(0);
        expect(file.slice(0, -90).size).toBe(10);
    });

    it("empty slices do not touch IPC", async () => {
        const buf = await new NativeRangeFile("/b", "b", "t", 0, 100).slice(30, 30).arrayBuffer();
        expect(buf.byteLength).toBe(0);
        expect(reads).toEqual([]);
    });

    it("keeps name and type (format sniffing uses them)", () => {
        const f = new NativeRangeFile("/b", "comic.cbz", "application/vnd.comicbook+zip", 0, 10);
        expect(f.slice(0, 4).name).toBe("comic.cbz");
        expect(f.slice(0, 4, "x/y").type).toBe("x/y");
        expect(isNativeRangeFile(f)).toBe(true);
        expect(isNativeRangeFile(new Blob([]))).toBe(false);
        expect(isNativeRangeFile(null)).toBe(false);
    });

    it("returns null for missing or empty files", async () => {
        expect(await openNativeRangeFile("/missing", "x", "t")).toBeNull();
    });

    it("works with zip.js: opens a real EPUB reading only a fraction of it", async () => {
        const { readFileSync } = await import("node:fs");
        const { invoke } = await import("@tauri-apps/api/core");
        const epub = new Uint8Array(readFileSync(`${process.cwd()}/tests/fixtures/epub/multi-chapter.epub`));
        vi.mocked(invoke).mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
            if (cmd === "read_pdf_range") {
                reads.push({ offset: args!.offset as number, length: args!.length as number });
                return epub.slice(args!.offset as number, (args!.offset as number) + (args!.length as number)).buffer;
            }
            return epub.length;
        });
        const file = (await openNativeRangeFile("/multi.epub", "multi.epub", "application/epub+zip"))!;
        const { ZipReader, BlobReader, TextWriter, configure } = await import("../src/features/reader/foliate-js-runtime/vendor/zip.js");
        configure({ useWebWorkers: false });
        const reader = new ZipReader(new BlobReader(file as unknown as Blob));
        const entries = await reader.getEntries();
        const opf = entries.find((e: { filename: string }) => e.filename.endsWith(".opf"))!;
        const text = await opf.getData(new TextWriter());
        expect(text).toContain("<package");
        const bytesRead = reads.reduce((sum, r) => sum + r.length, 0);
        expect(bytesRead).toBeLessThan(epub.length / 2);
    });
});
