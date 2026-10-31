// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { render, unmountAll } from "./helpers/opds-browser-harness";
import { AnnotationsPage } from "../src/features/library/Annotations";
import { LibraryDailyReviewDeck } from "../src/features/library/components/LibraryDailyReviewDeck";
import { useLibraryStore, useUIStore } from "../src/core/store";
import { getDailyReviewStatus, getDailyReviewDismissal, markDailyReviewCompleted, resetDailyReview } from "../src/core/lib/daily-review";
import type { Annotation, Book } from "../src/core/types";

describe("Library Daily Highlights Deck & Refocused Workbench", () => {
    beforeEach(() => {
        window.localStorage.clear();
        window.sessionStorage.clear();
        useUIStore.setState({ currentRoute: "annotations", searchQuery: "" });
    });

    afterEach(() => {
        unmountAll();
        vi.useRealTimers();
        useLibraryStore.setState({ annotations: [], books: [] });
    });

    const mockBook: Book = {
        id: "book-1",
        title: "Letters from a Stoic",
        author: "Seneca",
        format: "epub",
        filePath: "/books/seneca.epub",
        fileSize: 1000,
        addedAt: new Date(), progress: 0, tags: [], isFavorite: false, readingTime: 0,
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
        beforeEach(() => { useUIStore.setState({currentRoute:"library"}); });
        it("renders interactive Daily Review deck when enabled with unreviewed cards", () => {
            useLibraryStore.setState({
                books: [mockBook],
                annotations: mockAnnotations,
            });

            render(
                <LibraryDailyReviewDeck
                    showDailyHighlight={true}
                    selectedShelf={null}
                    showFavoritesOnly={false}
                    isSelecting={false}
                />,
            );

            expect(document.body.textContent).not.toContain("Daily Review");
            expect(document.body.textContent).toContain("True happiness is to enjoy the present.");
            expect(document.body.textContent).toContain("Letters from a Stoic");
            expect(document.body.textContent).toContain("Seneca");
            expect(document.body.querySelector('button[aria-label="Dismiss for today"]')).not.toBeNull();
        });

        it("dismisses deck when close button is clicked and saves session snooze", () => {
            useLibraryStore.setState({
                books: [mockBook],
                annotations: mockAnnotations,
            });

            render(
                <LibraryDailyReviewDeck
                    showDailyHighlight={true}
                    selectedShelf={null}
                    showFavoritesOnly={false}
                    isSelecting={false}
                />,
            );

            const dismissBtn = document.body.querySelector('button[aria-label="Dismiss for today"]') as HTMLButtonElement;
            expect(dismissBtn).not.toBeNull();

            act(() => {
                dismissBtn.click();
            });

            expect(window.localStorage.getItem("theorem-dismiss-daily-deck")).toBeTruthy();
            expect(document.body.textContent).toBe("");
        });

        it("keeps today's dismissal after a new app session", () => {
            useLibraryStore.setState({ books: [mockBook], annotations: mockAnnotations });
            const deck = () => <LibraryDailyReviewDeck showDailyHighlight selectedShelf={null} showFavoritesOnly={false} isSelecting={false} />;
            render(deck());
            act(() => document.querySelector<HTMLButtonElement>('[aria-label="Dismiss for today"]')!.click());
            unmountAll();
            window.sessionStorage.clear();
            render(deck());
            expect(document.querySelector('[role="dialog"][aria-label="Daily Review"]')).toBeNull();
        });

        it("places the overlay outside the Library scroll container", () => {
            useLibraryStore.setState({ books: [mockBook], annotations: mockAnnotations });
            const root = render(<div data-library-scroll="true" style={{contentVisibility:"auto",overflow:"auto"}}>
                <LibraryDailyReviewDeck showDailyHighlight selectedShelf={null} showFavoritesOnly={false} isSelecting={false} />
            </div>);
            const overlay=document.querySelector('[role="dialog"][aria-label="Daily Review"]');
            expect(overlay).not.toBeNull();
            expect(root.contains(overlay)).toBe(false);
        });

        it("observes completion while mounted and does not replay after annotation updates", () => {
            useLibraryStore.setState({ books: [mockBook], annotations: mockAnnotations });
            render(<LibraryDailyReviewDeck showDailyHighlight selectedShelf={null} showFavoritesOnly={false} isSelecting={false} />);
            act(() => markDailyReviewCompleted(undefined, mockAnnotations.map(card => card.id)));
            expect(document.querySelector('[aria-label="Daily Review"]')).toBeNull();
            act(() => { useLibraryStore.setState({ annotations: [...mockAnnotations] }); });
            expect(document.querySelector('[aria-label="Daily Review"]')).toBeNull();
        });

        it("offers a fresh deck the next local day without restarting", () => {
            vi.useFakeTimers({toFake:["Date"]});
            vi.setSystemTime(new Date(2026, 9, 31, 23, 59));
            expect(getDailyReviewStatus().completed).toBe(false);
            expect(getDailyReviewDismissal()).toBeNull();
            useLibraryStore.setState({ books: [mockBook], annotations: mockAnnotations });
            render(<LibraryDailyReviewDeck showDailyHighlight selectedShelf={null} showFavoritesOnly={false} isSelecting={false} />);
            act(() => document.querySelector<HTMLButtonElement>('[aria-label="Dismiss for today"]')!.click());
            expect(document.querySelector('[aria-label="Daily Review"]')).toBeNull();
            vi.setSystemTime(new Date(2026, 10, 1, 0, 1));
            act(() => window.dispatchEvent(new Event("focus")));
            expect(document.querySelector('[aria-label="Daily Review"]')).not.toBeNull();
        });

        it("does not cover another route when Library stays mounted", () => {
            useLibraryStore.setState({ books: [mockBook], annotations: mockAnnotations });
            render(<LibraryDailyReviewDeck showDailyHighlight selectedShelf={null} showFavoritesOnly={false} isSelecting={false} />);
            expect(document.querySelector('[aria-label="Daily Review"]')).not.toBeNull();
            act(() => { useUIStore.getState().setRoute("settings"); });
            expect(document.querySelector('[aria-label="Daily Review"]')).toBeNull();
            act(() => { useUIStore.getState().setRoute("library"); });
            expect(document.querySelector('[aria-label="Daily Review"]')).not.toBeNull();
        });

        it("does not render when showDailyHighlight is false", () => {
            useLibraryStore.setState({
                books: [mockBook],
                annotations: mockAnnotations,
            });

            render(
                <LibraryDailyReviewDeck
                    showDailyHighlight={false}
                    selectedShelf={null}
                    showFavoritesOnly={false}
                    isSelecting={false}
                />,
            );

            expect(document.body.textContent).toBe("");
        });

        it("does not render when completed for the day", () => {
            useLibraryStore.setState({
                books: [mockBook],
                annotations: mockAnnotations,
            });
            markDailyReviewCompleted();

            render(
                <LibraryDailyReviewDeck
                    showDailyHighlight={true}
                    selectedShelf={null}
                    showFavoritesOnly={false}
                    isSelecting={false}
                />,
            );

            expect(document.body.textContent).toBe("");
            resetDailyReview();
        });

        it("renders as a centered overlay on top of the library with solid backdrop", () => {
            useLibraryStore.setState({
                books: [mockBook],
                annotations: mockAnnotations,
            });

            render(
                <LibraryDailyReviewDeck
                    showDailyHighlight={true}
                    selectedShelf={null}
                    showFavoritesOnly={false}
                    isSelecting={false}
                />,
            );

            const overlay = document.body.querySelector('[role="dialog"][aria-modal="true"]');
            expect(overlay).not.toBeNull();
            expect(overlay?.className).toContain("fixed");
            expect(overlay?.className).toContain("inset-0");
            expect(overlay?.className).toContain("bg-[var(--color-background)]");
            expect(overlay?.className).toContain("items-center");
            expect(overlay?.parentElement).toBe(document.body);
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
            expect(root.textContent).toContain("Letters from a Stoic");
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
