import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    deferredJsonStorage,
    memoizePartialize,
} from "../src/core/lib/persist-storage";

describe("memoizePartialize", () => {
    it("reuses the result when slices are identical", () => {
        const partialize = memoizePartialize(
            (state: { books: unknown[]; flag: boolean }) => [state.books, state.flag],
            (state) => ({ n: (state.books as unknown[]).length, flag: state.flag }),
        );
        const books: unknown[] = [1, 2, 3];
        const first = partialize({ books, flag: true });
        const second = partialize({ books, flag: true });
        expect(second).toBe(first);
    });

    it("rebuilds when any slice changes identity", () => {
        const partialize = memoizePartialize(
            (state: { books: unknown[] }) => [state.books],
            (state) => ({ n: (state.books as unknown[]).length }),
        );
        const first = partialize({ books: [1] });
        const second = partialize({ books: [1, 2] });
        expect(second).not.toBe(first);
        expect(second).toEqual({ n: 2 });
    });
});

describe("deferredJsonStorage", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        localStorage.clear();
    });

    afterEach(() => {
        vi.useRealTimers();
        localStorage.clear();
    });

    it("serves pending values from getItem before flush", async () => {
        const value = { state: { a: 1 }, version: 1 };
        await deferredJsonStorage.setItem("test-pending-x", value);
        const read = await deferredJsonStorage.getItem("test-pending-x");
        expect(read).toEqual(value);
        await deferredJsonStorage.removeItem("test-pending-x");
    });

    it("coalesces bursts and flushes a single write", async () => {
        await deferredJsonStorage.setItem("test-burst-x", { state: { n: 1 }, version: 1 });
        await deferredJsonStorage.setItem("test-burst-x", { state: { n: 2 }, version: 1 });
        await deferredJsonStorage.setItem("test-burst-x", { state: { n: 3 }, version: 1 });
        // Coalesce window elapses, then the idle fallback runs.
        await vi.advanceTimersByTimeAsync(400);
        await vi.advanceTimersByTimeAsync(50);
        await vi.runAllTimersAsync();
        const raw = localStorage.getItem("test-burst-x");
        expect(raw).not.toBeNull();
        expect(JSON.parse(raw as string).state).toEqual({ n: 3 });
        await deferredJsonStorage.removeItem("test-burst-x");
    });
});
