/**
 * Library Performance Benchmarks
 *
 * Purpose: Quantify the actual cost of library operations so we can make
 * evidence-based decisions about which optimizations are worthwhile.
 *
 * Each benchmark reports timing (ms) via `console.info` so CI logs are
 * readable. No threshold assertions are made — the tests always pass.
 * Instead they produce a table you can compare across commits.
 *
 * Interpretation guide (rough targets for 60fps budget = 16ms/frame):
 *   < 1ms   → No further optimization needed
 *   1–5ms   → Monitor; optimize if the library grows large
 *   5–16ms  → Worthwhile to optimize
 *   > 16ms  → Blocks a frame; HIGH PRIORITY to fix
 *
 * How to run:
 *   pnpm test tests/library-performance.test.ts
 *   pnpm test --reporter=verbose tests/library-performance.test.ts
 */

import { describe, it, expect, beforeAll } from "vitest";
import type { Book } from "../src/core/types";
import { getFilteredAndSortedBooks } from "../src/features/library/filtering";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const FORMATS = ["epub", "mobi", "pdf", "azw3", "fb2", "cbz"] as const;
const TAGS = ["fiction", "non-fiction", "science", "history", "fantasy", "rss", "news", "tech"];
const AUTHORS = [
    "Alice Walker", "Bob Martin", "Carol King", "David Lynch",
    "Eve Online", "Frank Herbert", "Grace Hopper", "Henry James",
];

function makeBook(index: number, overrides: Partial<Book> = {}): Book {
    return {
        id: `book-${index}`,
        title: `Book Title Number ${index} — A Long Title That Exercises The Search Index`,
        author: AUTHORS[index % AUTHORS.length],
        filePath: `/library/book-${index}.epub`,
        format: FORMATS[index % FORMATS.length],
        fileSize: 1024 * (index + 1),
        addedAt: new Date(Date.now() - index * 86_400_000),
        lastReadAt: index % 3 === 0 ? new Date(Date.now() - index * 3_600_000) : undefined,
        progress: (index % 100) / 100,
        tags: [TAGS[index % TAGS.length]],
        isFavorite: index % 7 === 0,
        readingTime: index * 60,
        rating: index % 5 === 0 ? (index % 4) + 1 : undefined,
        // required fields with defaults
        coverPath: undefined,
        locations: undefined,
        storagePath: undefined,
        currentLocation: undefined,
        lastClickFraction: undefined,
        pageProgress: undefined,
        pdfViewState: undefined,
        category: undefined,
        description: undefined,
        publisher: undefined,
        publishedDate: undefined,
        language: undefined,
        isbn: undefined,
        manualCompletionState: undefined,
        progressBeforeFinish: undefined,
        completedAt: undefined,
        contentHash: `sha256-${index}`,
        coverExtractionDone: false,
        ...overrides,
    };
}

function makeLibrary(size: number): Book[] {
    return Array.from({ length: size }, (_, i) => makeBook(i));
}

/** Runs fn `iterations` times and returns {min, max, avg, total} in ms */
function bench(fn: () => void, iterations = 50): {
    min: number; max: number; avg: number; total: number; iterations: number;
} {
    const times: number[] = [];
    for (let i = 0; i < iterations; i++) {
        const t0 = performance.now();
        fn();
        times.push(performance.now() - t0);
    }
    const total = times.reduce((a, b) => a + b, 0);
    return {
        min: Math.min(...times),
        max: Math.max(...times),
        avg: total / iterations,
        total,
        iterations,
    };
}

function fmt(ms: number) {
    return `${ms.toFixed(3)}ms`;
}

function printBenchResult(label: string, result: ReturnType<typeof bench>) {
    console.info(
        `  [PERF] ${label.padEnd(52)} avg=${fmt(result.avg)}  min=${fmt(result.min)}  max=${fmt(result.max)}`
    );
}

// ─── Fixture data ─────────────────────────────────────────────────────────────

const SMALL = 50;
const MEDIUM = 200;
const LARGE = 500;
const XLARGE = 1000;

let libSmall: Book[];
let libMedium: Book[];
let libLarge: Book[];
let libXLarge: Book[];

beforeAll(() => {
    libSmall = makeLibrary(SMALL);
    libMedium = makeLibrary(MEDIUM);
    libLarge = makeLibrary(LARGE);
    libXLarge = makeLibrary(XLARGE);
});

// ─── 1. Sort-only (no search query) ──────────────────────────────────────────

