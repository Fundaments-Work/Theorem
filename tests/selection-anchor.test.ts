import { describe, expect, it } from "vitest";
import {
    cfiRangesOverlap,
    findAnnotationForSelection,
    pickVisibleAnchorRect,
} from "../src/features/reader/foliate/selection-anchor";

const page = { left: 0, top: 0, right: 400, bottom: 800 };

describe("pickVisibleAnchorRect", () => {
    it("returns null for no usable rects", () => {
        expect(pickVisibleAnchorRect([], page)).toBeNull();
        expect(pickVisibleAnchorRect([{ left: 1, top: 1, width: 0, height: 10 }], page)).toBeNull();
    });

    it("uses the last rect when it is on the visible page", () => {
        const rects = [
            { left: 20, top: 100, width: 300, height: 20 },
            { left: 20, top: 120, width: 150, height: 20 },
        ];
        expect(pickVisibleAnchorRect(rects, page)).toEqual(rects[1]);
    });

    it("skips rects that continue onto the next page", () => {
        const visible = { left: 20, top: 700, width: 300, height: 20 };
        const offscreen = [
            { left: 440, top: 40, width: 300, height: 20 },
            { left: 440, top: 60, width: 120, height: 20 },
        ];
        expect(pickVisibleAnchorRect([visible, ...offscreen], page)).toEqual(visible);
    });

    it("skips rects left of the page when selecting backwards across a page", () => {
        const visible = { left: 20, top: 40, width: 300, height: 20 };
        const prev = { left: -380, top: 700, width: 300, height: 20 };
        expect(pickVisibleAnchorRect([prev, visible], page)).toEqual(visible);
    });

    it("clamps into bounds when nothing is visible", () => {
        const r = pickVisibleAnchorRect([{ left: 900, top: 40, width: 50, height: 20 }], page)!;
        expect(r.left).toBeGreaterThanOrEqual(page.left);
        expect(r.left + r.width).toBeLessThanOrEqual(page.right);
        expect(r.width).toBeGreaterThan(0);
    });

    it("clamps a rect poking out of the bottom edge", () => {
        const r = pickVisibleAnchorRect([{ left: 10, top: 790, width: 50, height: 40 }], page)!;
        expect(r.top + r.height).toBeLessThanOrEqual(page.bottom);
    });
});

describe("cfiRangesOverlap", () => {
    const a = "epubcfi(/6/4!/4/2,/1:0,/1:10)";
    it("is true for identical CFIs", () => {
        expect(cfiRangesOverlap(a, a)).toBe(true);
    });
    it("is true for partial overlap", () => {
        expect(cfiRangesOverlap(a, "epubcfi(/6/4!/4/2,/1:5,/1:20)")).toBe(true);
    });
    it("is true when one contains the other", () => {
        expect(cfiRangesOverlap(a, "epubcfi(/6/4!/4/2,/1:2,/1:4)")).toBe(true);
    });
    it("is false for disjoint ranges in one paragraph", () => {
        expect(cfiRangesOverlap(a, "epubcfi(/6/4!/4/2,/1:10,/1:20)")).toBe(false);
        expect(cfiRangesOverlap(a, "epubcfi(/6/4!/4/2,/1:30,/1:40)")).toBe(false);
    });
    it("is false for different paragraphs and different sections", () => {
        expect(cfiRangesOverlap(a, "epubcfi(/6/4!/4/4,/1:0,/1:10)")).toBe(false);
        expect(cfiRangesOverlap(a, "epubcfi(/6/6!/4/2,/1:0,/1:10)")).toBe(false);
    });
    it("is false for empty or garbage input", () => {
        expect(cfiRangesOverlap("", a)).toBe(false);
        expect(cfiRangesOverlap(a, "not a cfi")).toBe(false);
    });
});

describe("findAnnotationForSelection", () => {
    const hl = (location: string, selectedText: string, type = "highlight") => ({
        type,
        location,
        selectedText,
    });

    it("never matches by text alone across the book (repeated phrase)", () => {
        const existing = hl("epubcfi(/6/4!/4/2,/1:0,/1:14)", "the old king");
        const found = findAnnotationForSelection(
            [existing],
            "epubcfi(/6/20!/4/8,/1:3,/1:17)",
            "the old king",
        );
        expect(found).toBeUndefined();
    });

    it("does not match a selection that is a substring of another highlight elsewhere", () => {
        const existing = hl("epubcfi(/6/4!/4/2,/1:0,/1:40)", "it was the best of times");
        expect(
            findAnnotationForSelection([existing], "epubcfi(/6/30!/4/2,/1:0,/1:8)", "the best"),
        ).toBeUndefined();
    });

    it("matches an exact CFI", () => {
        const existing = hl("epubcfi(/6/4!/4/2,/1:0,/1:14)", "x");
        expect(findAnnotationForSelection([existing], existing.location, "x")).toBe(existing);
    });

    it("treats a selection that only partly overlaps as new (it extends the highlight)", () => {
        const existing = hl("epubcfi(/6/4!/4/2,/1:0,/1:14)", "the old king");
        expect(
            findAnnotationForSelection([existing], "epubcfi(/6/4!/4/2,/1:10,/1:30)", "king and more"),
        ).toBeUndefined();
    });

    it("matches a selection contained in a highlight", () => {
        const existing = hl("epubcfi(/6/4!/4/2,/1:0,/1:14)", "the old king");
        expect(
            findAnnotationForSelection([existing], "epubcfi(/6/4!/4/2,/1:4,/1:9)", "old k"),
        ).toBe(existing);
    });

    it("ignores bookmarks and annotations without a location", () => {
        const bookmark = hl("epubcfi(/6/4!/4/2,/1:0,/1:14)", "text", "bookmark");
        expect(findAnnotationForSelection([bookmark], bookmark.location, "text")).toBeUndefined();
        expect(findAnnotationForSelection([{ type: "highlight" }], "epubcfi(/6/4!/4/2/1:0)", "t")).toBeUndefined();
    });

    it("handles an empty annotation list", () => {
        expect(findAnnotationForSelection([], "epubcfi(/6/4!/4/2/1:0)", "abcd")).toBeUndefined();
    });
});

