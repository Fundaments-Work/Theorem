/**
 * Virtual scrolling performance benchmarks.
 *
 * Measures JS pipeline cost behind the @tanstack/react-virtual integration:
 * column detection, row computation, item slicing, and combined overhead.
 *
 * Run: pnpm test tests/library-virtualization.test.ts
 */

import { describe, it, expect } from "vitest";
import type { Book, LibraryViewMode } from "../src/core/types";

// ── Test helpers ───────────────────────────────────────────

function makeBook(index: number): Book {
    return {
        id: `book-${index}`,
        title: `Book Title Number ${index} — A Rather Long Title for Testing`,
        author: `Author ${index % 50} Surname`,
        format: "epub",
        filePath: `/books/file-${index}.epub`,
        storagePath: `/storage/book-${index}`,
        dateAdded: new Date(2024, 0, 1 + index).toISOString(),
        lastRead: index % 3 === 0 ? new Date(2025, 0, 1 + index).toISOString() : null,
        progress: index % 5 === 0 ? 0.5 : index % 4 === 0 ? 0.25 : 0,
        coverPath: index % 3 === 0 ? `data:image/webp;base64,cover-${index}` : undefined,
        isFavorite: index % 7 === 0,
        coverExtractionDone: true,
    } as Book;
}

function makeLibrary(size: number): Book[] {
    return Array.from({ length: size }, (_, i) => makeBook(i));
}

// ── Column count logic (mirrors Library.tsx ResizeObserver) ─

function computeGridCols(
    containerWidth: number,
    viewMode: LibraryViewMode,
): number {
    if (viewMode === "list") return 1;
    if (viewMode === "compact") {
        if (containerWidth >= 1280) return 6;
        if (containerWidth >= 1024) return 5;
        if (containerWidth >= 640) return 4;
        return 3;
    }
    // grid
    if (containerWidth >= 1440) return 6;
    if (containerWidth >= 1150) return 5;
    if (containerWidth >= 850) return 4;
    if (containerWidth >= 640) return 3;
    return 2;
}

// ── Virtual row computation (mirrors Library.tsx virtualizer setup) ──

interface VirtualRow {
    index: number;
    start: number;
    size: number;
    items: Book[];
}

function computeEstimateSize(
    viewMode: LibraryViewMode,
    cols: number,
    containerWidth: number,
): number {
    if (viewMode === "list") return 68;
    const gap = viewMode === "compact" ? 8 : 20;
    const cardW = Math.max(1, (containerWidth - (cols - 1) * gap) / cols);
    const textH = viewMode === "compact" ? 0 : 72;
    return Math.round(cardW * 1.5 + textH + gap);
}

function computeVirtualRows(
    books: Book[],
    viewMode: LibraryViewMode,
    cols: number,
    rowHeight: number,
    overscan: number,
): VirtualRow[] {
    const isListView = viewMode === "list";
    const rowCount = isListView
        ? books.length
        : Math.ceil(books.length / Math.max(cols, 1));

    const scrollTop = 0;
    const viewportHeight = 800;

    // Simulate @tanstack/react-virtual range computation
    const startIndex = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
    const endIndex = Math.min(
        rowCount - 1,
        Math.ceil((scrollTop + viewportHeight) / rowHeight) + overscan,
    );

    const rows: VirtualRow[] = [];
    for (let i = startIndex; i <= endIndex; i++) {
        const start = i * (isListView ? 1 : cols);
        const count = isListView ? 1 : Math.min(cols, books.length - start);
        rows.push({
            index: i,
            start: i * rowHeight,
            size: rowHeight,
            items: books.slice(start, start + count),
        });
    }
    return rows;
}

function runFullPipeline(
    books: Book[],
    viewMode: LibraryViewMode,
    containerWidth: number,
    overscan: number,
): { cols: number; rowHeight: number; visibleRows: number } {
    const cols = computeGridCols(containerWidth, viewMode);
    const rowHeight = computeEstimateSize(viewMode, cols, containerWidth);
    const rows = computeVirtualRows(books, viewMode, cols, rowHeight, overscan);
    return { cols, rowHeight, visibleRows: rows.length };
}

// ── Benchmarks ─────────────────────────────────────────────

