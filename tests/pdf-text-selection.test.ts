import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readPdfTextSelection } from "../src/features/reader/hooks/usePdfTextSelection";

const rect = (left: number, top: number, width: number, height: number) =>
    ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() {} }) as DOMRect;

let restore: (() => void) | undefined;
beforeEach(() => {
    document.body.innerHTML = `
        <div class="textLayer"><span id="a">Ludwig  wrote</span> <span id="b">the\nTractatus</span></div>
        <p id="outside">Toolbar label</p>`;
    // jsdom has no layout: give ranges two line boxes.
    const proto = Range.prototype as unknown as Record<string, unknown>;
    const before = { rects: proto.getClientRects, bounds: proto.getBoundingClientRect };
    proto.getClientRects = () => [rect(10, 100, 80, 18), rect(10, 124, 60, 18), rect(0, 0, 0, 0)];
    proto.getBoundingClientRect = () => rect(10, 100, 80, 42);
    restore = () => { proto.getClientRects = before.rects; proto.getBoundingClientRect = before.bounds; };
});
afterEach(() => { restore?.(); window.getSelection()?.removeAllRanges(); });

function select(startId: string, start: number, endId: string, end: number) {
    const range = document.createRange();
    range.setStart(document.getElementById(startId)!.firstChild!, start);
    range.setEnd(document.getElementById(endId)!.firstChild!, end);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    return sel;
}

describe("readPdfTextSelection", () => {
    it("reads text-layer selections with collapsed whitespace, anchored on the last line", () => {
        const result = readPdfTextSelection(select("a", 0, "b", 13));
        expect(result?.text).toBe("Ludwig wrote the Tractatus");
        expect(result?.position).toEqual({ x: 40, y: 124, height: 24 });
    });

    it("single word (double-click) works", () => {
        expect(readPdfTextSelection(select("b", 4, "b", 13))?.text).toBe("Tractatus");
    });

    it("ignores selections outside the text layer, collapsed and empty ones", () => {
        expect(readPdfTextSelection(select("outside", 0, "outside", 7))).toBeNull();
        expect(readPdfTextSelection(select("a", 3, "a", 3))).toBeNull();
        expect(readPdfTextSelection(select("a", 6, "a", 8))).toBeNull(); // only spaces
        expect(readPdfTextSelection(null)).toBeNull();
    });

    it("rejects selections too long to look up", () => {
        document.getElementById("a")!.firstChild!.textContent = "x".repeat(2001);
        expect(readPdfTextSelection(select("a", 0, "a", 2001))).toBeNull();
    });
});
