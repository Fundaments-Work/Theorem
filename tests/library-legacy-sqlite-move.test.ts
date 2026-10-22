import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Annotation, Book } from "../src/core/types";

// Plain functions (not vi.fn) so the global clearMocks/restoreMocks settings
// cannot reset the fake SQLite between the steps of one test.
const { sqlite } = vi.hoisted(() => {
    const sqlite = {
        books: new Map<string, string>(),
        annotations: new Map<string, string>(),
        failBookWrites: false,
        failAnnotationWrites: false,
        bookWrites: [] as string[],
        annotationWrites: [] as string[],
    };
    return { sqlite };
});

vi.mock("../src/core/lib/env", () => ({
    isTauri: () => true,
    isTauriDesktop: () => true,
    isTauriMobile: () => false,
    isMobile: () => false,
}));

vi.mock("../src/core/lib/sqlite-storage", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../src/core/lib/sqlite-storage")>();
    const ok = () => Promise.resolve(undefined);
    return {
        ...actual,
        sqliteSaveBookMetadata: async (id: string, json: string) => {
            sqlite.bookWrites.push(id);
            if (sqlite.failBookWrites) throw new Error("database is locked");
            sqlite.books.set(id, json);
        },
        sqliteLoadAllBooks: async () => [...sqlite.books.values()],
        sqliteUpsertAnnotation: async (id: string, _bookId: string, json: string) => {
            sqlite.annotationWrites.push(id);
            if (sqlite.failAnnotationWrites) throw new Error("database is locked");
            sqlite.annotations.set(id, json);
        },
        sqliteGetAllAnnotations: async () => [...sqlite.annotations.values()],
        sqliteDeleteBookMetadata: ok,
        sqliteUpdateBookProgress: ok,
        sqliteSaveBookAnnotations: ok,
        sqliteDeleteAnnotation: ok,
        sqliteListCoverVersions: async () => [],
        sqliteIndexBooksFtsBatch: ok,
        sqliteIndexBookFts: ok,
        sqliteGetKv: async () => null,
        sqliteSetKv: ok,
        sqliteDeleteBookData: ok,
    };
});

import { useLibraryStore } from "../src/core/store/libraryStore";

function book(id: string, title = `Book ${id}`): Book {
    return {
        id,
        title,
        author: "Author",
        filePath: `/books/${id}.epub`,
        format: "epub",
        fileSize: 1000,
        addedAt: new Date("2026-01-01"),
        progress: 0.1,
        tags: [],
        isFavorite: false,
        readingTime: 10,
    };
}

