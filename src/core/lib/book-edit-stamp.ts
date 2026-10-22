import type { Book } from "../types";

/**
 * The book details a user edits. Sync treats them as one unit: the side
 * with the newer `metadataUpdatedAt` wins all of them, removals included.
 * Reading progress is not here; it follows `lastReadAt`.
 */
export const BOOK_EDITABLE_FIELDS = [
    "title",
    "author",
    "description",
    "publisher",
    "language",
    "isbn",
    "publishedDate",
    "category",
    "isFavorite",
    "tags",
    "rating",
    "completedAt",
    "manualCompletionState",
    "series",
    "seriesIndex",
] as const satisfies readonly (keyof Book)[];

function sameValue(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (a instanceof Date || b instanceof Date) {
        const ta = a ? new Date(a as Date | string).getTime() : NaN;
        const tb = b ? new Date(b as Date | string).getTime() : NaN;
        return ta === tb || (Number.isNaN(ta) && Number.isNaN(tb) && !a && !b);
    }
    if (Array.isArray(a) && Array.isArray(b)) {
        return a.length === b.length && a.every((x, i) => x === b[i]);
    }
    return false;
}

/**
 * `after` with `metadataUpdatedAt` set to `now` if a user-editable detail
 * changed, and `metadataBaseAt` to the stamp of the version it was edited
 * from: with it, sync tells an edit made after seeing another device's
 * from one made without seeing it (a conflict, listed for the user).
 */
export function withMetadataStamp(before: Book, after: Book, now: Date = new Date()): Book {
    if (after === before) return after;
    const edited = BOOK_EDITABLE_FIELDS.some((field) => !sameValue(before[field], after[field]));
    if (!edited) return after;
    const { metadataBaseAt: _previousBase, ...rest } = after;
    return {
        ...rest,
        metadataUpdatedAt: now.toISOString(),
        ...(before.metadataUpdatedAt ? { metadataBaseAt: before.metadataUpdatedAt } : {}),
    };
}
