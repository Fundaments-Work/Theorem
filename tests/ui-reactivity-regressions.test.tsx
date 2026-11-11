// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KnapTemplateEditor } from "../src/features/settings/KnapTemplateEditor";
import { AnnotationsPage } from "../src/features/library/Annotations";
import { LibraryPage } from "../src/features/library/Library";
import { DEFAULT_KNAP_TEMPLATE } from "../src/core/lib/knap-templates";
import * as knapTemplates from "../src/core/lib/knap-templates";
import * as storage from "../src/core/lib/storage";
import * as coverExtractor from "../src/core/lib/cover-extractor";
import { useLibraryStore, useUIStore } from "../src/core/store";
import type { Annotation, Book } from "../src/core/types";

function makeBook(id: string, overrides: Partial<Book> = {}): Book {
    return {
        id,
        title: `Title ${id}`,
        author: "Author",
        format: "epub",
        filePath: `/books/${id}.epub`,
        fileSize: 1024,
        addedAt: new Date("2026-10-01T00:00:00Z"),
        progress: 0,
        tags: [],
        isFavorite: false,
        readingTime: 0,
        ...overrides,
    };
}

function makeHighlight(id: string, bookId: string, selectedText = "Highlighted passage"): Annotation {
    return {
        id,
        bookId,
        type: "highlight",
        location: `cfi:${id}`,
        selectedText,
        createdAt: new Date("2026-10-15T10:00:00Z"),
    };
}

function stubDomMeasurements(): () => void {
    const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
    const keys = ["offsetWidth", "offsetHeight", "clientWidth", "clientHeight"] as const;
    const prevDescriptors = keys.map((k) => [k, Object.getOwnPropertyDescriptor(proto, k)] as const);
    for (const k of keys) {
        Object.defineProperty(proto, k, {
            configurable: true,
            get: () => (k.includes("Width") ? 960 : 720),
        });
    }
    const prevResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class ResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
    };
    return () => {
        for (const [k, desc] of prevDescriptors) {
            if (desc) Object.defineProperty(proto, k, desc);
            else delete proto[k];
        }
        globalThis.ResizeObserver = prevResizeObserver;
    };
}

describe("UI reactivity and render stability regressions", () => {
    let host: HTMLDivElement;
    let root: Root;
    let restoreDom: () => void;

    beforeEach(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        window.localStorage.clear();
        window.sessionStorage.clear();
        restoreDom = stubDomMeasurements();
        host = document.createElement("div");
        document.body.appendChild(host);
        root = createRoot(host);
        useLibraryStore.setState({
            books: [],
            annotations: [],
            collections: [],
            coversHydrated: false,
            recentBooksCache: [],
        });
        useUIStore.setState({ currentRoute: "library", searchQuery: "" });
    });

    afterEach(() => {
        act(() => {
            root.unmount();
        });
        host.remove();
        restoreDom();
        vi.restoreAllMocks();
        useLibraryStore.setState({
            books: [],
            annotations: [],
            collections: [],
            coversHydrated: false,
            recentBooksCache: [],
        });
    });

    it("KnapTemplateEditor does not loop indefinitely when store has books and highlights", async () => {
        const book = makeBook("knap-b1");
        const ann = makeHighlight("knap-a1", book.id, "Fear is the mind-killer.");
        useLibraryStore.setState({ books: [book], annotations: [ann] });

        const renderSpy = vi.spyOn(knapTemplates, "renderKnapBookPage").mockImplementation(async () => ({
            output: "# Dune\n",
            errors: [],
        }));

        await act(async () => {
            root.render(<KnapTemplateEditor template={DEFAULT_KNAP_TEMPLATE} onChange={vi.fn()} />);
        });

        // Drain multiple promise/effect cycles; an unmemoized dependency causes repeated re-renders here.
        for (let i = 0; i < 6; i++) {
            await act(async () => {
                await new Promise((r) => setTimeout(r, 10));
            });
        }

        expect(renderSpy.mock.calls.length).toBeLessThanOrEqual(2);
    });

    it("AnnotationsPage Cards view clamps groupIndex cleanly when annotation groups shrink", () => {
        const b1 = makeBook("ann-b1", { title: "Book One" });
        const b2 = makeBook("ann-b2", { title: "Book Two" });
        const a1 = makeHighlight("ann-1", b1.id, "First card");
        const a2 = makeHighlight("ann-2", b2.id, "Second card");
        useUIStore.setState({ currentRoute: "annotations", searchQuery: "" });
        useLibraryStore.setState({ books: [b1, b2], annotations: [a1, a2] });

        act(() => {
            root.render(<AnnotationsPage />);
        });

        const cardsToggle = host.querySelector<HTMLButtonElement>('button[aria-label="Cards view"]');
        expect(cardsToggle).not.toBeNull();
        act(() => {
            cardsToggle!.click();
        });
        expect(host.textContent).toContain("Deck 1 of 2");

        const nextDeckBtn = host.querySelector<HTMLButtonElement>('button[aria-label="Next Book"]');
        expect(nextDeckBtn).not.toBeNull();
        act(() => {
            nextDeckBtn!.click();
        });
        expect(host.textContent).toContain("Deck 2 of 2");

        // Case 1: Same filteredAnnotations.length (2 -> 2), but groups shrink from 2 books to 1 book.
        act(() => {
            useLibraryStore.setState({
                annotations: [a1, makeHighlight("ann-1b", b1.id, "Also in Book One")],
            });
        });
        expect(host.textContent).toContain("Deck 1 of 1");

        // Case 2: Shrink to 0 decks cleanly without out-of-bounds throw.
        act(() => {
            useLibraryStore.setState({ annotations: [] });
        });
        expect(host.textContent).toContain("No Highlights or Notes Yet");
    });

    it("LibraryPage fallback cover extraction processes all books instead of stalling after the first", async () => {
        const b1 = makeBook("cov-b1", { title: "Cover One", coverPath: undefined });
        const b2 = makeBook("cov-b2", { title: "Cover Two", coverPath: undefined });

        vi.spyOn(storage, "getBookData").mockResolvedValue(new ArrayBuffer(16));
        vi.spyOn(coverExtractor, "extractMetadata").mockImplementation(async (_data, _fmt, _name, bookId) => ({
            title: `Extracted ${bookId}`,
            author: "Author",
            coverDataUrl: `data:image/png;base64,${bookId}`,
        }));

        useUIStore.setState({ currentRoute: "library", searchQuery: "" });
        useLibraryStore.setState({
            books: [b1, b2],
            coversHydrated: true,
        });

        await act(async () => {
            root.render(<LibraryPage />);
        });

        for (let i = 0; i < 10; i++) {
            const state = useLibraryStore.getState();
            if (state.getBook("cov-b1")?.coverPath && state.getBook("cov-b2")?.coverPath) {
                break;
            }
            await act(async () => {
                await new Promise((r) => setTimeout(r, 20));
            });
        }

        const state = useLibraryStore.getState();
        expect(state.getBook("cov-b1")?.coverPath).toBe("data:image/png;base64,cov-b1");
        expect(state.getBook("cov-b2")?.coverPath).toBe("data:image/png;base64,cov-b2");
    });
});
