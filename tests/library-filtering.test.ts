import { beforeAll, describe, expect, it } from "vitest";
import type { Book, LibrarySortBy, LibrarySortOrder, LibraryStatusFilter } from "../src/core";
import { getFilteredAndSortedBooks } from "../src/features/library/filtering";
import { initTheoremCoreWasm } from "../src/core/lib/theorem-core";

// Without native results the Library ranks with the WebAssembly build of the
// Rust matcher (there is no JavaScript matcher); Library.tsx loads it on the
// first search, these tests load it up front.
beforeAll(async () => {
    expect(await initTheoremCoreWasm()).toBe(true);
});

function makeBook(overrides: Partial<Book> & Pick<Book, "id" | "title">): Book {
    return {
        id: overrides.id,
        title: overrides.title,
        author: overrides.author ?? "Unknown Author",
        filePath: overrides.filePath ?? `/library/${overrides.id}.epub`,
        format: overrides.format ?? "epub",
        fileSize: overrides.fileSize ?? 1024,
        addedAt: overrides.addedAt ?? new Date("2025-01-01T00:00:00.000Z"),
        lastReadAt: overrides.lastReadAt,
        progress: overrides.progress ?? 0,
        tags: overrides.tags ?? [],
        isFavorite: overrides.isFavorite ?? false,
        readingTime: overrides.readingTime ?? 0,
        rating: overrides.rating,
        coverPath: overrides.coverPath,
        locations: overrides.locations,
        storagePath: overrides.storagePath,
        currentLocation: overrides.currentLocation,
        lastClickFraction: overrides.lastClickFraction,
        pageProgress: overrides.pageProgress,
        pdfViewState: overrides.pdfViewState,
        category: overrides.category,
        description: overrides.description,
        publisher: overrides.publisher,
        publishedDate: overrides.publishedDate,
        language: overrides.language,
        isbn: overrides.isbn,
        manualCompletionState: overrides.manualCompletionState,
        progressBeforeFinish: overrides.progressBeforeFinish,
        completedAt: overrides.completedAt,
        contentHash: overrides.contentHash,
        coverExtractionDone: overrides.coverExtractionDone,
    };
}

function runFilter({
    books,
    searchQuery = "",
    selectedShelfBookIds = null,
    showFavoritesOnly = false,
    statusFilter = "all",
    sortBy = "title",
    sortOrder = "asc",
}: {
    books: Book[];
    searchQuery?: string;
    selectedShelfBookIds?: Set<string> | null;
    showFavoritesOnly?: boolean;
    statusFilter?: LibraryStatusFilter;
    sortBy?: LibrarySortBy;
    sortOrder?: LibrarySortOrder;
}) {
    return getFilteredAndSortedBooks({
        books,
        searchQuery,
        selectedShelfBookIds,
        showFavoritesOnly,
        statusFilter,
        sortBy,
        sortOrder,
    });
}

function ids(books: Book[]) {
    return books.map((book) => book.id);
}

