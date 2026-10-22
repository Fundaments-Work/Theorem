import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
    invoke: vi.fn(),
    stat: vi.fn(),
    getBookData: vi.fn(),
    mobile: false,
}));
vi.mock("@tauri-apps/api/core", () => ({
    invoke: native.invoke,
    Channel: class<T> { constructor(public onmessage: (m: T) => void) {} },
}));
vi.mock("@tauri-apps/plugin-fs", () => ({ stat: native.stat, readDir: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("../src/core/lib/env", () => ({ isTauri: () => true, isMobile: () => native.mobile }));
vi.mock("../src/core/lib/storage", () => ({ saveBookData: vi.fn(), getBookData: native.getBookData, saveCoverDataUrl: vi.fn() }));
import { importBooksIncremental, scanBookFolder } from "../src/core/lib/import";

type Msg = Record<string, unknown>;
const record = (path: string) => ({ id: `id:${path}`, title: "T", author: "A", filePath: path, storagePath: `/c/${path}.book`,
    format: "epub", contentHash: "h", coverExtractionDone: true, fileSize: 5, addedAt: "2026-10-22T00:00:00Z", progress: 0, isFavorite: false, tags: [] });

/** Make `ingest_books_native` send these messages on its channel, then resolve. */
function nativeSends(messages: Msg[], opts: { reject?: Error } = {}) {
    native.invoke.mockImplementation(async (cmd: string, args: { onProgress: { onmessage: (m: Msg) => void } }) => {
        if (cmd !== "ingest_books_native") return undefined;
        for (const m of messages) args.onProgress.onmessage(m);
        if (opts.reject) throw opts.reject;
        return { total: 0, imported: 0, failed: 0, duplicates: 0, cancelled: false };
    });
}

beforeEach(() => {
    native.mobile = false;
    native.invoke.mockReset(); native.stat.mockReset(); native.getBookData.mockReset();
});

describe("native desktop import", () => {
    it("routes imported, failed and duplicate files to their callbacks", async () => {
        nativeSends([
            { kind: "progress", completed: 2, total: 3, items: [
                { status: "imported", path: "/a.epub", book: record("/a.epub") },
                { status: "failed", path: "/b.epub", reason: "The file is empty" },
            ] },
            { kind: "progress", completed: 3, total: 3, items: [{ status: "duplicate", path: "/c.epub", contentHash: "abc" }] },
            { kind: "done", summary: { total: 3, imported: 1, failed: 1, duplicates: 1, cancelled: false } },
        ]);
        const imported = vi.fn(); const failed = vi.fn(); const dup = vi.fn(); const progress = vi.fn();
        const books = await importBooksIncremental(["/a.epub", "/b.epub", "/c.epub"], imported, failed,
            { onDuplicate: dup, onProgress: progress, known: [{ size: 5, hash: "abc" }] });

        expect(books.map((b) => b.id)).toEqual(["id:/a.epub"]);
        expect(imported).toHaveBeenCalledOnce();
        expect(failed.mock.calls.map(([s, e]) => [s, (e as Error).message])).toEqual([["/b.epub", "The file is empty"]]);
        expect(dup).toHaveBeenCalledWith("/c.epub", "abc");
        expect(progress.mock.calls).toEqual([[2, 3], [3, 3]]);
        const [, args] = native.invoke.mock.calls.find(([cmd]) => cmd === "ingest_books_native")!;
        expect(args).toMatchObject({ filePaths: ["/a.epub", "/b.epub", "/c.epub"], known: [{ size: 5, hash: "abc" }] });
        expect(typeof args.jobId).toBe("string");
    });

    it("reports a file the importer never mentioned instead of losing it", async () => {
        nativeSends([{ kind: "done", summary: { total: 1, imported: 0, failed: 0, duplicates: 0, cancelled: false } }]);
        const failed = vi.fn();
        await importBooksIncremental(["/lost.epub"], vi.fn(), failed);
        expect(failed).toHaveBeenCalledWith("/lost.epub", expect.objectContaining({ message: "The importer did not report this file" }));
    });

    it("cancels the native job with the same job id when aborted", async () => {
        const controller = new AbortController();
        native.invoke.mockImplementation(async (cmd: string, args: { onProgress: { onmessage: (m: Msg) => void } }) => {
            if (cmd !== "ingest_books_native") return undefined;
            controller.abort();
            args.onProgress.onmessage({ kind: "done", summary: { total: 2, imported: 0, failed: 0, duplicates: 0, cancelled: true } });
            return {};
        });
        const failed = vi.fn();
        await importBooksIncremental(["/a.epub", "/b.epub"], vi.fn(), failed, { signal: controller.signal });
        const ingestArgs = native.invoke.mock.calls.find(([cmd]) => cmd === "ingest_books_native")![1];
        expect(native.invoke).toHaveBeenCalledWith("cancel_import_job", { jobId: ingestArgs.jobId });
        expect(failed).not.toHaveBeenCalled(); // untouched files are not failures
    });

    it("falls back to JavaScript only for files the native importer did not handle", async () => {
        nativeSends([{ kind: "progress", completed: 1, total: 2, items: [{ status: "imported", path: "/a.epub", book: record("/a.epub") }] }],
            { reject: new Error("worker crashed") });
        native.stat.mockRejectedValue(new Error("gone"));
        native.getBookData.mockResolvedValue(null);
        const imported = vi.fn(); const failed = vi.fn();
        const books = await importBooksIncremental(["/a.epub", "/b.epub"], imported, failed);
        expect(books).toHaveLength(1);
        expect(imported).toHaveBeenCalledOnce();
        expect(failed.mock.calls.map(([s]) => s)).toEqual(["/b.epub"]);
        expect(native.getBookData).toHaveBeenCalledTimes(1);
    });
});

describe("JavaScript import", () => {
    it("does not start files after it is aborted", async () => {
        native.mobile = true;
        const controller = new AbortController();
        controller.abort();
        const failed = vi.fn();
        expect(await importBooksIncremental(["/a.epub"], vi.fn(), failed, { signal: controller.signal })).toEqual([]);
        expect(failed).not.toHaveBeenCalled();
        expect(native.invoke).not.toHaveBeenCalled();
    });

    it("reports an empty file as empty and refuses to read a huge one into memory", async () => {
        // The desktop JavaScript fallback reads whole files; it runs when the native importer cannot.
        native.stat.mockImplementation(async (path: string) => ({ size: path === "/empty.epub" ? 0 : 3 * 1024 ** 3 }));
        native.invoke.mockRejectedValue(new Error("no native importer"));
        const failed = vi.fn();
        await importBooksIncremental(["/empty.epub", "/huge.pdf"], vi.fn(), failed);
        const reasons = Object.fromEntries(failed.mock.calls.map(([s, e]) => [s, (e as Error).message]));
        expect(reasons["/empty.epub"]).toBe("The file is empty");
        expect(reasons["/huge.pdf"]).toMatch(/too large to import here/);
        expect(native.getBookData).not.toHaveBeenCalled();
    });
});

describe("folder scan", () => {
    it("passes a job id when it can be cancelled, and reports scan issues", async () => {
        native.invoke.mockImplementation(async (cmd: string) => cmd === "scan_library_folder_desktop"
            ? { files: [{ path: "/B/a.epub", relativePath: "a.epub", rootName: "B", size: 3 }], issues: [{ path: "/B/x", reason: "Permission denied" }], cancelled: false }
            : undefined);
        const controller = new AbortController();
        const scan = await scanBookFolder("/B", controller.signal);
        expect(scan.files[0].size).toBe(3);
        expect(scan.issues).toEqual([{ path: "/B/x", reason: "Permission denied" }]);
        const args = native.invoke.mock.calls[0][1];
        expect(typeof args.jobId).toBe("string");
    });

    it("reports a folder that cannot be opened instead of walking it again", async () => {
        native.invoke.mockRejectedValue("Cannot open /gone: The file is no longer there");
        await expect(scanBookFolder("/gone")).rejects.toThrow("Cannot open /gone");
    });
});
