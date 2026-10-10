import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * PDF TOC jumps were dropped on the first click after opening a document.
 *
 * Pages are virtualized, so `scrollToPage` legitimately fails when the target
 * has no DOM node and no measured position yet. The jump was parked in
 * `pendingScrollPageRef` and the *only* thing that retried it was a layout
 * effect keyed on `[pages, scale, rotation, totalPages, ...]`. But
 * `loadSpecificPages` early-returns **without** calling `setPages` when every
 * requested page is already loaded or already in flight, so no re-render
 * happened and the parked jump was dropped forever. Later clicks worked because
 * by then the layout had settled and `scrollToPage` succeeded synchronously.
 */
const engine = readFileSync(
    resolve("src/features/reader/engines/pdfjs-engine.tsx"),
    "utf-8",
);

describe("PDF scroll jumps are retried independently of page state", () => {
    it("retries a parked jump on its own bounded rAF loop", () => {
        expect(engine).toContain("const retryPendingScroll = useCallback(");
        expect(engine).toContain("pendingScrollRetryRafRef.current = window.requestAnimationFrame(");
        expect(engine).toContain("const PENDING_SCROLL_RETRY_MS");
    });

    it("re-measures the layout on every retry attempt", () => {
        // Without rebuildPageLayout the measured tops never refresh and the
        // retry can never succeed.
        expect(engine).toMatch(
            /const retryPendingScroll = useCallback\([\s\S]*?rebuildPageLayout\(\);/,
        );
    });

    it("also retries once the target page load settles", () => {
        // The load-settled hook covers slow loads; the rAF loop covers the case
        // where loadSpecificPages early-returned because nothing needed loading.
        expect(engine).toMatch(
            /void loadSpecificPages\(nearTargets\)\.then\(\(\) => \{[\s\S]*?retryPendingScroll\(targetPage, effectiveBehavior\);[\s\S]*?\}\);/,
        );
    });

    it("parks the jump and starts retrying when the immediate scroll fails", () => {
        expect(engine).toMatch(
            /pendingScrollPageRef\.current = targetPage;\s*\n\s*retryPendingScroll\(targetPage, effectiveBehavior\);/,
        );
    });

    it("guards the retry against a superseded jump", () => {
        // A newer navigation must not be hijacked by the previous retry loop.
        expect(engine).toContain(
            "if (pendingScrollPageRef.current !== targetPage) return;",
        );
    });

    it("cancels the retry loop when the pending scroll is reset", () => {
        const cancellations = engine.match(
            /cancelAnimationFrame\(pendingScrollRetryRafRef\.current\)/g,
        );
        // Both the document-teardown reset and the effect cleanup must cancel.
        expect((cancellations ?? []).length).toBeGreaterThanOrEqual(2);
    });

    it("loadSpecificPages can settle without a state change (the original trap)", () => {
        // Pins the precondition that made the bug invisible: this early return
        // skips setPages entirely, so no layout effect re-runs.
        expect(engine).toMatch(
            /if \(numbersToLoad\.length === 0\) return false;/,
        );
    });
});