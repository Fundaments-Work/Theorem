import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Book } from "../src/core/types";
import { mergeBooks } from "../src/core/lib/sync-import";

// ── Fake Tauri: IPC, events, device list ───────────────────────────────────
type Handler = (event: { payload: unknown }) => void;
const listeners = new Map<string, Set<Handler>>();
const listenCalls: string[] = [];
function emit(name: string, payload: unknown): void {
    for (const h of [...(listeners.get(name) ?? [])]) h({ payload });
}
vi.mock("@tauri-apps/api/event", () => ({
    listen: async (name: string, cb: Handler) => {
        listenCalls.push(name);
        if (!listeners.has(name)) listeners.set(name, new Set());
        listeners.get(name)!.add(cb);
        return () => { listeners.get(name)?.delete(cb); };
    },
}));

type Ipc = (args: Record<string, unknown>) => unknown;
let ipc: Record<string, Ipc> = {};
const ipcCalls: string[] = [];
const docsWrites: Array<{ key: string; value: string }> = [];
vi.mock("@tauri-apps/api/core", () => ({
    invoke: vi.fn(async (cmd: string, args: Record<string, unknown> = {}) => {
        ipcCalls.push(cmd);
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

let pairedDevices: Array<{ deviceId: string; irohNodeId: string }> = [];
const downloadBookFile = vi.fn(async (_peer: string, bookId: string) => `/books/${bookId}.epub`);
vi.mock("../src/core/lib/device-sync", () => ({
    irohStart: async () => undefined,
    getPairedDevices: async () => pairedDevices,
    downloadBookFile: (peer: string, bookId: string) => downloadBookFile(peer, bookId),
}));

vi.mock("../src/core/lib/env", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../src/core/lib/env")>()),
    isTauri: () => true,
}));

const book = (id: string, extra: Partial<Book> = {}): Book => ({
    id, title: id, author: "a", format: "epub", filePath: `/b/${id}`, fileSize: 1,
    addedAt: new Date("2026-01-01"), progress: 0.1, tags: [], isFavorite: false, readingTime: 0,
    ...extra,
} as Book);

type Orchestrator = typeof import("../src/core/lib/sync-orchestrator");
type Stores = typeof import("../src/core/store");
let orch: Orchestrator;
let stores: Stores;

beforeEach(async () => {
    vi.resetModules();
    listeners.clear();
    listenCalls.length = 0;
    ipc = {};
    ipcCalls.length = 0;
    docsWrites.length = 0;
    pairedDevices = [{ deviceId: "dev-1", irohNodeId: "node-1" }];
    downloadBookFile.mockClear();
    stores = await import("../src/core/store");
    orch = await import("../src/core/lib/sync-orchestrator");
    for (const s of [stores.useLibraryStore, stores.useSettingsStore, stores.useVocabularyStore, stores.useRssStore]) {
        vi.spyOn(s.persist, "hasHydrated").mockReturnValue(true);
    }
    stores.useLibraryStore.setState({ books: [book("b1")], annotations: [], collections: [], deletionTombstones: [] });
    stores.useUIStore.getState().setDeviceSyncStatus("idle");
    stores.useUIStore.getState().setDownloadingBook(undefined);
});

afterEach(() => {
    orch.stopAutoSync();
    // Timers a test left pending must not fire inside the next one.
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

const ui = () => stores.useUIStore.getState();
const lib = () => stores.useLibraryStore.getState();

/** Runs a round under fake timers, letting all its waits elapse. */
async function runRound(peer = "dev-1", ms = 60_000) {
    const p = orch.runDeviceSync(peer);
    await vi.advanceTimersByTimeAsync(ms);
    return p;
}

describe("cancellation is not sticky (R1)", () => {
    it("a cancel with no sync running (unpair) does not block the next on-demand download", async () => {
        orch.cancelRunningSync();
        await expect(orch.downloadBookOnDemand("b1")).resolves.toBe(true);
        expect(downloadBookFile).toHaveBeenCalledWith("dev-1", "b1");
        expect(ui().deviceSyncStatus).toBe("synced");
    });

    it("a cancel during a round does not leak into the next round", async () => {
        vi.useFakeTimers();
        ipc.docs_sync_now = () => {
            orch.cancelRunningSync();
            emit("docs-sync-finished", { peer: "node-1", synced: true });
            return null;
        };
        expect((await runRound()).error).toBe("Sync cancelled");
        ipc.docs_sync_now = () => { emit("docs-sync-finished", { peer: "node-1", synced: true }); return null; };
        expect((await runRound()).success).toBe(true);
    });
});

describe("status never sticks on syncing (R2)", () => {
    it("a live book entry outside a round does not set round progress", async () => {
        vi.useFakeTimers();
        await orch.initDocsLiveListener();
        emit("docs-entry-batch", { entries: [{ key: "book:new", value: JSON.stringify(book("new")) }] });
        await vi.advanceTimersByTimeAsync(1000);
        expect(lib().getBook("new")).toBeDefined();
        expect(ui().deviceSyncStatus).not.toBe("syncing");
    });

    it("a download that throws still clears the spinner and the syncing status", async () => {
        downloadBookFile.mockRejectedValueOnce(new Error("PEER_BOOK_DELETED"));
        vi.spyOn(console, "error").mockImplementation(() => {});
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const removeBook = lib().removeBook;
        stores.useLibraryStore.setState({ removeBook: () => { throw new Error("db locked"); } });
        await expect(orch.downloadBookOnDemand("b1")).resolves.toBe(false);
        stores.useLibraryStore.setState({ removeBook });
        expect(ui().downloadingBookId).toBeUndefined();
        expect(ui().deviceSyncStatus).not.toBe("syncing");
    });
});

describe("a round only succeeds when this peer finished a sync (R3, R4)", () => {
    beforeEach(() => vi.useFakeTimers());

    it("no sync-finished from the peer: Peer offline, not a success", async () => {
        const result = await runRound();
        expect(result.success).toBe(false);
        expect(result.error).toBe("Peer offline");
        expect(ui().deviceSyncStatus).toBe("error");
    });

    it("another peer's events do not end the wait or count as success", async () => {
        ipc.docs_sync_now = () => {
            emit("docs-sync-finished", { peer: "node-OTHER", synced: true });
            emit("docs-pending-content-ready", { remaining_count: 0 });
            return null;
        };
        const p = orch.runDeviceSync("dev-1");
        let done = false;
        void p.then(() => { done = true; });
        await vi.advanceTimersByTimeAsync(10_000);
        expect(done).toBe(false);
        await vi.advanceTimersByTimeAsync(60_000);
        expect((await p).success).toBe(false);
    });

    it("the peer's failed exchange (synced: false) ends the round at once as unreachable", async () => {
        ipc.docs_sync_now = () => { emit("docs-sync-finished", { peer: "node-1", synced: false, received: 0, sent: 0 }); return null; };
        const p = orch.runDeviceSync("dev-1");
        await vi.advanceTimersByTimeAsync(1_000);
        const result = await p;
        expect(result.success).toBe(false);
        expect(result.error).toBe("Peer offline");
    });

    it("the peer's sync-finished then content-ready settles the round as a success", async () => {
        ipc.docs_sync_now = () => {
            emit("docs-sync-finished", { peer: "node-1", synced: true, received: 3, sent: 1 });
            emit("docs-pending-content-ready", { remaining_count: 0 });
            return null;
        };
        const p = orch.runDeviceSync("dev-1");
        await vi.advanceTimersByTimeAsync(1_000);
        const result = await p;
        expect(result.success).toBe(true);
        expect(ui().deviceSyncStatus).toBe("synced");
    });

    it("an unreachable peer keeps the data dirty, so the next timer round retries it", async () => {
        stores.useSettingsStore.setState({
            settings: { ...stores.useSettingsStore.getState().settings, deviceSync: { ...stores.useSettingsStore.getState().settings.deviceSync, autoSyncEnabled: true } },
        });
        await orch.startAutoSync();
        await vi.advanceTimersByTimeAsync(60_000); // forced startup round: peer offline
        const afterStartup = ipcCalls.filter((c) => c === "docs_sync_now").length;
        expect(afterStartup).toBe(1);
        await vi.advanceTimersByTimeAsync(2 * 60_000); // first (non-forced) tick
        expect(ipcCalls.filter((c) => c === "docs_sync_now").length).toBe(2);
    });
});

describe("rounds queue instead of failing (R5)", () => {
    beforeEach(() => vi.useFakeTimers());

    it("Sync now during a running round waits for it rather than 'Sync already in progress'", async () => {
        pairedDevices = [{ deviceId: "dev-1", irohNodeId: "node-1" }, { deviceId: "dev-2", irohNodeId: "node-2" }];
        const order: string[] = [];
        ipc.docs_sync_now = (args) => {
            const id = args.peerDeviceId as string;
            order.push(id);
            emit("docs-sync-finished", { peer: id === "dev-1" ? "node-1" : "node-2", synced: true });
            return null;
        };
        const first = orch.runDeviceSync("dev-1");
        const second = orch.runDeviceSync("dev-2");
        await vi.advanceTimersByTimeAsync(30_000);
        expect((await first).success).toBe(true);
        const r2 = await second;
        expect(r2.error).not.toBe("Sync already in progress");
        expect(r2.success).toBe(true);
        expect(order).toEqual(["dev-1", "dev-2"]);
    });

    it("quick sync syncs every paired device, one after another", async () => {
        pairedDevices = [{ deviceId: "dev-1", irohNodeId: "node-1" }, { deviceId: "dev-2", irohNodeId: "node-2" }];
        const order: string[] = [];
        ipc.docs_sync_now = (args) => {
            const id = args.peerDeviceId as string;
            order.push(id);
            emit("docs-sync-finished", { peer: id === "dev-1" ? "node-1" : "node-2", synced: true });
            return null;
        };
        const p = orch.syncAllPairedDevices();
        await vi.advanceTimersByTimeAsync(30_000);
        const results = await p;
        expect(order).toEqual(["dev-1", "dev-2"]);
        expect(results.map((r) => r.success)).toEqual([true, true]);
    });
});

describe("live listener (R6, C4, C7)", () => {
    it("concurrent initialisations register the docs listener once", async () => {
        await Promise.all([orch.initDocsLiveListener(), orch.initDocsLiveListener()]);
        expect(listenCalls.filter((n) => n === "docs-entry-batch")).toHaveLength(1);
    });

    it("an older incoming settings entry on the live path does not replace newer local settings", async () => {
        vi.useFakeTimers();
        const s = stores.useSettingsStore.getState();
        const localTheme = s.settings.theme;
        stores.useSettingsStore.setState({ settingsLastModifiedAt: "2026-06-01T00:00:00.000Z" });
        await orch.initDocsLiveListener();
        const remote = { ...s.settings, theme: localTheme === "dark" ? "light" : "dark", _settingsUpdatedAt: "2026-01-01T00:00:00.000Z" };
        ipcCalls.length = 0;
        emit("docs-entry-batch", { entries: [{ key: "settings", value: JSON.stringify(remote) }] });
        await vi.advanceTimersByTimeAsync(2000);
        vi.useRealTimers();
        // The live merge really ran (it loads its schemas lazily, outside fake time).
        await vi.waitFor(() => expect(ipcCalls).toContain("sqlite_merge_sync_entries"));
        await new Promise((r) => setTimeout(r, 50));
        expect(stores.useSettingsStore.getState().settings.theme).toBe(localTheme);
    });

    it("a peer's different value for a key we just wrote is merged, not dropped as an echo", async () => {
        vi.useFakeTimers();
        await orch.provisionToIrohDocs();
        expect(docsWrites.some((w) => w.key === "book:b1")).toBe(true);
        await orch.initDocsLiveListener();
        const edited = { ...book("b1"), title: "Edited on the peer" };
        emit("docs-entry-batch", { entries: [{ key: "book:b1", value: JSON.stringify(edited) }] });
        await vi.advanceTimersByTimeAsync(1000);
        expect(lib().getBook("b1")?.title).toBe("Edited on the peer");
    });

    it("our own value coming back is still dropped as an echo", async () => {
        vi.useFakeTimers();
        docsWrites.length = 0;
        await orch.provisionToIrohDocs();
        const ownSettings = docsWrites.filter((w) => w.key === "settings").at(-1)!.value;
        await orch.initDocsLiveListener();
        ipcCalls.length = 0;
        emit("docs-entry-batch", { entries: [{ key: "settings", value: ownSettings }] });
        await vi.advanceTimersByTimeAsync(2000);
        vi.useRealTimers();
        await new Promise((r) => setTimeout(r, 100));
        expect(ipcCalls).not.toContain("sqlite_merge_sync_entries");
    });
});

describe("merges are serialized and rebased on the live state (C6)", () => {
    const report = (over: Record<string, string[]>) => ({
        domainsUpdated: ["books", "annotations"], booksCount: 2, annotationsCount: 1,
        updatedBooks: [], deletedBooks: [], updatedAnnotations: [], deletedAnnotations: [],
        updatedVocabulary: [], deletedVocabulary: [], updatedRssArticles: [], deletedRssArticles: [],
        ...over,
    });

    it("a local edit made while a merge awaits survives it, and a second merge waits its turn", async () => {
        stores.useLibraryStore.setState({ books: [book("b1"), book("b2")] });
        let releaseAnnotations!: (v: string[]) => void;
        ipc.sqlite_merge_sync_entries = () => report({ updatedBooks: ["b1"], updatedAnnotations: ["a1"] });
        ipc.sqlite_get_all_annotations = () => new Promise<string[]>((res) => { releaseAnnotations = res; });
        ipc.docs_get_changed_entries = () => ({ entries: {
            "book:b1": JSON.stringify({ ...book("b1"), title: "Remote title" }),
            "anno:b1:a1": JSON.stringify({ id: "a1", bookId: "b1", type: "highlight", location: "x", createdAt: "2026-01-01" }),
        }, token: 1 });

        const first = orch.hydrateFromIrohDocs();
        await vi.waitFor(() => expect(releaseAnnotations).toBeTypeOf("function"));
        const second = orch.hydrateFromIrohDocs();
        await new Promise((r) => setTimeout(r, 20));
        // The second merge has not started while the first is in flight.
        expect(ipcCalls.filter((c) => c === "sqlite_merge_sync_entries")).toHaveLength(1);

        // The user keeps reading b2 meanwhile.
        lib().updateBook("b2", { progress: 0.6 });

        releaseAnnotations([JSON.stringify({ id: "a1", bookId: "b1", type: "highlight", location: "x", createdAt: "2026-01-01" })]);
        await first;
        expect(lib().getBook("b2")?.progress).toBe(0.6);
        expect(lib().getBook("b1")?.title).toBe("Remote title");
        expect(lib().annotations.map((a) => a.id)).toEqual(["a1"]);
        ipc.sqlite_get_all_annotations = () => [];
        await second;
        expect(lib().getBook("b2")?.progress).toBe(0.6);
    });
});

describe("Zustand→docs bridge (P3)", () => {
    it("a book the bridge wrote is not written again by the next provisioning", async () => {
        await orch.ensureResponderSyncReady();
        vi.useFakeTimers();
        orch.subscribeZustandToIrohDocs();
        await orch.provisionToIrohDocs();
        lib().updateBook("b1", { progress: 0.42 });
        await vi.advanceTimersByTimeAsync(2000);
        expect(docsWrites.filter((w) => w.key === "book:b1").length).toBeGreaterThan(0);
        docsWrites.length = 0;
        await orch.provisionToIrohDocs();
        expect(docsWrites.map((w) => w.key)).not.toContain("book:b1");
    });

    it("an entity received from a peer is not written back to the doc", async () => {
        await orch.ensureResponderSyncReady();
        vi.useFakeTimers();
        orch.subscribeZustandToIrohDocs();
        ipc.docs_get_changed_entries = () => ({ entries: { "book:b1": JSON.stringify({ ...book("b1"), title: "From peer" }) }, token: 1 });
        docsWrites.length = 0;
        await orch.hydrateFromIrohDocs();
        expect(lib().getBook("b1")?.title).toBe("From peer");
        await vi.advanceTimersByTimeAsync(2000);
        expect(docsWrites.map((w) => w.key)).not.toContain("book:b1");
    });
});

describe("merge diagnostics", () => {
    it("warns in development when an incoming entry cannot be parsed", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        ipc.docs_get_changed_entries = () => ({ entries: { "book:broken": "{not json" }, token: 1 });
        await orch.hydrateFromIrohDocs();
        expect(warn.mock.calls.some((c) => String(c[0]).includes("[sync-merge] book entry"))).toBe(true);
    });
});

describe("mergeBooks keeps progress and position together (C3)", () => {
    const local = (over: Partial<Book>) => [book("a", { contentHash: "h", ...over })];
    const remote = (over: Partial<Book>) => [book("a", { contentHash: "h", ...over })];

    it("a newer local read wins progress and location even when the peer's progress is higher", () => {
        const [m] = mergeBooks(
            remote({ progress: 0.9, currentLocation: "end", lastReadAt: new Date("2026-01-01") }),
            local({ progress: 0.05, currentLocation: "start", lastReadAt: new Date("2026-02-01") }),
        );
        expect(m.progress).toBe(0.05);
        expect(m.currentLocation).toBe("start");
    });

    it("a newer remote read wins both", () => {
        const [m] = mergeBooks(
            remote({ progress: 0.05, currentLocation: "start", lastReadAt: new Date("2026-03-01") }),
            local({ progress: 0.9, currentLocation: "end", lastReadAt: new Date("2026-02-01") }),
        );
        expect(m.progress).toBe(0.05);
        expect(m.currentLocation).toBe("start");
    });

    it("tied or missing timestamps take the higher progress with its own location", () => {
        const [m] = mergeBooks(
            remote({ progress: 0.7, currentLocation: "remote-pos" }),
            local({ progress: 0.3, currentLocation: "local-pos" }),
        );
        expect(m.progress).toBe(0.7);
        expect(m.currentLocation).toBe("remote-pos");
        const [n] = mergeBooks(
            remote({ progress: 0.2, currentLocation: "remote-pos", lastReadAt: new Date("2026-01-01") }),
            local({ progress: 0.3, currentLocation: "local-pos", lastReadAt: new Date("2026-01-01") }),
        );
        expect(n.progress).toBe(0.3);
        expect(n.currentLocation).toBe("local-pos");
    });
});

describe("hydrate reads only changed entries", () => {
    const reads: Array<{ full: unknown }> = [];
    const acks: number[] = [];
    let nextToken = 0;
    let served: Record<string, string> = {};

    beforeEach(() => {
        reads.length = 0;
        acks.length = 0;
        nextToken = 0;
        served = {};
        ipc.docs_get_changed_entries = (args) => {
            reads.push({ full: args.full });
            return { entries: served, token: ++nextToken };
        };
        ipc.docs_ack_entries = (args) => { acks.push(args.token as number); return null; };
        ipc.sqlite_merge_sync_entries = () => ({
            domainsUpdated: [], booksCount: 0, annotationsCount: 0,
            updatedBooks: [], deletedBooks: [], updatedAnnotations: [], deletedAnnotations: [],
            updatedVocabulary: [], deletedVocabulary: [], updatedRssArticles: [], deletedRssArticles: [],
        });
        orch.__resetHydrateScheduleForTests();
    });

    it("starts with a full read, then asks only for changes, acknowledging each merged read", async () => {
        served = { "book:b2": JSON.stringify(book("b2")) };
        await orch.hydrateFromIrohDocs();
        served = {};
        await orch.hydrateFromIrohDocs();
        expect(reads).toEqual([{ full: true }, { full: false }]);
        expect(acks).toEqual([1, 2]);
    });

    it("does not acknowledge a read whose native merge failed, so it comes again", async () => {
        served = { "book:b2": JSON.stringify(book("b2")) };
        ipc.sqlite_merge_sync_entries = () => { throw new Error("disk full"); };
        await orch.hydrateFromIrohDocs();
        expect(acks).toEqual([]);
        // Still due for a full read: the failed one did not count.
        ipc.sqlite_merge_sync_entries = () => ({
            domainsUpdated: [], booksCount: 0, annotationsCount: 0,
            updatedBooks: [], deletedBooks: [], updatedAnnotations: [], deletedAnnotations: [],
            updatedVocabulary: [], deletedVocabulary: [], updatedRssArticles: [], deletedRssArticles: [],
        });
        await orch.hydrateFromIrohDocs();
        expect(reads).toEqual([{ full: true }, { full: true }]);
        expect(acks).toEqual([2]);
    });

    it("an unreachable sync engine merges nothing and acknowledges nothing", async () => {
        ipc.docs_get_changed_entries = () => { throw new Error("iroh-docs not initialized"); };
        expect(await orch.hydrateFromIrohDocs()).toEqual([]);
        expect(acks).toEqual([]);
    });
});

describe("deleted items leave the sync doc", () => {
    it("provisioning removes this device's doc entries for deletions, once per change", async () => {
        const purges: Array<Array<{ entityType: string; entityId: string }>> = [];
        ipc.docs_purge_entities = (args) => {
            purges.push(args.entities as Array<{ entityType: string; entityId: string }>);
            return 3;
        };
        const deletedAt = new Date().toISOString();
        stores.useLibraryStore.setState({
            deletionTombstones: [{ entityType: "book", entityId: "gone", deletedAt }],
        });
        await orch.provisionToIrohDocs();
        expect(purges).toEqual([[{ entityType: "book", entityId: "gone" }]]);

        // Nothing new deleted: no second pass.
        await orch.provisionToIrohDocs();
        expect(purges).toHaveLength(1);

        stores.useLibraryStore.setState({
            deletionTombstones: [
                { entityType: "book", entityId: "gone", deletedAt },
                { entityType: "annotation", entityId: "a9", deletedAt },
            ],
        });
        await orch.provisionToIrohDocs();
        expect(purges).toHaveLength(2);
        expect(purges[1]).toContainEqual({ entityType: "annotation", entityId: "a9" });
    });

    it("a failed removal is retried on the next provisioning", async () => {
        let fail = true;
        let calls = 0;
        ipc.docs_purge_entities = () => {
            calls++;
            if (fail) throw new Error("engine restarting");
            return 1;
        };
        stores.useLibraryStore.setState({
            deletionTombstones: [{ entityType: "book", entityId: "gone", deletedAt: new Date().toISOString() }],
        });
        await orch.provisionToIrohDocs();
        fail = false;
        await orch.provisionToIrohDocs();
        await orch.provisionToIrohDocs();
        expect(calls).toBe(2);
    });
});

describe("live book entries are saved", () => {
    it("a book that arrives between rounds is written to SQLite, an unchanged one is not", async () => {
        const saved: string[] = [];
        ipc.sqlite_save_book_metadata = (args) => { saved.push(args.bookId as string); return null; };
        vi.useFakeTimers();
        await orch.initDocsLiveListener();
        emit("docs-entry-batch", { entries: [{ key: "book:b9", value: JSON.stringify(book("b9", { title: "Live" })) }] });
        await vi.advanceTimersByTimeAsync(1000);
        expect(lib().getBook("b9")?.title).toBe("Live");
        expect(saved).toEqual(["b9"]);
    });
});

describe("live deletions reach SQLite", () => {
    it("a deletion received between rounds is applied to the database, not only the store", async () => {
        const merged: Array<Record<string, string>> = [];
        ipc.sqlite_merge_sync_entries = (args) => {
            merged.push(args.entries as Record<string, string>);
            return {
                domainsUpdated: ["deletion_tombstones"], booksCount: 0, annotationsCount: 0,
                updatedBooks: [], deletedBooks: ["b1"], updatedAnnotations: [], deletedAnnotations: [],
                updatedVocabulary: [], deletedVocabulary: [], updatedRssArticles: [], deletedRssArticles: [],
            };
        };
        vi.useFakeTimers();
        await orch.initDocsLiveListener();
        const tomb = [{ entityType: "book", entityId: "b1", deletedAt: new Date().toISOString() }];
        emit("docs-entry-batch", { entries: [{ key: "deletion_tombstones", value: JSON.stringify(tomb) }] });
        await vi.advanceTimersByTimeAsync(3000);
        expect(lib().getBook("b1")).toBeUndefined();
        expect(merged).toHaveLength(1);
        expect(JSON.parse(merged[0].deletion_tombstones)).toEqual([expect.objectContaining({ entityId: "b1" })]);
    });
});
