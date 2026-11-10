import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    invoke: vi.fn(), setSnapshot: vi.fn(), setError: vi.fn(),
    getBook: vi.fn(), addBook: vi.fn(), updateBook: vi.fn(), android: vi.fn(() => false),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("../src/core/store", () => ({
    useImportStore: { getState: () => ({ setSnapshot: mocks.setSnapshot, setError: mocks.setError }) },
    useLibraryStore: { getState: () => ({ getBook: mocks.getBook, addBook: mocks.addBook, updateBook: mocks.updateBook }) },
}));
vi.mock("../src/core/lib/env", () => ({ isTauri: () => true, isAndroid: mocks.android }));
vi.mock("../src/core/lib/import", () => ({
    getBookFormat: (path: string) => path.endsWith(".epub") ? "epub" : null,
    extractFilenameFromPath: (path: string) => path.split("/").pop(), pickBookFiles: async () => ["/books/a.epub"],
}));
import { importPathsAsNativeJob, refreshNativeImport, resumeNativeImport, pollNativeImports, pickAndImportNativeJob } from "../src/core/lib/native-import-jobs";

const snapshot = (over = {}) => ({ id: "job", active: false, resumable: false, total: 1, completed: 1, imported: 1, duplicates: 0, errors: [], current: { name: "", stage: null, completedBytes: 0, totalBytes: null }, ...over });
const book = { id: "book", title: "A", author: "B", addedAt: "2026-11-10T00:00:00Z", filePath: "/books/a.epub", format: "epub", contentHash: "hash", progress: 0, tags: [], isFavorite: false, fileSize: 100 };
let status: ReturnType<typeof snapshot>;
beforeEach(() => {
    vi.useFakeTimers(); vi.clearAllMocks(); status = snapshot(); mocks.android.mockReturnValue(false); mocks.getBook.mockReturnValue(undefined);
    mocks.invoke.mockImplementation(async (command: string) => {
        if (command === "native_import_start" || command === "native_import_resume") return "job";
        if (command === "native_import_snapshot") return status;
        if (command === "native_import_results") return { next: 1, items: [{ source: "/books/a.epub", outcome: "saved", book, message: null }] };
        if (command === "native_import_cancel") { status = snapshot({ completed: 0, resumable: true }); return; }
        throw new Error(`Unexpected command: ${command}`);
    });
});
afterEach(() => vi.useRealTimers());

