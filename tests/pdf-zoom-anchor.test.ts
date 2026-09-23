import { describe, expect, it } from "vitest";
import { captureZoomAnchor, resolveZoomAnchor, type PageBox } from "../src/features/reader/engines/pdf-zoom-anchor";

// Continuous layout: fixed 16px top padding and 12px gaps that do NOT scale,
// pages centred horizontally in a 1000px-wide container.
function layout(pages: number, scale: number, containerWidth = 1000): PageBox[] {
    const w = 600 * scale;
    const h = 800 * scale;
    const left = Math.max(0, (containerWidth - w) / 2);
    return Array.from({ length: pages }, (_, i) => {
        const top = 16 + i * (h + 12);
        return { pageNumber: i + 1, top, bottom: top + h, left, width: w };
    });
}

/** Content point (page, fraction) currently under a focus point. */
function pointUnder(boxes: PageBox[], scrollLeft: number, scrollTop: number, fx: number, fy: number) {
    const y = scrollTop + fy;
    const box = boxes.find((b) => y >= b.top && y <= b.bottom)!;
    return { page: box.pageNumber, fy: (y - box.top) / (box.bottom - box.top), fx: (scrollLeft + fx - box.left) / box.width };
}

describe("zoom anchoring", () => {
    it("keeps the same page point under the viewport centre deep in a long document", () => {
        const before = layout(400, 1.0);
        const scrollTop = before[299].top + 300; // reading page 300
        const focus = { x: 500, y: 400 };
        const anchor = captureZoomAnchor(before, 0, scrollTop, focus.x, focus.y, 1.1)!;
        const after = layout(400, 1.1);
        const pos = resolveZoomAnchor(after, anchor)!;

        const was = pointUnder(before, 0, scrollTop, focus.x, focus.y);
        const now = pointUnder(after, pos.left, pos.top, focus.x, focus.y);
        expect(now.page).toBe(was.page);
        expect(now.fy).toBeCloseTo(was.fy, 6);

        // The old "multiply the offset" formula drifts by (gaps not scaling):
        const naiveTop = (scrollTop + focus.y) * 1.1 - focus.y;
        expect(Math.abs(naiveTop - pos.top)).toBeGreaterThan(300);
    });

    it("anchors on the cursor for wheel zoom, including horizontally when zoomed wider than the viewport", () => {
        const before = layout(10, 2.0); // 1200px pages in 1000px container → horizontal scroll
        const scrollLeft = 150;
        const scrollTop = before[4].top + 200;
        const cursor = { x: 830, y: 120 };
        const anchor = captureZoomAnchor(before, scrollLeft, scrollTop, cursor.x, cursor.y, 3.0)!;
        const after = layout(10, 3.0);
        const pos = resolveZoomAnchor(after, anchor)!;
        const was = pointUnder(before, scrollLeft, scrollTop, cursor.x, cursor.y);
        const now = pointUnder(after, pos.left, pos.top, cursor.x, cursor.y);
        expect(now.page).toBe(was.page);
        expect(now.fy).toBeCloseTo(was.fy, 6);
        expect(now.fx).toBeCloseTo(was.fx, 6);
    });

    it("zooming out then back in returns to the same scroll position", () => {
        const a = layout(50, 1.5);
        const scrollTop = a[20].top + 123;
        const out = captureZoomAnchor(a, 0, scrollTop, 500, 450, 0.75)!;
        const b = layout(50, 0.75);
        const mid = resolveZoomAnchor(b, out)!;
        const back = captureZoomAnchor(b, mid.left, mid.top, 500, 450, 1.5)!;
        const end = resolveZoomAnchor(layout(50, 1.5), back)!;
        expect(end.top).toBeCloseTo(scrollTop, 6);
    });

    it("handles a focus point in the gap between pages", () => {
        const before = layout(5, 1);
        const gapY = before[1].bottom + 6; // middle of the gap after page 2
        const anchor = captureZoomAnchor(before, 0, gapY - 100, 500, 100, 2)!;
        expect([2, 3]).toContain(anchor.pageNumber);
        const pos = resolveZoomAnchor(layout(5, 2), anchor)!;
        expect(Number.isFinite(pos.top)).toBe(true);
    });

    it("clamps to the top of the document and never returns negative scroll", () => {
        const before = layout(3, 1);
        const anchor = captureZoomAnchor(before, 0, 0, 500, 5, 0.5)!;
        expect(resolveZoomAnchor(layout(3, 0.5), anchor)!.top).toBe(0);
    });

    it("returns null for an empty layout or a page that is no longer laid out", () => {
        expect(captureZoomAnchor([], 0, 0, 0, 0, 2)).toBeNull();
        const anchor = captureZoomAnchor(layout(3, 1), 0, 0, 500, 400, 2)!;
        expect(resolveZoomAnchor([], anchor)).toBeNull();
    });

    it("ignores degenerate zero-size boxes", () => {
        expect(captureZoomAnchor([{ pageNumber: 1, top: 0, bottom: 0, left: 0, width: 0 }], 0, 0, 0, 0, 2)).toBeNull();
    });
});