describe("getFilteredAndSortedBooks", () => {
    const books: Book[] = [
        makeBook({
            id: "alpha",
            title: "Alpha",
            author: "Alice",
            addedAt: new Date("2024-01-02T00:00:00.000Z"),
            isFavorite: false,
            tags: ["fiction"],
            progress: 0.15,
            rating: 1,
            lastReadAt: undefined,
        }),
        makeBook({
            id: "beta-rss",
            title: "Beta RSS",
            author: "Bob",
            addedAt: new Date("2024-01-01T00:00:00.000Z"),
            isFavorite: true,
            tags: ["rss", "news"],
            progress: 0.9,
            rating: 5,
            lastReadAt: new Date("2024-01-05T00:00:00.000Z"),
        }),
        makeBook({
            id: "beta-book",
            title: "Beta Book",
            author: "Beatrice",
            addedAt: new Date("2024-01-03T00:00:00.000Z"),
            isFavorite: true,
            tags: ["fantasy"],
            format: "pdf",
            progress: 0.75,
            rating: undefined,
            lastReadAt: new Date("2024-02-01T00:00:00.000Z"),
        }),
        makeBook({
            id: "gamma",
            title: "Gamma",
            author: "Gabe",
            addedAt: new Date("2024-01-04T00:00:00.000Z"),
            isFavorite: false,
            tags: ["science"],
            format: "mobi",
            progress: 0.45,
            rating: 4,
            lastReadAt: new Date("2024-01-15T00:00:00.000Z"),
        }),
    ];

    describe("rss, shelf, and favorites filtering", () => {
        it("hides rss books in the main library view", () => {
            const result = runFilter({ books });
            expect(ids(result)).toEqual(["alpha", "beta-book", "gamma"]);
        });

        it("includes rss books when filtering by a selected shelf", () => {
            const result = runFilter({
                books,
                selectedShelfBookIds: new Set(["beta-rss", "gamma"]),
            });
            expect(ids(result)).toEqual(["beta-rss", "gamma"]);
        });

        it("returns an empty list when a selected shelf has no book ids", () => {
            const result = runFilter({
                books,
                selectedShelfBookIds: new Set<string>(),
            });
            expect(ids(result)).toEqual([]);
        });

        it("applies favorites after shelf filtering", () => {
            const result = runFilter({
                books,
                selectedShelfBookIds: new Set(["alpha", "beta-book", "gamma"]),
                showFavoritesOnly: true,
            });
            expect(ids(result)).toEqual(["beta-book"]);
        });

        it("keeps rss items hidden in favorites-only mode when no shelf is selected", () => {
            const result = runFilter({
                books,
                showFavoritesOnly: true,
            });
            expect(ids(result)).toEqual(["beta-book"]);
        });
    });

    describe("search behavior", () => {
        it("searches only within the already filtered set", () => {
            const result = runFilter({
                books,
                searchQuery: "beta",
            });
            expect(ids(result)).toEqual(["beta-book"]);
        });

        it("can search rss books when the current shelf includes them", () => {
            const result = runFilter({
                books,
                searchQuery: "rss",
                selectedShelfBookIds: new Set(["beta-rss", "gamma"]),
            });
            expect(ids(result)).toEqual(["beta-rss"]);
        });

        it("matches searchable tags and format labels", () => {
            const tagResult = runFilter({
                books,
                searchQuery: "science",
            });
            const formatResult = runFilter({
                books,
                searchQuery: "pdf",
            });

            expect(ids(tagResult)).toEqual(["gamma"]);
            expect(ids(formatResult)).toEqual(["beta-book"]);
        });

        it("uses fuzzy relevance order when searching regardless of sort settings", () => {
            const byTitleAsc = runFilter({
                books,
                searchQuery: "beta",
                selectedShelfBookIds: new Set(["beta-rss", "beta-book"]),
                sortBy: "title",
                sortOrder: "asc",
            });
            const byDateDesc = runFilter({
                books,
                searchQuery: "beta",
                selectedShelfBookIds: new Set(["beta-rss", "beta-book"]),
                sortBy: "dateAdded",
                sortOrder: "desc",
            });

            expect(ids(byTitleAsc)).toEqual(ids(byDateDesc));
        });

        it("treats whitespace-only query as no search and falls back to configured sort", () => {
            const result = runFilter({
                books,
                searchQuery: "   ",
                sortBy: "progress",
                sortOrder: "desc",
            });
            expect(ids(result)).toEqual(["beta-book", "gamma", "alpha"]);
        });

        it("normalizes non-string author values while searching", () => {
            const result = runFilter({
                books: [
                    makeBook({
                        id: "author-object",
                        title: "Object Author",
                        author: { name: "Jane Doe" } as unknown as string,
                    }),
                    makeBook({
                        id: "author-array",
                        title: "Array Author",
                        author: ["Alice", { name: "Bob" }] as unknown as string,
                    }),
                ],
                searchQuery: "jane",
            });
            expect(ids(result)).toEqual(["author-object"]);
        });
    });

    describe("sorting behavior", () => {
        it("sorts by title in both directions", () => {
            const asc = runFilter({ books, sortBy: "title", sortOrder: "asc" });
            const desc = runFilter({ books, sortBy: "title", sortOrder: "desc" });

            expect(ids(asc)).toEqual(["alpha", "beta-book", "gamma"]);
            expect(ids(desc)).toEqual(["gamma", "beta-book", "alpha"]);
        });

        it("sorts by author in both directions", () => {
            const asc = runFilter({ books, sortBy: "author", sortOrder: "asc" });
            const desc = runFilter({ books, sortBy: "author", sortOrder: "desc" });

            expect(ids(asc)).toEqual(["alpha", "beta-book", "gamma"]);
            expect(ids(desc)).toEqual(["gamma", "beta-book", "alpha"]);
        });

        it("normalizes non-string author values while sorting", () => {
            const asc = runFilter({
                books: [
                    makeBook({
                        id: "author-sort-1",
                        title: "Author Sort 1",
                        author: { name: "Ada" } as unknown as string,
                    }),
                    makeBook({
                        id: "author-sort-2",
                        title: "Author Sort 2",
                        author: "Bea",
                    }),
                    makeBook({
                        id: "author-sort-3",
                        title: "Author Sort 3",
                        author: ["Zed", { name: "Yara" }] as unknown as string,
                    }),
                ],
                sortBy: "author",
                sortOrder: "asc",
            });

            expect(ids(asc)).toEqual(["author-sort-1", "author-sort-2", "author-sort-3"]);
        });

        it("sorts by dateAdded and accepts string-based date values", () => {
            const result = runFilter({
                books: [
                    makeBook({
                        id: "date-1",
                        title: "Date 1",
                        addedAt: new Date("2024-01-11T00:00:00.000Z"),
                    }),
                    makeBook({
                        id: "date-2",
                        title: "Date 2",
                        addedAt: "2024-01-09T00:00:00.000Z" as unknown as Date,
                    }),
                    makeBook({
                        id: "date-3",
                        title: "Date 3",
                        addedAt: new Date("2024-01-13T00:00:00.000Z"),
                    }),
                ],
                sortBy: "dateAdded",
                sortOrder: "asc",
            });
            expect(ids(result)).toEqual(["date-2", "date-1", "date-3"]);
        });

        it("sorts by lastRead and treats missing values as zero", () => {
            const asc = runFilter({
                books: [
                    makeBook({
                        id: "read-none",
                        title: "Unread",
                        lastReadAt: undefined,
                    }),
                    makeBook({
                        id: "read-string",
                        title: "Read String",
                        lastReadAt: "2024-01-11T00:00:00.000Z" as unknown as Date,
                    }),
                    makeBook({
                        id: "read-date",
                        title: "Read Date",
                        lastReadAt: new Date("2024-01-15T00:00:00.000Z"),
                    }),
                ],
                sortBy: "lastRead",
                sortOrder: "asc",
            });
            const desc = runFilter({
                books: [
                    makeBook({
                        id: "read-none",
                        title: "Unread",
                        lastReadAt: undefined,
                    }),
                    makeBook({
                        id: "read-string",
                        title: "Read String",
                        lastReadAt: "2024-01-11T00:00:00.000Z" as unknown as Date,
                    }),
                    makeBook({
                        id: "read-date",
                        title: "Read Date",
                        lastReadAt: new Date("2024-01-15T00:00:00.000Z"),
                    }),
                ],
                sortBy: "lastRead",
                sortOrder: "desc",
            });

            expect(ids(asc)).toEqual(["read-none", "read-string", "read-date"]);
            expect(ids(desc)).toEqual(["read-date", "read-string", "read-none"]);
        });

        it("sorts by progress in both directions", () => {
            const asc = runFilter({ books, sortBy: "progress", sortOrder: "asc" });
            const desc = runFilter({ books, sortBy: "progress", sortOrder: "desc" });

            expect(ids(asc)).toEqual(["alpha", "gamma", "beta-book"]);
            expect(ids(desc)).toEqual(["beta-book", "gamma", "alpha"]);
        });

        it("sorts by rating and treats unrated books as zero", () => {
            const asc = runFilter({ books, sortBy: "rating", sortOrder: "asc" });
            const desc = runFilter({ books, sortBy: "rating", sortOrder: "desc" });

            expect(ids(asc)).toEqual(["beta-book", "alpha", "gamma"]);
            expect(ids(desc)).toEqual(["gamma", "alpha", "beta-book"]);
        });

        it("does not mutate the original input array order while sorting", () => {
            const sortableBooks = [
                makeBook({
                    id: "mut-1",
                    title: "C Book",
                    addedAt: new Date("2024-01-03T00:00:00.000Z"),
                }),
                makeBook({
                    id: "mut-2",
                    title: "A Book",
                    addedAt: new Date("2024-01-01T00:00:00.000Z"),
                }),
                makeBook({
                    id: "mut-3",
                    title: "B Book",
                    addedAt: new Date("2024-01-02T00:00:00.000Z"),
                }),
            ];
            const originalOrder = ids(sortableBooks);

            const sorted = runFilter({
                books: sortableBooks,
                sortBy: "title",
                sortOrder: "asc",
            });

            expect(ids(sorted)).toEqual(["mut-2", "mut-3", "mut-1"]);
            expect(ids(sortableBooks)).toEqual(originalOrder);
        });
    });

    describe("unshelved filtering", () => {
        it("filters out books that belong to shelves when showUnshelvedOnly is true", () => {
            const sampleBooks = [
                makeBook({ id: "b1", title: "Book One" }),
                makeBook({ id: "b2", title: "Book Two" }),
                makeBook({ id: "b3", title: "Book Three" }),
            ];
            const shelvedSet = new Set(["b1", "b3"]);

            const result = getFilteredAndSortedBooks({
                books: sampleBooks,
                searchQuery: "",
                selectedShelfBookIds: null,
                showFavoritesOnly: false,
                showUnshelvedOnly: true,
                allShelvedBookIds: shelvedSet,
                statusFilter: "all",
                sortBy: "title",
                sortOrder: "asc",
            });

            expect(ids(result)).toEqual(["b2"]);
        });
    });
});

