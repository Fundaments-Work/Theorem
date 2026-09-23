import { describe, expect, it } from "vitest";
import { getFilteredAndSortedBooks } from "../src/features/library/filtering";
import type { Book } from "../src/core/types";

const book = (id: string, title: string) => ({ id, title, author: "A", format: "epub", tags: [], addedAt: new Date(0) }) as unknown as Book;
const books = [book("1", "Dune"), book("2", "Emma"), book("3", "Dunes of Arrakis")];
const base = {
    books,
    selectedShelfBookIds: null,
    showFavoritesOnly: false,
    showUnshelvedOnly: false,
    allShelvedBookIds: new Set<string>(),
    statusFilter: "all",
    sortBy: "title",
    sortOrder: "asc",
} as unknown as Parameters<typeof getFilteredAndSortedBooks>[0];

const ids = (list: Book[]) => list.map((b) => b.id).sort();

describe("library search: native vs JS matching", () => {
    it("while a native query is pending, the list stays unfiltered (no JS fuzzy flash)", () => {
        expect(ids(getFilteredAndSortedBooks({ ...base, searchQuery: "dune", nativeSearchPending: true }))).toEqual(["1", "2", "3"]);
    });

    it("native results win once they arrive, in native order", () => {
        const result = getFilteredAndSortedBooks({ ...base, searchQuery: "dune", nativeSearchPending: true, ftsSearchIds: ["3", "missing", "1"] });
        expect(ids(result)).toEqual(["1", "3"]);
    });

    it("an empty native result means no matches, not a fallback", () => {
        expect(getFilteredAndSortedBooks({ ...base, searchQuery: "zzz", nativeSearchPending: true, ftsSearchIds: [] })).toEqual([]);
    });

    it("browser build or failed native call uses JS matching", () => {
        expect(ids(getFilteredAndSortedBooks({ ...base, searchQuery: "dune" }))).toEqual(["1", "3"]);
    });
});
