import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Annotation, DeletionTombstone } from "../src/core/types";

const { mockIsTauriEnv, mocks } = vi.hoisted(() => ({
    mockIsTauriEnv: { value: true },
    mocks: {
        sqliteDeleteAnnotation: vi.fn().mockResolvedValue(undefined),
        sqliteUpsertAnnotation: vi.fn().mockResolvedValue(undefined),
    },
}));

vi.mock("../src/core/lib/env", () => ({
    isTauri: () => mockIsTauriEnv.value,
    isTauriDesktop: () => mockIsTauriEnv.value,
    isTauriMobile: () => false,
    isMobile: () => false,
}));

vi.mock("../src/core/lib/sqlite-storage", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../src/core/lib/sqlite-storage")>();
    return {
        ...actual,
        sqliteSaveBookMetadata: vi.fn().mockResolvedValue(undefined),
        sqliteDeleteBookMetadata: vi.fn().mockResolvedValue(undefined),
        sqliteLoadAllBooks: vi.fn().mockResolvedValue([]),
        sqliteSaveBookAnnotations: vi.fn().mockResolvedValue(undefined),
        sqliteGetAllAnnotations: vi.fn().mockResolvedValue([]),
        sqliteUpsertAnnotation: (...args: unknown[]) => mocks.sqliteUpsertAnnotation(...args),
        sqliteDeleteAnnotation: (...args: unknown[]) => mocks.sqliteDeleteAnnotation(...args),
        sqliteListCoverVersions: vi.fn().mockResolvedValue([]),
        sqliteIndexBooksFtsBatch: vi.fn().mockResolvedValue(undefined),
        sqliteIndexBookFts: vi.fn().mockResolvedValue(undefined),
        sqliteGetKv: vi.fn().mockResolvedValue(null),
        sqliteSetKv: vi.fn().mockResolvedValue(undefined),
        sqliteDeleteBookData: vi.fn().mockResolvedValue(undefined),
    };
});

import { useLibraryStore, reconcileHydratedAnnotations } from "../src/core/store/libraryStore";
import { mergeAnnotations } from "../src/core/lib/sync-import";

function ann(id: string, bookId = "b1", extra: Partial<Annotation> = {}): Annotation {
    return {
        id,
        bookId,
        type: "highlight",
        location: `epubcfi(/6/4!/4/2,/1:0,/1:${id.length})`,
        selectedText: `text ${id}`,
        color: "yellow",
        createdAt: new Date("2026-09-01T00:00:00Z"),
        ...extra,
    };
}

function tomb(entityId: string, entityType: DeletionTombstone["entityType"] = "annotation"): DeletionTombstone {
    return { entityId, entityType, deletedAt: new Date().toISOString() };
}