describe("native import jobs", () => {
    it("submits source options, publishes only saved results, and reports mixed errors", async () => {
        status = snapshot({ total: 2, completed: 2 });
        mocks.invoke.mockImplementation(async (command: string) => {
            if (command === "native_import_start") return "job";
            if (command === "native_import_snapshot") return status;
            return { next: 2, items: [{ source: "/books/a.epub", outcome: "saved", book }, { source: "/books/b.epub", outcome: "failed", message: "Disk full" }] };
        });
        const onBook = vi.fn(), onFailure = vi.fn(), onProgress = vi.fn();
        const folder = { root: "/books", rootName: "Books", relativePath: "a.epub" };
        const books = await importPathsAsNativeJob(["/books/a.epub", "/books/b.epub"], onBook, onFailure, { sourceFolders: { "/books/a.epub": folder }, onProgress });
        expect(mocks.invoke).toHaveBeenCalledWith("native_import_start", { requests: [{ source: "/books/a.epub", name: "a.epub", format: "epub", sourceFolder: folder }, { source: "/books/b.epub", name: "b.epub", format: "epub", sourceFolder: null }] });
        expect(books).toHaveLength(1);
        expect(books[0].addedAt).toBeInstanceOf(Date);
        expect(onBook).toHaveBeenCalledTimes(1);
        expect(onFailure).toHaveBeenCalledWith("/books/b.epub", expect.objectContaining({ message: "Disk full" }));
        expect(onProgress).toHaveBeenLastCalledWith(2, 2);
        expect(mocks.invoke).toHaveBeenCalledWith("native_import_results", { jobId: "job", offset: 0, limit: 100 });
    });

    it("refuses unsupported files before starting a native job", async () => {
        await expect(importPathsAsNativeJob(["/books/unknown.bin"])).rejects.toThrow("Unsupported book");
        expect(mocks.invoke).not.toHaveBeenCalled();
        expect(await importPathsAsNativeJob([])).toEqual([]);
    });

    it("deduplicates concurrent status reads and recovers after a failed read", async () => {
        let reject!: (error: Error) => void;
        mocks.invoke.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
        const first = refreshNativeImport();
        const second = refreshNativeImport();
        expect(first).toBe(second);
        expect(mocks.invoke).toHaveBeenCalledTimes(1);
        reject(new Error("Damaged checkpoint retained"));
        await expect(first).rejects.toThrow("Damaged checkpoint retained");
        expect(mocks.setError).toHaveBeenCalledWith("Error: Damaged checkpoint retained");
        await expect(refreshNativeImport()).resolves.toEqual(status);
        expect(mocks.setSnapshot).toHaveBeenCalledWith(status);
    });

    it("keeps a newer batch from replacing results still being consumed", async () => {
        let release!: (value: unknown) => void;
        mocks.invoke.mockImplementation(async (command: string) => {
            if (command === "native_import_start") return "job";
            if (command === "native_import_snapshot") return status;
            if (command === "native_import_results") return new Promise((resolve) => { release = resolve; });
        });
        const first = importPathsAsNativeJob(["/books/a.epub"]);
        await vi.advanceTimersByTimeAsync(0);
        await expect(importPathsAsNativeJob(["/books/b.epub"])).rejects.toThrow("An import is already running");
        expect(mocks.invoke.mock.calls.filter(([name]) => name === "native_import_start")).toHaveLength(1);
        release({ next: 1, items: [{ source: "/books/a.epub", outcome: "saved", book }] });
        expect(await first).toHaveLength(1);
    });

    it("does not start a job for an already-aborted request", async () => {
        const controller = new AbortController(); controller.abort();
        const onCancelled = vi.fn();
        expect(await importPathsAsNativeJob(["/books/a.epub"], undefined, undefined, { signal: controller.signal, onCancelled })).toEqual([]);
        expect(onCancelled).toHaveBeenCalledTimes(1);
        expect(mocks.invoke).not.toHaveBeenCalled();
    });

    it("does not consume results from another job", async () => {
        status = snapshot({ id: "other-job" });
        await expect(importPathsAsNativeJob(["/books/a.epub"])).rejects.toThrow("The import job changed");
        expect(mocks.invoke.mock.calls.some(([name]) => name === "native_import_results")).toBe(false);
    });

    it("cancels a running job once and leaves interrupted work resumable", async () => {
        status = snapshot({ active: true, completed: 0 });
        const controller = new AbortController();
        const result = importPathsAsNativeJob(["/books/a.epub"], undefined, undefined, { signal: controller.signal });
        await vi.advanceTimersByTimeAsync(0);
        controller.abort(); controller.abort();
        await vi.advanceTimersByTimeAsync(250);
        expect(await result).toEqual([]);
        expect(mocks.invoke.mock.calls.filter(([name]) => name === "native_import_cancel")).toHaveLength(1);
        expect(mocks.setSnapshot).toHaveBeenLastCalledWith(expect.objectContaining({ resumable: true, completed: 0 }));
    });

    it("resume does not overwrite a book already loaded with reading progress", async () => {
        mocks.getBook.mockReturnValue({ ...book, progress: 0.8, title: "Edited" });
        await resumeNativeImport();
        await vi.advanceTimersByTimeAsync(0);
        expect(mocks.invoke).toHaveBeenCalledWith("native_import_resume", { jobId: "job" });
        expect(mocks.addBook).not.toHaveBeenCalled();
        expect(mocks.updateBook).not.toHaveBeenCalled();
    });

    it("uses the persistent Android document picker", async () => {
        mocks.android.mockReturnValue(true);
        mocks.invoke.mockImplementation(async (command: string) => {
            if (command === "pick_native_import_documents") return [{ source: "content://provider/123", name: "a.epub" }];
            if (command === "native_import_start") return "job";
            if (command === "native_import_snapshot") return status;
            return { next: 1, items: [{ source: "content://provider/123", outcome: "saved", book }] };
        });
        await pickAndImportNativeJob();
        expect(mocks.invoke).toHaveBeenCalledWith("native_import_start", { requests: [{ source: "content://provider/123", name: "a.epub", format: "epub", sourceFolder: null }] });
    });

    it("uses scanner filenames for opaque Android URIs in flat imports", async () => {
        await importPathsAsNativeJob(["content://provider/document/123"], undefined, undefined, { sourceNames: { "content://provider/document/123": "Series/a.epub" } });
        expect(mocks.invoke).toHaveBeenCalledWith("native_import_start", { requests: [{ source: "content://provider/document/123", name: "a.epub", format: "epub", sourceFolder: null }] });
    });

    it("does not schedule another poll after cleanup during an in-flight read", async () => {
        let resolve!: (value: unknown) => void;
        mocks.invoke.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
        const stop = pollNativeImports(); stop(); resolve(status);
        await vi.advanceTimersByTimeAsync(2000);
        expect(mocks.invoke).toHaveBeenCalledTimes(1);
    });
});
