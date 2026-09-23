import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A fake SQLite kv table shared by every fresh import of persist-storage, so a
// test can "quit" (drop the module) and "relaunch" (re-import) against the
// same durable state, exactly like the real app.
const sqliteTable = new Map<string, string>();
let failSqliteWrites = false;
const sqliteSetKv = vi.fn(async (key: string, value: string) => {
    if (failSqliteWrites) throw new Error("ipc down");
    sqliteTable.set(key, value);
});
const sqliteGetKv = vi.fn(async (key: string) => sqliteTable.get(key) ?? null);
const sqliteDeleteKv = vi.fn(async (key: string) => {
    sqliteTable.delete(key);
});

vi.mock("../src/core/lib/sqlite-storage", () => ({
    sqliteSetKv: (key: string, value: string) => sqliteSetKv(key, value),
    sqliteGetKv: (key: string) => sqliteGetKv(key),
    sqliteDeleteKv: (key: string) => sqliteDeleteKv(key),
}));

type PersistModule = typeof import("../src/core/lib/persist-storage");

async function launch(): Promise<PersistModule> {
    vi.resetModules();
    return import("../src/core/lib/persist-storage");
}

const SNAPSHOT = (name: string) => `theorem-unload:${name}`;
const SQLITE = (name: string) => `zustand:${name}`;

function setTauri(on: boolean): void {
    const w = window as unknown as Record<string, unknown>;
    if (on) w.__TAURI_INTERNALS__ = {};
    else delete w.__TAURI_INTERNALS__;
}

