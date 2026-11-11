// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Book } from "../src/core/types";

const coreMocks = vi.hoisted(() => ({
    invoke: vi.fn(),
}));

const eventMocks = vi.hoisted(() => ({
    listeners: new Map<string, Array<(event: { payload: unknown }) => void>>(),
    listen: vi.fn(async (eventName: string, cb: (event: { payload: unknown }) => void) => {
        const list = eventMocks.listeners.get(eventName) ?? [];
        list.push(cb);
        eventMocks.listeners.set(eventName, list);
        return () => {
            const cur = eventMocks.listeners.get(eventName) ?? [];
            eventMocks.listeners.set(eventName, cur.filter((fn) => fn !== cb));
        };
    }),
    emit: (eventName: string, payload: unknown) => {
        for (const cb of eventMocks.listeners.get(eventName) ?? []) {
            cb({ payload });
        }
    },
}));

const importSpies = vi.hoisted(() => ({
    importBooksIncremental: vi.fn(),
    scanBookFolder: vi.fn(),
    reportMalformedSyncEntry: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
    invoke: coreMocks.invoke,
}));

vi.mock("@tauri-apps/api/event", () => ({
    listen: eventMocks.listen,
}));

vi.mock("../src/core/lib/import", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../src/core/lib/import")>();
    return {
        ...actual,
        importBooksIncremental: (...args: unknown[]) => importSpies.importBooksIncremental(...args),
        scanBookFolder: (...args: unknown[]) => importSpies.scanBookFolder(...args),
    };
});

vi.mock("../src/core/lib/sync-entries", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../src/core/lib/sync-entries")>();
    return {
        ...actual,
        reportMalformedSyncEntry: (...args: unknown[]) => importSpies.reportMalformedSyncEntry(...args),
    };
});

import {
    ANNOUNCEMENT_CACHE_TTL_MS,
    ANNOUNCEMENTS_CACHE_KEY,
    fetchAnnouncements,
} from "../src/core/lib/announcements";
import { applyBookEdits } from "../src/core/lib/book-edit";
import { initDocsLiveListener } from "../src/core/lib/sync-orchestrator";
import { useLibraryStore } from "../src/core/store";
import { LibraryFoldersSection } from "../src/features/settings/LibraryFoldersSection";
import { convertArticleToEpubBlob } from "../src/core/lib/rss-epub";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

const makeBook = (overrides: Partial<Book> = {}): Book => ({
    id: "book-1",
    title: "Dune",
    author: "Frank Herbert",
    filePath: "/library/dune.epub",
    format: "epub",
    fileSize: 2048,
    addedAt: new Date("2026-01-01T00:00:00Z"),
    progress: 0,
    readingTime: 0,
    tags: [],
    isFavorite: false,
    ...overrides,
});

