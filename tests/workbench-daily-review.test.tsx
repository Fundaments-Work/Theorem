// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { render, unmountAll } from "./helpers/opds-browser-harness";
import { AnnotationsPage } from "../src/features/library/Annotations";
import { LibraryDailyReviewDeck } from "../src/features/library/components/LibraryDailyReviewDeck";
import { useLibraryStore, useUIStore } from "../src/core/store";
import { markDailyReviewCompleted, resetDailyReview } from "../src/core/lib/daily-review";
import type { Annotation, Book } from "../src/core/types";

describe("Library Daily Highlights Deck & Refocused Workbench", () => {
    beforeEach(() => {
        window.localStorage.clear();
        window.sessionStorage.clear();
        useUIStore.setState({ currentRoute: "annotations", searchQuery: "" });
    });

    afterEach(() => {
        unmountAll();
        useLibraryStore.setState({ annotations: [], books: [] });
    });

    const mockBook: Book = {
        id: "book-1",
        title: "Letters from a Stoic",
        author: "Seneca",
        format: "epub",
        filePath: "/books/seneca.epub",
        fileSize: 1000,
        createdAt: new Date(),
        updatedAt: new Date(),
    };

    const mockAnnotations: Annotation[] = [
        {
            id: "anno-1",
            bookId: "book-1",
            type: "highlight",
            location: "loc-1",
            selectedText: "True happiness is to enjoy the present.",
            createdAt: new Date("2026-10-28"),
        },
        {
            id: "anno-2",
            bookId: "book-1",
            type: "highlight",
            location: "loc-2",
            selectedText: "We suffer more often in imagination than in reality.",
            createdAt: new Date("2026-10-27"),
        },
    ];

    describe("LibraryDailyReviewDeck", () => {
        it("renders interactive Daily Highlights deck when enabled with unreviewed cards", () => {
            useLibraryStore.setState({
                books: [mockBook],
                annotations: mockAnnotations,
            });

            const root = render(
                <LibraryDailyReviewDeck
                    showDailyHighlight={true}
                    selectedShelf={null}
                    showFavoritesOnly={false}
                    isSelecting={false}
                />,
            );

            expect(root.textContent).toContain("Daily Highlights");
            expect(root.textContent).toContain("2 cards");
            expect(root.textContent).toContain("True happiness is to enjoy the present.");
            expect(root.textContent).toContain("Letters from a Stoic");
            expect(root.textContent).toContain("Seneca");
        });

        it("dismisses deck when close button is clicked and saves session snooze", () => {
            useLibraryStore.setState({
                books: [mockBook],
                annotations: mockAnnotations,
            });

            const root = render(
                <LibraryDailyReviewDeck
                    showDailyHighlight={true}
                    selectedShelf={null}
                    showFavoritesOnly={false}
                    isSelecting={false}
                />,
            );

            const dismissBtn = root.querySelector('button[aria-label="Dismiss for today"]') as HTMLButtonElement;
            expect(dismissBtn).not.toBeNull();

            act(() => {
                dismissBtn.click();
            });

            expect(window.sessionStorage.getItem("theorem-dismiss-daily-deck")).toBeTruthy();
            expect(root.textContent).toBe("");
        });

        it("does not render when showDailyHighlight is false", () => {
            useLibraryStore.setState({
                books: [mockBook],
                annotations: mockAnnotations,
            });

            const root = render(
                <LibraryDailyReviewDeck
                    showDailyHighlight={false}
                    selectedShelf={null}
                    showFavoritesOnly={false}
                    isSelecting={false}
                />,
            );

            expect(root.textContent).toBe("");
        });

        it("does not render when completed for the day", () => {
            useLibraryStore.setState({
                books: [mockBook],
                annotations: mockAnnotations,
            });
            markDailyReviewCompleted();

            const root = render(
                <LibraryDailyReviewDeck
                    showDailyHighlight={true}
                    selectedShelf={null}
                    showFavoritesOnly={false}
                    isSelecting={false}
                />,
            );

            expect(root.textContent).toBe("");
            resetDailyReview();
        });
    });

    describe("Workbench (refocused)", () => {
        it("renders Workbench header directly without daily review takeover", () => {
            useLibraryStore.setState({
                books: [mockBook],
                annotations: mockAnnotations,
            });

            const root = render(<AnnotationsPage />);

            // Should directly render standard Workbench page
            expect(root.textContent).toContain("Workbench");
            expect(root.textContent).not.toContain("Skip to Workbench");
            expect(root.querySelector('button[aria-label="Skip daily review to workbench"]')).toBeNull();
        });

        it("renders unified ReviewCardStack in Workbench card view mode", () => {
            useLibraryStore.setState({
                books: [mockBook],
                annotations: mockAnnotations,
            });

            const root = render(<AnnotationsPage />);

            // Switch to cards mode
            const cardViewBtn = root.querySelector('button[aria-label="Cards view"]') as HTMLButtonElement;
            expect(cardViewBtn).not.toBeNull();

            act(() => {
                cardViewBtn.click();
            });

            // Now renders ReviewCardStack with deck title
            expect(root.textContent).toContain("Deck 1 of 1: Letters from a Stoic");
            expect(root.textContent).toContain("Book Deck");
            expect(root.textContent).toContain("1 of 2");
            expect(root.textContent).toContain("True happiness is to enjoy the present.");

            // Switch back to list mode
            const listViewBtn = root.querySelector('button[aria-label="List view"]') as HTMLButtonElement;
            expect(listViewBtn).not.toBeNull();

            act(() => {
                listViewBtn.click();
            });

            // ReviewCardStack is replaced with list view
            expect(root.textContent).not.toContain("Deck 1 of 1");
        });

        it("renders sort dropdown with expected sorting options", () => {
            useLibraryStore.setState({
                books: [mockBook],
                annotations: mockAnnotations,
            });

            const root = render(<AnnotationsPage />);

            const sortButton = root.querySelector('button[aria-haspopup="menu"]') as HTMLButtonElement;
            expect(sortButton).not.toBeNull();
            expect(sortButton.textContent).toContain("Newest First");

            // Open dropdown options
            act(() => {
                sortButton.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
            });

            expect(document.body.textContent).toContain("Newest First");
            expect(document.body.textContent).toContain("Oldest First");
            expect(document.body.textContent).toContain("By Book");
        });
    });
});
