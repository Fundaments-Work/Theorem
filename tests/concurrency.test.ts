import { describe, expect, it } from "vitest";
import { mapSettledWithConcurrency } from "../src/core/lib/concurrency";

const tick = () => new Promise((r) => setTimeout(r, 1));

describe("mapSettledWithConcurrency", () => {
    it("never exceeds the limit and returns results in input order", async () => {
        let active = 0, peak = 0;
        const results = await mapSettledWithConcurrency([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 4, async (n) => {
            active++; peak = Math.max(peak, active);
            await tick();
            active--;
            return n * 2;
        });
        expect(peak).toBe(4);
        expect(results.map((r) => (r.status === "fulfilled" ? r.value : null))).toEqual([2, 4, 6, 8, 10, 12, 14, 16, 18, 20]);
    });

    it("keeps going after failures, like allSettled", async () => {
        const results = await mapSettledWithConcurrency(["a", "b", "c"], 2, async (s) => {
            await tick();
            if (s === "b") throw new Error("feed down");
            return s;
        });
        expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
    });

    it("handles empty input and nonsense limits", async () => {
        expect(await mapSettledWithConcurrency([], 4, async () => 1)).toEqual([]);
        const r = await mapSettledWithConcurrency([1, 2], 0, async (n) => n);
        expect(r).toHaveLength(2);
    });
});
