// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Book } from "../src/core/types";

const mocks = vi.hoisted(() => ({
    isTauri: false,
    queryWindow: vi.fn(),
    invoke: vi.fn(),
}));

vi.mock("../src/core/lib/env", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../src/core/lib/env")>()),
    isTauri: () => mocks.isTauri,
    isTauriDesktop: () => mocks.isTauri,
    isTauriMobile: () => false,
    isMobile: () => false,
}));

vi.mock("@tauri-apps/api/core", () => ({
    invoke: (...args: unknown[]) => mocks.invoke(...args),
}));

vi.mock("../src/core/lib/sqlite-storage", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../src/core/lib/sqlite-storage")>()),
    sqliteQueryBooksWindow: (...args: unknown[]) => mocks.queryWindow(...args),
}));

vi.mock("../src/core/lib/useSmartShelves", () => ({
    useSmartShelves: (_books: unknown[], collections: unknown[]) => ({
        collections,
        ready: true,
        error: undefined,
    }),
}));

vi.mock("@tanstack/react-virtual", () => ({
    useVirtualizer: ({ count }: { count: number }) => ({
        getTotalSize: () => count * 100,
        getVirtualItems: () =>
            Array.from({ length: count }, (_, index) => ({
                index,
                key: index,
                start: index * 100,
                size: 100,
            })),
        measure: vi.fn(),
        scrollToOffset: vi.fn(),
    }),
}));

import { LibraryPage } from "../src/features/library/Library";
import { useLibraryStore, useSettingsStore, useUIStore } from "../src/core/store";

function makeBook(id: string, overrides: Partial<Book> = {}): Book {
    return {
        id,
        title: `Title ${id}`,
        author: "Author",
        filePath: `/books/${id}.epub`,
        format: "epub",
        fileSize: 1024,
        addedAt: new Date("2026-01-01T00:00:00Z"),
        progress: 0,
        isFavorite: false,
        tags: [],
        readingTime: 0,
        ...overrides,
    };
}

function collectTsFiles(dir: string): string[] {
    const entries = readdirSync(dir);
    const out: string[] = [];
    for (const entry of entries) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
            out.push(...collectTsFiles(full));
        } else if (/\.(ts|tsx)$/.test(entry)) {
            out.push(full);
        }
    }
    return out;
}

describe("Architecture & SQLite window integration", () => {
    let container: HTMLDivElement;
    let root: Root | null = null;

    beforeEach(() => {
        (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
        mocks.isTauri = false;
        mocks.queryWindow.mockReset();
        mocks.invoke.mockReset();
        container = document.createElement("div");
        document.body.appendChild(container);
        useUIStore.setState({
            currentRoute: "library",
            searchQuery: "",
            selectedBooks: [],
        });
        useLibraryStore.setState({
            books: [],
            collections: [],
            annotations: [],
            recentBooksCache: [],
            deletionTombstones: [],
            coversHydrated: true,
        });
    });

    afterEach(() => {
        if (root) {
            act(() => {
                root!.unmount();
            });
            root = null;
        }
        container.remove();
        mocks.isTauri = false;
    });

    it("drives unfiltered dateAdded/asc Tauri library view through sqliteQueryBooksWindow", async () => {
        mocks.isTauri = true;
        const b1 = makeBook("b1", { title: "First Added" });
        const b2 = makeBook("b2", { title: "Second Added" });
        const b3 = makeBook("b3", { title: "Excluded By Window" });

        useSettingsStore.setState((s) => ({
            settings: {
                ...s.settings,
                librarySortBy: "dateAdded",
                librarySortOrder: "asc",
                libraryViewMode: "list",
            },
        }));
        useLibraryStore.setState({ books: [b1, b2, b3] });
        mocks.queryWindow.mockResolvedValue({
            bookIds: ["b2", "b1"],
            totalCount: 2,
        });

        await act(async () => {
            root = createRoot(container);
            root.render(<LibraryPage />);
        });
        await act(async () => {
            await Promise.resolve();
        });

        expect(mocks.queryWindow).toHaveBeenCalledWith(120, 0);
        const text = container.textContent ?? "";
        expect(text).toContain("Second Added");
        expect(text).toContain("First Added");
        expect(text).not.toContain("Excluded By Window");

        // Switching to a non-FTS sort mode falls back cleanly to JS sort without querying window.
        mocks.queryWindow.mockClear();
        await act(async () => {
            useSettingsStore.setState((s) => ({
                settings: { ...s.settings, librarySortBy: "title" },
            }));
        });
        expect(mocks.queryWindow).not.toHaveBeenCalled();
        expect(container.textContent).toContain("Excluded By Window");
    });

    it("exports book annotations via canonical YAML/markdown formatter", () => {
        const b = makeBook("b-md", { title: "Dune", author: "Frank Herbert" });
        useLibraryStore.setState({
            books: [b],
            annotations: [
                {
                    id: "a1",
                    bookId: "b-md",
                    type: "highlight",
                    location: "epubcfi(/6/2!/4/2:0)",
                    selectedText: "Fear is the mind-killer.",
                    color: "yellow",
                    createdAt: new Date("2026-09-01T10:00:00Z"),
                },
            ],
        });

        const md = useLibraryStore.getState().exportAnnotationsToMarkdown("b-md");
        expect(md).toContain('type: "theorem-book-highlights"');
        expect(md).toContain("# Dune");
        expect(md).toContain("Fear is the mind-killer.");
    });

    it("does not fall back to JS StarDict lookup on Tauri when native returns empty", async () => {
        mocks.isTauri = true;
        mocks.invoke.mockResolvedValue([]);
        const { lookupInStarDictDictionaries } = await import("../src/core/services/StarDictService");

        const result = await lookupInStarDictDictionaries(["dict-1"], "serendipity");
        expect(result).toEqual([]);
        expect(mocks.invoke.mock.calls.map(([cmd]) => cmd)).toEqual(["mdx_lookup", "stardict_lookup"]);
    });

    it("keeps src/core free of imports from src/features", () => {
        const coreDir = resolve("src/core");
        const offenders: string[] = [];
        for (const file of collectTsFiles(coreDir)) {
            const source = readFileSync(file, "utf-8");
            if (/from\s+["'][^"']*features\//.test(source) || /import\s*\(\s*["'][^"']*features\//.test(source)) {
                offenders.push(file);
            }
        }
        expect(offenders).toEqual([]);
    });
});
