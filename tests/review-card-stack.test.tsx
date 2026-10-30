// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import React, { act } from "react";
import { render, flush, unmountAll } from "./helpers/opds-browser-harness";
import { ReviewCardStack } from "../src/features/library/components/ReviewCardStack";
import type { Annotation } from "../src/core/types";
import type { ResolvedAnnotationSource } from "../src/core/lib/annotation-source";

function pointerDown(el: HTMLElement, opts: { clientX: number; clientY: number; pointerId?: number }) {
    act(() => {
        el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, isPrimary: true, pointerId: opts.pointerId ?? 1, ...opts }));
    });
}

function pointerMove(el: HTMLElement, opts: { clientX: number; clientY: number; pointerId?: number }) {
    act(() => {
        el.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, cancelable: true, isPrimary: true, pointerId: opts.pointerId ?? 1, ...opts }));
    });
}

function pointerUp(el: HTMLElement, opts: { clientX: number; clientY: number; pointerId?: number }) {
    act(() => {
        el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, isPrimary: true, pointerId: opts.pointerId ?? 1, ...opts }));
    });
}

describe("ReviewCardStack", () => {
    afterEach(() => {
        unmountAll();
        vi.useRealTimers();
    });

    const mockCards: Annotation[] = [
        {
            id: "card-1",
            bookId: "book-1",
            type: "highlight",
            location: "loc-1",
            selectedText: "The first great idea in this book.",
            noteContent: "My personal reflection on card 1.",
            createdAt: new Date(),
        },
        {
            id: "card-2",
            bookId: "book-1",
            type: "highlight",
            location: "loc-2",
            selectedText: "A second memorable passage.",
            createdAt: new Date(),
        },
    ];

    const mockSources = new Map<string, ResolvedAnnotationSource>([
        [
            "book-1",
            {
                id: "book-1",
                title: "Meditations",
                author: "Marcus Aurelius",
                isArticle: false,
            },
        ],
    ]);

    it("renders the active top card with quote, source and author", () => {
        const root = render(
            <ReviewCardStack
                cards={mockCards}
                sources={mockSources}
                onGoToSource={vi.fn()}
                onClose={vi.fn()}
            />
        );

        expect(root.textContent).toContain("The first great idea in this book.");
        expect(root.textContent).toContain("My personal reflection on card 1.");
        expect(root.textContent).toContain("Meditations");
        expect(root.textContent).toContain("Marcus Aurelius");
    });

    it("navigates forward using keyboard and reaches completion state", () => {
        vi.useFakeTimers();
        const onComplete = vi.fn();

        const root = render(
            <ReviewCardStack
                cards={mockCards}
                sources={mockSources}
                onComplete={onComplete}
                onGoToSource={vi.fn()}
                onClose={vi.fn()}
            />
        );

        // Advance to card 2 via keyboard
        act(() => {
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
            vi.advanceTimersByTime(250);
        });

        // Now on card 2 of 2
        expect(root.textContent).toContain("A second memorable passage.");

        // Advance past last card
        act(() => {
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
            vi.advanceTimersByTime(250);
        });

        // Now finished
        expect(root.textContent).toContain("All Caught Up");
        expect(onComplete).toHaveBeenCalledTimes(1);
    });

    it("navigates backward using keyboard", () => {
        vi.useFakeTimers();

        const root = render(
            <ReviewCardStack
                cards={mockCards}
                sources={mockSources}
                onGoToSource={vi.fn()}
                onClose={vi.fn()}
            />
        );

        // Advance to card 2
        act(() => {
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
            vi.advanceTimersByTime(250);
        });

        expect(root.textContent).toContain("A second memorable passage.");

        // Go back to card 1
        act(() => {
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft" }));
            vi.advanceTimersByTime(50);
        });

        expect(root.textContent).toContain("The first great idea in this book.");
    });

    it("advances card upon drag fling gesture", () => {
        vi.useFakeTimers();

        const root = render(
            <ReviewCardStack
                cards={mockCards}
                sources={mockSources}
                onGoToSource={vi.fn()}
                onClose={vi.fn()}
            />
        );

        const topCard = root.querySelector(".cursor-grab") as HTMLElement;
        expect(topCard).toBeDefined();

        // Fling drag to the right past 100px
        pointerDown(topCard, { clientX: 100, clientY: 100 });
        pointerMove(topCard, { clientX: 220, clientY: 100 });
        pointerUp(topCard, { clientX: 220, clientY: 100 });

        act(() => {
            vi.advanceTimersByTime(250);
        });

        expect(root.textContent).toContain("A second memorable passage.");
    });

    it("invokes onGoToSource and closes when clicking open in reader", () => {
        const onGoToSource = vi.fn();
        const onClose = vi.fn();

        const root = render(
            <ReviewCardStack
                cards={mockCards}
                sources={mockSources}
                onGoToSource={onGoToSource}
                onClose={onClose}
            />
        );

        const openBtn = root.querySelector('[title="Open in Reader"]') as HTMLElement;
        expect(openBtn).not.toBeNull();

        act(() => {
            openBtn.click();
        });

        expect(onClose).toHaveBeenCalledTimes(1);
        expect(onGoToSource).toHaveBeenCalledWith("book-1", "loc-1");
    });

    it("advances card upon tapping the card body (tap-to-swipe)", () => {
        vi.useFakeTimers();

        const root = render(
            <ReviewCardStack
                cards={mockCards}
                sources={mockSources}
                onGoToSource={vi.fn()}
                onClose={vi.fn()}
            />
        );

        const topCard = root.querySelector(".cursor-grab") as HTMLElement;
        expect(topCard).toBeDefined();

        // Mock bounding client rect for click calculation
        vi.spyOn(topCard, "getBoundingClientRect").mockReturnValue({
            left: 0,
            top: 0,
            width: 400,
            height: 360,
            right: 400,
            bottom: 360,
            x: 0,
            y: 0,
            toJSON: () => {},
        });

        // Tap in the middle of the card (clientX = 250)
        act(() => {
            topCard.click();
            vi.advanceTimersByTime(250);
        });

        // Advances to card 2
        expect(root.textContent).toContain("A second memorable passage.");

        // Now on card 2: tap on the left edge (clientX = 30 < 400 * 0.18) -> goes back
        const newTopCard = root.querySelector(".cursor-grab") as HTMLElement;
        vi.spyOn(newTopCard, "getBoundingClientRect").mockReturnValue({
            left: 0,
            top: 0,
            width: 400,
            height: 360,
            right: 400,
            bottom: 360,
            x: 0,
            y: 0,
            toJSON: () => {},
        });

        act(() => {
            newTopCard.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 30 }));
            vi.advanceTimersByTime(50);
        });

        // Went back to card 1
        expect(root.textContent).toContain("The first great idea in this book.");
    });

    it("disables text selection on the card and quote to avoid gesture interference", () => {
        const root = render(
            <ReviewCardStack
                cards={mockCards}
                sources={mockSources}
                onGoToSource={vi.fn()}
                onClose={vi.fn()}
            />
        );

        const topCard = root.querySelector(".cursor-grab") as HTMLElement;
        expect(topCard).toBeDefined();
        expect(topCard.className).toContain("select-none");
        expect(topCard.style.userSelect).toBe("none");

        const quotes = Array.from(root.querySelectorAll("blockquote"));
        expect(quotes.length).toBeGreaterThan(0);
        for (const quote of quotes) {
            expect(quote.className).toContain("select-none");
            expect(quote.className).not.toContain("select-text");
            expect(quote.style.userSelect).toBe("none");
        }
    });

    it("renders deck navigation header and triggers onPrevDeck and onNextDeck", () => {
        const onPrevDeck = vi.fn();
        const onNextDeck = vi.fn();

        const root = render(
            <ReviewCardStack
                cards={mockCards}
                sources={mockSources}
                deckTitle="Deck 2 of 5: Deep Work"
                deckSubtitle="Book Deck"
                hasPrevDeck={true}
                hasNextDeck={true}
                prevDeckLabel="Prev Deck"
                nextDeckLabel="Next Deck"
                onPrevDeck={onPrevDeck}
                onNextDeck={onNextDeck}
                onGoToSource={vi.fn()}
            />
        );

        expect(root.textContent).toContain("Deck 2 of 5: Deep Work");
        expect(root.textContent).toContain("Book Deck");

        const prevDeckBtn = root.querySelector('button[aria-label="Prev Deck"]') as HTMLButtonElement;
        const nextDeckBtn = root.querySelector('button[aria-label="Next Deck"]') as HTMLButtonElement;
        expect(prevDeckBtn).toBeDefined();
        expect(nextDeckBtn).toBeDefined();
        expect(prevDeckBtn.disabled).toBe(false);
        expect(nextDeckBtn.disabled).toBe(false);

        act(() => {
            prevDeckBtn.click();
        });
        expect(onPrevDeck).toHaveBeenCalledTimes(1);

        act(() => {
            nextDeckBtn.click();
        });
        expect(onNextDeck).toHaveBeenCalledTimes(1);
    });

    it("renders bookmark card cleanly without redundant quote bar or generic position chips", () => {
        const bookmarkCard: Annotation = {
            id: "bookmark-1",
            bookId: "book-1",
            type: "bookmark",
            location: "loc-bm-1",
            chapterTitle: "Side by Side",
            selectedText: "Side by Side", // often duplicated in bookmark objects
            createdAt: new Date(),
        };

        const onGoToSource = vi.fn();
        const root = render(
            <ReviewCardStack
                cards={[bookmarkCard]}
                sources={mockSources}
                onGoToSource={onGoToSource}
                onClose={vi.fn()}
            />
        );

        // Renders title and jump button
        expect(root.textContent).toContain("Side by Side");
        expect(root.textContent).toContain("Jump to Bookmark");

        // Does NOT render redundant quote block or generic placeholder chip
        expect(root.querySelector("blockquote")).toBeNull();
        expect(root.textContent).not.toContain("Saved reading location");
        expect(root.textContent).not.toContain("Bookmarked position");

        // Clicking Jump to Bookmark triggers navigation
        const jumpBtn = root.querySelector("button") as HTMLButtonElement;
        expect(jumpBtn).toBeDefined();
        act(() => {
            jumpBtn.click();
        });
        expect(onGoToSource).toHaveBeenCalledWith("book-1", "loc-bm-1");
    });

    it("renders multiple stepped background cards like a proper deck when cards are available", () => {
        const fiveCards: Annotation[] = Array.from({ length: 5 }, (_, i) => ({
            id: `card-${i + 1}`,
            bookId: "book-1",
            type: "highlight",
            location: `loc-${i + 1}`,
            selectedText: `Highlight text ${i + 1}`,
            createdAt: new Date(),
        }));

        const root = render(
            <ReviewCardStack
                cards={fiveCards}
                sources={mockSources}
                onGoToSource={vi.fn()}
            />
        );

        // Check for stepped deck cards underneath the top card
        const deckLayers = root.querySelectorAll(".absolute.inset-0.rounded-2xl");
        // We expect up to 4 background cards (Card 1, 2, 3, 4) layered beneath the active top card
        expect(deckLayers.length).toBe(4);

        // Verify bottom center transformOrigin for physical deck stacking
        for (const layer of Array.from(deckLayers)) {
            const htmlLayer = layer as HTMLElement;
            expect(htmlLayer.style.transformOrigin).toBe("bottom center");
        }
    });

    it("does not render decorative quote watermark illustration behind text", () => {
        const root = render(
            <ReviewCardStack
                cards={mockCards}
                sources={mockSources}
                onGoToSource={vi.fn()}
            />
        );

        // The text-8xl quote watermark illustration should be completely removed
        expect(root.querySelector(".text-8xl")).toBeNull();
    });

    it("renders completion card as a single unified card without nested borders", () => {
        vi.useFakeTimers();

        const root = render(
            <ReviewCardStack
                cards={mockCards}
                sources={mockSources}
                onGoToSource={vi.fn()}
                completionTitle="Daily Review Complete"
            />
        );

        // Advance past all cards to trigger completion
        act(() => {
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
            vi.advanceTimersByTime(250);
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
            vi.advanceTimersByTime(250);
        });

        expect(root.textContent).toContain("Daily Review Complete");

        // Should not have nested card border wrappers inside the completion card
        expect(root.querySelector(".rounded-xl.border")).toBeNull();
        const completionCard = root.querySelector(".min-h-\\[380px\\]");
        expect(completionCard).not.toBeNull();
        expect(completionCard?.className).toContain("rounded-2xl");
        expect(completionCard?.className).toContain("border");
    });
});


