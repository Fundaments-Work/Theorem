// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { render, unmountAll } from "./helpers/opds-browser-harness";
import { BookmarksPanel } from "../src/features/library/Bookmarks";
import { useLibraryStore, useUIStore } from "../src/core/store";
import type { Annotation, Book } from "../src/core/types";

describe("Bookmarks Ribbon & Physical Card Deck", () => {
    let appMain: HTMLDivElement | null = null;

    beforeEach(() => {
        window.localStorage.clear();
        window.sessionStorage.clear();
        useUIStore.setState({ currentRoute: "bookmarks", searchQuery: "" });
        appMain = document.createElement("div");
        appMain.id = "app-main";
        Object.defineProperty(appMain, "clientHeight", { value: 800, configurable: true });
        Object.defineProperty(appMain, "offsetHeight", { value: 800, configurable: true });
        document.body.appendChild(appMain);
    });

    afterEach(() => {
        unmountAll();
        if (appMain && appMain.parentNode) {
            appMain.parentNode.removeChild(appMain);
            appMain = null;
        }
        useLibraryStore.setState({ annotations: [], books: [] });
    });

    const mockBook: Book = {
        id: "book-1",
        title: "Meditations",
        author: "Marcus Aurelius",
        format: "epub",
        filePath: "/books/meditations.epub",
        fileSize: 1000,
        createdAt: new Date(),
        updatedAt: new Date(),
    };

    const mockBookmark: Annotation = {
        id: "bm-1",
        bookId: "book-1",
        type: "bookmark",
        location: "loc-1",
        chapterTitle: "Book IV — The Inner Citadel",
        pageNumber: 42,
        createdAt: new Date("2026-10-28"),
    };

    it("renders empty state when no bookmarks exist", () => {
        useLibraryStore.setState({ books: [mockBook], annotations: [] });
        const root = render(<BookmarksPanel tabs={<div>Tabs</div>} />);

        expect(root.textContent).toContain("No Bookmarks Yet");
        expect(root.textContent).toContain("Bookmark pages while reading to quickly return to them later.");
    });

    it("renders physical bookmark ribbon card with chapter title, position badge, and jump button", () => {
        useLibraryStore.setState({
            books: [mockBook],
            annotations: [mockBookmark],
        });

        const root = render(<BookmarksPanel tabs={<div>Tabs</div>} />);

        expect(root.textContent).toContain("Book IV — The Inner Citadel");
        expect(root.textContent).toContain("Meditations");
        expect(root.textContent).toContain("Marcus Aurelius");
        expect(root.textContent).toContain("Page 42");
        expect(root.textContent).toContain("Jump to Page");

        // Verify bookmark ribbon tab fold is present in markup
        const ribbonTab = root.querySelector('div[style*="clip-path"]') || root.querySelector('div[class*="clip-path"]');
        expect(ribbonTab).not.toBeNull();
    });

    it("switches to physical card deck mode and renders bookmark centerpiece", () => {
        useLibraryStore.setState({
            books: [mockBook],
            annotations: [mockBookmark],
        });

        const root = render(<BookmarksPanel tabs={<div>Tabs</div>} />);

        const cardsBtn = root.querySelector('button[aria-label="Cards view"]') as HTMLButtonElement;
        expect(cardsBtn).not.toBeNull();

        act(() => {
            cardsBtn.click();
        });

        // ReviewCardStack with physical bookmark deck
        expect(root.textContent).toContain("Bookmarks");
        expect(root.textContent).toContain("1 bookmark");
        expect(root.textContent).toContain("Book IV — The Inner Citadel");
        expect(root.textContent).toContain("Page 42");
        expect(root.textContent).toContain("Jump to Bookmark");
    });

    it("opens action dropdown and triggers delete confirm dialog", () => {
        useLibraryStore.setState({
            books: [mockBook],
            annotations: [mockBookmark],
        });

        const root = render(<BookmarksPanel tabs={<div>Tabs</div>} />);

        const menuBtn = root.querySelector('button[aria-label="Bookmark options"]') as HTMLButtonElement;
        expect(menuBtn).not.toBeNull();

        act(() => {
            menuBtn.click();
        });

        const deleteItem = Array.from(root.querySelectorAll('button[role="menuitem"]')).find(
            (b) => b.textContent?.includes("Delete"),
        ) as HTMLButtonElement;
        expect(deleteItem).toBeDefined();

        act(() => {
            deleteItem.click();
        });

        expect(document.body.textContent).toContain("Delete Bookmark");
        expect(document.body.textContent).toContain("Are you sure you want to delete this bookmark?");
    });
});
