import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { getFilteredAndSortedBooks } from "../src/features/library/filtering";
import type { Book } from "../src/core";

/**
 * "Sort By → Series" was removed from the Library filter panels. Series metadata
 * itself is untouched — shelves "Group by Series", AssignSeriesModal, the Edit
 * Book modal and the reader's series display all still use it.
 */

function makeBook(overrides: Partial<Book> & Pick<Book, "id" | "title">): Book {
    return {
        id: overrides.id,
        title: overrides.title,
        author: overrides.author ?? "Unknown Author",
        filePath: overrides.filePath ?? `/library/${overrides.id}.epub`,
        format: overrides.format ?? "epub",
        fileSize: 1024,
        addedAt: overrides.addedAt ?? new Date("2025-01-01T00:00:00.000Z"),
        lastReadAt: overrides.lastReadAt,
        progress: overrides.progress ?? 0,
        tags: [],
        isFavorite: false,
        readingTime: 0,
        rating: overrides.rating,
        series: overrides.series,
        seriesIndex: overrides.seriesIndex,
    } as Book;
}

function sortBy_(books: Book[], sortBy: never) {
    return getFilteredAndSortedBooks({
        books,
        searchQuery: "",
        statusFilter: "all",
        // Deliberately passing the retired value at runtime, as stale persisted
        // state would, to prove it cannot crash or silently corrupt ordering.
        sortBy: sortBy as never,
        sortOrder: "asc",
    });
}

describe("library sort no longer offers series", () => {
    it("the type union excludes series", () => {
        const types = readFileSync(resolve("src/core/types/index.ts"), "utf-8");
        const union = types.match(
            /export type LibrarySortBy = ([^;]+);/,
        )?.[1] ?? "";
        expect(union).not.toContain('"series"');
        expect(union).toContain('"title"');
    });

    it("the sync schema rejects series", () => {
        const schemas = readFileSync(resolve("src/core/lib/sync-schemas.ts"), "utf-8");
        const enumValues = schemas.match(
            /librarySortBy: z\.enum\(\[([^\]]+)\]\)/,
        )?.[1] ?? "";
        expect(enumValues).not.toContain('"series"');
    });

    it("neither filter panel lists a Series option", () => {
        const lib = readFileSync(resolve("src/features/library/Library.tsx"), "utf-8");
        expect(lib).not.toContain('{ id: "series", label: "Series" }');
    });

    it("the comparator has no series branch", () => {
        const filtering = readFileSync(resolve("src/features/library/filtering.ts"), "utf-8");
        expect(filtering).not.toContain('case "series"');
    });
});

describe("series metadata survives the sort removal", () => {
    it("is still stored on Book", () => {
        const types = readFileSync(resolve("src/core/types/index.ts"), "utf-8");
        expect(types).toMatch(/series\?: string;/);
        expect(types).toMatch(/seriesIndex\?: number;/);
    });

    it("still powers shelves grouping and the series modal", () => {
        const shelves = readFileSync(resolve("src/features/library/Shelves.tsx"), "utf-8");
        expect(shelves).toContain("groupBySeries");
        expect(shelves).toContain("Group by Series");
        const library = readFileSync(resolve("src/features/library/Library.tsx"), "utf-8");
        expect(library).toContain("AssignSeriesModal");
    });

    it("does not alter ordering for the remaining sort keys", () => {
        const books = [
            makeBook({ id: "a", title: "Zeta", series: "Beta", seriesIndex: 1 }),
            makeBook({ id: "b", title: "Alpha", series: "Alpha", seriesIndex: 2 }),
        ];
        // Title sort must ignore series entirely now.
        expect(sortBy_(books, "title" as never).map(b => b.id)).toEqual(["b", "a"]);
    });

    it("a stale persisted series value cannot crash the sort", () => {
        const books = [
            makeBook({ id: "a", title: "Bravo" }),
            makeBook({ id: "b", title: "Alpha" }),
        ];
        // No `case "series"` means the comparator falls through; ordering must
        // still be stable and total rather than throwing.
        const result = sortBy_(books, "series" as never);
        expect(result).toHaveLength(2);
        expect(new Set(result.map(b => b.id))).toEqual(new Set(["a", "b"]));
    });
});

describe("settings migration for retired series sort", () => {
    it("resets a persisted series sort to the default", () => {
        const store = readFileSync(resolve("src/core/store/settingsStore.ts"), "utf-8");
        expect(store).toContain('state.settings?.librarySortBy === "series"');
        expect(store).toContain(
            "state.settings.librarySortBy = defaultAppSettings.librarySortBy;",
        );
    });

    it("keeps every other persisted sort value untouched", () => {
        const store = readFileSync(resolve("src/core/store/settingsStore.ts"), "utf-8");
        // The guard must be specific, not a blanket reset of librarySortBy.
        expect(store).not.toMatch(/delete state\.settings\.librarySortBy/);
    });
});