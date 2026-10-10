import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Opening a PDF applied up to three different scales in sequence.
 *
 *   1. the pre-fetch pass computed the correct mode-derived scale and set it,
 *      but only to lay out placeholders;
 *   2. the first paint then overwrote it with the raw saved `initialZoom`,
 *      ignoring the zoom *mode* — so "fit width"/"fit page" documents opened at
 *      a stale numeric zoom;
 *   3. once the first `PDFPageProxy` existed, the initial-view-state effect
 *      recomputed the fitted scale and applied it, producing the visible jump.
 */
const engine = readFileSync(
    resolve("src/features/reader/engines/pdfjs-engine.tsx"),
    "utf-8",
);

describe("PDF opens directly at its real zoom level", () => {
    it("computes one opening scale from the zoom mode, not the raw saved zoom", () => {
        expect(engine).toContain("let openingScale = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, initialZoom));");
        expect(engine).toMatch(
            /if \(\s*zoomContainer\s*&&\s*\(initialZoomMode === 'width-fit' \|\| initialZoomMode === 'page-fit'\)/,
        );
    });

    it("commits that single scale before the first paint", () => {
        expect(engine).toContain("scaleRef.current = openingScale;");
        expect(engine).toContain("setScale(openingScale);");
        // The bug: overwriting the fitted scale with the raw saved zoom.
        expect(engine).not.toContain(
            "setCurrentPage(clampedInitialPage); setTotalPages(totalPageCount); setScale(scaleRef.current);",
        );
    });

    it("lays out placeholders at the same scale the pages will render at", () => {
        expect(engine).toMatch(
            /computeVirtualPageTops\(\s*prefetched\.total_pages,\s*prefetched\.default_height_pt,\s*openingScale,/,
        );
        expect(engine).not.toContain("initialScaleForTops");
    });

    it("skips the redundant re-apply once the first page proxy lands", () => {
        expect(engine).toContain("if (Math.abs(nextScale - scaleRef.current) > 0.0005) {");
        expect(engine).toMatch(
            /if \(Math\.abs\(nextScale - scaleRef\.current\) > 0\.0005\) \{\s*applyZoom\(/,
        );
    });

    it("has a points-based fit-page helper so page-fit works before load", () => {
        expect(engine).toContain("function getFitPageScaleFromPts(");
        expect(engine).toMatch(
            /openingScale = initialZoomMode === 'page-fit'\s*\?\s*getFitPageScaleFromPts\(/,
        );
    });

    it("leaves custom (numeric) zoom untouched", () => {
        // A custom zoom must still open at exactly the saved percentage.
        expect(engine).toMatch(
            /const nextScale = normalizedMode === "page-fit"[\s\S]*?: Math\.max\(MIN_ZOOM, Math\.min\(MAX_ZOOM, initialZoom\)\);/,
        );
    });
});