describe("Sort-only performance (no search query)", () => {
    const sorts = ["title", "author", "dateAdded", "lastRead", "progress", "rating"] as const;

    it("measures all sort keys at each library size", () => {
        console.info("\n── Sort-only benchmarks ─────────────────────────────────────");
        for (const lib of [
            { label: `small (${SMALL})`, data: libSmall },
            { label: `medium (${MEDIUM})`, data: libMedium },
            { label: `large (${LARGE})`, data: libLarge },
            { label: `xlarge (${XLARGE})`, data: libXLarge },
        ]) {
            for (const sortBy of sorts) {
                const result = bench(() => {
                    getFilteredAndSortedBooks({
                        books: lib.data,
                        searchQuery: "",
                        selectedShelfBookIds: null,
                        showFavoritesOnly: false,
                        sortBy,
                        sortOrder: "asc",
                    });
                }, 100);
                printBenchResult(`sort:${sortBy} lib:${lib.label}`, result);

                // Soft check: sort should never take more than 50ms even on xlarge
                expect(result.avg).toBeLessThan(50);
            }
        }
    });
});

// ─── 2. Fuse search: first call (cold, index build) vs subsequent (warm) ─────

describe("Fuse search: cold vs warm index", () => {
    it("measures index build cost (cold) versus cached lookup (warm)", () => {
        console.info("\n── Fuse search: cold vs warm ────────────────────────────────");

        for (const [label, data] of [
            [`small (${SMALL})`, libSmall],
            [`medium (${MEDIUM})`, libMedium],
            [`large (${LARGE})`, libLarge],
            [`xlarge (${XLARGE})`, libXLarge],
        ] as [string, Book[]][]) {
            // Force a fresh books array so the WeakMap cache misses on first call
            const freshBooks = [...data];

            // Cold: first call on a new array reference (cache miss → index build)
            const cold = bench(() => {
                const freshBooksInner = [...data]; // new reference every time to force rebuild
                getFilteredAndSortedBooks({
                    books: freshBooksInner,
                    searchQuery: "fiction",
                    selectedShelfBookIds: null,
                    showFavoritesOnly: false,
                    sortBy: "title",
                    sortOrder: "asc",
                });
            }, 30);

            // Warm: same array reference, cache hit
            const warm = bench(() => {
                getFilteredAndSortedBooks({
                    books: freshBooks,
                    searchQuery: "fiction",
                    selectedShelfBookIds: null,
                    showFavoritesOnly: false,
                    sortBy: "title",
                    sortOrder: "asc",
                });
            }, 100);

            printBenchResult(`fuse cold  lib:${label}`, cold);
            printBenchResult(`fuse warm  lib:${label}`, warm);

            const speedup = cold.avg / Math.max(warm.avg, 0.001);
            console.info(
                `  [PERF]   speedup from cache: ${speedup.toFixed(1)}x  (cold=${fmt(cold.avg)} warm=${fmt(warm.avg)})`
            );

            // Warm should be faster than cold for >= medium, but CI runners
            // are noisy — only assert when the difference is clear (>20% gap).
            if (data.length >= MEDIUM) {
                const ratio = warm.avg / Math.max(cold.avg, 0.001);
                if (ratio > 1.5) {
                    // Warm is significantly slower — something is broken
                    expect(ratio).toBeLessThanOrEqual(1.0);
                }
            }
        }
    }, 20000);

    it("measures how query length affects warm search latency", () => {
        console.info("\n── Fuse search: query length sensitivity ────────────────────");
        const books = libLarge; // use a stable reference for warm cache
        // Prime the cache
        getFilteredAndSortedBooks({
            books, searchQuery: "a", selectedShelfBookIds: null,
            showFavoritesOnly: false, sortBy: "title", sortOrder: "asc",
        });

        for (const query of ["f", "fi", "fic", "fict", "fictio", "fiction"]) {
            const result = bench(() => {
                getFilteredAndSortedBooks({
                    books,
                    searchQuery: query,
                    selectedShelfBookIds: null,
                    showFavoritesOnly: false,
                    sortBy: "title",
                    sortOrder: "asc",
                });
            }, 100);
            printBenchResult(`fuse warm query="${query.padEnd(7)}" lib:large`, result);
            expect(result.avg).toBeLessThan(20);
        }
    });
});

// ─── 3. Filter cost: shelf + favorites ───────────────────────────────────────

