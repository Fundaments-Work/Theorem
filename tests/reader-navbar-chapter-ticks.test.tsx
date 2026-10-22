// @vitest-environment jsdom
/**
 * Issue #160 in the reader's progress bar: chapter ticks thin out to stay at
 * least 8px apart, the position marker stays the accent, and hovering with a
 * mouse names the chapter while touch does not.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ReaderNavbar } from "../src/features/reader/components/progress/ReaderNavbar";
import type { TocItem } from "../src/core/types";

const WIDTH = 600;
const evenly = (n: number) => Array.from({ length: n }, (_, i) => i / n);
const toc = (n: number) => Array.from({ length: n }, (_, i) => ({ label: `Chapter ${i + 1}`, href: `c${i}.xhtml` })) as unknown as TocItem[];

let container: HTMLDivElement;
let root: Root;

function render(chapters: number) {
    act(() => {
        root.render(createElement(ReaderNavbar, {
            location: { percentage: 0.5 } as never,
            toc: toc(chapters),
            sectionFractions: evenly(chapters),
            onSeek: () => {},
            onToggleToc: () => {},
        }));
    });
}

const track = () => container.querySelector("[data-chapter-tick]")?.parentElement as HTMLElement;
const ticks = () => [...container.querySelectorAll<HTMLElement>("[data-chapter-tick]")];

function pointer(type: string, clientX: number, pointerType: string) {
    const event = new MouseEvent(type, { bubbles: true, clientX });
    Object.defineProperty(event, "pointerType", { value: pointerType });
    act(() => {
        track().dispatchEvent(event);
    });
}

beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
        x: 0, y: 0, left: 0, top: 0, right: WIDTH, bottom: 14, width: WIDTH, height: 14, toJSON: () => ({}),
    } as DOMRect);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
});

describe("reader progress bar chapter ticks", () => {
    it("a book with a handful of chapters shows every tick", () => {
        render(6);
        expect(ticks()).toHaveLength(5);
    });

    it("a book with 40 chapters on a 600px bar (15px each) keeps its ticks", () => {
        render(40);
        expect(ticks()).toHaveLength(39);
    });

    it("a book with 300 chapters (2px each) shows a calm, plain bar", () => {
        render(300);
        expect(ticks()).toHaveLength(0);
        // The bar itself and the position marker are still there.
        expect(container.querySelector(".cursor-pointer .w-2\\.5")).not.toBeNull();
    });

    it("ticks are muted and ignore the pointer; the position marker is the accent", () => {
        render(10);
        for (const tick of ticks()) {
            expect(tick.className).toContain("color-text-muted");
            expect(tick.className).not.toContain("color-accent");
            expect(tick.className).toContain("pointer-events-none");
        }
        const marker = [...track().children].find((el) => (el as HTMLElement).style.left === "50%" && el.className.includes("w-2.5"));
        expect(marker?.className).toContain("bg-[var(--color-accent)]");
    });

    it("hovering with a mouse names the chapter under the pointer; touch does not", () => {
        render(4);
        // The reader is at 50% (Chapter 3); the pointer is over Chapter 2.
        pointer("pointermove", WIDTH * 0.3, "touch");
        expect(container.textContent).not.toContain("Chapter 2");
        expect(container.textContent).not.toContain("30%");
        pointer("pointermove", WIDTH * 0.3, "mouse");
        expect(container.textContent).toContain("30%");
        expect(container.textContent).toContain("Chapter 2");
    });
});
