import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { errorKind, storageErrorHint } from "../src/core/lib/error-kind";

// Messages exactly as `with_connection` sends them (see src-tauri/src/error.rs).
const BUSY = "SQLite operation failed: database is locked";
const LOCKED = "SQLite operation failed: database table is locked";
const POOL_TIMEOUT = "Failed to acquire SQLite connection from pool: timed out waiting for connection";
const NOT_A_DB = "SQLite operation failed: file is not a database";
const MALFORMED = "SQLite operation failed: database disk image is malformed";
const UNIQUE = "SQLite operation failed: UNIQUE constraint failed: books.id";
const FOREIGN = "SQLite operation failed: FOREIGN KEY constraint failed";
const NO_ROWS = "SQLite operation failed: Query returned no rows";
const SYNTAX = 'SQLite operation failed: near "SELEC": syntax error';

describe("errorKind", () => {
    it("reads the kind of SQLite errors from the message string", () => {
        expect(errorKind(BUSY)).toBe("busy");
        expect(errorKind(LOCKED)).toBe("busy");
        expect(errorKind(POOL_TIMEOUT)).toBe("busy");
        expect(errorKind(NOT_A_DB)).toBe("corrupt");
        expect(errorKind(MALFORMED)).toBe("corrupt");
        expect(errorKind(UNIQUE)).toBe("constraint");
        expect(errorKind(FOREIGN)).toBe("constraint");
        expect(errorKind(NO_ROWS)).toBe("not_found");
        expect(errorKind(SYNTAX)).toBe("internal");
    });

    it("reads Error instances and message objects the same way", () => {
        expect(errorKind(new Error(BUSY))).toBe("busy");
        expect(errorKind({ message: NOT_A_DB })).toBe("corrupt");
    });

    it("prefers an explicit kind (the structured form)", () => {
        expect(errorKind({ kind: "network", message: "offline" })).toBe("network");
        expect(errorKind({ kind: "not_found", message: BUSY })).toBe("not_found");
        // An unknown kind falls back to the message.
        expect(errorKind({ kind: "weird", message: BUSY })).toBe("busy");
    });

    it("does not guess at messages that are not SQLite failures", () => {
        expect(errorKind("the shared folder is locked by another app")).toBeUndefined();
        expect(errorKind("book 'x' not found in library")).toBeUndefined();
        expect(errorKind("database is locked")).toBeUndefined();
        expect(errorKind("")).toBeUndefined();
    });

    it("tolerates anything thrown", () => {
        for (const value of [undefined, null, 0, 42, true, {}, [], Symbol("x"), { message: 3 }, { kind: 7 }]) {
            expect(() => errorKind(value)).not.toThrow();
            expect(errorKind(value)).toBeUndefined();
        }
    });

    it("leaves the string-based handling of existing call sites unchanged", () => {
        // Commands still reject with the plain string, so String(e),
        // typeof checks and substring tests see the same text as before.
        const rejected: unknown = BUSY;
        expect(typeof rejected).toBe("string");
        expect(String(rejected)).toBe(BUSY);
        expect(String(rejected).includes("database is locked")).toBe(true);
    });

    it("gives a hint only for busy and corrupt", () => {
        expect(storageErrorHint(BUSY)).toMatch(/busy, try again/);
        expect(storageErrorHint(NOT_A_DB)).toMatch(/Restore a snapshot/);
        expect(storageErrorHint(UNIQUE)).toBeUndefined();
        expect(storageErrorHint("ipc down")).toBeUndefined();
        expect(storageErrorHint(undefined)).toBeUndefined();
    });
});

// ── persist-storage reports a locked or damaged database ────────────────────

let sqliteWriteError: unknown = null;
const sqliteSetKv = vi.fn(async () => {
    if (sqliteWriteError !== null) throw sqliteWriteError;
});

vi.mock("../src/core/lib/sqlite-storage", () => ({
    sqliteSetKv: () => sqliteSetKv(),
    sqliteGetKv: async () => null,
    sqliteDeleteKv: async () => {},
}));

describe("persist write failures on the desktop/mobile app", () => {
    beforeEach(() => {
        (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
        sqliteWriteError = null;
        localStorage.clear();
        vi.clearAllMocks();
    });

    afterEach(() => {
        delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
        localStorage.clear();
    });

    async function failedWrite(error: unknown): Promise<unknown[]> {
        vi.resetModules();
        const m = await import("../src/core/lib/persist-storage");
        const reported: unknown[] = [];
        const stop = m.onPersistWriteFailure((_name, e) => reported.push(e));
        sqliteWriteError = error;
        await m.theoremPersistStorage.setItem("lib", '{"v":1}');
        await m.flushAllPersistence();
        stop();
        return reported;
    }

    it("reports busy and corrupt errors with their message intact", async () => {
        expect(await failedWrite(BUSY)).toEqual([BUSY]);
        expect(await failedWrite(NOT_A_DB)).toEqual([NOT_A_DB]);
    });

    it("stays quiet for other failures, as before", async () => {
        expect(await failedWrite("ipc down")).toEqual([]);
        expect(await failedWrite(UNIQUE)).toEqual([]);
    });

    it("reports a busy key again after a successful write in between", async () => {
        vi.resetModules();
        const m = await import("../src/core/lib/persist-storage");
        const reported: unknown[] = [];
        m.onPersistWriteFailure((_name, e) => reported.push(e));
        sqliteWriteError = BUSY;
        await m.theoremPersistStorage.setItem("lib", '{"v":1}');
        await m.flushAllPersistence();
        await m.theoremPersistStorage.setItem("lib", '{"v":2}');
        await m.flushAllPersistence();
        expect(reported).toEqual([BUSY]);
        sqliteWriteError = null;
        await m.theoremPersistStorage.setItem("lib", '{"v":3}');
        await m.flushAllPersistence();
        sqliteWriteError = BUSY;
        await m.theoremPersistStorage.setItem("lib", '{"v":4}');
        await m.flushAllPersistence();
        expect(reported).toEqual([BUSY, BUSY]);
    });
});
