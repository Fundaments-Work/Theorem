import { describe, expect, it } from "vitest";
import { createThumbnailStore } from "../src/features/reader/engines/pdf-thumbnails";

function harness(maxEntries = 3) {
    const started: number[] = [];
    const gates = new Map<number, (b: Blob | null) => void>();
    const aborted: number[] = [];
    const revoked: string[] = [];
    const store = createThumbnailStore((page, signal) => {
        started.push(page);
        signal.addEventListener("abort", () => aborted.push(page));
        return new Promise((resolve) => gates.set(page, resolve));
    }, { maxEntries, createUrl: () => `url:${started.at(-1)}`, revokeUrl: (u) => { revoked.push(u); } });
    const finish = async (page: number, blob: Blob | null = new Blob(["x"])) => {
        gates.get(page)!(blob);
        await new Promise((r) => setTimeout(r, 0));
    };
    return { store, started, aborted, revoked, finish };
}

describe("thumbnail store", () => {
    it("renders one at a time, newest request first, and deduplicates", async () => {
        const { store, started, finish } = harness();
        const a = store.request(1);
        store.request(2);
        store.request(3);
        expect(store.request(1)).toBe(a); // same pending promise
        expect(started).toEqual([1]);
        await finish(1);
        expect(await a).toBe("url:1");
        expect(started).toEqual([1, 3]); // 3 was requested last
        await finish(3);
        expect(started).toEqual([1, 3, 2]);
    });

    it("re-requesting a waiting page moves it to the front", async () => {
        const { store, started, finish } = harness();
        store.request(1);
        store.request(2);
        store.request(3);
        store.request(2);
        await finish(1);
        expect(started).toEqual([1, 2]);
    });

    it("cancelling a waiting tile skips it and resolves null; a running one is aborted", async () => {
        const { store, started, aborted, finish } = harness();
        const one = store.request(1);
        const two = store.request(2);
        store.cancel(2);
        expect(await two).toBeNull();
        store.cancel(1);
        expect(aborted).toEqual([1]);
        await finish(1);
        expect(await one).toBeNull(); // aborted result is not cached
        expect(store.get(1)).toBeUndefined();
        expect(started).toEqual([1]);
    });

    it("keeps at most maxEntries URLs, evicting least recently used", async () => {
        const { store, revoked, finish } = harness(2);
        store.request(1); await finish(1);
        store.request(2); await finish(2);
        store.get(1); // 1 is now most recent
        store.request(3); await finish(3);
        expect(revoked).toEqual(["url:2"]);
        expect(store.get(2)).toBeUndefined();
        expect(await store.request(1)).toBe("url:1"); // served from cache
    });

    it("failed or empty renders resolve null and do not block the queue", async () => {
        const { store, started, finish } = harness();
        const one = store.request(1);
        store.request(2);
        await finish(1, null);
        expect(await one).toBeNull();
        expect(started).toEqual([1, 2]);
    });

    it("dispose revokes every URL and settles waiting requests", async () => {
        const { store, revoked, finish } = harness();
        store.request(1); await finish(1);
        store.request(2);
        const waiting = store.request(3);
        store.dispose();
        expect(await waiting).toBeNull();
        expect(revoked).toEqual(["url:1"]);
        expect(await store.request(4)).toBeNull();
    });
});
