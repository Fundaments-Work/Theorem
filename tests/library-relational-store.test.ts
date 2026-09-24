import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Book } from "../src/core/types";

const { mockIsTauriEnv, mocks } = vi.hoisted(() => {
    return {
        mockIsTauriEnv: { value: false },
        mocks: {
            mockSqliteSaveBookMetadata: vi.fn().mockResolvedValue(undefined),
            mockSqliteDeleteBookMetadata: vi.fn().mockResolvedValue(undefined),
            mockSqliteLoadAllBooks: vi.fn().mockResolvedValue([]),
            mockSqliteUpdateBookProgress: vi.fn().mockResolvedValue(undefined),
            mockSqliteIndexBookFts: vi.fn().mockResolvedValue(undefined),
            mockSqliteIndexBooksFtsBatch: vi.fn().mockResolvedValue(undefined),
        },
    };
});

vi.mock("../src/core/lib/env", () => ({
    isTauri: () => mockIsTauriEnv.value,
    isTauriDesktop: () => mockIsTauriEnv.value,
    isTauriMobile: () => false,
    isMobile: () => false,
}));

vi.mock("../src/core/lib/sqlite-storage", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../src/core/lib/sqlite-storage")>();
    return {
        ...actual,
        sqliteSaveBookMetadata: (...args: any[]) => mocks.mockSqliteSaveBookMetadata(...args),
        sqliteDeleteBookMetadata: (...args: any[]) => mocks.mockSqliteDeleteBookMetadata(...args),
        sqliteLoadAllBooks: (...args: any[]) => mocks.mockSqliteLoadAllBooks(...args),
        sqliteUpdateBookProgress: (...args: any[]) => mocks.mockSqliteUpdateBookProgress(...args),
        sqliteSaveBookAnnotations: vi.fn().mockResolvedValue(undefined),
        sqliteGetAllAnnotations: vi.fn().mockResolvedValue([]),
        sqliteUpsertAnnotation: vi.fn().mockResolvedValue(undefined),
        sqliteDeleteAnnotation: vi.fn().mockResolvedValue(undefined),
        sqliteListCoverVersions: vi.fn().mockResolvedValue([]),
        sqliteIndexBooksFtsBatch: (...args: any[]) => mocks.mockSqliteIndexBooksFtsBatch(...args),
        sqliteIndexBookFts: (...args: any[]) => mocks.mockSqliteIndexBookFts(...args),
        sqliteGetKv: vi.fn().mockResolvedValue(null),
        sqliteSetKv: vi.fn().mockResolvedValue(undefined),
        sqliteDeleteBookData: vi.fn().mockResolvedValue(undefined),
    };
});

import { useLibraryStore } from "../src/core/store/libraryStore";

function sampleBook(id: string, title = `Book ${id}`): Book {
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

describe("R7: Relational Library Store (SQLite Books & Metadata)", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockIsTauriEnv.value = false;
        useLibraryStore.setState({
            books: [],
            collections: [],
            annotations: [],
            deletionTombstones: [],
            recentBooksCache: [],
            coversHydrated: false,
        });
    });

    it("partialize excludes books on Tauri but includes them in browser", () => {
        const persistOptions = (useLibraryStore as any).persist.getOptions();
        const testState = {
            books: [sampleBook("b1")],
            collections: [],
            annotations: [],
            deletionTombstones: [],
            lastScannedAt: undefined,
            recentBooksCache: [],
        };

        // When not Tauri
        mockIsTauriEnv.value = false;
        const browserPartial = persistOptions.partialize(testState);
        expect(browserPartial.books).toHaveLength(1);
        expect(browserPartial.books[0].id).toBe("b1");

        // When Tauri
        mockIsTauriEnv.value = true;
        const tauriPartial = persistOptions.partialize(testState);
        expect(tauriPartial.books).toHaveLength(0);
    });

    it("addBook and updateBook call sqliteSaveBookMetadata on Tauri", () => {
        mockIsTauriEnv.value = true;
        const b = sampleBook("b1");

        useLibraryStore.getState().addBook(b);
        expect(mocks.mockSqliteSaveBookMetadata).toHaveBeenCalledWith("b1", expect.stringContaining('"id":"b1"'));

        useLibraryStore.getState().updateBook("b1", { title: "Updated Title" });
        expect(mocks.mockSqliteSaveBookMetadata).toHaveBeenCalledWith("b1", expect.stringContaining('"title":"Updated Title"'));
    });

    it("updateProgress calls sqliteUpdateBookProgress directly on Tauri without full store rewrite", () => {
        mockIsTauriEnv.value = true;
        const b = sampleBook("b1");
        useLibraryStore.getState().addBook(b);
        mocks.mockSqliteSaveBookMetadata.mockClear();

        useLibraryStore.getState().updateProgress("b1", 0.5, "loc-456", 0.8, {
            currentPage: 50,
            totalPages: 100,
            range: "50",
        });

        // Does NOT re-save full metadata (which would re-index FTS)
        expect(mocks.mockSqliteSaveBookMetadata).not.toHaveBeenCalled();

        // Calls sqliteUpdateBookProgress with granular payload
        expect(mocks.mockSqliteUpdateBookProgress).toHaveBeenCalledWith("b1", expect.objectContaining({
            progress: 0.5,
            currentLocation: "loc-456",
            lastClickFraction: 0.8,
            pageProgressJson: expect.stringContaining('"currentPage":50'),
        }));
    });

    it("removeBooks calls sqliteDeleteBookMetadata for each deleted book on Tauri", () => {
        mockIsTauriEnv.value = true;
        useLibraryStore.getState().addBook(sampleBook("b1"));
        useLibraryStore.getState().addBook(sampleBook("b2"));

        useLibraryStore.getState().removeBooks(["b1", "b2"]);
        expect(mocks.mockSqliteDeleteBookMetadata).toHaveBeenCalledWith("b1");
        expect(mocks.mockSqliteDeleteBookMetadata).toHaveBeenCalledWith("b2");
    });

    it("migration from v7 saves legacy books to SQLite and clears books from persist", () => {
        mockIsTauriEnv.value = true;
        const persistOptions = (useLibraryStore as any).persist.getOptions();

        const legacyState = {
            books: [sampleBook("legacy1"), sampleBook("legacy2")],
            collections: [],
            annotations: [],
            deletionTombstones: [],
        };

        const migrated = persistOptions.migrate(legacyState, 7);

        expect(mocks.mockSqliteSaveBookMetadata).toHaveBeenCalledWith("legacy1", expect.any(String));
        expect(mocks.mockSqliteSaveBookMetadata).toHaveBeenCalledWith("legacy2", expect.any(String));
        expect(migrated.books).toHaveLength(0);
    });

    it("rehydration loads books from sqliteLoadAllBooks on Tauri", async () => {
        mockIsTauriEnv.value = true;
        const b1 = sampleBook("rehydrated1");
        mocks.mockSqliteLoadAllBooks.mockResolvedValue([JSON.stringify(b1)]);

        const persistOptions = (useLibraryStore as any).persist.getOptions();
        const onRehydrate = persistOptions.onRehydrateStorage();

        const stateRef = {
            books: [],
            collections: [],
            annotations: [],
            deletionTombstones: [],
            recentBooksCache: [],
        };

        onRehydrate(stateRef);

        await vi.waitFor(() => {
            expect(mocks.mockSqliteLoadAllBooks).toHaveBeenCalled();
            const loaded = useLibraryStore.getState().books;
            expect(loaded.length).toBe(1);
            expect(loaded[0].id).toBe("rehydrated1");
        });
    });
});
