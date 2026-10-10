import { beforeEach, describe, expect, it } from "vitest";
import type { Book } from "../src/core/types";
import { useLibraryStore } from "../src/core/store";
import { attachSourceFolder, buildSourceFolderIndex, normalizeSourceFolders, validRelativeBookPath } from "../src/core/lib/source-folders";
import { getFilteredAndSortedBooks } from "../src/features/library/filtering";

function book(id: string, overrides: Partial<Book> = {}): Book {
    return { id, title: id, author: "Author", filePath: `/books/${id}.pdf`, format: "pdf",
        fileSize: 10, addedAt: new Date(), progress: 0, isFavorite: false, tags: [], readingTime: 0, ...overrides };
}
const source = { path: "C:/Books/Engineering/Electronics/book.pdf", relativePath: "Engineering/Electronics/book.pdf", rootName: "Books" };

beforeEach(() => useLibraryStore.setState({ books: [], collections: [], annotations: [], recentBooksCache: [], deletionTombstones: [] }));

describe("folder-preserving import", () => {
    it("retains a nested path without changing the original or materialized file location", () => {
        const original = book("a", { storagePath: "sqlite://a" });
        const imported = attachSourceFolder(original, source, "C:/Books", true);
        expect(imported.sourceFolders).toEqual([{ root: "C:/Books", name: "Books", relativePath: source.relativePath }]);
        expect(imported.filePath).toBe(original.filePath);
        expect(imported.storagePath).toBe(original.storagePath);
        expect(original.sourceFolders).toBeUndefined();
    });
    it("leaves flat imports and existing folder membership unchanged", () => {
        const original = book("flat");
        expect(attachSourceFolder(original, source, "C:/Books", false)).toBe(original);
        const preserved = attachSourceFolder(original, source, "C:/Books", true);
        expect(attachSourceFolder(preserved, source, "C:/Books", false)).toBe(preserved);
    });
    it("supports opaque Android URIs using scanner-provided names", () => {
        const imported = attachSourceFolder(book("android"), { ...source, path: "content://provider/document/123", relativePath: "Science/量子 physics.pdf" }, "content://provider/tree/42", true);
        expect(imported.sourceFolders?.[0].relativePath).toBe("Science/量子 physics.pdf");
    });
    it.each(["", "/book.pdf", "../book.pdf", "Science/../book.pdf", "Science//book.pdf", "./book.pdf", "C:/book.pdf", "Science\\book.pdf"])("rejects an invalid relative path: %s", (path) => {
        expect(validRelativeBookPath(path)).toBe(false);
    });
    it("retains literal percent, spaces, and Unicode names", () => {
        expect(validRelativeBookPath("Math/100%25 — 数学.pdf")).toBe(true);
    });
    it.each(["addBook", "addBooks"] as const)("merges folder locations on duplicate rescans through %s while retaining progress and shelves", (method) => {
        const existing = book("old", { contentHash: "hash", progress: .6, isFavorite: true });
        useLibraryStore.getState().addBook(existing);
        const incoming = attachSourceFolder(book("new", { contentHash: "hash" }), source, "C:/Books", true);
        const store = useLibraryStore.getState();
        if (method === "addBook") { store.addBook(incoming); store.addBook(incoming); }
        else { store.addBooks([incoming, incoming]); }
        expect(useLibraryStore.getState().books).toHaveLength(1);
        expect(useLibraryStore.getState().getBook("old")).toMatchObject({ progress: .6, isFavorite: true, sourceFolders: incoming.sourceFolders });
        expect(useLibraryStore.getState().collections).toEqual([]);
        const other = attachSourceFolder(book("other", { contentHash: "hash" }), { ...source, relativePath: "Reference/book.pdf" }, "D:/Books", true);
        useLibraryStore.getState().addBook(other);
        expect(useLibraryStore.getState().getBook("old")?.sourceFolders).toHaveLength(2);
    });
    it("migrates old libraries without inventing folders and retains valid new metadata", async () => {
        const migrate = useLibraryStore.persist.getOptions().migrate!;
        const existing = attachSourceFolder(book("new"), source, "C:/Books", true);
        const migrated = await migrate({ books: [book("old"), existing] }, 6) as { books: Book[] };
        expect(migrated.books[0].sourceFolders).toEqual([]);
        expect(migrated.books[1].sourceFolders).toEqual(existing.sourceFolders);
        const partial = useLibraryStore.persist.getOptions().partialize!({ ...useLibraryStore.getState(), books: [existing] }) as { books: Book[] };
        expect(JSON.parse(JSON.stringify(partial)).books[0].sourceFolders).toEqual(existing.sourceFolders);
    });
    it("ignores malformed persisted memberships", () => {
        expect(normalizeSourceFolders([null, {}, { root: "x", relativePath: "../a" }])).toEqual([]);
    });
});

describe("source folder browsing", () => {
    const books = [
        attachSourceFolder(book("nested"), source, "C:/Books", true),
        attachSourceFolder(book("sibling"), { ...source, relativePath: "Engineering2/a.pdf" }, "C:/Books", true),
        attachSourceFolder(book("root"), { ...source, relativePath: "root.pdf" }, "C:/Books", true),
        attachSourceFolder(book("other"), source, "D:/Books", true),
        book("flat"),
    ];
    it("creates ancestors, isolates roots and sibling prefixes, and includes root-level books", () => {
        const index = buildSourceFolderIndex(books);
        expect(index.size).toBe(2);
        expect([...index.get("C:/Books")!.folders.get("")!]).toEqual(["nested", "sibling", "root"]);
        expect([...index.get("C:/Books")!.folders.get("Engineering")!]).toEqual(["nested"]);
        expect([...index.get("C:/Books")!.folders.get("Engineering/Electronics")!]).toEqual(["nested"]);
    });
    it("combines folder filters with other library filters without leaking books", () => {
        const options = { books, searchQuery: "", selectedShelfBookIds: null, showFavoritesOnly: false,
            statusFilter: "all" as const, sortBy: "title" as const, sortOrder: "asc" as const };
        expect(getFilteredAndSortedBooks({ ...options, sourceFolderBookIds: new Set(["nested"]) }).map(b => b.id)).toEqual(["nested"]);
        expect(getFilteredAndSortedBooks({ ...options, sourceFolderBookIds: new Set() })).toEqual([]);
        expect(getFilteredAndSortedBooks({ ...options, sourceFolderBookIds: new Set(["nested"]), selectedShelfBookIds: new Set(["other"]) })).toEqual([]);
        expect(getFilteredAndSortedBooks(options)).toHaveLength(5);
    });
    it("handles an empty library", () => expect(buildSourceFolderIndex([]).size).toBe(0));
});