describe("Virtual scrolling pipeline", () => {
    describe("Column count detection", () => {
        const widths = [480, 800, 1200, 1600, 1920];
        const modes: LibraryViewMode[] = ["grid", "compact", "list"];

        for (const mode of modes) {
            for (const w of widths) {
                it(`${mode} @ ${w}px`, () => {
                    const t0 = performance.now();
                    const result = computeGridCols(w, mode);
                    const elapsed = performance.now() - t0;
                    console.log(`  [VIRT] cols:${mode} container:${w}px = ${result} cols (${elapsed.toFixed(4)}ms)`);
                    expect(result).toBeGreaterThanOrEqual(1);
                    expect(elapsed).toBeLessThan(2); // column detection is O(1)
                });
            }
        }
    });

    describe("Row height estimation", () => {
        it("grid: 500px container, 3 cols", () => {
            const t0 = performance.now();
            const h = computeEstimateSize("grid", 3, 500);
            const elapsed = performance.now() - t0;
            console.log(`  [VIRT] row-est:grid cols:3 w:500 = ${h}px (${elapsed.toFixed(4)}ms)`);
            expect(h).toBeGreaterThan(0);
            expect(elapsed).toBeLessThan(1);
        });

        it("grid: 1200px container, 5 cols", () => {
            const t0 = performance.now();
            const h = computeEstimateSize("grid", 5, 1200);
            const elapsed = performance.now() - t0;
            console.log(`  [VIRT] row-est:grid cols:5 w:1200 = ${h}px (${elapsed.toFixed(4)}ms)`);
            expect(h).toBeGreaterThan(0);
            expect(elapsed).toBeLessThan(1);
        });

        it("compact: 1200px container, 5 cols", () => {
            const t0 = performance.now();
            const h = computeEstimateSize("compact", 5, 1200);
            const elapsed = performance.now() - t0;
            console.log(`  [VIRT] row-est:compact cols:5 w:1200 = ${h}px (${elapsed.toFixed(4)}ms)`);
            expect(h).toBeGreaterThan(0);
            expect(elapsed).toBeLessThan(1);
        });
    });

    describe("Virtual row generation: library sizes", () => {
        const sizes = [50, 100, 200, 500, 1000];

        for (const size of sizes) {
            it(`grid @ ${size} books`, () => {
                const books = makeLibrary(size);
                const t0 = performance.now();
                runFullPipeline(books, "grid", 1200, 3);
                const elapsed = performance.now() - t0;
                const { cols, rowHeight, visibleRows } = runFullPipeline(
                    books,
                    "grid",
                    1200,
                    3,
                );
                console.log(`  [VIRT] grid size:${size} cols:${cols} rowH:${rowHeight}px visible:${visibleRows} rows (${elapsed.toFixed(4)}ms total)`);
                expect(cols).toBeGreaterThan(1);
                expect(rowHeight).toBeGreaterThan(0);
                expect(visibleRows).toBeLessThanOrEqual(size);
            });

            it(`list @ ${size} books`, () => {
                const books = makeLibrary(size);
                const t0 = performance.now();
                runFullPipeline(books, "list", 800, 5);
                const elapsed = performance.now() - t0;
                const { cols, visibleRows } = runFullPipeline(
                    books,
                    "list",
                    800,
                    5,
                );
                console.log(`  [VIRT] list size:${size} visible:${visibleRows} rows (${elapsed.toFixed(4)}ms total)`);
                expect(cols).toBe(1);
                expect(visibleRows).toBeLessThanOrEqual(size);
                // Full pipeline at 1000 books should be well under 5ms
                if (size >= 1000) expect(elapsed).toBeLessThan(5);
            });
        }
    });

    describe("DOM reduction: visible items vs total", () => {
        const sizes = [50, 200, 500, 1000];

        for (const size of sizes) {
            it(`grid: ${size} books → ~${Math.ceil(size / 5) * 3} rows visible`, () => {
                const books = makeLibrary(size);
                const { visibleRows } = runFullPipeline(books, "grid", 1200, 3);
                const visibleItems = visibleRows * 5; // 5 cols at 1200px
                const domReduction = Math.round(
                    ((size - visibleItems) / size) * 100,
                );
                expect(visibleItems).toBeLessThan(size);
                // Log reduction for the report
                console.log(
                    `  [VSCROLL] grid size:${size} → visible:${visibleItems} items (${domReduction}% DOM reduction)`,
                );
            });
        }

        for (const size of sizes) {
            it(`list: ${size} books → ~20 items visible`, () => {
                const books = makeLibrary(size);
                const { visibleRows } = runFullPipeline(books, "list", 800, 10);
                const domReduction = Math.round(
                    ((size - visibleRows) / size) * 100,
                );
                expect(visibleRows).toBeLessThan(size);
                console.log(
                    `  [VSCROLL] list size:${size} → visible:${visibleRows} items (${domReduction}% DOM reduction)`,
                );
            });
        }
    });

    describe("View mode switch: full pipeline cost", () => {
        it("switching modes recomputes correctly at 500 books", () => {
            const books500 = makeLibrary(500);

            const t0 = performance.now();
            runFullPipeline(books500, "grid", 1200, 3);
            runFullPipeline(books500, "compact", 1200, 3);
            runFullPipeline(books500, "list", 800, 5);
            const elapsed = performance.now() - t0;
            console.log(`  [VIRT] mode-switch grid→compact→list 500books: ${elapsed.toFixed(4)}ms total`);

            const r1 = runFullPipeline(books500, "grid", 1200, 3);
            const r2 = runFullPipeline(books500, "compact", 1200, 3);
            const r3 = runFullPipeline(books500, "list", 800, 5);
            expect(r1.cols).toBe(5);
            expect(r2.cols).toBe(5);
            expect(r3.cols).toBe(1);
            expect(elapsed).toBeLessThan(5);
        });
    });
});
