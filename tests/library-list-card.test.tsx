import { describe, it, expect, beforeEach, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { createPortal } from "react-dom";
import { act, useState } from "react";
import { AnnotationListCard } from "../src/features/library/components/AnnotationListCard";
import {
    ANNOTATION_ROW_GAP_PX,
    BLOCK_GAP_PX,
    CARD_HORIZONTAL_CHROME_PX,
    META_BLOCK_PX,
    NOTE_LINE_PX,
    NOTE_MAX_LINES,
    QUOTE_INDENT_PX,
    QUOTE_LINE_PX,
    QUOTE_MAX_LINES,
    TOGGLE_BLOCK_PX,
    annotationCardHeight,
    annotationRowSize,
    computeCardLayout,
    countWrappedLines,
    type CardTextMeasurer,
} from "../src/features/library/components/annotation-card-layout";
import { bookmarkPositionLabel } from "../src/features/library/components/bookmark-position";

// @ts-expect-error React act environment flag
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// Monospace stand-in: every character is 10px wide.
const mono = (text: string) => text.length * 10;

function measurerFor(textWidth: number): CardTextMeasurer {
    // listWidth such that quote lines hold exactly `textWidth / 10` chars
    // (computeCardLayout applies a 2% safety slack).
    return {
        listWidth: textWidth / 0.98 + CARD_HORIZONTAL_CHROME_PX + QUOTE_INDENT_PX,
        measureQuote: mono,
        measureNote: mono,
    };
}

describe("countWrappedLines", () => {
    it("returns 0 for missing/empty text and 1 for a non-positive width", () => {
        expect(countWrappedLines(undefined, 100, mono, false)).toBe(0);
        expect(countWrappedLines("", 100, mono, false)).toBe(0);
        expect(countWrappedLines("abc", 0, mono, false)).toBe(1);
        expect(countWrappedLines("abc", Number.NaN, mono, false)).toBe(1);
    });

    it("wraps greedily at spaces", () => {
        // 10 chars per line
        expect(countWrappedLines("aaaa bbbb", 100, mono, false)).toBe(1);
        expect(countWrappedLines("aaaa bbbbb", 100, mono, false)).toBe(1); // exactly fills the line
        expect(countWrappedLines("aaaa bbbbbb", 100, mono, false)).toBe(2);
        expect(countWrappedLines("aaaa bbbb cccc dddd", 100, mono, false)).toBe(2);
    });

    it("collapses whitespace in normal flow", () => {
        expect(countWrappedLines("  aaaa \n\n  bbbb  ", 100, mono, false)).toBe(1);
        expect(countWrappedLines("   ", 100, mono, false)).toBe(1);
    });

    it("keeps newlines and blank lines in pre-wrap", () => {
        expect(countWrappedLines("a\nb\n\nc", 100, mono, true)).toBe(4);
        expect(countWrappedLines("a\r\nb", 100, mono, true)).toBe(2);
    });

    it("breaks words longer than the line between characters", () => {
        expect(countWrappedLines("x".repeat(25), 100, mono, false)).toBe(3);
        expect(countWrappedLines("ab " + "x".repeat(25), 100, mono, false)).toBe(4);
    });

    it("counts a huge highlight without blowing up", () => {
        const text = "word ".repeat(20_000);
        expect(countWrappedLines(text, 100, mono, false)).toBe(10_000);
    });
});

describe("computeCardLayout / annotationCardHeight", () => {
    const m = measurerFor(100); // 10 chars per quote line

    it("fits short content: one line, no toggle", () => {
        const layout = computeCardLayout({ quote: "short" }, m, false);
        expect(layout).toMatchObject({ quoteLines: 1, noteLines: 0, expandable: false });
        expect(annotationCardHeight(layout)).toBe(annotationCardHeight({ ...layout, quoteLines: 0 }) + QUOTE_LINE_PX);
    });

    it("grows with content up to the collapsed cap", () => {
        const three = computeCardLayout({ quote: "aaaa bbbb cccc dddd eeee ffff" }, m, false);
        expect(three.quoteLines).toBe(3);
        const small = annotationCardHeight(computeCardLayout({ quote: "a" }, m, false));
        expect(annotationCardHeight(three)).toBe(small + 2 * QUOTE_LINE_PX);
    });

    it("caps very long content and offers a toggle; expanding shows everything", () => {
        const long = "aaaa bbbb ".repeat(40); // 40 lines
        const collapsed = computeCardLayout({ quote: long }, m, false);
        expect(collapsed).toMatchObject({ quoteLines: QUOTE_MAX_LINES, expandable: true, expanded: false });
        const expanded = computeCardLayout({ quote: long }, m, true);
        expect(expanded).toMatchObject({ quoteLines: 40, expandable: true, expanded: true });
        expect(annotationCardHeight(expanded) - annotationCardHeight(collapsed)).toBe((40 - QUOTE_MAX_LINES) * QUOTE_LINE_PX);
    });

    it("expanded flag is ignored when nothing is clipped", () => {
        expect(computeCardLayout({ quote: "a" }, m, true)).toMatchObject({ expandable: false, expanded: false });
    });

    it("caps notes separately", () => {
        const note = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
        const layout = computeCardLayout({ note }, m, false);
        expect(layout).toMatchObject({ noteLines: NOTE_MAX_LINES, expandable: true });
    });

    it("adds block gaps, meta line and toggle row", () => {
        const base = annotationCardHeight({ quoteLines: 0, noteLines: 0, hasMeta: false, expandable: false, expanded: false });
        expect(annotationCardHeight({ quoteLines: 2, noteLines: 1, hasMeta: true, expandable: true, expanded: false }))
            .toBe(base + 2 * QUOTE_LINE_PX + NOTE_LINE_PX + META_BLOCK_PX + 2 * BLOCK_GAP_PX + BLOCK_GAP_PX + TOGGLE_BLOCK_PX);
    });

    it("row size is card height plus the uniform gap, and tolerates a missing row", () => {
        const layout = computeCardLayout({ quote: "q" }, m, false);
        expect(annotationRowSize(layout)).toBe(annotationCardHeight(layout) + ANNOTATION_ROW_GAP_PX);
        expect(annotationRowSize(undefined)).toBe(
            annotationCardHeight({ quoteLines: 0, noteLines: 0, hasMeta: false, expandable: false, expanded: false }) + ANNOTATION_ROW_GAP_PX,
        );
    });

    it("narrower lists produce taller cards", () => {
        const text = "aaaa bbbb cccc dddd";
        const wide = annotationCardHeight(computeCardLayout({ quote: text }, measurerFor(400), false));
        const narrow = annotationCardHeight(computeCardLayout({ quote: text }, measurerFor(50), false));
        expect(narrow).toBeGreaterThan(wide);
    });
});

describe("bookmarkPositionLabel", () => {
    it("labels PDF pages from pageNumber or the location", () => {
        expect(bookmarkPositionLabel({ location: "pdf:page:12", pageNumber: 12 })).toBe("Page 12");
        expect(bookmarkPositionLabel({ location: "pdf:page:7" })).toBe("Page 7");
    });

    it("labels article bookmarks as a clamped percentage", () => {
        expect(bookmarkPositionLabel({ location: "article-bookmark:0.425000" })).toBe("43% through");
        expect(bookmarkPositionLabel({ location: "article-bookmark:0" })).toBe("0% through");
        expect(bookmarkPositionLabel({ location: "article-bookmark:1.7" })).toBe("100% through");
        expect(bookmarkPositionLabel({ location: "article-bookmark:-3" })).toBe("0% through");
    });

    it("returns nothing for CFIs and malformed locations", () => {
        expect(bookmarkPositionLabel({ location: "epubcfi(/6/4!/4/2)" })).toBeUndefined();
        expect(bookmarkPositionLabel({ location: "pdf:page:abc" })).toBeUndefined();
        expect(bookmarkPositionLabel({ location: "pdf:page:0" })).toBeUndefined();
        expect(bookmarkPositionLabel({ location: "article-bookmark:NaN" })).toBeUndefined();
        expect(bookmarkPositionLabel({ location: "" })).toBeUndefined();
        expect(bookmarkPositionLabel({ location: "pdf:page:3", pageNumber: 0 })).toBe("Page 3");
    });
});

describe("AnnotationListCard menu", () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        container = document.createElement("div");
        document.body.appendChild(container);
        root = createRoot(container);
        return () => {
            act(() => root.unmount());
            container.remove();
        };
    });

    const LONG = "aaaa bbbb ".repeat(40);

    function Harness({ onDelete, onPopoverClose, withPortal = false, quote = "Fear is the mind-killer." }: {
        onDelete: () => void;
        onPopoverClose?: () => void;
        withPortal?: boolean;
        quote?: string;
    }) {
        const [open, setOpen] = useState<string | null>(null);
        const [expanded, setExpanded] = useState(false);
        const layout = computeCardLayout({ quote }, measurerFor(100), expanded);
        return (
            <>
                <button id="outside">outside</button>
                <AnnotationListCard
                    id="a1"
                    typeLabel="highlight"
                    dateLabel="2026-09-26"
                    sourceTitle="Dune"
                    sourceAuthor="Frank Herbert"
                    quote={quote}
                    layout={layout}
                    onToggleExpanded={() => setExpanded((v) => !v)}
                    menuItems={[{ label: "Delete", onSelect: onDelete, danger: true }]}
                    menuOpen={open === "a1"}
                    onMenuOpenChange={setOpen}
                    popover={withPortal ? createPortal(<button id="in-portal">portal</button>, document.body) : undefined}
                    onPopoverClose={onPopoverClose}
                    onOpen={() => {}}
                    openTitle="open"
                />
            </>
        );
    }

    const pointerDown = (el: Element) =>
        act(() => { el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); });
    const menuButton = () => container.querySelector('button[aria-label="Actions"]') as HTMLButtonElement;
    const menu = () => container.querySelector('[role="menu"]');

    const cardHeight = () => (container.querySelector(".group") as HTMLElement).style.height;
    const toggle = () => [...container.querySelectorAll("button")].find((b) => /Show (more|less)/.test(b.textContent ?? ""));

    it("renders at exactly its computed height", () => {
        act(() => root.render(<Harness onDelete={() => {}} />));
        expect(cardHeight()).toBe(`${annotationCardHeight(computeCardLayout({ quote: "Fear is the mind-killer." }, measurerFor(100), false))}px`);
        expect(toggle()).toBeUndefined();
    });

    it("long content collapses with Show more and expands to full height", () => {
        act(() => root.render(<Harness onDelete={() => {}} quote={LONG} />));
        const collapsed = cardHeight();
        const quote = container.querySelector("blockquote") as HTMLElement;
        expect(quote.style.height).toBe(`${QUOTE_MAX_LINES * QUOTE_LINE_PX}px`);
        expect(toggle()!.textContent).toBe("Show more");
        act(() => toggle()!.click());
        expect(toggle()!.textContent).toBe("Show less");
        expect(parseFloat(cardHeight())).toBe(parseFloat(collapsed) + (40 - QUOTE_MAX_LINES) * QUOTE_LINE_PX);
        act(() => toggle()!.click());
        expect(cardHeight()).toBe(collapsed);
    });

    it("opens, runs an item and closes", () => {
        const onDelete = vi.fn();
        act(() => root.render(<Harness onDelete={onDelete} />));
        act(() => menuButton().click());
        expect(menu()).not.toBeNull();
        const item = container.querySelector('[role="menuitem"]') as HTMLButtonElement;
        pointerDown(item);
        expect(menu()).not.toBeNull(); // inside press does not close
        act(() => item.click());
        expect(onDelete).toHaveBeenCalledTimes(1);
        expect(menu()).toBeNull();
    });

    it("closes on an outside press and on Escape", () => {
        act(() => root.render(<Harness onDelete={() => {}} />));
        act(() => menuButton().click());
        pointerDown(container.querySelector("#outside")!);
        expect(menu()).toBeNull();

        act(() => menuButton().click());
        act(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
        expect(menu()).toBeNull();
    });

    it("toggles closed when the menu button is pressed again", () => {
        act(() => root.render(<Harness onDelete={() => {}} />));
        act(() => menuButton().click());
        pointerDown(menuButton());
        act(() => menuButton().click());
        expect(menu()).toBeNull();
    });

    it("presses inside portalled popover content do not close it", () => {
        const onPopoverClose = vi.fn();
        act(() => root.render(<Harness onDelete={() => {}} onPopoverClose={onPopoverClose} withPortal />));
        pointerDown(document.getElementById("in-portal")!);
        expect(onPopoverClose).not.toHaveBeenCalled();
        pointerDown(container.querySelector("#outside")!);
        expect(onPopoverClose).toHaveBeenCalledTimes(1);
    });
});
