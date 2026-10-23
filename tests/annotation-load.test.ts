import { afterEach, describe, expect, it, vi } from "vitest";

// Annotations used to arrive as one JSON string per row and were parsed one by
// one at startup, with unreadable rows dropped by an empty catch. Rust now
// sends them parsed and validated in one payload and lists unreadable rows.

const load = vi.fn();
vi.mock("../src/core/lib/sqlite-storage", () => ({
    sqliteLoadAllAnnotations: () => load(),
}));

import { loadStoredAnnotations, reviveStoredAnnotations } from "../src/core/lib/annotation-load";

afterEach(() => {
    vi.restoreAllMocks();
    load.mockReset();
});

describe("loadStoredAnnotations", () => {
    it("uses the objects from the single native payload and revives their dates", async () => {
        load.mockResolvedValue({
            annotations: [
                { id: "a1", bookId: "b1", type: "highlight", createdAt: "2026-01-02T03:04:05.000Z", updatedAt: "2026-02-01T00:00:00.000Z" },
                { id: "a2", bookId: "b1", type: "note" },
            ],
            corruptIds: [],
        });
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        const annotations = await loadStoredAnnotations();

        expect(annotations.map((a) => a.id)).toEqual(["a1", "a2"]);
        expect(annotations[0].createdAt).toEqual(new Date("2026-01-02T03:04:05.000Z"));
        expect(annotations[0].updatedAt).toEqual(new Date("2026-02-01T00:00:00.000Z"));
        expect(annotations[1].createdAt).toBeInstanceOf(Date);
        expect(annotations[1].updatedAt).toBeUndefined();
        expect(warn).not.toHaveBeenCalled();
    });

    it("reports unreadable rows by id, never by content", async () => {
        load.mockResolvedValue({ annotations: [{ id: "ok" }], corruptIds: ["bad-1", "bad-2"] });
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        const annotations = await loadStoredAnnotations();

        expect(annotations.map((a) => a.id)).toEqual(["ok"]);
        expect(warn).toHaveBeenCalledTimes(1);
        const message = String(warn.mock.calls[0][0]);
        expect(message).toContain("2 stored annotation(s)");
        expect(message).toContain("bad-1");
        expect(message).toContain("bad-2");
    });

    it("handles an empty or missing payload", () => {
        expect(reviveStoredAnnotations({ annotations: [], corruptIds: [] })).toEqual([]);
        expect(reviveStoredAnnotations(undefined)).toEqual([]);
    });

    it("revives 50k annotations quickly", () => {
        const annotations = Array.from({ length: 50_000 }, (_, i) => ({
            id: `ann-${i}`,
            bookId: `b${i % 200}`,
            type: "highlight",
            createdAt: "2026-01-01T00:00:00Z",
        }));
        const start = performance.now();
        const revived = reviveStoredAnnotations({ annotations, corruptIds: [] });
        const elapsed = performance.now() - start;
        expect(revived).toHaveLength(50_000);
        expect(revived[49_999].createdAt).toBeInstanceOf(Date);
        // Generous bound: it is a single pass with no parsing.
        expect(elapsed).toBeLessThan(1000);
    });
});