import * as CFI from "../src/features/reader/foliate-js-runtime/epubcfi.js";
import {
    cfiRangesConnect,
    findMergeTargets,
    unionCfis,
} from "../src/features/reader/foliate/selection-anchor";

describe("cross-page highlight merge", () => {
    const makeDoc = () => {
        const doc = document.implementation.createHTMLDocument("t");
        doc.body.innerHTML =
            "<p>It was a bright cold day in April, and the clocks were striking thirteen.</p>"
            + "<p>Winston Smith slipped quickly through the glass doors.</p>";
        return doc;
    };
    const SECTION = "/6/4!";
    // CFI.fromRange yields a path relative to the section; add the spine prefix.
    const cfiFor = (doc: Document, node: Node, from: number, to: number, node2: Node = node) => {
        const r = doc.createRange();
        r.setStart(node, from);
        r.setEnd(node2, to);
        const raw = CFI.fromRange(r) as string;
        return raw.replace("epubcfi(", `epubcfi(${SECTION}`);
    };
    const textOf = (doc: Document, cfi: string) => {
        const inner = cfi.replace(SECTION, "");
        return CFI.toRange(doc, CFI.parse(inner))!.toString();
    };

    it("unions the two halves of one sentence into one range", () => {
        const doc = makeDoc();
        const t = doc.querySelector("p")!.firstChild!;
        const first = cfiFor(doc, t, 0, 30);
        const second = cfiFor(doc, t, 30, 70);
        const union = unionCfis([first, second])!;
        expect(union).toBeTruthy();
        expect(textOf(doc, union)).toBe((t as Text).data.slice(0, 70));
    });

    it("is order independent and idempotent", () => {
        const doc = makeDoc();
        const t = doc.querySelector("p")!.firstChild!;
        const a = cfiFor(doc, t, 5, 25);
        const b = cfiFor(doc, t, 20, 50);
        expect(unionCfis([a, b])).toBe(unionCfis([b, a]));
        const u = unionCfis([a, b])!;
        expect(unionCfis([u, a, b])).toBe(u);
    });

    it("keeps the outer range when one nests inside the other", () => {
        const doc = makeDoc();
        const t = doc.querySelector("p")!.firstChild!;
        const outer = cfiFor(doc, t, 0, 60);
        const inner = cfiFor(doc, t, 10, 20);
        expect(textOf(doc, unionCfis([outer, inner])!)).toBe((t as Text).data.slice(0, 60));
    });

    it("unions across paragraphs", () => {
        const doc = makeDoc();
        const [p1, p2] = Array.from(doc.querySelectorAll("p")).map((p) => p.firstChild!);
        const a = cfiFor(doc, p1, 50, 60);
        const b = cfiFor(doc, p2, 0, 15);
        const union = unionCfis([a, b])!;
        expect(textOf(doc, union)).toBe(
            (p1 as Text).data.slice(50) + (p2 as Text).data.slice(0, 15),
        );
    });

    it("refuses to merge across spine sections and handles empty input", () => {
        expect(unionCfis([])).toBeNull();
        expect(unionCfis(["epubcfi(/6/4!/4/2,/1:0,/1:5)", "epubcfi(/6/6!/4/2,/1:0,/1:5)"])).toBeNull();
        expect(unionCfis(["epubcfi(/6/4!/4/2,/1:0,/1:5)"])).toBe("epubcfi(/6/4!/4/2,/1:0,/1:5)");
        expect(unionCfis(["epubcfi(/6/4!/4/2,/1:0,/1:5)", "garbage"])).toBeNull();
    });

    it("treats exactly-touching ranges as connected but not overlapping", () => {
        const doc = makeDoc();
        const t = doc.querySelector("p")!.firstChild!;
        const a = cfiFor(doc, t, 0, 30);
        const b = cfiFor(doc, t, 30, 60);
        const far = cfiFor(doc, t, 40, 60);
        expect(cfiRangesOverlap(a, b)).toBe(false);
        expect(cfiRangesConnect(a, b)).toBe(true);
        expect(cfiRangesConnect(a, far)).toBe(false);
    });

    it("finds merge targets only in the same section", () => {
        const doc = makeDoc();
        const t = doc.querySelector("p")!.firstChild!;
        const first = { type: "highlight", location: cfiFor(doc, t, 0, 30), selectedText: "a" };
        const elsewhere = { type: "highlight", location: "epubcfi(/6/8!/4/2,/1:0,/1:30)", selectedText: "a" };
        const bookmark = { type: "bookmark", location: cfiFor(doc, t, 0, 30) };
        const fresh = cfiFor(doc, t, 30, 50);
        expect(findMergeTargets([first, elsewhere, bookmark], fresh)).toEqual([first]);
    });
});
