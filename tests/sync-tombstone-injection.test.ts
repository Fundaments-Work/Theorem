import { describe, expect, it, vi } from "vitest";
import type { DeletionTombstone } from "../src/core/types";

vi.mock("../src/core/store", () => ({
    useSettingsStore: { getState: () => ({ settings: {} }) },
    useLibraryStore: { getState: () => ({}), setState: () => {}, subscribe: () => () => {} },
    useVocabularyStore: { getState: () => ({}), setState: () => {}, subscribe: () => () => {} },
    useRssStore: { getState: () => ({}), setState: () => {}, subscribe: () => () => {} },
    useUIStore: { getState: () => ({}), setState: () => {} },
}));

import { withLocalTombstones } from "../src/core/lib/sync-orchestrator";

const recent = () => new Date().toISOString();
const t = (entityId: string, entityType: DeletionTombstone["entityType"] = "annotation"): DeletionTombstone =>
    ({ entityId, entityType, deletedAt: recent() });

function tombstoneIds(entries: Record<string, string>): string[] {
    return (JSON.parse(entries["deletion_tombstones"]) as DeletionTombstone[])
        .map((x) => x.entityId)
        .sort();
}

describe("withLocalTombstones", () => {
    it("returns the entries untouched when there are no local tombstones", () => {
        const entries = { "anno:b1:a1": "{}" };
        expect(withLocalTombstones(entries, [])).toBe(entries);
    });

    it("adds local tombstones to a batch that carries none (live anno:* batch)", () => {
        const entries = { "anno:b1:a1": '{"id":"a1","bookId":"b1"}' };
        const out = withLocalTombstones(entries, [t("a1")]);
        expect(out["anno:b1:a1"]).toBe(entries["anno:b1:a1"]);
        expect(tombstoneIds(out)).toEqual(["a1"]);
        // input is not mutated
        expect(entries).not.toHaveProperty("deletion_tombstones");
    });

    it("unions incoming and local tombstones", () => {
        const entries = { deletion_tombstones: JSON.stringify([t("remote")]) };
        expect(tombstoneIds(withLocalTombstones(entries, [t("local"), t("b9", "book")]))).toEqual(["b9", "local", "remote"]);
    });

    it("dedupes an id present on both sides", () => {
        const entries = { deletion_tombstones: JSON.stringify([t("a1")]) };
        expect(tombstoneIds(withLocalTombstones(entries, [t("a1")]))).toEqual(["a1"]);
    });

    it("survives a corrupt incoming tombstone entry", () => {
        const entries = { deletion_tombstones: "{not json" };
        expect(tombstoneIds(withLocalTombstones(entries, [t("a1")]))).toEqual(["a1"]);
        const notArray = { deletion_tombstones: '{"a":1}' };
        expect(tombstoneIds(withLocalTombstones(notArray, [t("a1")]))).toEqual(["a1"]);
    });
});
