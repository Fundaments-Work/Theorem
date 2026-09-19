import { describe, expect, it, beforeEach, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { BookCard } from "../src/features/library/Library";
import type { Book, LibraryViewMode } from "../src/core/types";

// @ts-expect-error React act environment flag
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function makeBook(): Book {
    return {
        id: "book-1",
        title: "Dune",
        author: "Frank Herbert",
        format: "epub",
        filePath: "/books/dune.epub",
        progress: 0,
        isFavorite: false,
    } as unknown as Book;
}

const noop = () => {};

interface CardProps {
    book: Book;
    viewMode: LibraryViewMode;
    onOpenBook?: (book: Book) => void;
    onToggleFavorite?: (bookId: string) => void;
    onDeleteBook?: (bookId: string) => void;
    onShowInfo?: (book: Book) => void;
    onAddToShelf?: (bookId: string) => void;
    onRename?: (book: Book) => void;
    onExport?: (book: Book) => void;
    onMarkAsRead?: (bookId: string) => void;
    onMarkAsUnread?: (bookId: string) => void;
    isSelecting?: boolean;
    isSelected?: boolean;
    onToggleSelect?: (bookId: string, event?: { shiftKey: boolean }) => void;
}

function renderCard(container: HTMLDivElement, props: CardProps) {
    act(() => {
        createRoot(container).render(
            <BookCard
                onOpenBook={noop}
                onToggleFavorite={noop}
                onDeleteBook={noop}
                onShowInfo={noop}
                onAddToShelf={noop}
                onRename={noop}
                onExport={noop}
                onMarkAsRead={noop}
                onMarkAsUnread={noop}
                {...props}
            />,
        );
    });
    return container.querySelector('[role="button"]') as HTMLElement;
}

describe("BookCard selection interaction", () => {
    let container: HTMLDivElement;

    beforeEach(() => {
        container = document.createElement("div");
        document.body.appendChild(container);
        return () => {
            container.remove();
        };
    });

    it("toggles selection when tapped in selecting mode", () => {
        const onToggleSelect = vi.fn();
        const card = renderCard(container, {
            book: makeBook(),
            viewMode: "grid",
            isSelecting: true,
            isSelected: false,
            onToggleSelect,
        });
        act(() => {
            card.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        expect(onToggleSelect).toHaveBeenCalledTimes(1);
        expect(onToggleSelect.mock.calls[0][0]).toBe("book-1");
    });

    it("forwards modifier keys for range select", () => {
        const onToggleSelect = vi.fn();
        const card = renderCard(container, {
            book: makeBook(),
            viewMode: "grid",
            isSelecting: true,
            isSelected: false,
            onToggleSelect,
        });
        act(() => {
            card.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
        });
        expect(onToggleSelect.mock.calls[0][1]?.shiftKey).toBe(true);
    });

    it("does not toggle when not in selecting mode", () => {
        const onToggleSelect = vi.fn();
        const onOpenBook = vi.fn();
        const card = renderCard(container, {
            book: makeBook(),
            viewMode: "grid",
            isSelecting: false,
            isSelected: false,
            onToggleSelect,
            onOpenBook,
        });
        act(() => {
            card.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        // Single click opens via 250ms timer; toggle must stay silent.
        expect(onToggleSelect).not.toHaveBeenCalled();
        expect(onOpenBook).not.toHaveBeenCalled();
    });

    it.each(["grid", "list", "compact"] as const)(
        "renders the circular selector in %s view when selecting",
        (viewMode) => {
            renderCard(container, {
                book: makeBook(),
                viewMode,
                isSelecting: true,
                isSelected: true,
                onToggleSelect: noop,
            });
            const selector = container.querySelector(".rounded-full.transition-all");
            expect(selector).not.toBeNull();
        },
    );

    it("hides the selector when not selecting", () => {
        renderCard(container, {
            book: makeBook(),
            viewMode: "grid",
            isSelecting: false,
            isSelected: false,
            onToggleSelect: noop,
        });
        expect(container.querySelector(".rounded-full.transition-all")).toBeNull();
    });
});
