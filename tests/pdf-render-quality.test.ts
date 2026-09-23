import { describe, expect, it } from "vitest";
import { FAST_SCROLL_VIEWPORTS_PER_SECOND, interactionPixelRatio, isFastScroll } from "../src/features/reader/engines/pdf-render-quality";

describe("fast-scroll detection", () => {
    const viewport = 800;
    it("reading-speed scrolls stay full quality; flings and drags do not", () => {
        // A wheel notch (~100 px) per frame is 7.5 viewports/s: fast.
        expect(isFastScroll(100, 16, viewport)).toBe(true);
        // Slow reading scroll: 20 px per frame is 1.5 viewports/s, the threshold.
        expect(isFastScroll(20, 16.7, viewport)).toBe(false);
        expect(isFastScroll(21, 16, viewport)).toBe(true);
        // Scrollbar drag jumping 30 viewports in one frame, either direction.
        expect(isFastScroll(-24000, 16, viewport)).toBe(true);
    });

    it("threshold is exactly FAST_SCROLL_VIEWPORTS_PER_SECOND", () => {
        const px = viewport * FAST_SCROLL_VIEWPORTS_PER_SECOND; // per second
        expect(isFastScroll(px, 1000, viewport)).toBe(true);
        expect(isFastScroll(px - 1, 1000, viewport)).toBe(false);
    });

    it("guards zero, negative and non-finite inputs", () => {
        expect(isFastScroll(0, 16, viewport)).toBe(false);
        expect(isFastScroll(500, 0, viewport)).toBe(false);
        expect(isFastScroll(500, -5, viewport)).toBe(false);
        expect(isFastScroll(500, Number.NaN, viewport)).toBe(false);
        expect(isFastScroll(500, 16, 0)).toBe(false);
    });

    it("low-resolution pass renders well under device pixels", () => {
        expect(interactionPixelRatio(true)).toBe(0.5);
        expect(interactionPixelRatio(false)).toBe(0.6);
    });
});