describe("reconcileHydratedAnnotations", () => {
    it("keeps annotations whose book has not been loaded yet (hydration race)", () => {
        // Books hydrate concurrently; the old code treated every annotation
        // as orphaned when they resolved first and deleted them from SQLite.
        const persisted = [ann("a1", "not-loaded-yet"), ann("a2", "rss:article-1")];
        const { kept, purgedIds } = reconcileHydratedAnnotations(persisted, [], []);
        expect(kept.map((a) => a.id)).toEqual(["a1", "a2"]);
        expect(purgedIds).toEqual([]);
    });

    it("purges tombstoned annotations and annotations of tombstoned books", () => {
        const persisted = [ann("a1"), ann("a2"), ann("a3", "b-deleted")];
        const { kept, purgedIds } = reconcileHydratedAnnotations(
            persisted,
            [],
            [tomb("a2"), tomb("b-deleted", "book")],
        );
        expect(kept.map((a) => a.id)).toEqual(["a1"]);
        expect(purgedIds.sort()).toEqual(["a2", "a3"]);
    });

    it("keeps annotations added in memory while storage was loading", () => {
        const { kept } = reconcileHydratedAnnotations([ann("a1")], [ann("fresh")], []);
        expect(kept.map((a) => a.id).sort()).toEqual(["a1", "fresh"]);
    });

    it("prefers the newer copy when an id exists in both", () => {
        const stored = ann("a1", "b1", { noteContent: "old", updatedAt: new Date("2026-09-02T00:00:00Z") });
        const newer = ann("a1", "b1", { noteContent: "new", updatedAt: new Date("2026-09-03T00:00:00Z") });
        const older = ann("a1", "b1", { noteContent: "older", updatedAt: new Date("2026-09-01T00:00:00Z") });
        expect(reconcileHydratedAnnotations([stored], [newer], []).kept[0].noteContent).toBe("new");
        expect(reconcileHydratedAnnotations([stored], [older], []).kept[0].noteContent).toBe("old");
    });

    it("drops tombstoned in-memory annotations without asking storage to delete them", () => {
        const { kept, purgedIds } = reconcileHydratedAnnotations([], [ann("a1")], [tomb("a1")]);
        expect(kept).toEqual([]);
        expect(purgedIds).toEqual([]);
    });

    it("handles empty inputs", () => {
        expect(reconcileHydratedAnnotations([], [], [])).toEqual({ kept: [], purgedIds: [] });
    });

    it("tolerates missing/invalid dates", () => {
        const bad = ann("a1", "b1", { createdAt: "garbage" as unknown as Date });
        const good = ann("a1", "b1", { noteContent: "valid" });
        expect(reconcileHydratedAnnotations([bad], [good], []).kept[0].noteContent).toBe("valid");
    });
});

describe("removeAnnotation", () => {
    beforeEach(() => {
        mocks.sqliteDeleteAnnotation.mockClear();
        useLibraryStore.setState({ annotations: [], deletionTombstones: [] });
    });

    it("removes from state, records a tombstone and deletes the SQLite row", () => {
        useLibraryStore.setState({ annotations: [ann("a1"), ann("a2")] });
        useLibraryStore.getState().removeAnnotation("a1");

        const state = useLibraryStore.getState();
        expect(state.annotations.map((a) => a.id)).toEqual(["a2"]);
        expect(state.deletionTombstones).toEqual([
            expect.objectContaining({ entityId: "a1", entityType: "annotation" }),
        ]);
        expect(mocks.sqliteDeleteAnnotation).toHaveBeenCalledWith("a1");
    });

    it("a stale sync copy of a deleted annotation is not merged back", () => {
        const stale = ann("a1");
        useLibraryStore.setState({ annotations: [stale, ann("a2")] });
        useLibraryStore.getState().removeAnnotation("a1");

        const state = useLibraryStore.getState();
        const merged = mergeAnnotations([stale], state.annotations, state.deletionTombstones);
        expect(merged.map((a) => a.id)).toEqual(["a2"]);
    });

    it("rapid consecutive deletes all stick", () => {
        useLibraryStore.setState({ annotations: [ann("a1"), ann("a2"), ann("a3")] });
        const { removeAnnotation } = useLibraryStore.getState();
        removeAnnotation("a1");
        removeAnnotation("a2");
        removeAnnotation("a3");
        const state = useLibraryStore.getState();
        expect(state.annotations).toEqual([]);
        expect(state.deletionTombstones.map((t) => t.entityId).sort()).toEqual(["a1", "a2", "a3"]);
        const { kept } = reconcileHydratedAnnotations(
            [ann("a1"), ann("a2"), ann("a3")],
            state.annotations,
            state.deletionTombstones,
        );
        expect(kept).toEqual([]);
    });

    it("deleting an unknown id is a no-op for the list", () => {
        useLibraryStore.setState({ annotations: [ann("a1")] });
        useLibraryStore.getState().removeAnnotation("missing");
        expect(useLibraryStore.getState().annotations.map((a) => a.id)).toEqual(["a1"]);
    });
});
