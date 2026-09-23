import { describe, expect, it } from "vitest";
import { mergeLineRects } from "../src/features/reader/foliate/selection-rects";

const r = (left: number, top: number, width: number, height = 18) => ({ left, top, width, height });

describe("mergeLineRects", () => {
    it("merges adjacent inline runs on the same line into one box", () => {
        // "plain " + <em>"emphasis"</em> + " text" on one line.
        expect(mergeLineRects([r(10, 100, 50), r(60, 100, 70), r(131, 100, 40)])).toEqual([r(10, 100, 161)]);
    });

    it("keeps separate lines separate and orders them top to bottom", () => {
        const out = mergeLineRects([r(10, 140, 300), r(10, 100, 300), r(10, 120, 300)]);
        expect(out.map((x) => x.top)).toEqual([100, 120, 140]);
    });

    it("does not bridge a wide horizontal gap (e.g. two columns on one row)", () => {
        const out = mergeLineRects([r(10, 100, 200), r(400, 100, 200)]);
        expect(out).toHaveLength(2);
    });

    it("tolerates sub-pixel baseline differences and mixed font sizes on one line", () => {
        const out = mergeLineRects([r(10, 100, 50, 18), r(60, 99.4, 30, 19.5)]);
        expect(out).toHaveLength(1);
        expect(out[0].top).toBe(99.4);
        // Union of [100, 118] and [99.4, 118.9].
        expect(out[0].height).toBeCloseTo(19.5, 5);
    });

    it("does not merge a superscript-sized box that sits clearly above the line", () => {
        const out = mergeLineRects([r(10, 100, 50, 18), r(61, 90, 8, 10)]);
        expect(out).toHaveLength(2);
    });

    it("handles empty input and does not mutate the input", () => {
        expect(mergeLineRects([])).toEqual([]);
        const input = [r(10, 100, 50), r(60, 100, 50)];
        const copy = JSON.parse(JSON.stringify(input));
        mergeLineRects(input);
        expect(input).toEqual(copy);
    });
});
