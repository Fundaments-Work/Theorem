// @vitest-environment jsdom
/**
 * Sync conflicts are listed in Settings → Device Sync: what is in use, what
 * was replaced, and a way to switch to the replaced version (applied as a
 * new edit, so it reaches the other devices) or keep things as they are.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Book, SyncConflict } from "../src/core/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let listed: SyncConflict[] = [];
const dismissed: string[][] = [];
vi.mock("../src/core/lib/sqlite-storage", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../src/core/lib/sqlite-storage")>()),
    sqliteListSyncConflicts: async () => listed,
    sqliteDismissSyncConflicts: async (ids: string[] = []) => {
        dismissed.push(ids);
        listed = ids.length === 0 ? [] : listed.filter((c) => !ids.includes(c.id));
        return ids.length;
    },
}));

import { SyncConflictList, useSyncConflicts } from "../src/features/settings/SyncConflicts";
import { useLibraryStore } from "../src/core/store";

const bookConflict: SyncConflict = {
    id: "c1",
    entityType: "book",
    entityId: "b1",
    label: "Dune",
    winner: "remote",
    kept: { tags: ["classic"], completedAt: null, metadataBaseAt: "x" },
    discarded: { tags: ["sf"], completedAt: "2026-05-01T00:00:00.000Z", metadataBaseAt: "y" },
    keptAt: 2,
    discardedAt: 1,
    detectedAt: Date.parse("2026-05-03T10:00:00Z"),
};

const annotationConflict: SyncConflict = {
    id: "c2",
    entityType: "annotation",
    entityId: "gone",
    label: "Fear is the mind-killer",
    winner: "local",
    kept: { noteContent: "mine" },
    discarded: { noteContent: "theirs" },
    keptAt: 2,
    discardedAt: 1,
    detectedAt: Date.parse("2026-05-03T11:00:00Z"),
};

let root: Root | null = null;
let host: HTMLElement | null = null;

function Harness() {
    const { conflicts, dismiss, restore } = useSyncConflicts(true);
    return conflicts.length > 0
        ? <SyncConflictList conflicts={conflicts} onRestore={(c) => void restore(c)} onDismiss={(ids) => void dismiss(ids)} />
        : <p>none</p>;
}

async function render() {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root!.render(<Harness />));
}

function buttons(label: string): HTMLButtonElement[] {
    return Array.from(document.body.querySelectorAll("button")).filter((b) => b.textContent?.trim() === label);
}

beforeEach(() => {
    listed = [bookConflict, annotationConflict];
    dismissed.length = 0;
    useLibraryStore.setState({
        books: [{ id: "b1", title: "Dune", author: "F", format: "epub", filePath: "/b", fileSize: 1, addedAt: new Date(), progress: 0, tags: ["classic"], isFavorite: false, readingTime: 0 } as Book],
        annotations: [],
    });
});

afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
});

describe("sync conflict list", () => {
    it("shows what is in use and what was replaced, and never internal fields", async () => {
        await render();
        const text = document.body.textContent ?? "";
        expect(text).toContain("Dune");
        expect(text).toContain("Your change on this device was replaced");
        expect(text).toContain("A change from another device was replaced");
        expect(text).toContain("classic");
        expect(text).toContain("sf");
        expect(text).not.toContain("metadataBaseAt");
        // The deleted highlight can only be dismissed.
        expect(text).toContain("This highlight has since been deleted.");
        expect(buttons("Use the replaced version")).toHaveLength(1);
    });

    it("switching to the replaced version applies it as a new edit and clears the conflict", async () => {
        await render();
        await act(async () => buttons("Use the replaced version")[0].click());
        const b = useLibraryStore.getState().getBook("b1")!;
        expect(b.tags).toEqual(["sf"]);
        expect(b.completedAt).toBeInstanceOf(Date);
        expect(b.metadataUpdatedAt).toBeDefined();
        expect(dismissed).toEqual([["c1"]]);
        expect(document.body.textContent).not.toContain("Dune");
    });

    it("keeping one or all dismisses them, and new conflicts show up when found", async () => {
        await render();
        await act(async () => buttons("Keep the one in use")[1].click());
        expect(dismissed).toEqual([["c2"]]);
        listed = [bookConflict, { ...annotationConflict, id: "c3" }];
        await act(async () => window.dispatchEvent(new CustomEvent("theorem:sync-conflicts")));
        expect(buttons("Keep the one in use")).toHaveLength(2);
        await act(async () => buttons("Keep all as they are")[0].click());
        expect(dismissed.at(-1)).toEqual([]);
        expect(document.body.textContent).toContain("none");
    });
});