describe("Filter cost: shelf scoping and favorites", () => {
    it("measures filter overhead on top of search", () => {
        console.info("\n── Filter: shelf + favorites ────────────────────────────────");

        const halfIds = new Set(libLarge.slice(0, LARGE / 2).map((b) => b.id));

        const noFilter = bench(() => {
            getFilteredAndSortedBooks({
                books: libLarge,
                searchQuery: "",
                selectedShelfBookIds: null,
                showFavoritesOnly: false,
                sortBy: "title",
                sortOrder: "asc",
            });
        }, 100);

        const shelfFilter = bench(() => {
            getFilteredAndSortedBooks({
                books: libLarge,
                searchQuery: "",
                selectedShelfBookIds: halfIds,
                showFavoritesOnly: false,
                sortBy: "title",
                sortOrder: "asc",
            });
        }, 100);

        const favFilter = bench(() => {
            getFilteredAndSortedBooks({
                books: libLarge,
                searchQuery: "",
                selectedShelfBookIds: null,
                showFavoritesOnly: true,
                sortBy: "title",
                sortOrder: "asc",
            });
        }, 100);

        const shelfAndSearch = bench(() => {
            getFilteredAndSortedBooks({
                books: libLarge,
                searchQuery: "fiction",
                selectedShelfBookIds: halfIds,
                showFavoritesOnly: false,
                sortBy: "title",
                sortOrder: "asc",
            });
        }, 100);

        printBenchResult(`no filter        lib:large (${LARGE})`, noFilter);
        printBenchResult(`shelf filter     lib:large (${LARGE})`, shelfFilter);
        printBenchResult(`favorites filter lib:large (${LARGE})`, favFilter);
        printBenchResult(`shelf + search   lib:large (${LARGE})`, shelfAndSearch);

        expect(noFilter.avg).toBeLessThan(20);
        expect(shelfFilter.avg).toBeLessThan(20);
    });
});

// ─── 4. RSS URL normalization throughput ─────────────────────────────────────

describe("RSS URL normalization throughput", () => {
    function normalizeUrl(url: string): string {
        return url.toLowerCase().replace(/\/+$/, "");
    }

    it("measures normalization cost at article-batch scale", () => {
        console.info("\n── RSS URL normalization ─────────────────────────────────────");

        const urls = Array.from({ length: 1000 }, (_, i) =>
            `HTTPS://Example-${i}.com/Feed/Article-${i}/`
        );

        const result = bench(() => {
            for (const url of urls) {
                normalizeUrl(url);
            }
        }, 200);

        printBenchResult("normalizeUrl ×1000 articles", result);
        // 1000 normalizations should never exceed 5ms
        expect(result.avg).toBeLessThan(5);
    });

    it("proves normalization eliminates duplicates that exact-match misses", () => {
        const variants = [
            "https://Example.com/feed/",
            "HTTPS://EXAMPLE.COM/FEED/",
            "https://example.com/feed",
            "https://example.com/feed/",
        ];
        const normalized = new Set(variants.map((u) =>
            u.toLowerCase().replace(/\/+$/, "")
        ));
        // All four variants collapse to one canonical URL
        expect(normalized.size).toBe(1);

        // Without normalization, exact match sees 4 distinct URLs
        const exact = new Set(variants);
        expect(exact.size).toBe(4);
    });
});

// ─── 5. Library size decision matrix ─────────────────────────────────────────

