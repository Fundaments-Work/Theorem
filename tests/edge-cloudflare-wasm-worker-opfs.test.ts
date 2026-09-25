import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import {
    initTheoremCoreWasm,
    isWasmCoreReady,
    wasmFuzzyRank,
    wasmMarkdownToHtml,
    type FuzzyRankCandidate,
} from "../src/core/lib/theorem-core";
import { coreWorker } from "../src/core/lib/core-worker-client";
import {
    isOpfsSupported,
    saveBookData,
    getBookData,
    getBookBlob,
    deleteBookData,
} from "../src/core/lib/storage";
import { getFilteredAndSortedBooks } from "../src/features/library/filtering";
import type { Book } from "../src/core/types";

describe("Web & Edge Performance Parity (W1 - W4)", () => {
    describe("W1: Cloudflare Edge Immutable Caching", () => {
        it("public/_headers exists and enforces immutable caching on assets and wasm", () => {
            const headersPath = resolve(process.cwd(), "public/_headers");
            expect(existsSync(headersPath)).toBe(true);

            const content = readFileSync(headersPath, "utf-8");
            expect(content).toContain("/assets/*");
            expect(content).toContain("max-age=31536000, immutable");
            expect(content).toContain("*.wasm");
            expect(content).toContain("/index.html");
            expect(content).toContain("must-revalidate");
        });
    });

    describe("W2: Active Client WASM Hookup", () => {
        beforeEach(async () => {
            await initTheoremCoreWasm();
        });

        it("instantiates theorem-core.wasm and provides SIMD nucleo-matcher ranking", () => {
            expect(isWasmCoreReady()).toBe(true);

            const candidates: FuzzyRankCandidate[] = [
                { id: "b1", title: "Neuromancer", author: "William Gibson" },
                { id: "b2", title: "Snow Crash", author: "Neal Stephenson" },
                { id: "b3", title: "Count Zero", author: "William Gibson" },
            ];

            const results = wasmFuzzyRank(candidates, "gibson");
            expect(results.length).toBe(2);
            expect(results.map((r) => r.id)).toEqual(["b1", "b3"]);
        });

        it("converts Markdown to HTML via pulldown-cmark in WebAssembly", () => {
            const md = "## Title\n\nVisit [Theorem](https://fundaments.work).";
            const html = wasmMarkdownToHtml(md);
            expect(html).toContain("<h2>Title</h2>");
            expect(html).toContain('<a href="https://fundaments.work">Theorem</a>');
        });

        it("integrates into getFilteredAndSortedBooks for browser-mode search", () => {
            const mockBooks: Book[] = [
                {
                    id: "book-1",
                    title: "The Hobbit",
                    author: "J.R.R. Tolkien",
                    format: "epub",
                    progress: 0.5,
                    tags: [],
                    addedAt: new Date(),
                    lastReadAt: new Date(),
                    isFavorite: false,
                },
                {
                    id: "book-2",
                    title: "Dune",
                    author: "Frank Herbert",
                    format: "epub",
                    progress: 0.1,
                    tags: [],
                    addedAt: new Date(),
                    lastReadAt: new Date(),
                    isFavorite: false,
                },
            ];

            const filtered = getFilteredAndSortedBooks({
                books: mockBooks,
                searchQuery: "tolkien",
                selectedShelfBookIds: null,
                showFavoritesOnly: false,
                statusFilter: "all",
                sortBy: "title",
                sortOrder: "asc",
            });

            expect(filtered.length).toBe(1);
            expect(filtered[0].id).toBe("book-1");
        });
    });

    describe("W3: Web Worker Task Offloading", () => {
        it("coreWorker executes fuzzy search and markdown batch with graceful fallback", async () => {
            const candidates: FuzzyRankCandidate[] = [
                { id: "1", title: "Solaris", author: "Stanislaw Lem" },
                { id: "2", title: "Roadside Picnic", author: "Arkady and Boris Strugatsky" },
            ];

            const searchResults = await coreWorker.fuzzySearch(candidates, "solaris");
            expect(searchResults.length).toBeGreaterThanOrEqual(1);
            expect(searchResults[0].id).toBe("1");

            const renderedBatch = await coreWorker.renderMarkdownBatch([
                "# Heading 1",
                "*List item*",
            ]);
            expect(renderedBatch.length).toBe(2);
            expect(renderedBatch[0]).toContain("<h1>Heading 1</h1>");
            expect(renderedBatch[1]).toContain("<em>List item</em>");
        });
    });

    describe("W4: Origin Private File System (OPFS)", () => {
        let opfsStorage: Map<string, ArrayBuffer>;
        let origNavigator: any;

        beforeEach(() => {
            opfsStorage = new Map<string, ArrayBuffer>();
            origNavigator = global.navigator;

            // Mock OPFS FileSystemDirectoryHandle and FileSystemFileHandle
            const mockFileHandle = (filename: string) => ({
                createWritable: async () => ({
                    write: async (data: ArrayBuffer) => {
                        opfsStorage.set(filename, data);
                    },
                    close: async () => {},
                }),
                getFile: async () => {
                    const data = opfsStorage.get(filename);
                    if (!data) throw new Error("File not found");
                    return new File([data], filename);
                },
            });

            const mockDirectoryHandle = {
                getFileHandle: async (name: string, opts?: { create?: boolean }) => {
                    if (!opts?.create && !opfsStorage.has(name)) {
                        throw new Error(`File ${name} not found`);
                    }
                    return mockFileHandle(name);
                },
                getDirectoryHandle: async (_name: string, _opts?: any) => mockDirectoryHandle,
                removeEntry: async (name: string) => {
                    opfsStorage.delete(name);
                },
            };

            // Set mock navigator.storage.getDirectory
            Object.defineProperty(global, "navigator", {
                value: {
                    ...global.navigator,
                    storage: {
                        getDirectory: async () => mockDirectoryHandle,
                    },
                },
                configurable: true,
                writable: true,
            });
        });

        afterEach(() => {
            Object.defineProperty(global, "navigator", {
                value: origNavigator,
                configurable: true,
                writable: true,
            });
        });

        it("detects OPFS support correctly", () => {
            expect(isOpfsSupported()).toBe(true);
        });

        it("streams book binary directly into OPFS and retrieves it without copying", async () => {
            const testBookId = "test-book-opfs-123";
            const buffer = new TextEncoder().encode("EPUB_BINARY_CONTENT_STUB").buffer;

            const storagePath = await saveBookData(testBookId, buffer);
            expect(storagePath).toBe(`opfs://${testBookId}`);

            const retrievedBuffer = await getBookData(testBookId, storagePath);
            expect(retrievedBuffer).not.toBeNull();
            expect(new TextDecoder().decode(retrievedBuffer!)).toBe("EPUB_BINARY_CONTENT_STUB");

            const blob = await getBookBlob(testBookId, storagePath);
            expect(blob).not.toBeNull();
            expect(await blob!.text()).toBe("EPUB_BINARY_CONTENT_STUB");

            await deleteBookData(testBookId, storagePath);
            const afterDelete = await getBookData(testBookId, storagePath);
            expect(afterDelete).toBeNull();
        });
    });
});