beforeEach(() => {
    coreMocks.invoke.mockReset();
    coreMocks.invoke.mockResolvedValue(null);
    eventMocks.listeners.clear();
    eventMocks.listen.mockClear();
    importSpies.importBooksIncremental.mockReset();
    importSpies.scanBookFolder.mockReset();
    importSpies.reportMalformedSyncEntry.mockReset();
    localStorage.clear();
    useLibraryStore.setState({ books: [], annotations: [], collections: [], deletionTombstones: [] });
    (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__ = {};
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
});

afterEach(() => {
    act(() => root.unmount());
    host.remove();
    delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe("B17: announcements cache TTL", () => {
    it("ignores expired announcement cache entries older than ANNOUNCEMENT_CACHE_TTL_MS", async () => {
        localStorage.setItem(
            ANNOUNCEMENTS_CACHE_KEY,
            JSON.stringify({
                timestamp: Date.now() - ANNOUNCEMENT_CACHE_TTL_MS - 60_000,
                data: [
                    {
                        id: "stale-anno",
                        severity: "warning",
                        title: "Expired warning",
                        body: "Old message",
                        publishedAt: "2026-01-01T00:00:00Z",
                    },
                ],
            }),
        );
        vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Offline")));

        const result = await fetchAnnouncements(500);
        expect(result).toEqual([]);
    });
});

describe("M15: libraryStore & book-edit regressions", () => {
    it("indexes the surviving mergedBook.id into FTS5 when addBook merges a duplicate", async () => {
        const existing = makeBook({ id: "existing-kept-id", contentHash: "same-hash", title: "Dune", author: "Frank Herbert" });
        useLibraryStore.setState({ books: [existing] });

        act(() => {
            useLibraryStore.getState().addBook(
                makeBook({
                    id: "incoming-discarded-id",
                    contentHash: "same-hash",
                    title: "Dune",
                    author: "Frank Herbert",
                    description: "Added blurb triggering merge",
                }),
            );
        });
        await new Promise((resolve) => setTimeout(resolve, 25));

        const ftsCalls = coreMocks.invoke.mock.calls.filter(([cmd]) => cmd === "sqlite_index_book_fts");
        expect(ftsCalls.length).toBe(1);
        expect(ftsCalls[0]?.[1]).toMatchObject({ bookId: "existing-kept-id", title: "Dune" });
    });

    it("uses the SHA-256 hash returned by rewrite_epub_metadata instead of re-reading the EPUB via IPC", async () => {
        const book = makeBook({ id: "edit-book", format: "epub", filePath: "/library/edit.epub" });
        useLibraryStore.setState({ books: [book] });

        coreMocks.invoke.mockImplementation(async (cmd: string) => {
            if (cmd === "rewrite_epub_metadata") {
                return { size: 4096, blobHash: "rust-computed-sha256" };
            }
            if (cmd === "read_file" || cmd === "sqlite_load_book_binary") {
                throw new Error("Should not re-read EPUB into JS just to hash it");
            }
            return null;
        });

        const res = await applyBookEdits("edit-book", { title: "Dune (Revised)" });
        expect(res.ok).toBe(true);
        expect(useLibraryStore.getState().getBook("edit-book")?.blobHash).toBe("rust-computed-sha256");
    });
});

describe("N3: sync-orchestrator deletion_tombstones warning", () => {
    it("does not report a false 'not a list' warning when tombstones prune no annotations", async () => {
        vi.useFakeTimers();
        useLibraryStore.setState({ books: [makeBook({ id: "b1" })], annotations: [] });

        const unlisten = await initDocsLiveListener();
        eventMocks.emit("docs-entry-batch", {
            entries: [
                {
                    key: "deletion_tombstones",
                    value: JSON.stringify([
                        { entityId: "b1", entityType: "book", deletedAt: "2026-06-01T00:00:00Z" },
                    ]),
                },
            ],
        });

        await vi.advanceTimersByTimeAsync(1500);
        unlisten();

        const falseWarn = importSpies.reportMalformedSyncEntry.mock.calls.find(
            ([key]) => key === "deletion_tombstones",
        );
        expect(falseWarn).toBeUndefined();
    });
});

describe("B14: Settings LibraryFoldersSection durable import job wiring", () => {
    it("starts durable native import jobs when rescanning a folder from Settings", async () => {
        importSpies.scanBookFolder.mockResolvedValue({
            root: "/library/folder",
            rootName: "folder",
            files: [{ path: "/library/folder/a.epub", relativePath: "a.epub", rootName: "folder", size: 1024 }],
            issues: [],
        });
        importSpies.importBooksIncremental.mockResolvedValue([]);

        useLibraryStore.setState({
            books: [
                makeBook({
                    id: "b1",
                    sourceFolders: [{ root: "/library/folder", name: "folder", relativePath: "a.epub" }],
                }),
            ],
        });

        act(() => {
            root.render(<LibraryFoldersSection />);
        });

        const rescanBtn = host.querySelector<HTMLButtonElement>('button[aria-label="Rescan folder"]');
        expect(rescanBtn).toBeTruthy();

        await act(async () => {
            rescanBtn!.click();
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(importSpies.importBooksIncremental).toHaveBeenCalledTimes(1);
        const callOpts = importSpies.importBooksIncremental.mock.calls[0]?.[3] as { durable?: boolean } | undefined;
        expect(callOpts?.durable).toBe(true);
    });
});

describe("M16: clean core layer boundaries", () => {
    it("builds RSS article EPUBs cleanly via core utilities without importing features/", async () => {
        delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
        const blob = await convertArticleToEpubBlob({
            id: "a1",
            feedId: "f1",
            title: "Hello",
            url: "https://example.com/a",
            content: "<p>World</p>",
            fetchedAt: new Date("2026-01-01T00:00:00Z"),
            isRead: false,
            isFavorite: false,
            isSaved: true,
        });
        expect(blob.size).toBeGreaterThan(0);
    });
});
