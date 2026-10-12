import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFilteredSelection } from "../src/features/library/useFilteredSelection";
import { getFilteredAndSortedBooks } from "../src/features/library/filtering";
import { BookCard } from "../src/features/library/Library";
import { useUIStore, useLibraryStore } from "../src/core/store";
import type { Book, LibraryViewMode } from "../src/core/types";

vi.mock("../src/ui", () => ({
    ContextMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    TheoremBookCover: () => <span>Cover</span>,
    HighlightMatch: ({ text }: { text: string }) => <span>{text}</span>,
}));
let host: HTMLDivElement;
let root: Root;
let selection: ReturnType<typeof useFilteredSelection>;
const book = (id: string, extra: Partial<Book> = {}): Book => ({ id, title: id, author: "Author", filePath: id,
    format: "pdf", fileSize: 1, addedAt: new Date(), progress: 0, readingTime: 0, tags: [], isFavorite: false, ...extra });
const books = [book("a"), book("b"), book("c")];
function Harness({ items = books, scope = "all", enabled = true, ready = true }: {
    items?: Book[]; scope?: string; enabled?: boolean; ready?: boolean;
}) { selection = useFilteredSelection(items, scope, enabled, ready); return null; }
const render = (props: React.ComponentProps<typeof Harness> = {}) => act(() => root.render(<Harness {...props} />));
beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    useUIStore.getState().clearSelection();
    useLibraryStore.setState({ books: [], collections: [] });
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); });

describe("filtered bulk selection", () => {
    it("starts a fresh selection when mounting with leftover global IDs", () => {
        useUIStore.getState().setSelectedBooks(["a", "missing"]);
        render();
        expect(selection.selectedBooks).toEqual([]);
        expect(useUIStore.getState().selectedBooks).toEqual([]);
    });
    it("selects every filtered result, including off-screen virtualized rows", () => {
        const items = Array.from({ length: 500 }, (_, i) => book(String(i)));
        render({ items }); act(() => selection.selectAll());
        expect(selection.selectedBooks).toEqual(items.map(b => b.id));
        expect(selection.allSelected).toBe(true);
        act(() => { selection.clearSelection(); });
        expect(selection.selectedBooks).toEqual([]);
    });
    it("honors combined shelf, source folder, favorites, status, and search filters", () => {
        const items = [book("a", { isFavorite: true }), book("b", { isFavorite: true, progress: 1 }), book("c")];
        const filtered = getFilteredAndSortedBooks({ books: items, searchQuery: "a", ftsSearchIds: ["a", "b"],
            selectedShelfBookIds: new Set(["a", "b"]), sourceFolderBookIds: new Set(["a", "c"]),
            showFavoritesOnly: true, statusFilter: "unread", sortBy: "title", sortOrder: "asc" });
        render({ items: filtered }); act(() => selection.selectAll());
        expect(selection.selectedBooks).toEqual(["a"]);
    });
    it("clears selection when changing filters, including overlapping results", () => {
        render(); act(() => selection.selectAll());
        render({ items: books.slice(0, 2), scope: "shelf" });
        expect(selection.selectedBooks).toEqual([]);
        expect(useUIStore.getState().selectedBooks).toEqual([]);
        act(() => selection.selectAll());
        render({ scope: "all" });
        expect(selection.selectedBooks).toEqual([]);
    });
    it("retains selection on sorting and never automatically selects newly imported books", () => {
        render({ items: books.slice(0, 2) }); act(() => selection.selectAll());
        render({ items: [...books].reverse() });
        expect(selection.selectedBooks).toEqual(["a", "b"]);
        expect(selection.allSelected).toBe(false);
    });
    it("prunes deleted or newly hidden books and does not restore them later", () => {
        render(); act(() => selection.selectAll());
        render({ items: books.slice(1) });
        expect(selection.selectedBooks).toEqual(["b", "c"]);
        expect(useUIStore.getState().selectedBooks).toEqual(["b", "c"]);
        render(); expect(selection.selectedBooks).toEqual(["b", "c"]);
    });
    it("blocks selecting stale results while a search is pending", () => {
        render(); act(() => selection.selectAll());
        render({ scope: "search", ready: false });
        act(() => { selection.selectAll(); selection.toggleBookSelection("a"); });
        expect(selection.selectedBooks).toEqual([]);
        render({ scope: "search", items: [books[1]], ready: true });
        act(() => selection.selectAll()); expect(selection.selectedBooks).toEqual(["b"]);
    });
    it("handles empty views, rapid toggles, and IDs outside the filtered result", () => {
        render();
        act(() => { selection.toggleBookSelection("a"); selection.toggleBookSelection("a"); selection.toggleBookSelection("missing"); });
        expect(selection.selectedBooks).toEqual([]);
        render({ items: [] }); act(() => selection.selectAll());
        expect(selection.allSelected).toBe(false);
    });
    it("clears selection when leaving selection mode or unmounting", () => {
        render(); act(() => selection.selectAll()); render({ enabled: false });
        expect(useUIStore.getState().selectedBooks).toEqual([]);
        render(); act(() => selection.selectAll()); act(() => root.render(null));
        expect(useUIStore.getState().selectedBooks).toEqual([]);
    });
});

describe("accessible book selection", () => {
    const callbacks = () => ({ onOpenBook: vi.fn(), onToggleFavorite: vi.fn(), onDeleteBook: vi.fn(), onShowInfo: vi.fn(),
        onAddToShelf: vi.fn(), onRename: vi.fn(), onExport: vi.fn(), onMarkAsRead: vi.fn(), onMarkAsUnread: vi.fn(), onToggleSelect: vi.fn() });
    it.each(["grid", "list", "compact"] as LibraryViewMode[])("toggles with Space and Enter in %s view without opening the reader", (viewMode) => {
        const handlers = callbacks();
        act(() => root.render(<BookCard book={books[0]} viewMode={viewMode} {...handlers} isSelecting isSelected />));
        const card = host.querySelector('[role="checkbox"]')!;
        expect(card.getAttribute("aria-checked")).toBe("true");
        for (const key of [" ", "Enter"]) act(() => { card.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })); });
        expect(handlers.onToggleSelect).toHaveBeenCalledTimes(2);
        expect(handlers.onOpenBook).not.toHaveBeenCalled();
        act(() => (card as HTMLElement).click());
        expect(handlers.onToggleSelect).toHaveBeenCalledTimes(3);
    });
    it("cancels a pending open when selection mode starts", () => {
        vi.useFakeTimers(); const handlers = callbacks();
        act(() => root.render(<BookCard book={books[0]} viewMode="grid" {...handlers} />));
        act(() => (host.querySelector('[role="button"]') as HTMLElement).click());
        act(() => root.render(<BookCard book={books[0]} viewMode="grid" {...handlers} isSelecting />));
        act(() => vi.advanceTimersByTime(300)); expect(handlers.onOpenBook).not.toHaveBeenCalled();
    });
});