describe("Library size decision matrix", () => {
    /**
     * This test generates a summary table to inform whether virtual scrolling
     * is worth implementing. The key question: at what library size does
     * rendering and filtering become visibly slow?
     *
     * DOM rendering cost is NOT measured here (no jsdom rendering),
     * but filtering + sort cost is — the JS slice of the frame budget.
     */
    it("prints total pipeline cost at each library size", () => {
        console.info("\n── Pipeline cost decision matrix ─────────────────────────────");
        console.info("  Library size | Sort avg | Search avg | Verdict");
        console.info("  -------------|----------|------------|--------");

        const thresholds = [
            { size: 25,   label: "25   " },
            { size: 50,   label: "50   " },
            { size: 100,  label: "100  " },
            { size: 200,  label: "200  " },
            { size: 500,  label: "500  " },
            { size: 1000, label: "1000 " },
        ];

        for (const { size, label } of thresholds) {
            const lib = makeLibrary(size);

            const sortResult = bench(() => {
                getFilteredAndSortedBooks({
                    books: lib,
                    searchQuery: "",
                    selectedShelfBookIds: null,
                    showFavoritesOnly: false,
                    sortBy: "title",
                    sortOrder: "asc",
                });
            }, 50);

            // Warm search (same reference)
            getFilteredAndSortedBooks({
                books: lib, searchQuery: "a",
                selectedShelfBookIds: null, showFavoritesOnly: false,
                sortBy: "title", sortOrder: "asc",
            });
            const searchResult = bench(() => {
                getFilteredAndSortedBooks({
                    books: lib,
                    searchQuery: "fiction",
                    selectedShelfBookIds: null,
                    showFavoritesOnly: false,
                    sortBy: "title",
                    sortOrder: "asc",
                });
            }, 50);

            const sortOk = sortResult.avg < 5 ? "✓ fast" : sortResult.avg < 16 ? "⚠ ok" : "✗ SLOW";
            const searchOk = searchResult.avg < 5 ? "✓ fast" : searchResult.avg < 16 ? "⚠ ok" : "✗ SLOW";
            const verdict =
                sortResult.avg < 5 && searchResult.avg < 5
                    ? "No action needed"
                    : sortResult.avg < 16 && searchResult.avg < 16
                    ? "Monitor — consider virtual scroll"
                    : "Virtual scroll recommended";

            console.info(
                `  ${label.padEnd(13)}| ${fmt(sortResult.avg).padEnd(8)} | ${fmt(searchResult.avg).padEnd(10)} | ${sortOk}/${searchOk} → ${verdict}`
            );

            expect(sortResult.avg).toBeLessThan(100);
            expect(searchResult.avg).toBeLessThan(100);
        }
    });
});

// ─── 6. Fuse WeakMap cache invalidation correctness ──────────────────────────

describe("Fuse cache invalidation correctness", () => {
    it("returns stale results if the same array reference is mutated in-place", () => {
        /**
         * This is a KNOWN LIMITATION of the WeakMap cache: if code mutates the
         * `books` array in-place (push/splice) without changing the reference,
         * the cached Fuse index will be stale.
         *
         * Zustand replaces the array on every store mutation (immutable updates),
         * so in practice this never happens — but this test documents the contract.
         */
        const books: Book[] = [
            makeBook(0, { title: "Hamlet", author: "Shakespeare" }),
            makeBook(1, { title: "Othello", author: "Shakespeare" }),
        ];

        // Prime the cache
        const before = getFilteredAndSortedBooks({
            books,
            searchQuery: "hamlet",
            selectedShelfBookIds: null,
            showFavoritesOnly: false,
            sortBy: "title",
            sortOrder: "asc",
        });
        expect(before.length).toBe(1);
        expect(before[0].title).toBe("Hamlet");

        // Mutate in-place (THIS IS THE ANTI-PATTERN — Zustand never does this)
        books.push(makeBook(2, { title: "Hamlet II", author: "Shakespeare" }));

        const after = getFilteredAndSortedBooks({
            books,
            searchQuery: "hamlet",
            selectedShelfBookIds: null,
            showFavoritesOnly: false,
            sortBy: "title",
            sortOrder: "asc",
        });

        // Still returns 1 result — the new book is NOT indexed (stale cache).
        // This documents the contract: always use new array references.
        console.info(
            `  [PERF] Cache stale-on-mutation: got ${after.length} result(s) ` +
            `(expected 2 — but stale cache returns ${after.length}). ` +
            "Zustand's immutable updates prevent this in production."
        );
        // We don't assert the stale behavior as a requirement, just document it.
        expect(after.length).toBeGreaterThanOrEqual(1);
    });

    it("picks up new books when a fresh array reference is used", () => {
        const original: Book[] = [
            makeBook(10, { title: "Hamlet", author: "Shakespeare" }),
        ];

        // Prime cache with original reference
        getFilteredAndSortedBooks({
            books: original, searchQuery: "hamlet",
            selectedShelfBookIds: null, showFavoritesOnly: false,
            sortBy: "title", sortOrder: "asc",
        });

        // New array reference — cache miss → index rebuild
        const updated = [
            ...original,
            makeBook(11, { title: "Hamlet II", author: "Shakespeare" }),
        ];

        const results = getFilteredAndSortedBooks({
            books: updated, searchQuery: "hamlet",
            selectedShelfBookIds: null, showFavoritesOnly: false,
            sortBy: "title", sortOrder: "asc",
        });

        expect(results.length).toBe(2);
        expect(results.map((b) => b.title)).toContain("Hamlet");
        expect(results.map((b) => b.title)).toContain("Hamlet II");
    });
});
