import { beforeEach, describe, expect, it } from "vitest";
import { useLibraryStore } from "../src/core/store";
import type { Collection } from "../src/core/types";
import { normalizeShelfHierarchy } from "../src/core/lib/shelf-hierarchy";
import { mergeCollections } from "../src/core/lib/sync-import";
import { CollectionSchema } from "../src/core/lib/sync-schemas";
const shelf = (id: string, parentId?: string): Collection => ({ id, name: id, parentId, kind: "general", bookIds: ["book"], createdAt: new Date(0) });
beforeEach(() => useLibraryStore.setState({ collections: [], deletionTombstones: [] }));
describe("sub-shelves", () => {
    it("creates and moves sub-shelves without changing book membership", () => {
        const store = useLibraryStore.getState();
        store.addCollection(shelf("a")); store.addCollection(shelf("b")); store.addCollection(shelf("child", "a"));
        store.updateCollection("child", { parentId: "b" });
        expect(useLibraryStore.getState().collections[2]).toMatchObject({ parentId: "b", bookIds: ["book"] });
        store.updateCollection("child", { parentId: undefined });
        expect(useLibraryStore.getState().collections[2].parentId).toBeUndefined();
    });
    it("rejects missing parents, self-parenting, deeper nesting, and moving a parent with children", () => {
        const store = useLibraryStore.getState(); store.addCollection(shelf("root")); store.addCollection(shelf("other"));
        store.addCollection(shelf("child", "root"));
        for (const parent of ["missing", "child", "root"]) store.updateCollection("child", { parentId: parent === "root" ? "child" : parent });
        store.updateCollection("root", { parentId: "other" });
        store.addCollection(shelf("grandchild", "child"));
        expect(useLibraryStore.getState().collections.map(s => [s.id, s.parentId])).toEqual([["root", undefined], ["other", undefined], ["child", "root"]]);
    });
    it("promotes children when deleting a parent, preserving books and recording only the parent's deletion", () => {
        const store = useLibraryStore.getState(); store.addCollection(shelf("root")); store.addCollection(shelf("child", "root")); store.removeCollection("root");
        expect(useLibraryStore.getState().collections).toEqual([expect.objectContaining({ id: "child", parentId: undefined, bookIds: ["book"] })]);
        expect(useLibraryStore.getState().deletionTombstones.map(t => t.entityId)).toEqual(["root"]);
    });
    it("normalizes legacy, orphaned, cyclic and over-nested data deterministically", () => {
        const result = normalizeShelfHierarchy([shelf("old"), shelf("orphan", "missing"), shelf("a", "b"), shelf("b", "a"), shelf("child", "old"), shelf("deep", "child")]);
        expect(result.map(s => s.parentId)).toEqual([undefined, undefined, undefined, undefined, "old", undefined]);
        expect(normalizeShelfHierarchy([])).toEqual([]);
    });
    it("retains a parent link when progressive sync delivers the child first", () => {
        const first = mergeCollections([shelf("child", "root")], []);
        expect(first[0].parentId).toBe("root");
        expect(mergeCollections([shelf("root")], first)[0].parentId).toBe("root");
    });
    it("syncs newer parent moves including promotion, and repairs deleted parents", () => {
        const older = { ...shelf("child", "root"), updatedAt: new Date(1) };
        const newer = { ...older, parentId: undefined, updatedAt: new Date(2) };
        expect(mergeCollections([newer], [shelf("root"), older])[1].parentId).toBeUndefined();
        expect(mergeCollections([], [shelf("root"), older], [{ entityId: "root", entityType: "collection", deletedAt: new Date().toISOString() }])[0].parentId).toBeUndefined();
        expect(CollectionSchema.parse(older).parentId).toBe("root");
    });
});
