import { beforeEach, describe, expect, it, vi } from "vitest";

// Rust runs these commands on a thread pool, so responses can come back in
// any order. Model that: each invoke resolves after a delay chosen per call.
const executed: string[] = [];
const store = new Map<string, string>();
let delays: number[] = [];

vi.mock("@tauri-apps/api/core", () => ({
    invoke: vi.fn(async (command: string, args: Record<string, string>) => {
        const delay = delays.shift() ?? 0;
        await new Promise((resolve) => setTimeout(resolve, delay));
        executed.push(`${command}:${args?.key ?? ""}:${args?.value ?? ""}`);
        if (command === "sqlite_set_kv") store.set(args.key, args.value);
        if (command === "sqlite_get_kv") return store.get(args.key) ?? null;
        if (command === "boom") throw new Error("boom");
        return null;
    }),
}));
vi.mock("../src/core/lib/env", () => ({ isTauri: () => true }));

const { invokeSqliteInOrder, sqliteGetKv, sqliteSetKv } = await import("../src/core/lib/sqlite-storage");

describe("SQLite invoke queue", () => {
    beforeEach(() => {
        executed.length = 0;
        store.clear();
        delays = [];
    });

    it("applies writes to the same key in call order even if the first is slowest", async () => {
        delays = [30, 0, 0];
        await Promise.all([
            sqliteSetKv("k", "old"),
            sqliteSetKv("k", "new"),
        ]);
        expect(store.get("k")).toBe("new");
        expect(executed).toEqual(["sqlite_set_kv:k:old", "sqlite_set_kv:k:new"]);
    });

    it("lets a read see every write issued before it", async () => {
        delays = [25, 0];
        const write = sqliteSetKv("k", "v1");
        const read = sqliteGetKv("k");
        await write;
        expect(await read).toBe("v1");
    });

    it("keeps going after a failed command", async () => {
        const failed = invokeSqliteInOrder("boom");
        const next = sqliteSetKv("k", "after");
        await expect(failed).rejects.toThrow("boom");
        await next;
        expect(store.get("k")).toBe("after");
    });

    it("runs many calls strictly one after another", async () => {
        delays = Array.from({ length: 20 }, (_, i) => (i % 3) * 5);
        await Promise.all(Array.from({ length: 20 }, (_, i) => sqliteSetKv(`k${i}`, String(i))));
        expect(executed).toEqual(Array.from({ length: 20 }, (_, i) => `sqlite_set_kv:k${i}:${i}`));
    });
});
