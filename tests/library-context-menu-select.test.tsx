// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BookCard } from "../src/features/library/Library";
import { ShelvesPage } from "../src/features/library/Shelves";
import { useLibraryStore, useUIStore } from "../src/core/store";
import type { Book } from "../src/core/types";

// @ts-expect-error React 19 act environment flag
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const testBook: Book = {
    id: "b1",
    title: "Test Book",
    author: "Test Author",
    filePath: "/test/book.epub",
    format: "epub",
    fileSize: 1024,
    addedAt: new Date(),
    progress: 0,
    readingTime: 0,
    tags: [],
    isFavorite: false,
};

let host: HTMLDivElement;
let root: Root;

describe("Library & Shelves trigger-based selection mode", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        host = document.createElement("div");
        document.body.append(host);
        root = createRoot(host);
    });

    afterEach(() => {
        act(() => root.unmount());
        host.remove();
        document.body.innerHTML = "";
    });

    it("triggers onStartSelect when holding Ctrl or Meta on card click", () => {
        const onStartSelect = vi.fn();
        const onToggleSelect = vi.fn();
        const onOpenBook = vi.fn();

        act(() => {
            root.render(
                <BookCard
                    book={testBook}
                    viewMode="grid"
                    onOpenBook={onOpenBook}
                    onToggleFavorite={vi.fn()}
                    onDeleteBook={vi.fn()}
                    onShowInfo={vi.fn()}
                    onAddToShelf={vi.fn()}
                    onRename={vi.fn()}
                    onExport={vi.fn()}
                    onMarkAsRead={vi.fn()}
                    onMarkAsUnread={vi.fn()}
                    onToggleSelect={onToggleSelect}
                    onStartSelect={onStartSelect}
                />
            );
        });

        const card = host.querySelector('div[role="button"]');
        expect(card).not.toBeNull();

        // Standard click opens book (debounced/timeout)
        // Ctrl+Click triggers selection
        act(() => {
            card?.dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
        });

        expect(onStartSelect).toHaveBeenCalledWith("b1");
        expect(onOpenBook).not.toHaveBeenCalled();
    });

    it("hides toolbar select button with sr-only when not in selection mode on shelves", () => {
        useLibraryStore.setState({
            books: [testBook],
            collections: [
                {
                    id: "s1",
                    name: "Favorites",
                    description: "",
                    bookIds: ["b1"],
                    kind: "general" as const,
                    createdAt: new Date(),
                },
            ],
        });
        useUIStore.setState({ currentRoute: "shelves", searchQuery: "" });

        act(() => {
            root.render(<ShelvesPage />);
        });

        // Open shelf
        const shelfCard = host.querySelector("button.block.w-full");
        act(() => {
            shelfCard?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });

        const selectBtn = host.querySelector('button[data-action="toggle-select-mode"]');
        expect(selectBtn).not.toBeNull();
        // Sighted toolbar does not render an intrusive select button
        expect(selectBtn?.className).toContain("sr-only");
    });
});
