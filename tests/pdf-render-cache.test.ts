import { describe, expect, it, vi } from "vitest";
import { RenderedPageCache } from "../src/features/reader/engines/pdf-render-cache";

describe("RenderedPageCache", () => {
    it("keeps recently left pages and releases the oldest beyond the count limit", () => {
        const cache = new RenderedPageCache<string>(2, Infinity);
        const released: string[] = [];
        for (const k of ["p1", "p2", "p3"]) cache.retain(k, 100, () => released.push(k));
        expect(released).toEqual(["p1"]);
        expect(cache.size).toBe(2);
        expect(cache.pixels).toBe(200);
    });

    it("enforces the pixel budget, evicting as many oldest pages as needed", () => {
        const cache = new RenderedPageCache<string>(10, 1000);
        const released: string[] = [];
        cache.retain("a", 400, () => released.push("a"));
        cache.retain("b", 400, () => released.push("b"));
        cache.retain("c", 700, () => released.push("c"));
        expect(released).toEqual(["a", "b"]);
        expect(cache.pixels).toBe(700);
    });

    it("releases a single page that alone exceeds the budget", () => {
        const cache = new RenderedPageCache<string>(10, 100);
        const release = vi.fn();
        cache.retain("huge", 500, release);
        expect(release).toHaveBeenCalledTimes(1);
        expect(cache.size).toBe(0);
        expect(cache.pixels).toBe(0);
    });

    it("reclaiming a page (visible again) removes it without releasing, and refreshes recency", () => {
        const cache = new RenderedPageCache<string>(2, Infinity);
        const released: string[] = [];
        cache.retain("p1", 10, () => released.push("p1"));
        cache.retain("p2", 10, () => released.push("p2"));
        expect(cache.reclaim("p1")).toBe(true);
        expect(cache.reclaim("p1")).toBe(false);
        cache.retain("p1", 10, () => released.push("p1"));
        cache.retain("p3", 10, () => released.push("p3"));
        // p2 is now the oldest.
        expect(released).toEqual(["p2"]);
    });

    it("re-retaining an existing key replaces it without double counting", () => {
        const cache = new RenderedPageCache<string>(5, Infinity);
        cache.retain("p", 100, () => {});
        cache.retain("p", 300, () => {});
        expect(cache.size).toBe(1);
        expect(cache.pixels).toBe(300);
    });

    it("drop and clear release immediately; a throwing release does not stop the others", () => {
        const cache = new RenderedPageCache<string>(5, Infinity);
        const released: string[] = [];
        cache.retain("a", 1, () => { throw new Error("boom"); });
        cache.retain("b", 1, () => released.push("b"));
        cache.retain("c", 1, () => released.push("c"));
        cache.drop("c");
        expect(released).toEqual(["c"]);
        cache.clear();
        expect(released).toEqual(["c", "b"]);
        expect(cache.size).toBe(0);
        expect(cache.pixels).toBe(0);
    });

    it("treats invalid pixel counts as zero", () => {
        const cache = new RenderedPageCache<string>(5, 10);
        cache.retain("nan", Number.NaN, () => {});
        cache.retain("neg", -5, () => {});
        expect(cache.pixels).toBe(0);
        expect(cache.size).toBe(2);
    });
});