function annotation(id: string, bookId = "b1"): Annotation {
    return {
        id,
        bookId,
        type: "highlight",
        location: "epubcfi(/6/2)",
        selectedText: "text",
        color: "yellow",
        createdAt: new Date("2026-01-01"),
    } as Annotation;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const options = () => (useLibraryStore as any).persist.getOptions();

/** The same order zustand's persist uses: outer hook, migrate, merge, inner hook. */
function hydrate(persisted: Record<string, unknown>, version: number | null) {
    const after = options().onRehydrateStorage();
    const state = version === null ? persisted : options().migrate(persisted, version);
    useLibraryStore.setState(state);
    after(useLibraryStore.getState());
}

function persistedCopy() {
    return options().partialize(useLibraryStore.getState());
}

async function settle() {
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
}

describe("moving legacy books and annotations from the KV copy into SQLite", () => {
    let errorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        sqlite.books.clear();
        sqlite.annotations.clear();
        sqlite.failBookWrites = false;
        sqlite.failAnnotationWrites = false;
        sqlite.bookWrites.length = 0;
        sqlite.annotationWrites.length = 0;
        errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        useLibraryStore.setState({
            books: [],
            collections: [],
            annotations: [],
            deletionTombstones: [],
            recentBooksCache: [],
        });
    });

    afterEach(() => {
        errorSpy.mockRestore();
    });

    it("keeps legacy books in the saved copy when the SQLite write fails", async () => {
        sqlite.failBookWrites = true;
        hydrate({ books: [book("b1"), book("b2")], collections: [], annotations: [], deletionTombstones: [] }, 7);
        await settle();

        expect(persistedCopy().books.map((b: Book) => b.id).sort()).toEqual(["b1", "b2"]);
        // Still visible this session.
        expect(useLibraryStore.getState().books.map((b) => b.id).sort()).toEqual(["b1", "b2"]);
        expect(errorSpy).toHaveBeenCalled();
    });

    it("drops the saved copy once SQLite holds every book", async () => {
        hydrate({ books: [book("b1"), book("b2")], collections: [], annotations: [], deletionTombstones: [] }, 7);
        await settle();

        expect([...sqlite.books.keys()].sort()).toEqual(["b1", "b2"]);
        expect(persistedCopy().books).toEqual([]);
        expect(useLibraryStore.getState().books.map((b) => b.id).sort()).toEqual(["b1", "b2"]);
    });

    it("retries on the next launch and then drops the saved copy", async () => {
        sqlite.failBookWrites = true;
        hydrate({ books: [book("b1")], collections: [], annotations: [], deletionTombstones: [] }, 7);
        await settle();
        const saved = persistedCopy();
        expect(saved.books).toHaveLength(1);

        // Relaunch: the saved copy is already at the current version, so
        // migrate does not run; the books come back through the merge.
        sqlite.failBookWrites = false;
        useLibraryStore.setState({ books: [], annotations: [] });
        hydrate({ ...saved, books: JSON.parse(JSON.stringify(saved.books)) }, null);
        await settle();

        expect([...sqlite.books.keys()]).toEqual(["b1"]);
        expect(persistedCopy().books).toEqual([]);
        expect(useLibraryStore.getState().books.map((b) => b.id)).toEqual(["b1"]);
    });

    it("a retry never overwrites a newer row already in SQLite", async () => {
        sqlite.books.set("b1", JSON.stringify(book("b1", "Edited in SQLite")));
        hydrate({ books: [book("b1", "Stale KV title"), book("b2")], collections: [], annotations: [], deletionTombstones: [] }, null);
        await settle();

        expect(sqlite.bookWrites).toEqual(["b2"]);
        expect(JSON.parse(sqlite.books.get("b1")!).title).toBe("Edited in SQLite");
        expect(persistedCopy().books).toEqual([]);
    });

    it("does not resurrect a legacy book that was deleted", async () => {
        hydrate({
            books: [book("b1"), book("gone")],
            collections: [],
            annotations: [],
            deletionTombstones: [{ entityId: "gone", entityType: "book", deletedAt: new Date().toISOString() }],
        }, null);
        await settle();

        expect(sqlite.bookWrites).toEqual(["b1"]);
        expect(persistedCopy().books).toEqual([]);
    });

    it("keeps legacy annotations in the saved copy when the SQLite write fails", async () => {
        sqlite.failAnnotationWrites = true;
        hydrate({
            books: [],
            collections: [],
            annotations: [annotation("a1"), annotation("a2")],
            deletionTombstones: [],
        }, 6);
        await settle();

        expect(persistedCopy().annotations.map((a: Annotation) => a.id).sort()).toEqual(["a1", "a2"]);
        expect(useLibraryStore.getState().annotations.map((a) => a.id).sort()).toEqual(["a1", "a2"]);
        expect(errorSpy).toHaveBeenCalled();
    });

    it("drops legacy annotations from the saved copy once SQLite holds them", async () => {
        hydrate({
            books: [],
            collections: [],
            annotations: [annotation("a1"), annotation("a2")],
            deletionTombstones: [],
        }, 6);
        await settle();

        expect([...sqlite.annotations.keys()].sort()).toEqual(["a1", "a2"]);
        expect(persistedCopy().annotations).toEqual([]);
    });

    it("a store with nothing to move persists no books or annotations", async () => {
        hydrate({ books: [], collections: [], annotations: [], deletionTombstones: [] }, 10);
        await settle();
        expect(sqlite.bookWrites).toEqual([]);
        expect(sqlite.annotationWrites).toEqual([]);
        expect(persistedCopy().books).toEqual([]);
        expect(persistedCopy().annotations).toEqual([]);
    });
});
