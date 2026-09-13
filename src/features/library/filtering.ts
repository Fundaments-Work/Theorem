import { normalizeAuthor } from "../../core/lib/utils";
import { FORMAT_DISPLAY_NAMES } from "../../core/types";
import { rankByFuzzyQuery } from "../../core/lib/search/fuzzy";

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
}: LibraryFilterOptions): Book[] {
    let searchResults = books;
    const trimmedQuery = searchQuery.trim();

    if (trimmedQuery) {
        if (ftsSearchIds !== undefined) {
            const bookMap = new Map(books.map((b) => [b.id, b]));
            searchResults = ftsSearchIds
                .map((id) => bookMap.get(id))
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

    const sorted = [...result];
    sorted.sort((a, b) => {
        let comparison = 0;

        switch (sortBy) {
            case "title":
                comparison = a.title.localeCompare(b.title);
                break;
            case "author":
                comparison = normalizeAuthor(a.author).localeCompare(normalizeAuthor(b.author));
                break;
            case "dateAdded": {
                const aAdded = a.addedAt instanceof Date ? a.addedAt : new Date(a.addedAt);
                const bAdded = b.addedAt instanceof Date ? b.addedAt : new Date(b.addedAt);
                comparison = aAdded.getTime() - bAdded.getTime();
                break;
            }
            case "lastRead": {
                const aLastRead = a.lastReadAt
                    ? (a.lastReadAt instanceof Date ? a.lastReadAt : new Date(a.lastReadAt))
                    : null;
                const bLastRead = b.lastReadAt
                    ? (b.lastReadAt instanceof Date ? b.lastReadAt : new Date(b.lastReadAt))
                    : null;
                const aTime = aLastRead?.getTime() || 0;
                const bTime = bLastRead?.getTime() || 0;
                comparison = aTime - bTime;
                break;
            }
            case "progress":
                comparison = a.progress - b.progress;
                break;
            case "rating": {
                const aRating = a.rating || 0;
                const bRating = b.rating || 0;
                comparison = aRating - bRating;
                break;
            }
        }

        return sortOrder === "asc" ? comparison : -comparison;
    });

    return sorted;
}
