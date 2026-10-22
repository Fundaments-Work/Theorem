/**
 * Undoing an edit must sync too. A user's edits to a book's details are
 * stamped (metadataUpdatedAt), and the newer stamped side wins them as a
 * unit, so removing a favourite, a tag or a rating, or marking a book unread,
 * is not merged back by an older copy on another device.
 */
import { describe, it, expect } from "vitest";
import type { Book } from "../src/core/types";
import { mergeBooks } from "../src/core/lib/sync-import";
import { withMetadataStamp } from "../src/core/lib/book-edit-stamp";

function book(overrides: Partial<Book> = {}): Book {
    return {
        id: "b1",
        title: "Dune",
        author: "Frank Herbert",
        filePath: "/library/b1.epub",
        format: "epub",
        fileSize: 1,
        addedAt: new Date("2025-01-01"),
        progress: 0.2,
        tags: [],
        isFavorite: false,
        readingTime: 0,
        ...overrides,
    } as Book;
}

const EARLY = "2026-05-01T00:00:00.000Z";
const LATE = "2026-06-01T00:00:00.000Z";

describe("withMetadataStamp", () => {
    const now = new Date(LATE);

    it("stamps edits to the book's details", () => {
        for (const change of [
            { isFavorite: true },
            { tags: ["sf"] },
            { rating: 4 },
            { title: "Dune (Deluxe)" },
            { completedAt: new Date(EARLY) },
            { manualCompletionState: "unread" as const },
            { series: "Dune", seriesIndex: 1 },
        ]) {
            const before = book();
            expect(withMetadataStamp(before, { ...before, ...change }, now).metadataUpdatedAt).toBe(LATE);
        }
    });

    it("does not stamp reading progress, file moves or no-op rewrites", () => {
        const before = book({ tags: ["a"], completedAt: new Date(EARLY) });
        for (const change of [
            { progress: 0.9, currentLocation: "x", lastReadAt: new Date() },
            { filePath: "/elsewhere.epub", syncedWithoutFile: false },
            { tags: ["a"] },
            { completedAt: new Date(EARLY) },
        ]) {
            expect(withMetadataStamp(before, { ...before, ...change }, now).metadataUpdatedAt).toBeUndefined();
        }
        expect(withMetadataStamp(before, before, now)).toBe(before);
    });
});

describe("edits record the version they were made on", () => {
    it("the first edit has no base; each later one is based on the previous stamp", () => {
        const first = withMetadataStamp(book(), book({ isFavorite: true }), new Date(EARLY));
        expect(first.metadataUpdatedAt).toBe(EARLY);
        expect(first.metadataBaseAt).toBeUndefined();
        const second = withMetadataStamp(first, { ...first, tags: ["sf"] }, new Date(LATE));
        expect(second.metadataUpdatedAt).toBe(LATE);
        expect(second.metadataBaseAt).toBe(EARLY);
    });

    it("a base copied along with other fields never survives an edit", () => {
        const before = book({ metadataUpdatedAt: EARLY });
        const edited = withMetadataStamp(before, { ...before, title: "New", metadataBaseAt: "1999-01-01T00:00:00.000Z" }, new Date(LATE));
        expect(edited.metadataBaseAt).toBe(EARLY);
        const unstamped = withMetadataStamp(book(), { ...book(), title: "New", metadataBaseAt: "1999-01-01T00:00:00.000Z" }, new Date(LATE));
        expect(unstamped.metadataBaseAt).toBeUndefined();
    });

    it("the winning side's base travels with its edit", () => {
        const local = book({ title: "Mine", metadataUpdatedAt: EARLY });
        const remote = book({ title: "Theirs", metadataUpdatedAt: LATE, metadataBaseAt: EARLY });
        const [merged] = mergeBooks([remote], [local]);
        expect(merged.metadataBaseAt).toBe(EARLY);
        const [kept] = mergeBooks([book({ title: "Old", metadataUpdatedAt: "2026-04-01T00:00:00.000Z" })], [remote]);
        expect(kept.metadataUpdatedAt).toBe(LATE);
        expect(kept.metadataBaseAt).toBe(EARLY);
    });
});

