import { beforeEach, describe, expect, it } from "vitest";
import { useLibraryStore } from "../src/core/store";
import type { Book } from "../src/core/types";
function book(id: string): Book {
    return {id,title:id,author:"Author",format:"epub",filePath:`/${id}.epub`,fileSize:10,addedAt:new Date("2026-01-01"),progress:0.4,currentLocation:"saved-position",tags:[],isFavorite:false,readingTime:12};
}
beforeEach(() => useLibraryStore.setState({books:[],recentBooksCache:[]}));
describe("continue reading history", () => {
    it("records a successful open without changing the saved reading position", () => {
        useLibraryStore.getState().addBook(book("a"));
        useLibraryStore.getState().recordBookOpened("a");
        expect(useLibraryStore.getState().recentBooksCache.map(b => b.id)).toEqual(["a"]);
        expect(useLibraryStore.getState().getBook("a")).toMatchObject({progress:0.4,currentLocation:"saved-position",readingTime:12,lastReadAt:expect.any(Date)});
    });
    it("moves a reopened book to the front without duplicating it", () => {
        useLibraryStore.getState().addBooks([book("a"),book("b")]);
        for (const id of ["a","b","a"]) useLibraryStore.getState().recordBookOpened(id);
        expect(useLibraryStore.getState().recentBooksCache.map(b => b.id)).toEqual(["a","b"]);
    });
    it("keeps the existing bounded recent cache", () => {
        useLibraryStore.getState().addBooks(Array.from({length:25},(_,i) => book(String(i))));
        for (let i=0;i<25;i++) useLibraryStore.getState().recordBookOpened(String(i));
        expect(useLibraryStore.getState().recentBooksCache).toHaveLength(20);
        expect(useLibraryStore.getState().recentBooksCache[0].id).toBe("24");
    });
    it("ignores missing and removed books without resurrecting them", () => {
        useLibraryStore.getState().recordBookOpened("missing");
        expect(useLibraryStore.getState().recentBooksCache).toEqual([]);
        useLibraryStore.getState().addBook(book("a"));
        useLibraryStore.getState().recordBookOpened("a");
        useLibraryStore.getState().removeBook("a");
        useLibraryStore.getState().recordBookOpened("a");
        expect(useLibraryStore.getState().getBook("a")).toBeUndefined();
        expect(useLibraryStore.getState().recentBooksCache).toEqual([]);
    });
});
