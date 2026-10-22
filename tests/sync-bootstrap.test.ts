import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapAutoSync, type AutoSyncModule } from "../src/core/lib/sync-bootstrap";
import { subscribeUntilCleanup } from "../src/core/lib/async-subscription";

function deferred<T = void>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

async function flush() {
    for (let i = 0; i < 10; i++) await Promise.resolve();
}

function fakeSync(overrides: Partial<AutoSyncModule> = {}) {
    const log: string[] = [];
    const module: AutoSyncModule = {
        ensureResponderSyncReady: async () => { log.push("responder"); },
        subscribeZustandToIrohDocs: () => {
            log.push("subscribe");
            return () => log.push("unsubscribe");
        },
        startAutoSync: async () => { log.push("start"); },
        stopAutoSync: () => { log.push("stop"); },
        ...overrides,
    };
    return { module, log };
}

describe("bootstrapAutoSync", () => {
    let errorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.useFakeTimers();
        errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
        vi.useRealTimers();
        errorSpy.mockRestore();
    });

    it("starts sync after the delay and stops it on cleanup", async () => {
        const { module, log } = fakeSync();
        const cleanup = bootstrapAutoSync(async () => module, true, 2000);
        expect(log).toEqual([]);
        await vi.advanceTimersByTimeAsync(2000);
        expect(log).toEqual(["responder", "subscribe", "start"]);
        cleanup();
        expect(log).toEqual(["responder", "subscribe", "start", "unsubscribe", "stop"]);
    });

    it("cleanup before the delay starts nothing", async () => {
        const { module, log } = fakeSync();
        const cleanup = bootstrapAutoSync(async () => module, true, 2000);
        cleanup();
        await vi.advanceTimersByTimeAsync(5000);
        expect(log).toEqual([]);
    });

    it("cleanup while startAutoSync is in flight still stops the interval it starts", async () => {
        const started = deferred();
        const { module, log } = fakeSync({
            startAutoSync: () => {
                log.push("start");
                return started.promise;
            },
        });
        const cleanup = bootstrapAutoSync(async () => module, true, 0);
        await vi.advanceTimersByTimeAsync(0);
        expect(log).toEqual(["responder", "subscribe", "start"]);

        cleanup();
        started.resolve();
        await flush();

        expect(log.filter((l) => l === "stop")).toHaveLength(1);
        expect(log).toContain("unsubscribe");
        expect(log.indexOf("stop")).toBeGreaterThan(log.indexOf("start"));
    });

    it("cleanup while the sync module loads starts nothing", async () => {
        const loaded = deferred<AutoSyncModule>();
        const { module, log } = fakeSync();
        const cleanup = bootstrapAutoSync(() => loaded.promise, true, 0);
        await vi.advanceTimersByTimeAsync(0);
        cleanup();
        loaded.resolve(module);
        await flush();
        expect(log).toEqual([]);
    });

    it("stops auto sync when it is disabled", async () => {
        const { module, log } = fakeSync();
        bootstrapAutoSync(async () => module, false, 0);
        await vi.advanceTimersByTimeAsync(0);
        expect(log).toEqual(["stop"]);
    });

    it("reports each failing step and keeps going", async () => {
        const { module, log } = fakeSync({
            ensureResponderSyncReady: async () => { throw new Error("no responder"); },
            startAutoSync: async () => { throw new Error("no start"); },
        });
        const cleanup = bootstrapAutoSync(async () => module, true, 0);
        await vi.advanceTimersByTimeAsync(0);
        expect(log).toEqual(["subscribe"]);
        expect(errorSpy).toHaveBeenCalledTimes(2);
        cleanup();
        // A failed start can still have armed timers: stopping is always safe.
        expect(log).toEqual(["subscribe", "unsubscribe", "stop"]);
    });

    it("reports a sync module that fails to load", async () => {
        bootstrapAutoSync(() => Promise.reject(new Error("chunk load")), true, 0);
        await vi.advanceTimersByTimeAsync(0);
        expect(errorSpy).toHaveBeenCalledTimes(1);
    });
});

describe("subscribeUntilCleanup", () => {
    let errorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
        errorSpy.mockRestore();
    });

    it("unsubscribes on cleanup", async () => {
        const stop = vi.fn();
        const cleanup = subscribeUntilCleanup("test", async () => stop);
        await flush();
        cleanup();
        expect(stop).toHaveBeenCalledTimes(1);
    });

    it("unsubscribes a subscription that resolves after cleanup", async () => {
        const stop = vi.fn();
        const pending = deferred<() => void>();
        const cleanup = subscribeUntilCleanup("test", () => pending.promise);
        cleanup();
        pending.resolve(stop);
        await flush();
        expect(stop).toHaveBeenCalledTimes(1);
    });

    it("never unsubscribes twice", async () => {
        const stop = vi.fn();
        const cleanup = subscribeUntilCleanup("test", async () => stop);
        await flush();
        cleanup();
        cleanup();
        expect(stop).toHaveBeenCalledTimes(1);
    });

    it("reports a failing subscription, sync or async", async () => {
        subscribeUntilCleanup("async", async () => { throw new Error("no window"); });
        subscribeUntilCleanup("sync", () => { throw new Error("no window"); });
        await flush();
        expect(errorSpy).toHaveBeenCalledTimes(2);
        const messages = errorSpy.mock.calls.map((call) => String(call[0])).sort();
        expect(messages[0]).toContain("[App] async ");
        expect(messages[1]).toContain("[App] sync ");
    });
});
