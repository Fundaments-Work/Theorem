import { describe, expect, it, vi } from "vitest";
import type { Book } from "../src/core/types";
import type { FolderScanResult, ScannedBookFile } from "../src/core/lib/source-folders";
import type { ImportOptions } from "../src/core/lib/import";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));
vi.mock("../src/core/lib/env", () => ({ isTauri: () => true, isMobile: () => false }));
vi.mock("../src/core/lib/storage", () => ({ saveBookData: vi.fn(), getBookData: vi.fn(), saveCoverDataUrl: vi.fn() }));
import { describeFolderImport, importFolder, type FolderImportDeps } from "../src/core/lib/folder-import";

function book(id: string, overrides: Partial<Book> = {}): Book {
    return { id, title: id, author: "A", filePath: `/Books/${id}.epub`, format: "epub", fileSize: 100,
        addedAt: new Date(), progress: 0, isFavorite: false, tags: [], readingTime: 0, ...overrides };
}
function file(rel: string, size = 100): ScannedBookFile {
    return { path: `/Books/${rel}`, relativePath: rel, rootName: "Books", size };
}
function scanOf(files: ScannedBookFile[], extra: Partial<FolderScanResult> = {}): FolderImportDeps["scan"] {
    return vi.fn(async () => ({ files, issues: [], cancelled: false, ...extra }));
}

/** A fake native importer: imports every path not listed in `fail`/`dupes`. */
function fakeImporter(opts: { fail?: Record<string, string>; dupes?: Record<string, string>; onCall?: (paths: string[], o: ImportOptions) => void } = {}) {
    return vi.fn(async (paths: string[], onBook?: (b: Book) => void, onFail?: (s: string, e: unknown) => void, o: ImportOptions = {}) => {
        opts.onCall?.(paths, o);
        const books: Book[] = [];
        let done = 0;
        for (const path of paths) {
            if (o.signal?.aborted) break;
            if (opts.fail?.[path]) onFail?.(path, new Error(opts.fail[path]));
            else if (opts.dupes?.[path]) o.onDuplicate?.(path, opts.dupes[path]);
            else {
                const b = book(`new:${path}`, { filePath: path, contentHash: `hash:${path}` });
                books.push(b);
                onBook?.(b);
            }
            o.onProgress?.(++done, paths.length);
        }
        return books;
    });
}

function harness(library: Book[], scan: FolderImportDeps["scan"], importBooks = fakeImporter()) {
    const books = [...library];
    const deps: FolderImportDeps = {
        scan,
        importBooks: importBooks as unknown as FolderImportDeps["importBooks"],
        getBooks: () => books,
        addBooks: vi.fn((batch: Book[]) => { books.push(...batch); }),
        updateBook: vi.fn((id: string, updates: Partial<Book>) => {
            const i = books.findIndex((b) => b.id === id);
            books[i] = { ...books[i], ...updates };
        }),
        onBooksAdded: vi.fn(),
        onProgress: vi.fn(),
    };
    return { deps, books, importBooks };
}

