import { describe, it, expect, beforeEach, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { createPortal } from "react-dom";
import { act, useState } from "react";
import { AnnotationListCard } from "../src/features/library/components/AnnotationListCard";
import {
    ANNOTATION_ROW_GAP_PX,
    NOTE_BLOCK_PX,
    QUOTE_BLOCK_PX,
    META_BLOCK_PX,
    annotationCardHeight,
    annotationRowSize,
} from "../src/features/library/components/annotation-card-layout";
import { bookmarkPositionLabel } from "../src/features/library/components/bookmark-position";

// @ts-expect-error React act environment flag
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe("annotation card layout", () => {
    it("depends only on which blocks are present, not on text length", () => {
        const short = annotationCardHeight({ quote: "a" });
        const long = annotationCardHeight({ quote: "word ".repeat(2000) });
        expect(short).toBe(long);
    });

    it("adds each block plus one gap between blocks", () => {
        const chrome = annotationCardHeight({});
        expect(annotationCardHeight({ quote: "q" })).toBe(chrome + QUOTE_BLOCK_PX);
        expect(annotationCardHeight({ quote: "q", note: "n" })).toBe(chrome + QUOTE_BLOCK_PX + NOTE_BLOCK_PX + 12);
        expect(annotationCardHeight({ quote: "q", note: "n", meta: "m" }))
            .toBe(chrome + QUOTE_BLOCK_PX + NOTE_BLOCK_PX + META_BLOCK_PX + 24);
    });

    it("treats empty strings as absent blocks", () => {
        expect(annotationCardHeight({ quote: "", note: "", meta: "" })).toBe(annotationCardHeight({}));
    });

    it("row size is card height plus the uniform gap, and tolerates a missing row", () => {
        expect(annotationRowSize({ quote: "q" })).toBe(annotationCardHeight({ quote: "q" }) + ANNOTATION_ROW_GAP_PX);
        expect(annotationRowSize(undefined)).toBe(annotationCardHeight({}) + ANNOTATION_ROW_GAP_PX);
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

    function Harness({ onDelete, onPopoverClose, withPortal = false }: {
        onDelete: () => void;
        onPopoverClose?: () => void;
        withPortal?: boolean;
    }) {
        const [open, setOpen] = useState<string | null>(null);
        return (
            <>
                <button id="outside">outside</button>
                <AnnotationListCard
                    id="a1"
                    typeLabel="highlight"
                    dateLabel="2026-09-26"
                    sourceTitle="Dune"
                    sourceAuthor="Frank Herbert"
                    quote="Fear is the mind-killer."
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

    it("renders at its fixed height regardless of text length", () => {
        act(() => root.render(<Harness onDelete={() => {}} />));
        const card = container.querySelector(".group") as HTMLElement;
        expect(card.style.height).toBe(`${annotationCardHeight({ quote: "x" })}px`);
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
