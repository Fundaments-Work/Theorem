/**
 * One doc entry per item (sync protocol 2), deletions that never expire,
 * and conflicts found by the native merge.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Annotation, Book, DeletionTombstone } from "../src/core/types";

// ── Fake Tauri: IPC, events, device list ───────────────────────────────────
type Handler = (event: { payload: unknown }) => void;
const listeners = new Map<string, Set<Handler>>();
function emit(name: string, payload: unknown): void {
    for (const h of [...(listeners.get(name) ?? [])]) h({ payload });
}
vi.mock("@tauri-apps/api/event", () => ({
    listen: async (name: string, cb: Handler) => {
        if (!listeners.has(name)) listeners.set(name, new Set());
        listeners.get(name)!.add(cb);
        return () => { listeners.get(name)?.delete(cb); };
    },
}));

type Ipc = (args: Record<string, unknown>) => unknown;
let ipc: Record<string, Ipc> = {};
const ipcCalls: Array<{ cmd: string; args: Record<string, unknown> }> = [];
const docsWrites: Array<{ key: string; value: string }> = [];
vi.mock("@tauri-apps/api/core", () => ({
    invoke: vi.fn(async (cmd: string, args: Record<string, unknown> = {}) => {
        ipcCalls.push({ cmd, args });
        if (cmd === "docs_set_entry") docsWrites.push({ key: args.key as string, value: args.value as string });
        if (cmd === "docs_set_entries") docsWrites.push(...(args.entries as Array<{ key: string; value: string }>));
        const h = ipc[cmd];
        if (h) return h(args);
        if (cmd === "sqlite_get_kv") return "true";
        if (cmd === "sqlite_merge_sync_entries") throw new Error("no native merge in this test");
        return null;
    }),
    convertFileSrc: (p: string) => p,
}));

let pairedDevices: Array<{ deviceId: string; irohNodeId: string; protocol?: number }> = [];
vi.mock("../src/core/lib/device-sync", () => ({
    irohStart: async () => undefined,
    getPairedDevices: async () => pairedDevices,
    downloadBookFile: async () => null,
}));

vi.mock("../src/core/lib/env", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../src/core/lib/env")>()),
    isTauri: () => true,
}));

const toast = vi.fn();
vi.mock("sonner", () => ({ toast: (...args: unknown[]) => toast(...args) }));

const book = (id: string, extra: Partial<Book> = {}): Book => ({
    id, title: id, author: "a", format: "epub", filePath: `/b/${id}`, fileSize: 1,
    addedAt: new Date("2026-01-01"), progress: 0.1, tags: [], isFavorite: false, readingTime: 0,
    ...extra,
} as Book);

const annotation = (id: string, extra: Partial<Annotation> = {}): Annotation => ({
    id, bookId: "b1", type: "highlight", location: "cfi", selectedText: "text",
    createdAt: new Date("2026-01-02"), ...extra,
} as Annotation);

const emptyReport = {
    domainsUpdated: [], booksCount: 0, annotationsCount: 0,
    updatedBooks: [], deletedBooks: [], updatedAnnotations: [], deletedAnnotations: [],
    updatedVocabulary: [], deletedVocabulary: [], updatedRssArticles: [], deletedRssArticles: [],
};

type Orchestrator = typeof import("../src/core/lib/sync-orchestrator");
type Stores = typeof import("../src/core/store");
let orch: Orchestrator;
let stores: Stores;

beforeEach(async () => {
    vi.resetModules();
    listeners.clear();
    ipc = {};
    ipcCalls.length = 0;
    docsWrites.length = 0;
    toast.mockClear();
    pairedDevices = [{ deviceId: "dev-1", irohNodeId: "node-1", protocol: 2 }];
    stores = await import("../src/core/store");
    orch = await import("../src/core/lib/sync-orchestrator");
    for (const s of [stores.useLibraryStore, stores.useSettingsStore, stores.useVocabularyStore, stores.useRssStore]) {
        vi.spyOn(s.persist, "hasHydrated").mockReturnValue(true);
    }
    stores.useLibraryStore.setState({ books: [book("b1")], annotations: [], collections: [], deletionTombstones: [] });
    stores.useVocabularyStore.setState({ vocabularyTerms: [] });
    stores.useRssStore.setState({ feeds: [], articles: [] });
});

afterEach(() => {
    orch.stopAutoSync();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

const lib = () => stores.useLibraryStore.getState();
const keysWritten = () => docsWrites.map((w) => w.key);
const tomb = (entityType: DeletionTombstone["entityType"], entityId: string): DeletionTombstone =>
    ({ entityType, entityId, deletedAt: new Date().toISOString() });

describe("provisioning writes one entry per item", () => {
    it("every kind of item gets its own entry, all in one batched call", async () => {
        stores.useLibraryStore.setState({
            annotations: [annotation("a1")],
            collections: [{ id: "c1", name: "Shelf", bookIds: ["b1"], createdAt: new Date() } as never],
            deletionTombstones: [tomb("book", "gone")],
        });
        stores.useVocabularyStore.setState({ vocabularyTerms: [{ id: "v1", term: "word" } as never] });
        stores.useRssStore.setState({
            feeds: [{ id: "f1", url: "https://example.com/feed", title: "Feed" } as never],
            articles: [{ id: "r1", feedId: "f1", title: "Post" } as never],
        });

        await orch.provisionToIrohDocs();

        expect(keysWritten()).toEqual(expect.arrayContaining([
            "book:b1", "anno:b1:a1", "collection:c1", "tomb:book:gone",
            "vocab:v1", "rss_feed:f1", "rss_article:r1", "settings", "reading_stats",
        ]));
        expect(ipcCalls.filter((c) => c.cmd === "docs_set_entries")).toHaveLength(1);
        expect(ipcCalls.some((c) => c.cmd === "docs_set_entry")).toBe(false);
    });

    it("whole lists are written only while a paired device runs an older version", async () => {
        await orch.provisionToIrohDocs();
        for (const list of ["annotations", "collections", "deletion_tombstones", "vocabulary", "rss_feeds", "rss_articles"]) {
            expect(keysWritten()).not.toContain(list);
        }

        docsWrites.length = 0;
        pairedDevices = [...pairedDevices, { deviceId: "old", irohNodeId: "node-old" }];
        await orch.provisionToIrohDocs();
        for (const list of ["annotations", "collections", "deletion_tombstones", "vocabulary", "rss_feeds", "rss_articles"]) {
            expect(keysWritten()).toContain(list);
        }
    });

    it("an unchanged item is not sent again; a changed one is", async () => {
        stores.useLibraryStore.setState({ annotations: [annotation("a1"), annotation("a2")] });
        await orch.provisionToIrohDocs();
        docsWrites.length = 0;

        stores.useLibraryStore.setState({ annotations: [annotation("a1"), annotation("a2", { noteContent: "new" })] });
        await orch.provisionToIrohDocs();
        expect(keysWritten()).toEqual(["anno:b1:a2"]);
    });

    it("a large library goes in several calls", async () => {
        stores.useLibraryStore.setState({ books: Array.from({ length: 900 }, (_, i) => book(`b${i}`)) });
        await orch.provisionToIrohDocs();
        const batches = ipcCalls.filter((c) => c.cmd === "docs_set_entries");
        expect(batches.length).toBeGreaterThan(1);
        expect(batches.every((c) => (c.args.entries as unknown[]).length <= 400)).toBe(true);
        expect(keysWritten().filter((k) => k.startsWith("book:"))).toHaveLength(900);
    });

    it("expired deletion records leave the doc with the deletions", async () => {
        stores.useLibraryStore.setState({ deletionTombstones: [tomb("book", "gone")] });
        await orch.provisionToIrohDocs();
        const retain = ipcCalls.find((c) => c.cmd === "docs_retain_own_entries");
        expect(retain?.args).toEqual({ prefix: "tomb:", keep: ["tomb:book:gone"] });
    });
});

describe("the live bridge writes one entry per item", () => {
    it("a new word is its own entry, and a deletion sends no list to current devices", async () => {
        await orch.ensureResponderSyncReady();
        vi.useFakeTimers();
        orch.subscribeZustandToIrohDocs();
        await vi.advanceTimersByTimeAsync(10);
        docsWrites.length = 0;

        stores.useVocabularyStore.setState({ vocabularyTerms: [{ id: "v1", term: "word" } as never] });
        await vi.advanceTimersByTimeAsync(1000);
        expect(keysWritten()).toEqual(["vocab:v1"]);

        docsWrites.length = 0;
        stores.useLibraryStore.setState({ annotations: [annotation("a1")] });
        await vi.advanceTimersByTimeAsync(1000);
        docsWrites.length = 0;
        stores.useLibraryStore.setState({
            annotations: [],
            deletionTombstones: [tomb("annotation", "a1")],
        });
        await vi.advanceTimersByTimeAsync(1000);
        expect(keysWritten()).toEqual(["tomb:annotation:a1"]);
    });
});

describe("deletions that never expire", () => {
    it("an item deleted on another device goes, even with no deletion record left", async () => {
        ipc.docs_get_changed_entries = () => ({
            entries: {},
            deleted: [{ key: "book:b1", at: Date.now() }],
            token: 1,
        });
        await orch.hydrateFromIrohDocs();
        expect(lib().getBook("b1")).toBeUndefined();
        expect(lib().deletionTombstones).toEqual([expect.objectContaining({ entityType: "book", entityId: "b1" })]);
    });

    it("an item changed here after it was deleted there stays", async () => {
        stores.useLibraryStore.setState({ books: [book("b1", { lastReadAt: new Date("2026-06-02") })] });
        ipc.docs_get_changed_entries = () => ({
            entries: {},
            deleted: [{ key: "book:b1", at: new Date("2026-06-01").getTime() }],
            token: 1,
        });
        await orch.hydrateFromIrohDocs();
        expect(lib().getBook("b1")).toBeDefined();
        expect(lib().deletionTombstones).toEqual([]);
    });

    it("deletions of items this device never had add nothing", async () => {
        ipc.docs_get_changed_entries = () => ({
            entries: {},
            deleted: [{ key: "book:never-here", at: Date.now() }, { key: "anno:x:nope", at: Date.now() }],
            token: 1,
        });
        await orch.hydrateFromIrohDocs();
        expect(lib().deletionTombstones).toEqual([]);
        expect(lib().getBook("b1")).toBeDefined();
    });

    it("annotations, words, articles and feeds deleted elsewhere go too", () => {
        stores.useLibraryStore.setState({ annotations: [annotation("a1")] });
        stores.useVocabularyStore.setState({ vocabularyTerms: [{ id: "v1", term: "w", createdAt: new Date("2026-01-01") } as never] });
        stores.useRssStore.setState({ feeds: [{ id: "f1" } as never], articles: [{ id: "r1" } as never] });
        const at = Date.now();
        const tombs = orch.tombstonesForDocDeletions([
            { key: "anno:b1:a1", at }, { key: "vocab:v1", at }, { key: "rss_article:r1", at }, { key: "rss_feed:f1", at },
        ]);
        expect(tombs.map((t) => `${t.entityType}:${t.entityId}`).sort())
            .toEqual(["annotation:a1", "feed:f1", "rss_article:r1", "vocabulary:v1"]);
    });

    it("a deletion arriving live is applied without waiting for a round", async () => {
        vi.useFakeTimers();
        await orch.initDocsLiveListener();
        emit("docs-entry-batch", { entries: [], deleted: [{ key: "book:b1", at: Date.now() }] });
        await vi.advanceTimersByTimeAsync(3000);
        expect(lib().getBook("b1")).toBeUndefined();
    });

    it("several deletion records in one live batch are all applied", async () => {
        stores.useLibraryStore.setState({ books: [book("b1"), book("b2"), book("b3")] });
        vi.useFakeTimers();
        await orch.initDocsLiveListener();
        emit("docs-entry-batch", {
            entries: [
                { key: "tomb:book:b1", value: JSON.stringify(tomb("book", "b1")) },
                { key: "tomb:book:b2", value: JSON.stringify(tomb("book", "b2")) },
            ],
        });
        await vi.advanceTimersByTimeAsync(3000);
        expect(lib().books.map((b) => b.id)).toEqual(["b3"]);
    });

    it("deletion records and feeds sent as items are merged in a round", async () => {
        stores.useLibraryStore.setState({ books: [book("b1"), book("b2")] });
        ipc.docs_get_changed_entries = () => ({
            entries: {
                "tomb:book:b2": JSON.stringify(tomb("book", "b2")),
                "rss_feed:f9": JSON.stringify({ id: "f9", url: "https://example.org/rss", title: "New feed", addedAt: new Date().toISOString(), unreadCount: 0 }),
            },
            token: 1,
        });
        // Like the Rust merge: deletes what the deletion records it is handed name.
        const nativeEntries: Array<Record<string, string>> = [];
        ipc.sqlite_merge_sync_entries = (args) => {
            const entries = args.entries as Record<string, string>;
            nativeEntries.push(entries);
            const tombs = JSON.parse(entries.deletion_tombstones ?? "[]") as DeletionTombstone[];
            return { ...emptyReport, deletedBooks: tombs.filter((t) => t.entityType === "book").map((t) => t.entityId) };
        };
        await orch.hydrateFromIrohDocs();
        expect(Object.keys(nativeEntries[0])).not.toContain("tomb:book:b2");
        expect(lib().books.map((b) => b.id)).toEqual(["b1"]);
        expect(stores.useRssStore.getState().feeds.map((f) => f.id)).toContain("f9");
    });
});

describe("conflicts", () => {
    it("a live book goes through the native merge, and new conflicts are announced once", async () => {
        const merged: Array<Record<string, string>> = [];
        ipc.sqlite_merge_sync_entries = (args) => {
            merged.push(args.entries as Record<string, string>);
            return { ...emptyReport, conflicts: 1 };
        };
        const listed = vi.fn();
        window.addEventListener("theorem:sync-conflicts", listed);
        vi.useFakeTimers();
        await orch.initDocsLiveListener();
        const value = JSON.stringify(book("b1", { title: "Theirs", metadataUpdatedAt: "2026-05-03T00:00:00Z" }));
        emit("docs-entry-batch", { entries: [{ key: "book:b1", value }] });
        await vi.advanceTimersByTimeAsync(3000);
        expect(merged[0]["book:b1"]).toBe(value);
        expect(listed).toHaveBeenCalledTimes(1);
        await vi.waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
        expect(toast.mock.calls[0][0]).toBe("A sync conflict to review");
        window.removeEventListener("theorem:sync-conflicts", listed);
    });

    it("this device's newer edit is kept, and still goes to the native merge to be noted", async () => {
        stores.useLibraryStore.setState({ books: [book("b1", { title: "Mine", metadataUpdatedAt: "2026-05-09T00:00:00Z" })] });
        const merged: string[] = [];
        ipc.sqlite_merge_sync_entries = (args) => {
            merged.push(...Object.keys(args.entries as Record<string, string>));
            return emptyReport;
        };
        vi.useFakeTimers();
        await orch.initDocsLiveListener();
        emit("docs-entry-batch", { entries: [{ key: "book:b1", value: JSON.stringify(book("b1", { title: "Theirs", metadataUpdatedAt: "2026-05-08T00:00:00Z" })) }] });
        await vi.advanceTimersByTimeAsync(3000);
        expect(lib().getBook("b1")?.title).toBe("Mine");
        expect(merged).toContain("book:b1");
    });
});

describe("edits carry the version they were made on", () => {
    it("editing an annotation records the version it replaced", () => {
        const created = new Date("2026-01-02");
        stores.useLibraryStore.setState({ annotations: [annotation("a1", { createdAt: created })] });
        lib().updateAnnotation("a1", { noteContent: "first" });
        const first = lib().annotations[0];
        expect(new Date(first.baseUpdatedAt!).getTime()).toBe(created.getTime());
        lib().updateAnnotation("a1", { noteContent: "second" });
        const second = lib().annotations[0];
        expect(new Date(second.baseUpdatedAt!).getTime()).toBe(new Date(first.updatedAt!).getTime());
    });
});
