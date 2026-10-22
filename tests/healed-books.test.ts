import { describe, expect, it, vi } from "vitest";
import type { Book } from "../src/core/types";
import {
    HEALED_BOOKS_WAIT_MS,
    applyHealedBooks,
    applyHealedBooksWhenLoaded,
    parseHealedBooks,
} from "../src/core/lib/healed-books";

function book(id: string, syncedWithoutFile?: boolean): Book {
    return { id, title: id, author: "A", syncedWithoutFile } as unknown as Book;
}

function library(initial: Book[]) {
    const books = new Map(initial.map((b) => [b.id, b]));
    const listeners = new Set<() => void>();
    const updateBook = vi.fn((id: string, updates: Partial<Book>) => {
        const current = books.get(id);
        if (current) books.set(id, { ...current, ...updates });
    });
    return {
        books,
        updateBook,
        getBook: (id: string) => books.get(id),
        subscribeBooks: (listener: () => void) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        load: (b: Book) => {
            books.set(b.id, b);
            for (const l of [...listeners]) l();
        },
        listenerCount: () => listeners.size,
    };
}

describe("parseHealedBooks", () => {
    it("keeps only well-formed entries", () => {
        expect(parseHealedBooks(null)).toEqual([]);
        expect(parseHealedBooks({ id: "a" })).toEqual([]);
        expect(
            parseHealedBooks([
                { id: "a", storagePath: "/c/a.book" },
                { id: "", storagePath: "/c/x.book" },
                { id: "b" },
                { id: 3, storagePath: "/c/3.book" },
                "junk",
            ]),
        ).toEqual([{ id: "a", storagePath: "/c/a.book" }]);
    });
});

describe("applyHealedBooks", () => {
    it("clears the flag and sets the cache path on flagged books", () => {
        const lib = library([book("a", true)]);
        expect(applyHealedBooks([{ id: "a", storagePath: "/c/a.book" }], lib)).toEqual([]);
        expect(lib.updateBook).toHaveBeenCalledWith("a", { syncedWithoutFile: false, storagePath: "/c/a.book" });
        expect(lib.books.get("a")?.syncedWithoutFile).toBe(false);
    });

    it("writes nothing for a book whose flag is already clear", () => {
        const lib = library([book("a", false), book("b")]);
        applyHealedBooks(
            [
                { id: "a", storagePath: "/c/a.book" },
                { id: "b", storagePath: "/c/b.book" },
            ],
            lib,
        );
        expect(lib.updateBook).not.toHaveBeenCalled();
    });

    it("reports books the library does not hold", () => {
        const lib = library([]);
        expect(applyHealedBooks([{ id: "a", storagePath: "/c/a.book" }], lib)).toEqual([
            { id: "a", storagePath: "/c/a.book" },
        ]);
    });

    it("an empty list does nothing", () => {
        const lib = library([book("a", true)]);
        expect(applyHealedBooks([], lib)).toEqual([]);
        expect(lib.updateBook).not.toHaveBeenCalled();
    });
});

describe("applyHealedBooksWhenLoaded", () => {
    it("applies at once and does not wait when every book is loaded", () => {
        const lib = library([book("a", true)]);
        applyHealedBooksWhenLoaded([{ id: "a", storagePath: "/c/a.book" }], lib);
        expect(lib.updateBook).toHaveBeenCalledTimes(1);
        expect(lib.listenerCount()).toBe(0);
    });

    it("event before the library loaded: applies once the book appears", () => {
        const lib = library([]);
        applyHealedBooksWhenLoaded([{ id: "a", storagePath: "/c/a.book" }], lib);
        expect(lib.listenerCount()).toBe(1);
        lib.load(book("other", true));
        expect(lib.updateBook).not.toHaveBeenCalled();
        lib.load(book("a", true));
        expect(lib.updateBook).toHaveBeenCalledWith("a", { syncedWithoutFile: false, storagePath: "/c/a.book" });
        expect(lib.listenerCount()).toBe(0);
    });

    it("gives up on a book that never loads (deleted meanwhile)", () => {
        vi.useFakeTimers();
        try {
            const lib = library([]);
            applyHealedBooksWhenLoaded([{ id: "gone", storagePath: "/c/gone.book" }], lib);
            vi.advanceTimersByTime(HEALED_BOOKS_WAIT_MS);
            expect(lib.listenerCount()).toBe(0);
            lib.load(book("gone", true));
            expect(lib.updateBook).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it("cleanup stops waiting", () => {
        const lib = library([]);
        const stop = applyHealedBooksWhenLoaded([{ id: "a", storagePath: "/c/a.book" }], lib);
        stop();
        expect(lib.listenerCount()).toBe(0);
    });
});