describe("mergeBooks with edit stamps", () => {
    it("a newer unfavourite, untag and unrate reach the other device", () => {
        const local = book({ isFavorite: true, tags: ["sf", "classic"], rating: 5, metadataUpdatedAt: EARLY });
        const remote = book({ isFavorite: false, tags: ["sf"], rating: undefined, metadataUpdatedAt: LATE });
        const [merged] = mergeBooks([remote], [local]);
        expect(merged.isFavorite).toBe(false);
        expect(merged.tags).toEqual(["sf"]);
        expect(merged.rating).toBeUndefined();
        expect(merged.metadataUpdatedAt).toBe(LATE);
    });

    it("an older copy does not undo a newer local edit", () => {
        const local = book({ title: "Dune Messiah", isFavorite: false, tags: [], metadataUpdatedAt: LATE });
        const remote = book({ title: "Dune", isFavorite: true, tags: ["old"], rating: 3, metadataUpdatedAt: EARLY });
        const [merged] = mergeBooks([remote], [local]);
        expect(merged.title).toBe("Dune Messiah");
        expect(merged.isFavorite).toBe(false);
        expect(merged.tags).toEqual([]);
        expect(merged.rating).toBeUndefined();
        expect(merged.metadataUpdatedAt).toBe(LATE);
    });

    it("marking a book unread on another device sticks", () => {
        const local = book({ completedAt: new Date(EARLY), manualCompletionState: "read", progressBeforeFinish: 0.4, metadataUpdatedAt: EARLY });
        const remote = book({ completedAt: undefined, manualCompletionState: "unread", progressBeforeFinish: undefined, metadataUpdatedAt: LATE });
        const [merged] = mergeBooks([remote], [local]);
        expect(merged.completedAt).toBeUndefined();
        expect(merged.manualCompletionState).toBe("unread");
        expect(merged.progressBeforeFinish).toBeUndefined();
    });

    it("a stamped side wins over an unstamped copy from an older app version", () => {
        const local = book({ isFavorite: false, tags: [], metadataUpdatedAt: EARLY });
        const legacy = book({ isFavorite: true, tags: ["legacy"] });
        const [merged] = mergeBooks([legacy], [local]);
        expect(merged.isFavorite).toBe(false);
        expect(merged.tags).toEqual([]);
    });

    it("never leaves a book without a title, even if the winner sent none", () => {
        const local = book({ title: "Dune", metadataUpdatedAt: EARLY });
        const remote = book({ title: "", metadataUpdatedAt: LATE });
        const [merged] = mergeBooks([remote], [local]);
        expect(merged.title).toBe("Dune");
    });

    it("reading position still follows the newer read, separately from edits", () => {
        const local = book({ progress: 0.8, currentLocation: "ch9", lastReadAt: new Date(LATE), metadataUpdatedAt: EARLY });
        const remote = book({ progress: 0.1, currentLocation: "ch1", lastReadAt: new Date(EARLY), isFavorite: true, metadataUpdatedAt: LATE });
        const [merged] = mergeBooks([remote], [local]);
        expect(merged.progress).toBe(0.8);
        expect(merged.currentLocation).toBe("ch9");
        expect(merged.isFavorite).toBe(true);
    });
});

describe("library actions stamp edits", () => {
    it("toggling a favourite, marking unread and editing tags stamp the book; reading does not", async () => {
        const { useLibraryStore } = await import("../src/core/store");
        useLibraryStore.setState({ books: [book({ completedAt: new Date(EARLY), manualCompletionState: "read" })] });
        const stamp = () => useLibraryStore.getState().books[0].metadataUpdatedAt;

        useLibraryStore.getState().updateProgress("b1", 0.5, "ch3");
        expect(stamp()).toBeUndefined();

        useLibraryStore.getState().toggleFavorite("b1");
        const afterFavourite = stamp();
        expect(afterFavourite).toBeDefined();

        useLibraryStore.getState().updateBook("b1", { tags: ["sf"] });
        expect(stamp()).toBeDefined();

        useLibraryStore.setState({ books: [book({ completedAt: new Date(EARLY), manualCompletionState: "read" })] });
        useLibraryStore.getState().markBooksUnread(["b1"]);
        expect(useLibraryStore.getState().books[0].manualCompletionState).toBe("unread");
        expect(stamp()).toBeDefined();
    });
});