describe("last-read sort", () => {
    it("puts read books first, newest first, and orders never-opened books by when they were added", () => {
        const books = [
            makeBook({ id: "old-unread", title: "A", addedAt: new Date("2025-01-01T00:00:00Z") }),
            makeBook({ id: "read-1", title: "B", lastReadAt: new Date("2025-03-01T00:00:00Z") }),
            makeBook({ id: "new-unread", title: "C", addedAt: new Date("2025-02-01T00:00:00Z") }),
            makeBook({ id: "read-2", title: "D", lastReadAt: new Date("2025-04-01T00:00:00Z") }),
        ];
        const ids = runFilter({ books, sortBy: "lastRead", sortOrder: "desc" }).map((b) => b.id);
        expect(ids).toEqual(["read-2", "read-1", "new-unread", "old-unread"]);
    });

    it("an unreadable date sorts as never read instead of scrambling the order", () => {
        const books = [
            makeBook({ id: "bad", title: "A", lastReadAt: "not a date" as unknown as Date }),
            makeBook({ id: "read", title: "B", lastReadAt: new Date("2025-04-01T00:00:00Z") }),
            makeBook({ id: "bad-added", title: "C", addedAt: "garbage" as unknown as Date, lastReadAt: new Date("2025-03-01T00:00:00Z") }),
        ];
        const ids = runFilter({ books, sortBy: "lastRead", sortOrder: "desc" }).map((b) => b.id);
        expect(ids).toEqual(["read", "bad-added", "bad"]);
    });
});

describe("retired series sort", () => {
    it("title sort ignores series metadata", () => {
        const books = [
            { ...makeBook({ id: "a", title: "Zeta" }), series: "Beta", seriesIndex: 1 },
            { ...makeBook({ id: "b", title: "Alpha" }), series: "Alpha", seriesIndex: 2 },
        ];
        expect(runFilter({ books, sortBy: "title", sortOrder: "asc" }).map((b) => b.id)).toEqual(["b", "a"]);
    });

    it("a stale persisted series value still returns every book instead of throwing", () => {
        const books = [
            makeBook({ id: "a", title: "Bravo" }),
            makeBook({ id: "b", title: "Alpha" }),
        ];
        const result = runFilter({ books, sortBy: "series" as unknown as LibrarySortBy, sortOrder: "asc" });
        expect(new Set(result.map((b) => b.id))).toEqual(new Set(["a", "b"]));
    });
});
