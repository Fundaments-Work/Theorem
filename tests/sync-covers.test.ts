// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Fake IPC + cover storage ───────────────────────────────────────────────
const docsWrites: Array<{ key: string; value: string }> = [];
let docsEntries: Record<string, string> = {};
vi.mock("@tauri-apps/api/core", () => ({
    invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "docs_set_entry") { docsWrites.push({ key: args!.key as string, value: args!.value as string }); return null; }
        if (cmd === "docs_set_entries") { docsWrites.push(...(args!.entries as Array<{ key: string; value: string }>)); return null; }
        if (cmd === "docs_get_all_entries") return docsEntries;
        // A sync round reads only changed entries (the first read is full).
        if (cmd === "docs_get_changed_entries") return { entries: docsEntries, token: 1 };
        return null;
    }),
    convertFileSrc: (p: string, proto = "asset") => `${proto}://localhost/${encodeURIComponent(p)}`,
}));
vi.mock("../src/core/lib/device-sync", () => ({ getPairedDevices: async () => [{ deviceId: "peer" }], irohStart: async () => {} }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));

const storedCovers = new Map<string, string>();
const saveCalls: Array<{ id: string; dataUrl: string }> = [];
vi.mock("../src/core/lib/storage", async (importOriginal) => {
    const real = await importOriginal<typeof import("../src/core/lib/storage")>();
    return {
        ...real,
        getCoverImage: vi.fn(async (id: string) => storedCovers.get(id) ?? null),
        saveCoverDataUrl: vi.fn(async (id: string, dataUrl: string) => {
            saveCalls.push({ id, dataUrl });
            storedCovers.set(id, dataUrl);
            return `theorem-cover://localhost/${id}?v=new`;
        }),
        deleteCoverImage: vi.fn(async (id: string) => { storedCovers.delete(id); }),
    };
});

import { coverPathForBookEntry, needsCoverEntry, parseCoverEntry, applyIncomingCover } from "../src/core/lib/sync-covers";
import { coverDisplayUrl, getCoverImage, isFallbackCover } from "../src/core/lib/storage";
import { applyBookEdits } from "../src/core/lib/book-edit";
import { ensureResponderSyncReady, hydrateFromIrohDocs, provisionToIrohDocs, subscribeZustandToIrohDocs } from "../src/core/lib/sync-orchestrator";
import { useLibraryStore, useSettingsStore, useVocabularyStore, useRssStore } from "../src/core/store";
import type { Book } from "../src/core/types";

const BIG = "data:image/webp;base64," + "A".repeat(20_000);
const TINY = "data:image/png;base64,AAAA";
const book = (id: string, coverPath?: string) =>
    ({ id, title: id, author: "a", format: "epub", filePath: `/b/${id}`, progress: 0.5, tags: [], coverPath } as unknown as Book);

beforeEach(() => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    docsWrites.length = 0;
    saveCalls.length = 0;
    storedCovers.clear();
    docsEntries = {};
});
afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe("cover helpers", () => {
    it("builds versioned display URLs and recognises fallback covers", () => {
        expect(coverDisplayUrl("b 1", 42)).toBe("theorem-cover://localhost/b%201?v=42");
        expect(coverDisplayUrl("b1", 42, true)).toBe("theorem-cover://localhost/b1?v=42&fallback=1");
        expect(isFallbackCover("theorem-cover://localhost/b1?v=42&fallback=1")).toBe(true);
        expect(isFallbackCover("data:image/svg+xml;utf8,<svg/>")).toBe(true);
        expect(isFallbackCover("theorem-cover://localhost/b1?v=42")).toBe(false);
        expect(isFallbackCover(undefined)).toBe(false);
    });

    it("book entries only embed tiny inline covers; everything else needs a cover entry", () => {
        expect(coverPathForBookEntry(TINY)).toBe(TINY);
        expect(coverPathForBookEntry(BIG)).toBeUndefined();
        expect(coverPathForBookEntry("theorem-cover://localhost/b1?v=1")).toBeUndefined();
        expect(needsCoverEntry(BIG)).toBe(true);
        expect(needsCoverEntry("theorem-cover://localhost/b1?v=1")).toBe(true);
        expect(needsCoverEntry(TINY)).toBe(false);
        expect(needsCoverEntry(undefined)).toBe(false);
        expect(needsCoverEntry("")).toBe(false);
    });

    it("validates incoming cover entries", () => {
        expect(parseCoverEntry(JSON.stringify({ id: "b1", dataUrl: BIG }))).toEqual({ id: "b1", dataUrl: BIG });
        expect(parseCoverEntry(JSON.stringify({ id: "b1", dataUrl: "javascript:alert(1)" }))).toBeNull();
        expect(parseCoverEntry(JSON.stringify({ id: "", dataUrl: BIG }))).toBeNull();
        expect(parseCoverEntry(JSON.stringify({ id: "b1", dataUrl: "data:image/png;base64," + "A".repeat(8_000_001) }))).toBeNull();
        expect(parseCoverEntry("{not json")).toBeNull();
    });

    it("applies a peer's cover verbatim, and does nothing when it is already identical", async () => {
        expect(await applyIncomingCover("b1", BIG)).toBe("theorem-cover://localhost/b1?v=new");
        expect(saveCalls).toEqual([{ id: "b1", dataUrl: BIG }]);
        expect(await applyIncomingCover("b1", BIG)).toBeNull();
        expect(saveCalls).toHaveLength(1);
    });
});