describe("importFolder", () => {
    it("imports every file, reports every problem with its reason, and adds books in batches", async () => {
        const files = Array.from({ length: 450 }, (_, i) => file(`Shelf/${i}.epub`, 1000 + i));
        const scan = scanOf(files, { issues: [{ path: "/Books/Locked", reason: "Permission denied" }] });
        const { deps, books } = harness([], scan, fakeImporter({ fail: { "/Books/Shelf/7.epub": "The file is empty" } }));
        const result = await importFolder("/Books", true, deps);

        expect(result).toMatchObject({ found: 450, imported: 449, alreadyInLibrary: 0, cancelled: false });
        expect(result.failures).toEqual([
            { source: "/Books/Locked", message: "Permission denied" },
            { source: "/Books/Shelf/7.epub", message: "The file is empty" },
        ]);
        expect(books).toHaveLength(449);
        const calls = (deps.addBooks as ReturnType<typeof vi.fn>).mock.calls.length;
        expect(calls).toBeGreaterThan(0);
        expect(calls).toBeLessThanOrEqual(3);
        expect(books[0].sourceFolders).toEqual([{ root: "/Books", name: "Books", relativePath: "Shelf/0.epub" }]);
        expect(deps.onBooksAdded).toHaveBeenCalledTimes(calls);
    });

    it("rescans without reading unchanged files and changes nothing", async () => {
        const library = [book("a", { filePath: "/Books/a.epub", fileSize: 10 }), book("b", { filePath: "/Books/x/b.pdf", fileSize: 20 })];
        const importBooks = fakeImporter();
        const { deps, books } = harness(library, scanOf([file("a.epub", 10), file("x/b.pdf", 20)]), importBooks);
        const result = await importFolder("/Books", false, deps);
        expect(importBooks).toHaveBeenCalledWith([], expect.any(Function), expect.any(Function), expect.any(Object));
        expect(result).toMatchObject({ found: 2, imported: 0, alreadyInLibrary: 2, failures: [] });
        expect(deps.addBooks).not.toHaveBeenCalled();
        expect(deps.updateBook).not.toHaveBeenCalled();
        expect(books).toEqual(library);
        expect(describeFolderImport(result)).toBeNull();
    });

    it("re-imports a file whose size changed, and passes only same-size library books as known", async () => {
        const library = [
            book("a", { filePath: "/Books/a.epub", fileSize: 10, contentHash: "HA" }),
            book("other", { filePath: "/Else/o.epub", fileSize: 99, contentHash: "ho" }),
            book("nohash", { filePath: "/Else/n.epub", fileSize: 11 }),
        ];
        let seen: { paths: string[]; known?: ImportOptions["known"] } | null = null;
        const importBooks = fakeImporter({ onCall: (paths, o) => { seen = { paths, known: o.known }; } });
        const { deps } = harness(library, scanOf([file("a.epub", 11), file("new.epub", 10)]), importBooks);
        await importFolder("/Books", false, deps);
        expect(seen!.paths).toEqual(["/Books/a.epub", "/Books/new.epub"]);
        expect(seen!.known).toEqual([{ size: 10, hash: "ha" }]);
    });

    it("follows a moved file to its new path so the next rescan skips it, and keeps its progress", async () => {
        const library = [book("moved", { filePath: "/Books/old/m.epub", fileSize: 50, contentHash: "hm", progress: 0.4 })];
        const importBooks = fakeImporter({ dupes: { "/Books/new/m.epub": "HM" } });
        const { deps, books } = harness(library, scanOf([file("new/m.epub", 50)]), importBooks);
        const first = await importFolder("/Books", true, deps);
        expect(first).toMatchObject({ imported: 0, alreadyInLibrary: 1, failures: [] });
        expect(books).toHaveLength(1);
        expect(books[0]).toMatchObject({ id: "moved", filePath: "/Books/new/m.epub", progress: 0.4,
            sourceFolders: [{ root: "/Books", name: "Books", relativePath: "new/m.epub" }] });

        importBooks.mockClear();
        const again = await importFolder("/Books", true, deps);
        expect(importBooks.mock.calls[0][0]).toEqual([]);
        expect(again.alreadyInLibrary).toBe(1);
    });

    it("adds the folder of a second copy to the book imported from the first", async () => {
        const importBooks = vi.fn(async (paths: string[], onBook?: (b: Book) => void, _f?: unknown, o: ImportOptions = {}) => {
            onBook?.(book("first", { filePath: paths[0], contentHash: "same" }));
            o.onDuplicate?.(paths[1], "SAME");
            return [];
        });
        const { deps, books } = harness([], scanOf([file("a/x.epub", 7), file("b/x copy.epub", 7)]), importBooks);
        const result = await importFolder("/Books", true, deps);
        expect(result).toMatchObject({ imported: 1, alreadyInLibrary: 1 });
        expect(books).toHaveLength(1);
        expect(books[0].filePath).toBe("/Books/a/x.epub");
        expect(books[0].sourceFolders?.map((f) => f.relativePath)).toEqual(["a/x.epub", "b/x copy.epub"]);
    });

    it("keeps the path of a duplicate whose original is still in the folder", async () => {
        const library = [book("orig", { filePath: "/Books/a.epub", fileSize: 50, contentHash: "h" })];
        const { deps, books } = harness(library, scanOf([file("a.epub", 50), file("copy of a.epub", 50)]),
            fakeImporter({ dupes: { "/Books/copy of a.epub": "h" } }));
        const result = await importFolder("/Books", false, deps);
        expect(result.alreadyInLibrary).toBe(2);
        expect(books[0].filePath).toBe("/Books/a.epub");
        expect(deps.updateBook).not.toHaveBeenCalled();
    });

    it("imports names that cannot be preserved without their folder instead of failing the whole folder", async () => {
        const odd = { path: "/Books/back\\slash.epub", relativePath: "back\\slash.epub", rootName: "Books", size: 5 };
        const { deps, books } = harness([], scanOf([odd, file("ok/fine.epub", 6)]));
        const result = await importFolder("/Books", true, deps);
        expect(result.imported).toBe(2);
        expect(books.find((b) => b.filePath === odd.path)?.sourceFolders).toBeUndefined();
        expect(books.find((b) => b.filePath === "/Books/ok/fine.epub")?.sourceFolders).toHaveLength(1);
    });

    it("stops when cancelled, keeps what was imported, and says so", async () => {
        const controller = new AbortController();
        const files = Array.from({ length: 50 }, (_, i) => file(`${i}.epub`, i + 1));
        const importBooks = fakeImporter({ onCall: () => undefined });
        let count = 0;
        const { deps, books } = harness([], scanOf(files), vi.fn(async (paths: string[], onBook?: (b: Book) => void, onFail?: (s: string, e: unknown) => void, o: ImportOptions = {}) => {
            const wrapped = (b: Book) => { onBook?.(b); if (++count === 10) controller.abort(); };
            return importBooks(paths, wrapped, onFail, o);
        }));
        const result = await importFolder("/Books", false, deps, controller.signal);
        expect(result.cancelled).toBe(true);
        expect(result.imported).toBe(10);
        expect(books).toHaveLength(10);
        expect(describeFolderImport(result)?.title).toBe("Import Stopped");
    });

    it("does not import anything when the scan was cancelled", async () => {
        const { deps, importBooks } = harness([], scanOf([file("a.epub")], { cancelled: true }));
        const result = await importFolder("/Books", false, deps);
        expect(result.cancelled).toBe(true);
        expect(importBooks).not.toHaveBeenCalled();
    });

    it("throttles progress", async () => {
        const files = Array.from({ length: 300 }, (_, i) => file(`${i}.epub`, i + 1));
        const { deps } = harness([], scanOf(files));
        await importFolder("/Books", false, deps);
        const calls = (deps.onProgress as ReturnType<typeof vi.fn>).mock.calls.map(([p]) => p);
        expect(calls.length).toBeLessThan(10);
        expect(calls.at(-1)).toEqual({ phase: "importing", completed: 300, total: 300 });
    });
});

describe("describeFolderImport", () => {
    it("explains an empty folder, failures and duplicates", () => {
        expect(describeFolderImport({ found: 0, imported: 0, alreadyInLibrary: 0, failures: [], cancelled: false })?.title).toBe("No Books Found");
        const message = describeFolderImport({ found: 9, imported: 2, alreadyInLibrary: 1, cancelled: false,
            failures: Array.from({ length: 6 }, (_, i) => ({ source: `/b/${i}.epub`, message: "The file is empty" })) })!;
        expect(message.title).toBe("Import Errors");
        expect(message.message).toContain("2 imported, 1 already in your library, 6 could not be imported.");
        expect(message.message).toContain("- /b/0.epub: The file is empty");
        expect(message.message).toContain("(+1 more)");
    });
});
