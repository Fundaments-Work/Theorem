import { normalizeAuthor } from "../../core/lib/utils";
import { FORMAT_DISPLAY_NAMES } from "../../core/types";
import { joinFields } from "../../core/lib/search/native-rank";
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
     * WebAssembly results that the native ones replace a moment later. The
     * WebAssembly matcher (the same Rust code) is for the browser build or a
     * failed native call.
     */
    nativeSearchPending?: boolean;
    sourceFolderBookIds?: Set<string>;
}

/** A date as milliseconds; missing or unreadable dates count as 0 so the sort stays consistent. */
function toTime(value: Date | string | undefined): number {
    if (!value) return 0;
    const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
    return Number.isFinite(time) ? time : 0;
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
    sourceFolderBookIds,
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
            // Browser build (or failed native call): the nucleo matcher compiled to
            // WebAssembly. Author, tags and format share its second field.
            const candidates = books.map((book) => ({
                id: book.id,
                title: book.title || "",
                author: joinFields(
                    normalizeAuthor(book.author),
                    ...(Array.isArray(book.tags) ? book.tags : []),
                    FORMAT_DISPLAY_NAMES[book.format],
                    book.format,
                ) || undefined,
            }));
            const ranked = wasmFuzzyRank(candidates, trimmedQuery);
            const bookMap = new Map(books.map((b) => [b.id, b]));
            searchResults = ranked
                .map((r) => bookMap.get(r.id))
                .filter((b): b is Book => b !== undefined);
        }
        // Otherwise the WebAssembly matcher is still loading (Library starts it
        // when native search is unavailable): the list stays unfiltered for that
        // moment rather than being ranked by a second, JavaScript matcher.
    }

    let result = sourceFolderBookIds ? searchResults.filter((book) => sourceFolderBookIds.has(book.id)) : searchResults;

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
        addedAt: toTime(book.addedAt),
        lastReadAt: toTime(book.lastReadAt),
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
                // Never-opened books tie at 0; order those by when they were added.
                comparison = a.lastReadAt - b.lastReadAt || a.addedAt - b.addedAt;
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
