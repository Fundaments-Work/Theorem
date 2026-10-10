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

/**
 * Even with one opening scale, the ResizeObserver re-fits width-fit/page-fit
 * 120ms after the container settles (RESIZE_OBSERVER_DEBOUNCE_MS). If the pages
 * were already revealed at that point the reader watched the zoom level change a
 * moment after opening, so the loader is held until the stabilization window
 * (300ms) has closed and the fit has converged.
 */
describe("PDF reveal waits for the opening zoom to converge", () => {
    it("reveals by polling for convergence, not by a fixed delay", () => {
        // A fixed timer made the common case 300ms slower for no reason; the scale is
        // usually already correct the moment the first proxy lands.
        expect(engine).toContain("const revealDeadline = Date.now() + INITIAL_RENDER_STABILIZATION_MS;");
        expect(engine).toContain("revealRafRef.current = window.requestAnimationFrame(tryReveal);");
        expect(engine).not.toContain("renderStabilizationTimeoutRef");
    });

    it("keeps polling only while the fitted scale disagrees", () => {
        expect(engine).toMatch(
            /if \(Math\.abs\(fitted - scaleRef\.current\) > ZOOM_SETTLE_EPSILON\) \{/,
        );
        expect(engine).toContain("const ZOOM_SETTLE_EPSILON = 0.0005;");
    });

    it("reveals immediately when the opening scale is already correct", () => {
        expect(engine).toMatch(
            /setIsInitialRenderStabilizing\(false\);\s*setIsLoading\(false\);/,
        );
    });

    it("converges rather than revealing a stale scale once out of budget", () => {
        expect(engine).toMatch(
            /applyZoom\(fitted, \{ mode, preserveMode: true, anchor: false \}\);/,
        );
    });

    it("bounds the wait with the stabilization window", () => {
        expect(engine).toContain("const INITIAL_RENDER_STABILIZATION_MS = 300;");
        const debounce = Number(
            engine.match(/const RESIZE_OBSERVER_DEBOUNCE_MS = (\d+);/)?.[1],
        );
        // The re-fit must be able to land inside the polling budget.
        expect(debounce).toBeLessThan(300);
    });

    it("cancels the reveal loop on unmount and reload", () => {
        const cancellations = engine.match(
            /cancelAnimationFrame\(revealRafRef\.current\)/g,
        );
        expect((cancellations ?? []).length).toBeGreaterThanOrEqual(2);
    });

    it("still re-fits on a genuine later resize", () => {
        // Convergence must not disable the observer permanently.
        expect(engine).toMatch(
            /zoomModeRef\.current === 'width-fit'\) \{\s*applyZoom\(getFitWidthScale\(/,
        );
    });
});

/**
 * Opening flashed a column of blank page slots before the spinner appeared.
 * `isLoading` started `false` and was only set `true` from a 300ms grace timer,
 * so the first paint was the empty page-slot template rather than the loader.
 */
describe("PDF shows the spinner from the very first frame", () => {
    it("starts in the loading state", () => {
        expect(engine).toMatch(/const \[isLoading, setIsLoading\] = useState\(true\);/);
    });

    it("sets loading synchronously when the load begins", () => {
        expect(engine).toMatch(
            /setError\(null\); setPages\(\[\]\);[\s\S]{0,400}?setIsLoading\(true\);/,
        );
        // The synchronous call must precede the grace timer that also sets it.
        expect(engine.indexOf("setError(null); setPages([]);"))
            .toBeLessThan(engine.indexOf("loadingGraceTimerRef.current = setTimeout"));
    });

    it("covers the page slots with an opaque loader", () => {
        expect(engine).toMatch(
            /\{isLoading && \(\s*<PageLoader\s*message="Loading PDF\.\.\."\s*className="absolute inset-0 z-20"/,
        );
        // PageLoader paints an opaque background, so blank slots cannot show through.
        const pageLoader = readFileSync(resolve("src/ui/loading/PageLoader.tsx"), "utf-8");
        expect(pageLoader).toContain('bg-[var(--color-background)]');
    });

    it("cannot strand the spinner when the PDF data is missing", () => {
        expect(engine).toMatch(
            /if \(requiresProvidedData && !pdfData\) \{[\s\S]*?setIsLoading\(false\);[\s\S]*?return;/,
        );
    });

    it("clears loading on error too", () => {
        expect(engine).toMatch(
            /callbacksRef\.current\.onError\?\.[\s\S]*?setIsLoading\(false\);/,
        );
    });
});