/**
 * Issue #160: the reader's progress bar drew a tick for every chapter, so a
 * book with many short chapters showed a dense row of marks. A tick is now
 * drawn only when it has at least 8px of room on both sides.
 */
import { describe, expect, it } from "vitest";
import { MIN_TICK_GAP_PX, thinChapterTicks } from "../src/features/reader/lib/chapter-ticks";

const evenly = (n: number) => Array.from({ length: n }, (_, i) => i / n);

describe("thinChapterTicks", () => {
    it("keeps every tick of a book with a handful of chapters", () => {
        const ticks = thinChapterTicks(evenly(8), 400);
        // Chapter 1 starts at the left end of the bar, which needs no tick.
        expect(ticks.map((t) => t.index)).toEqual([1, 2, 3, 4, 5, 6, 7]);
        expect(ticks[0].fraction).toBeCloseTo(1 / 8);
    });

    it("a book with 300 short chapters gets a plain bar, not a ruler", () => {
        expect(thinChapterTicks(evenly(300), 600)).toEqual([]);
        expect(thinChapterTicks(evenly(150), 1000)).toEqual([]);
    });

    it("chapters just wide enough all keep their tick; just too narrow, none do", () => {
        expect(thinChapterTicks(evenly(50), 50 * MIN_TICK_GAP_PX)).toHaveLength(49);
        expect(thinChapterTicks(evenly(50), 50 * MIN_TICK_GAP_PX - 1)).toEqual([]);
    });

    it("in a mixed book only boundaries with room around them get a tick", () => {
        // Cover, title page and copyright crowd the start; then four long chapters,
        // the third followed by two tiny interludes.
        const fractions = [0, 0.002, 0.004, 0.01, 0.25, 0.5, 0.75, 0.752, 0.754, 0.9];
        const ticks = thinChapterTicks(fractions, 1000);
        // 0.01 sits 6px after the copyright page; 0.75 and the interludes are 2px apart.
        expect(ticks.map((t) => t.fraction)).toEqual([0.25, 0.5, 0.9]);
    });

    it("every tick has at least the gap on both sides, ends of the bar included", () => {
        const width = 700;
        const fractions = [0, 0.004, 0.03, 0.2, 0.21, 0.4, 0.6, 0.97, 0.995];
        const ticks = thinChapterTicks(fractions, width);
        const all = [0, ...fractions.map((f) => f * width), width];
        for (const t of ticks) {
            const x = t.fraction * width;
            const i = all.indexOf(x);
            expect(x - all[i - 1]).toBeGreaterThanOrEqual(MIN_TICK_GAP_PX);
            expect(all[i + 1] - x).toBeGreaterThanOrEqual(MIN_TICK_GAP_PX);
        }
        expect(ticks.map((t) => t.fraction)).toEqual([0.03, 0.4, 0.6, 0.97]);
    });

    it("keeps ticks off the ends of the bar", () => {
        expect(thinChapterTicks([0, 0.01, 0.5, 0.99], 200).map((t) => t.fraction)).toEqual([0.5]);
    });

    it("the same book shows more ticks on a wider bar", () => {
        const fractions = evenly(80);
        expect(thinChapterTicks(fractions, 320)).toEqual([]);
        expect(thinChapterTicks(fractions, 1200)).toHaveLength(79);
    });

    it("keeps each tick's index into the original list, for its chapter name", () => {
        const fractions = [Number.NaN, 0, 0.3, 0.6];
        expect(thinChapterTicks(fractions, 1000).map((t) => t.index)).toEqual([2, 3]);
    });

    it("honours a custom gap", () => {
        expect(thinChapterTicks(evenly(10), 100, 8)).toHaveLength(9);
        expect(thinChapterTicks(evenly(10), 100, 11)).toEqual([]);
    });

    it("draws nothing before the bar has a width, or without chapters", () => {
        expect(thinChapterTicks(evenly(10), 0)).toEqual([]);
        expect(thinChapterTicks(evenly(10), Number.NaN)).toEqual([]);
        expect(thinChapterTicks([], 500)).toEqual([]);
        expect(thinChapterTicks([0], 500)).toEqual([]);
    });

    it("skips unusable and out-of-order fractions", () => {
        const ticks = thinChapterTicks([Number.NaN, 0.5, Number.POSITIVE_INFINITY, 0.25, 0.75, -1, 2], 400);
        expect(ticks.map((t) => t.fraction)).toEqual([0.5, 0.75]);
    });
});