describe("cover sync over docs", () => {
    it.each(Array.from({ length: 20 }, (_, i) => i + 1))("a local removal during an incoming cover write stays removed (run %s)", async (run) => {
        const id = `cover-race-${run}`;
        storedCovers.set(id, BIG);
        useLibraryStore.setState({ books: [{ ...book(id, "theorem-cover://localhost/old"), format: "pdf" }] });
        docsEntries = { [`cover:${id}`]: JSON.stringify({ id, dataUrl: TINY, updatedAt: "2026-11-05T10:00:00Z" }) };
        let finishRead!: (value: string) => void;
        let started!: () => void;
        const reading = new Promise<string>(resolve => { finishRead = resolve; });
        const readStarted = new Promise<void>(resolve => { started = resolve; });
        vi.mocked(getCoverImage).mockImplementationOnce(() => { started(); return reading; });
        const incoming = hydrateFromIrohDocs();
        await readStarted;
        const editing = applyBookEdits(id, {}, { remove: true });
        finishRead(BIG);
        const [, result] = await Promise.all([incoming, editing]);
        expect(result.ok).toBe(true);
        expect(storedCovers.has(id)).toBe(false);
        expect(useLibraryStore.getState().getBook(id)?.coverPath).toBe("");
    });
    it.each([undefined, "2026-11-04T10:00:00Z"])("a stale peer cover cannot revert a local edit (stamp: %s)", async (updatedAt) => {
        storedCovers.set("edited-cover", BIG);
        useLibraryStore.setState({ books: [{ ...book("edited-cover", "theorem-cover://localhost/edited-cover?v=2"), coverUpdatedAt: "2026-11-05T10:00:00Z" }] });
        docsEntries = { "cover:edited-cover": JSON.stringify({ id: "edited-cover", dataUrl: TINY, updatedAt }) };
        await hydrateFromIrohDocs();
        expect(storedCovers.get("edited-cover")).toBe(BIG);
        expect(saveCalls).toHaveLength(0);
        expect(useLibraryStore.getState().getBook("edited-cover")?.coverPath).toBe("theorem-cover://localhost/edited-cover?v=2");
    });

    it("publishes a cover-only edit even when it is the first notification after subscribing", async () => {
        useLibraryStore.setState({ books: [book("live-cover", "theorem-cover://localhost/live-cover?v=1")] });
        storedCovers.set("live-cover", BIG);
        for (const store of [useLibraryStore, useSettingsStore, useVocabularyStore, useRssStore]) {
            vi.spyOn(store.persist, "hasHydrated").mockReturnValue(true);
        }
        await ensureResponderSyncReady();
        docsWrites.length = 0;
        vi.useFakeTimers();
        const stop = subscribeZustandToIrohDocs();
        try {
            useLibraryStore.setState({ books: [{ ...book("live-cover", "theorem-cover://localhost/live-cover?v=2"), coverUpdatedAt: "2026-11-05T10:00:00Z" }] });
            await vi.advanceTimersByTimeAsync(1000);
            const entry = docsWrites.find(w => w.key === "cover:live-cover");
            expect(entry).toBeDefined();
            expect(JSON.parse(entry!.value)).toMatchObject({ id: "live-cover", dataUrl: BIG, updatedAt: "2026-11-05T10:00:00Z" });
        } finally {
            stop();
            vi.useRealTimers();
        }
    });
    it("provisioning sends covers as their own entries and keeps them out of book entries", async () => {
        storedCovers.set("b1", BIG);
        useLibraryStore.setState({ books: [book("b1", "theorem-cover://localhost/b1?v=1"), book("b2", TINY)] });

        await provisionToIrohDocs();

        const bookEntry = JSON.parse(docsWrites.find((w) => w.key === "book:b1")!.value);
        expect(bookEntry.coverPath).toBeUndefined();
        expect(JSON.parse(docsWrites.find((w) => w.key === "book:b2")!.value).coverPath).toBe(TINY);
        expect(JSON.parse(docsWrites.find((w) => w.key === "cover:b1")!.value)).toEqual({ id: "b1", dataUrl: BIG });
        expect(docsWrites.some((w) => w.key === "cover:b2")).toBe(false);

        // A progress change re-provisions the book entry but not the (unchanged) cover.
        docsWrites.length = 0;
        useLibraryStore.setState({ books: [{ ...book("b1", "theorem-cover://localhost/b1?v=1"), progress: 0.7 }, book("b2", TINY)] });
        await provisionToIrohDocs();
        expect(docsWrites.map((w) => w.key)).toContain("book:b1");
        expect(docsWrites.map((w) => w.key)).not.toContain("cover:b1");
        expect(docsWrites.find((w) => w.key === "book:b1")!.value.length).toBeLessThan(1000);
    });

    it("receiving a cover entry stores it verbatim and points the book at it", async () => {
        useLibraryStore.setState({ books: [book("b1")] });
        docsEntries = { "cover:b1": JSON.stringify({ id: "b1", dataUrl: BIG }) };

        await hydrateFromIrohDocs();

        expect(saveCalls).toEqual([{ id: "b1", dataUrl: BIG }]);
        expect(useLibraryStore.getState().getBook("b1")?.coverPath).toBe("theorem-cover://localhost/b1?v=new");
    });

    it("still accepts covers embedded in book entries by older app versions", async () => {
        useLibraryStore.setState({ books: [book("b1")] });
        docsEntries = { "book:b1": JSON.stringify({ ...book("b1"), coverPath: BIG }) };
        await hydrateFromIrohDocs();
        expect(saveCalls.map((c) => c.id)).toEqual(["b1"]);
    });

    it("retains a newer cover stamp even when the image bytes are already identical", async () => {
        storedCovers.set("identical-cover", BIG);
        useLibraryStore.setState({ books: [book("identical-cover", "theorem-cover://localhost/identical-cover?v=1")] });
        docsEntries = { "cover:identical-cover": JSON.stringify({ id: "identical-cover", dataUrl: BIG, updatedAt: "2026-11-05T10:00:00Z" }) };
        await hydrateFromIrohDocs();
        expect(saveCalls).toHaveLength(0);
        expect(useLibraryStore.getState().getBook("identical-cover")?.coverUpdatedAt).toBe("2026-11-05T10:00:00Z");
    });

    it("removes a cover and does not resurrect it from an older peer", async () => {
        storedCovers.set("removed-cover", BIG);
        useLibraryStore.setState({ books: [book("removed-cover", "theorem-cover://localhost/removed-cover?v=1")] });
        docsEntries = { "cover:removed-cover": JSON.stringify({ id: "removed-cover", dataUrl: TINY, removed: true, updatedAt: "2026-11-05T10:00:00Z" }) };
        await hydrateFromIrohDocs();
        expect(storedCovers.has("removed-cover")).toBe(false);
        expect(useLibraryStore.getState().getBook("removed-cover")?.coverPath).toBe("");
        docsEntries = { "cover:removed-cover": JSON.stringify({ id: "removed-cover", dataUrl: BIG }) };
        await hydrateFromIrohDocs();
        expect(storedCovers.has("removed-cover")).toBe(false);
        expect(useLibraryStore.getState().getBook("removed-cover")?.coverPath).toBe("");
    });
});