describe("persist durability (Tauri)", () => {
    beforeEach(() => {
        setTauri(true);
        sqliteTable.clear();
        failSqliteWrites = false;
        localStorage.clear();
        vi.clearAllMocks();
    });

    afterEach(() => {
        setTauri(false);
        localStorage.clear();
    });

    it("recovers an unload snapshot that is newer than SQLite and promotes it", async () => {
        sqliteTable.set(SQLITE("lib"), '{"v":"old"}');
        localStorage.setItem(SNAPSHOT("lib"), '{"v":"new"}');

        const m = await launch();
        const value = await m.theoremPersistStorage.getItem("lib");

        expect(value).toBe('{"v":"new"}');
        expect(sqliteTable.get(SQLITE("lib"))).toBe('{"v":"new"}');
        expect(localStorage.getItem(SNAPSHOT("lib"))).toBeNull();
    });

    it("keeps the snapshot when promoting it to SQLite fails, and still serves it", async () => {
        sqliteTable.set(SQLITE("lib"), '{"v":"old"}');
        localStorage.setItem(SNAPSHOT("lib"), '{"v":"new"}');
        failSqliteWrites = true;

        const m = await launch();
        expect(await m.theoremPersistStorage.getItem("lib")).toBe('{"v":"new"}');
        expect(localStorage.getItem(SNAPSHOT("lib"))).toBe('{"v":"new"}');
        expect(sqliteTable.get(SQLITE("lib"))).toBe('{"v":"old"}');
    });

    it("never lets a stale legacy plain localStorage copy shadow SQLite", async () => {
        sqliteTable.set(SQLITE("lib"), '{"v":"sqlite"}');
        localStorage.setItem("lib", '{"v":"ancient-legacy"}');

        const m = await launch();
        expect(await m.theoremPersistStorage.getItem("lib")).toBe('{"v":"sqlite"}');
    });

    it("still migrates a legacy value when SQLite has none", async () => {
        localStorage.setItem("lib", '{"v":"legacy"}');
        const m = await launch();
        expect(await m.theoremPersistStorage.getItem("lib")).toBe('{"v":"legacy"}');
        expect(sqliteTable.get(SQLITE("lib"))).toBe('{"v":"legacy"}');
    });

    it("beforeunload saves pending writes as snapshots and the next launch restores them", async () => {
        const m = await launch();
        await m.theoremPersistStorage.getItem("lib");
        await m.theoremPersistStorage.setItem("lib", '{"v":"unsaved"}');
        // Quit before the 350ms debounce elapses.
        window.dispatchEvent(new Event("beforeunload"));

        expect(localStorage.getItem(SNAPSHOT("lib"))).toBe('{"v":"unsaved"}');
        expect(localStorage.getItem("lib")).toBeNull();

        const relaunched = await launch();
        expect(await relaunched.theoremPersistStorage.getItem("lib")).toBe('{"v":"unsaved"}');
        expect(sqliteTable.get(SQLITE("lib"))).toBe('{"v":"unsaved"}');
    });

    it("beforeunload serializes deferred (object) writes into snapshots", async () => {
        const m = await launch();
        await m.deferredJsonStorage.setItem("vocab", { state: { terms: ["a"] }, version: 5 });
        window.dispatchEvent(new Event("beforeunload"));

        const raw = localStorage.getItem(SNAPSHOT("vocab"));
        expect(raw).not.toBeNull();
        expect(JSON.parse(raw as string)).toEqual({ state: { terms: ["a"] }, version: 5 });
    });

    it("flushAllPersistence reaches SQLite without waiting for any timer", async () => {
        vi.useFakeTimers();
        try {
            const m = await launch();
            await m.deferredJsonStorage.setItem("lib", { state: { n: 1 }, version: 6 });
            await m.theoremPersistStorage.setItem("settings", '{"s":1}');

            await m.flushAllPersistence();

            expect(JSON.parse(sqliteTable.get(SQLITE("lib")) as string)).toEqual({ state: { n: 1 }, version: 6 });
            expect(sqliteTable.get(SQLITE("settings"))).toBe('{"s":1}');
        } finally {
            vi.useRealTimers();
        }
    });

    it("runs pre-flush hooks first so component-held state lands in the same flush", async () => {
        const m = await launch();
        const order: string[] = [];
        const unregister = m.registerPrePersistFlush(() => {
            order.push("hook");
            void m.deferredJsonStorage.setItem("lib", { state: { progress: 0.42 }, version: 6 });
        });

        await m.flushAllPersistence();
        order.push("flushed");

        expect(order).toEqual(["hook", "flushed"]);
        expect(JSON.parse(sqliteTable.get(SQLITE("lib")) as string).state.progress).toBe(0.42);

        unregister();
        sqliteTable.clear();
        await m.flushAllPersistence();
        expect(sqliteTable.size).toBe(0);
    });

    it("a throwing pre-flush hook does not block other hooks or the flush", async () => {
        const m = await launch();
        m.registerPrePersistFlush(() => {
            throw new Error("boom");
        });
        const good = vi.fn(() => {
            void m.theoremPersistStorage.setItem("x", "1");
        });
        m.registerPrePersistFlush(good);

        await m.flushAllPersistence();
        expect(good).toHaveBeenCalledTimes(1);
        expect(sqliteTable.get(SQLITE("x"))).toBe("1");
    });

    it("pre-flush hooks also run on beforeunload", async () => {
        const m = await launch();
        m.registerPrePersistFlush(() => {
            void m.theoremPersistStorage.setItem("progress", '{"p":0.9}');
        });
        await m.theoremPersistStorage.getItem("progress");
        window.dispatchEvent(new Event("beforeunload"));
        expect(localStorage.getItem(SNAPSHOT("progress"))).toBe('{"p":0.9}');
    });

    it("a failed SQLite write falls back to a snapshot that the next launch recovers", async () => {
        const m = await launch();
        failSqliteWrites = true;
        await m.theoremPersistStorage.setItem("lib", '{"v":"offline"}');
        await m.flushAllPersistence();
        expect(localStorage.getItem(SNAPSHOT("lib"))).toBe('{"v":"offline"}');

        failSqliteWrites = false;
        const relaunched = await launch();
        expect(await relaunched.theoremPersistStorage.getItem("lib")).toBe('{"v":"offline"}');
        expect(sqliteTable.get(SQLITE("lib"))).toBe('{"v":"offline"}');
        expect(localStorage.getItem(SNAPSHOT("lib"))).toBeNull();
    });

    it("a later successful write supersedes and clears an older snapshot", async () => {
        localStorage.setItem(SNAPSHOT("lib"), '{"v":"older"}');
        const m = await launch();
        await m.theoremPersistStorage.setItem("lib", '{"v":"newest"}');
        await m.flushAllPersistence();

        expect(localStorage.getItem(SNAPSHOT("lib"))).toBeNull();
        const relaunched = await launch();
        expect(await relaunched.theoremPersistStorage.getItem("lib")).toBe('{"v":"newest"}');
    });

    it("removeItem clears the snapshot too, so deleted state cannot resurrect", async () => {
        sqliteTable.set(SQLITE("lib"), "1");
        localStorage.setItem(SNAPSHOT("lib"), "2");
        const m = await launch();
        await m.theoremPersistStorage.removeItem("lib");

        const relaunched = await launch();
        expect(await relaunched.theoremPersistStorage.getItem("lib")).toBeNull();
    });

    it("an empty flush is a no-op", async () => {
        const m = await launch();
        await m.flushAllPersistence();
        expect(sqliteSetKv).not.toHaveBeenCalled();
    });
});

describe("persist durability (browser)", () => {
    beforeEach(() => {
        setTauri(false);
        localStorage.clear();
    });

    it("beforeunload keeps writing the plain key, which is the real browser storage", async () => {
        const m = await launch();
        await m.theoremPersistStorage.setItem("lib", '{"v":1}');
        window.dispatchEvent(new Event("beforeunload"));
        expect(localStorage.getItem("lib")).toBe('{"v":1}');
        expect(localStorage.getItem(SNAPSHOT("lib"))).toBeNull();

        const relaunched = await launch();
        expect(await relaunched.theoremPersistStorage.getItem("lib")).toBe('{"v":1}');
    });
});
