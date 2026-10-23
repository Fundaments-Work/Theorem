import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Book } from "../src/core/types";

const mocks = vi.hoisted(() => ({
    save: vi.fn().mockResolvedValue(undefined),
    ftsBatch: vi.fn().mockResolvedValue(undefined),
    deleteStorage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/core/lib/env", () => ({
    isTauri: () => true,
    isTauriDesktop: () => true,
    isTauriMobile: () => false,
    isMobile: () => false,
}));
vi.mock("../src/core/lib/storage-manager", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../src/core/lib/storage-manager")>()),
    deleteBookStorage: (...args: unknown[]) => mocks.deleteStorage(...args),
}));
vi.mock("../src/core/lib/sqlite-storage", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../src/core/lib/sqlite-storage")>()),
    sqliteSaveBookMetadata: (...args: unknown[]) => mocks.save(...args),
    sqliteIndexBooksFtsBatch: (...args: unknown[]) => mocks.ftsBatch(...args),
    sqliteIndexBookFts: vi.fn().mockResolvedValue(undefined),
    sqliteGetKv: vi.fn().mockResolvedValue(null),
    sqliteSetKv: vi.fn().mockResolvedValue(undefined),
    sqliteLoadAllBooks: vi.fn().mockResolvedValue([]),
    sqliteListCoverVersions: vi.fn().mockResolvedValue([]),
    sqliteLoadAllAnnotations: vi.fn().mockResolvedValue({ annotations: [], corruptIds: [] }),
}));

import { useLibraryStore } from "../src/core/store/libraryStore";

function book(id: string, overrides: Partial<Book> = {}): Book {
    return { id, title: id, author: "A", filePath: `/b/${id}.epub`, storagePath: `/cache/${id}.book`, format: "epub",
        fileSize: 10, addedAt: new Date(), progress: 0, isFavorite: false, tags: [], readingTime: 0, ...overrides };
}
const savedIds = () => mocks.save.mock.calls.map(([id]) => id);
const indexedIds = () => mocks.ftsBatch.mock.calls.flatMap(([entries]) => (entries as string[][]).map(([id]) => id));

beforeEach(() => {
    mocks.save.mockClear(); mocks.ftsBatch.mockClear(); mocks.deleteStorage.mockClear();
    useLibraryStore.setState({ books: [], collections: [], annotations: [], recentBooksCache: [], deletionTombstones: [] });
});

describe("addBooks with duplicates in the batch", () => {
    it("persists and indexes only the books it keeps, and discards the copies' files", () => {
        useLibraryStore.setState({ books: [book("existing", { contentHash: "h1", progress: 0.5 })] });
        useLibraryStore.getState().addBooks([
            book("dup-of-existing", { contentHash: "h1" }),
            book("new-1", { contentHash: "h2" }),
            book("dup-in-batch", { contentHash: "h2" }),
        ]);
        const ids = useLibraryStore.getState().books.map((b) => b.id);
        expect(ids).toEqual(["existing", "new-1"]);
        expect(savedIds()).not.toContain("dup-of-existing");
        expect(savedIds()).not.toContain("dup-in-batch");
        expect(savedIds()).toContain("new-1");
        expect(indexedIds()).toEqual(["new-1"]);
        expect(mocks.deleteStorage.mock.calls.map(([id]) => id).sort()).toEqual(["dup-in-batch", "dup-of-existing"]);
    });

    it("persists a kept book whose folder locations changed", () => {
        useLibraryStore.setState({ books: [book("existing", { contentHash: "h1" })] });
        useLibraryStore.getState().addBooks([book("again", { contentHash: "h1",
            sourceFolders: [{ root: "/Books", name: "Books", relativePath: "a/x.epub" }] })]);
        expect(useLibraryStore.getState().books).toHaveLength(1);
        expect(savedIds()).toEqual(["existing"]);
        expect(indexedIds()).toEqual([]);
    });
});

describe("updateBooks", () => {
    it("applies many updates in one store change and persists only the books that changed", () => {
        const books = Array.from({ length: 500 }, (_, i) => book(`b${i}`));
        useLibraryStore.setState({ books });
        const listener = vi.fn();
        const unsubscribe = useLibraryStore.subscribe(listener);
        const folders = (i: number) => [{ root: "/Books", name: "Books", relativePath: `s/${i}.epub` }];
        useLibraryStore.getState().updateBooks([
            ...books.slice(0, 300).map((b, i) => [b.id, { sourceFolders: folders(i) }] as const),
            ["missing", { title: "nobody" }] as const,
            ["b400", { filePath: "/moved/b400.epub", fileSize: 11 }] as const,
        ]);
        unsubscribe();
        expect(listener).toHaveBeenCalledTimes(1);
        const state = useLibraryStore.getState();
        expect(state.books).toHaveLength(500);
        expect(state.books[299].sourceFolders).toEqual(folders(299));
        expect(state.books[300]).toBe(books[300]);
        expect(state.getBook("b400")).toMatchObject({ filePath: "/moved/b400.epub", fileSize: 11 });
        expect(savedIds()).toHaveLength(301);
        expect(savedIds()).not.toContain("missing");
    });

    it("merges two updates for the same book and does nothing for an empty list", () => {
        useLibraryStore.setState({ books: [book("a")] });
        const listener = vi.fn();
        const unsubscribe = useLibraryStore.subscribe(listener);
        useLibraryStore.getState().updateBooks([]);
        expect(listener).not.toHaveBeenCalled();
        useLibraryStore.getState().updateBooks([["a", { filePath: "/x.epub" }], ["a", { fileSize: 99 }]]);
        unsubscribe();
        expect(useLibraryStore.getState().books[0]).toMatchObject({ filePath: "/x.epub", fileSize: 99 });
        expect(savedIds()).toEqual(["a"]);
    });
});
