// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The browser build used to persist every store in localStorage, whose ~5 MB
// quota silently stopped saving a library of a dozen books. These tests pin
// the IndexedDB path: big values round-trip, old localStorage data moves over
// once, and a failed write is reported instead of swallowed.

type PersistModule = typeof import("../src/core/lib/persist-storage");

async function launch(): Promise<PersistModule> {
    vi.resetModules();
    return import("../src/core/lib/persist-storage");
}

/** Read a value straight from the persist IndexedDB, bypassing the module cache. */
async function readIdb(name: string): Promise<string | undefined> {
    const { createStore, get } = await import("idb-keyval");
    return get<string>(name, createStore("theorem-persist", "kv"));
}

function bigLibrary(books: number): string {
    const description = "x".repeat(1024);
    const list = Array.from({ length: books }, (_, index) => ({
        id: `book-${index}`,
        title: `Book ${index}`,
        description,
        cover: `data:image/jpeg;base64,${"A".repeat(4096)}`,
    }));
    return JSON.stringify({ state: { books: list }, version: 1 });
}

describe("persist storage on the web build (IndexedDB)", () => {
    beforeEach(() => {
        // A fresh database per test.
        globalThis.indexedDB = new IDBFactory();
        localStorage.clear();
        delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
        localStorage.clear();
    });

    it("round-trips a library far larger than the localStorage quota", async () => {
        const value = bigLibrary(1500); // ~8 MB of JSON
        expect(value.length).toBeGreaterThan(5 * 1024 * 1024);

        // Simulate the browser quota: localStorage refuses anything this big.
        const realSetItem = localStorage.setItem.bind(localStorage);
        vi.spyOn(localStorage, "setItem").mockImplementation((key: string, v: string) => {
            if (v.length > 1024 * 1024) throw new DOMException("quota", "QuotaExceededError");
            realSetItem(key, v);
        });

        const first = await launch();
        const failures: string[] = [];
        first.onPersistWriteFailure((name) => failures.push(name));
        await first.theoremPersistStorage.setItem("theorem-library", value);
        await first.flushAllPersistence();

        expect(failures).toEqual([]);
        expect(await readIdb("theorem-library")).toBe(value);
        expect(localStorage.getItem("theorem-library")).toBeNull();

        // "Reload": a fresh module reads it back from IndexedDB.
        const second = await launch();
        expect(await second.theoremPersistStorage.getItem("theorem-library")).toBe(value);
    });

    it("moves existing localStorage data into IndexedDB once and frees the quota", async () => {
        localStorage.setItem("theorem-library", '{"state":{"books":[1]},"version":3}');

        const first = await launch();
        expect(await first.theoremPersistStorage.getItem("theorem-library")).toBe(
            '{"state":{"books":[1]},"version":3}',
        );
        expect(await readIdb("theorem-library")).toBe('{"state":{"books":[1]},"version":3}');
        expect(localStorage.getItem("theorem-library")).toBeNull();

        // A later write lands in IndexedDB and is what the next launch reads.
        await first.theoremPersistStorage.setItem("theorem-library", '{"state":{"books":[1,2]},"version":3}');
        await first.flushAllPersistence();
        const second = await launch();
        expect(await second.theoremPersistStorage.getItem("theorem-library")).toBe(
            '{"state":{"books":[1,2]},"version":3}',
        );
    });

    it("prefers IndexedDB over a stale legacy localStorage copy", async () => {
        const first = await launch();
        await first.theoremPersistStorage.setItem("theorem-rss", "new");
        await first.flushAllPersistence();
        localStorage.setItem("theorem-rss", "stale");

        const second = await launch();
        expect(await second.theoremPersistStorage.getItem("theorem-rss")).toBe("new");
    });

    it("recovers an unload snapshot newer than IndexedDB", async () => {
        const first = await launch();
        await first.theoremPersistStorage.setItem("theorem-library", "old");
        await first.flushAllPersistence();
        localStorage.setItem("theorem-unload:theorem-library", "newer");

        const second = await launch();
        expect(await second.theoremPersistStorage.getItem("theorem-library")).toBe("newer");
        expect(await readIdb("theorem-library")).toBe("newer");
        expect(localStorage.getItem("theorem-unload:theorem-library")).toBeNull();
    });

    it("removes a key from IndexedDB and every localStorage copy", async () => {
        const m = await launch();
        await m.theoremPersistStorage.setItem("theorem-opds", "v");
        await m.flushAllPersistence();
        localStorage.setItem("theorem-opds", "legacy");
        await m.theoremPersistStorage.removeItem("theorem-opds");

        expect(await readIdb("theorem-opds")).toBeUndefined();
        expect(localStorage.getItem("theorem-opds")).toBeNull();
        const relaunched = await launch();
        expect(await relaunched.theoremPersistStorage.getItem("theorem-opds")).toBeNull();
    });

    it("reports a failed write (log + listeners) instead of failing silently", async () => {
        const m = await launch();
        const warn = vi.spyOn(console, "error").mockImplementation(() => {});
        const failures: string[] = [];
        m.onPersistWriteFailure((name) => failures.push(name));

        // IndexedDB refuses the write (quota, private mode, broken database).
        vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(() => {
            throw new DOMException("quota", "QuotaExceededError");
        });
        // And the last-chance localStorage copy does not fit either.
        vi.spyOn(localStorage, "setItem").mockImplementation(() => {
            throw new DOMException("quota", "QuotaExceededError");
        });

        await m.theoremPersistStorage.setItem("theorem-library", "value");
        await m.flushAllPersistence();

        expect(failures).toEqual(["theorem-library"]);
        expect(warn).toHaveBeenCalled();
        expect(String(warn.mock.calls[0][0])).toContain("theorem-library");
    });

    it("reports a repeated failure once until a write succeeds again", async () => {
        const m = await launch();
        vi.spyOn(console, "error").mockImplementation(() => {});
        const failures: string[] = [];
        m.onPersistWriteFailure((name) => failures.push(name));
        const put = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(() => {
            throw new DOMException("quota", "QuotaExceededError");
        });

        await m.theoremPersistStorage.setItem("theorem-library", "a");
        await m.flushAllPersistence();
        await m.theoremPersistStorage.setItem("theorem-library", "b");
        await m.flushAllPersistence();
        expect(failures).toEqual(["theorem-library"]);

        put.mockRestore();
        await m.theoremPersistStorage.setItem("theorem-library", "c");
        await m.flushAllPersistence();
        expect(await readIdb("theorem-library")).toBe("c");

        vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(() => {
            throw new DOMException("quota", "QuotaExceededError");
        });
        await m.theoremPersistStorage.setItem("theorem-library", "d");
        await m.flushAllPersistence();
        expect(failures).toEqual(["theorem-library", "theorem-library"]);
    });

    it("falls back to localStorage where IndexedDB does not exist", async () => {
        // @ts-expect-error simulate a browser without IndexedDB
        delete globalThis.indexedDB;
        const m = await launch();
        await m.theoremPersistStorage.setItem("theorem-settings", "s");
        await m.flushAllPersistence();
        expect(localStorage.getItem("theorem-settings")).toBe("s");
    });
});
