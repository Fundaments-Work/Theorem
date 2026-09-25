import { normalizeAuthor } from "../../core/lib/utils";
import { FORMAT_DISPLAY_NAMES } from "../../core/types";
import { rankByFuzzyQuery } from "../../core/lib/search/fuzzy";
import { isWasmCoreReady, wasmFuzzyRank } from "../../core/lib/theorem-core";

import type { Book, LibrarySortBy, LibrarySortOrder, LibraryStatusFilter } from "../../core/types";

export function isBookCompleted(book: Book): boolean {
    if (book.manualCompletionState === "read") return true;
    if (book.manualCompletionState === "unread") return false;
    return !!book.completedAt || book.progress >= 0.99;
}

export interface LibraryFilterOptions {
    books: Book[];
    searchQuery: string;
    selectedShelfBookIds: Set<string> | null;
    showFavoritesOnly: boolean;
    showUnshelvedOnly?: boolean;
    allShelvedBookIds?: Set<string>;
    statusFilter: LibraryStatusFilter;
    sortBy: LibrarySortBy;
    sortOrder: LibrarySortOrder;
    
    ftsSearchIds?: string[];
    /**
     * Desktop/Android: a native (FTS5 + nucleo) query is in flight and there
     * are no native results yet. The list stays unfiltered instead of showing
     * JS fuzzy results that the native ones replace a moment later. JS fuzzy
     * matching is only for the browser build or a failed native call.
     */
    nativeSearchPending?: boolean;
}

export function getFilteredAndSortedBooks({
    books,
    searchQuery,
    selectedShelfBookIds,
    showFavoritesOnly,
    showUnshelvedOnly,
    allShelvedBookIds,
    statusFilter,
    sortBy,
    sortOrder,
    ftsSearchIds,
    nativeSearchPending = false,
}: LibraryFilterOptions): Book[] {
    let searchResults = books;
    const trimmedQuery = searchQuery.trim();

    if (trimmedQuery && !(nativeSearchPending && ftsSearchIds === undefined)) {
        if (ftsSearchIds !== undefined) {
            const bookMap = new Map(books.map((b) => [b.id, b]));
            searchResults = ftsSearchIds
                .map((id) => bookMap.get(id))
                .filter((b): b is Book => b !== undefined);
        } else if (isWasmCoreReady()) {
            // W2: Active WASM Client Hookup — SIMD nucleo-matcher ranking in browser mode
            const candidates = books.map((book) => ({
                id: book.id,
                title: book.title || "",
                author: book.author || undefined,
            }));
            const ranked = wasmFuzzyRank(candidates, trimmedQuery);
            const bookMap = new Map(books.map((b) => [b.id, b]));
            searchResults = ranked
                .map((r) => bookMap.get(r.id))
                .filter((b): b is Book => b !== undefined);
        } else {
            const searchableItems = books.map((book) => ({
                book,
                title: book.title || "",
                author: normalizeAuthor(book.author),
                tags: Array.isArray(book.tags) ? book.tags.join(" ") : "",
                format: `${FORMAT_DISPLAY_NAMES[book.format] || ""} ${book.format || ""}`,
            }));

            const ranked = rankByFuzzyQuery(searchableItems, trimmedQuery, {
                keys: [
                    { name: "title", weight: 0.45 },
                    { name: "author", weight: 0.3 },
                    { name: "tags", weight: 0.15 },
                    { name: "format", weight: 0.1 },
                ],
                threshold: 0.34,
                ignoreLocation: true,
                minMatchCharLength: 2,
            });
            searchResults = ranked.map((r) => r.item.book);
        }
    }

    let result = searchResults;

    if (selectedShelfBookIds) {
        result = result.filter((book) => selectedShelfBookIds.has(book.id));
    } else {
        result = result.filter((book) => !book.tags.includes("rss"));
    }

    if (showFavoritesOnly) {
        result = result.filter((book) => book.isFavorite);
    }

    if (showUnshelvedOnly && allShelvedBookIds) {
        result = result.filter((book) => !allShelvedBookIds.has(book.id));
    }

    if (statusFilter !== "all") {
        result = result.filter((book) => {
            const completed = isBookCompleted(book);
            switch (statusFilter) {
                case "completed":
                    return completed;
                case "reading":
                    return !completed && book.progress > 0;
                case "unread":
                    return !completed && book.progress === 0;
                default:
                    return true;
            }
        });
    }

    if (trimmedQuery) {
        return result;
    }

    // Schwartzian transform: pre-compute timestamps once, sort on numbers,
    // then strip the precomputed fields. Avoids O(n log n) Date allocations
    // that occurred when new Date() was called inside the comparator.
    type WithTimestamps = { book: Book; addedAt: number; lastReadAt: number };
    const decorated: WithTimestamps[] = result.map((book) => ({
        book,
        addedAt: book.addedAt instanceof Date
            ? book.addedAt.getTime()
            : new Date(book.addedAt as string).getTime(),
        lastReadAt: book.lastReadAt
            ? (book.lastReadAt instanceof Date
                ? book.lastReadAt.getTime()
                : new Date(book.lastReadAt as string).getTime())
            : 0,
    }));

    decorated.sort((a, b) => {
        let comparison = 0;

        switch (sortBy) {
            case "title":
                comparison = a.book.title.localeCompare(b.book.title);
                break;
            case "author":
                comparison = normalizeAuthor(a.book.author).localeCompare(normalizeAuthor(b.book.author));
                break;
            case "dateAdded":
                comparison = a.addedAt - b.addedAt;
                break;
            case "lastRead":
                comparison = a.lastReadAt - b.lastReadAt;
                break;
            case "progress":
                comparison = a.book.progress - b.book.progress;
                break;
            case "rating": {
                const aRating = a.book.rating || 0;
                const bRating = b.book.rating || 0;
                comparison = aRating - bRating;
                break;
            }
        }

        return sortOrder === "asc" ? comparison : -comparison;
    });

    return decorated.map((d) => d.book);

}
