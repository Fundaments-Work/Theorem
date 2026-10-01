import { describe, it, expect, beforeEach } from "vitest";
import { useLibraryStore } from "../src/core/store";
import { isBookMarkedRead } from "../src/core/lib/utils";
import type { Book, Collection } from "../src/core/types";

describe("Series support in library and reader", () => {
    beforeEach(() => {
        useLibraryStore.setState({
            books: [],
            collections: [],
            readingProgress: {},
        });
    });

    it("evaluates isBookMarkedRead correctly for edge cases", () => {
        expect(isBookMarkedRead({})).toBe(false);
        expect(isBookMarkedRead({ progress: 0 })).toBe(false);
        expect(isBookMarkedRead({ progress: 0.5 })).toBe(false);
        expect(isBookMarkedRead({ progress: 0.989 })).toBe(false);
        expect(isBookMarkedRead({ progress: 0.99 })).toBe(true);
        expect(isBookMarkedRead({ progress: 1.0 })).toBe(true);
        expect(isBookMarkedRead({ completedAt: new Date() })).toBe(true);
        expect(isBookMarkedRead({ completedAt: "2026-01-01T00:00:00Z" })).toBe(true);
        expect(isBookMarkedRead({ completedAt: null, progress: 0.1 })).toBe(false);
    });

    it("groups books by series and sorts volumes by seriesIndex", () => {
        const books: Book[] = [
            {
                id: "b3",
                title: "Children of Dune",
                series: "Dune",
                seriesIndex: 3,
                format: "epub",
                fileSize: 100,
                readingTime: 0,
                addedAt: new Date(),
                tags: [],
            },
            {
                id: "b1",
                title: "Dune",
                series: "Dune",
                seriesIndex: 1,
                format: "epub",
                fileSize: 100,
                readingTime: 0,
                addedAt: new Date(),
                tags: [],
            },
            {
                id: "b2",
                title: "Dune Messiah",
                series: "Dune",
                seriesIndex: 2,
                format: "epub",
                fileSize: 100,
                readingTime: 0,
                addedAt: new Date(),
                tags: [],
            },
            {
                id: "b4",
                title: "The Hobbit",
                format: "epub",
                fileSize: 100,
                readingTime: 0,
                addedAt: new Date(),
                tags: [],
            },
        ];

        const seriesMap = new Map<string, Book[]>();
        const standalone: Book[] = [];

        for (const book of books) {
            if (book.series) {
                const group = seriesMap.get(book.series);
                if (group) group.push(book);
                else seriesMap.set(book.series, [book]);
            } else {
                standalone.push(book);
            }
        }

        for (const group of seriesMap.values()) {
            group.sort((a, b) => (a.seriesIndex ?? Infinity) - (b.seriesIndex ?? Infinity));
        }

        expect(seriesMap.has("Dune")).toBe(true);
        const duneSeries = seriesMap.get("Dune")!;
        expect(duneSeries).toHaveLength(3);
        expect(duneSeries[0].id).toBe("b1");
        expect(duneSeries[1].id).toBe("b2");
        expect(duneSeries[2].id).toBe("b3");
        expect(standalone).toHaveLength(1);
        expect(standalone[0].id).toBe("b4");
    });

    it("resolves the next unread volume in a series upon completing a book", () => {
        const seriesBooks: Book[] = [
            {
                id: "vol-1",
                title: "The Fellowship of the Ring",
                series: "The Lord of the Rings",
                seriesIndex: 1,
                progress: 1.0,
                completedAt: new Date(),
                format: "epub",
                fileSize: 100,
                readingTime: 0,
                addedAt: new Date(),
                tags: [],
            },
            {
                id: "vol-2",
                title: "The Two Towers",
                series: "The Lord of the Rings",
                seriesIndex: 2,
                progress: 0.1,
                format: "epub",
                fileSize: 100,
                readingTime: 0,
                addedAt: new Date(),
                tags: [],
            },
            {
                id: "vol-3",
                title: "The Return of the King",
                series: "The Lord of the Rings",
                seriesIndex: 3,
                progress: 0,
                format: "epub",
                fileSize: 100,
                readingTime: 0,
                addedAt: new Date(),
                tags: [],
            },
        ];

        const completedBook = seriesBooks[0];
        const seriesName = completedBook.series!.trim().toLowerCase();

        const candidateSeries = seriesBooks
            .filter((b) => b.series?.trim().toLowerCase() === seriesName && b.id !== completedBook.id)
            .sort((a, b) => (a.seriesIndex ?? Infinity) - (b.seriesIndex ?? Infinity));

        const currentIdx = completedBook.seriesIndex ?? -1;
        const nextBook =
            candidateSeries.find((b) => b.seriesIndex != null && b.seriesIndex > currentIdx && !isBookMarkedRead(b)) ||
            candidateSeries.find((b) => !isBookMarkedRead(b));

        expect(nextBook).toBeDefined();
        expect(nextBook?.id).toBe("vol-2");
        expect(nextBook?.seriesIndex).toBe(2);
    });

    it("updates book metadata with series name and volume index in libraryStore", () => {
        const store = useLibraryStore.getState();
        const testBook: Book = {
            id: "book-series-test",
            title: "Foundation",
            format: "epub",
            fileSize: 100,
            readingTime: 0,
            addedAt: new Date(),
            tags: [],
        };

        store.addBook(testBook);

        store.updateBookMetadata("book-series-test", {
            series: "Foundation Universe",
            seriesIndex: 1,
        });

        const updated = useLibraryStore.getState().getBook("book-series-test");
        expect(updated?.series).toBe("Foundation Universe");
        expect(updated?.seriesIndex).toBe(1);
    });

    it("updates collection groupBySeries toggle in libraryStore", () => {
        const store = useLibraryStore.getState();
        const testCollection: Collection = {
            id: "shelf-sci-fi",
            name: "Sci-Fi Series",
            bookIds: ["b1", "b2"],
            kind: "general",
            createdAt: new Date(),
            updatedAt: new Date(),
            groupBySeries: false,
        };

        useLibraryStore.setState({ collections: [testCollection] });

        store.updateCollection("shelf-sci-fi", { groupBySeries: true });

        const updated = useLibraryStore.getState().collections.find((c) => c.id === "shelf-sci-fi");
        expect(updated?.groupBySeries).toBe(true);
    });
});
