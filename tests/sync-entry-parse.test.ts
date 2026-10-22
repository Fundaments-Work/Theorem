import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseSyncEntityEntry } from "../src/core/lib/sync-entries";

describe("parseSyncEntityEntry", () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
        warnSpy.mockRestore();
    });

    it("returns the parsed object", () => {
        expect(parseSyncEntityEntry("book:1", '{"id":"1","title":"T"}')).toEqual({ id: "1", title: "T" });
        expect(warnSpy).not.toHaveBeenCalled();
    });

    it("treats an empty value as a deletion, not as malformed", () => {
        expect(parseSyncEntityEntry("book:1", "")).toBeNull();
        expect(warnSpy).not.toHaveBeenCalled();
    });

    it("reports malformed JSON by key only, never the contents", () => {
        const secret = '{"id":"1","note":"private text"';
        expect(parseSyncEntityEntry("anno:1", secret)).toBeNull();
        expect(warnSpy).toHaveBeenCalledTimes(1);
        const logged = warnSpy.mock.calls[0].map(String).join(" ");
        expect(logged).toContain("anno:1");
        expect(logged).not.toContain("private text");
    });

    it.each([
        ["an array", "[1,2]"],
        ["null", "null"],
        ["a number", "42"],
        ["a string", '"x"'],
    ])("reports %s instead of an object", (_label, value) => {
        expect(parseSyncEntityEntry("collection:1", value)).toBeNull();
        expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it("requires an id when asked", () => {
        expect(parseSyncEntityEntry("book:1", '{"title":"T"}', { requireId: true })).toBeNull();
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(parseSyncEntityEntry("book:1", '{"title":"T"}')).toEqual({ title: "T" });
    });
});
