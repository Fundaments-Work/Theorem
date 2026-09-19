import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
    compareSemver,
    findLatestApplicableRelease,
    isPrereleaseVersion,
    parseSemver,
    type GitHubRelease,
} from "../src/core/lib/app-update";

// ─── #106: update channel semver ───

function release(tag: string, prerelease = false): GitHubRelease {
    return {
        tag_name: tag,
        body: "",
        prerelease,
        draft: false,
        html_url: `https://github.com/fundaments-work/Theorem/releases/tag/${tag}`,
    };
}

describe("app-update semver helpers", () => {
    it("parses versions with v prefix", () => {
        expect(parseSemver("v1.5.8")).toEqual([1, 5, 8]);
        expect(parseSemver("1.6.0")).toEqual([1, 6, 0]);
        expect(parseSemver("not-a-version")).toBeNull();
    });

    it("compares numerically, not lexicographically", () => {
        expect(compareSemver("1.5.8", "1.5.0")).toBe(1);
        expect(compareSemver("1.5.0", "1.5.8")).toBe(-1);
        expect(compareSemver("1.10.0", "1.9.0")).toBe(1);
        expect(compareSemver("1.5.8", "1.5.8")).toBe(0);
    });

    it("treats X.Y.Z (Z > 0) as pre-release per repo convention", () => {
        expect(isPrereleaseVersion("1.5.8")).toBe(true);
        expect(isPrereleaseVersion("1.6.0")).toBe(false);
        expect(isPrereleaseVersion("garbage")).toBe(false);
    });
});

describe("findLatestApplicableRelease", () => {
    it("surfaces newer betas when running a pre-release", () => {
        const found = findLatestApplicableRelease(
            [release("v1.5.0"), release("v1.5.9", true)],
            "1.5.8",
        );
        expect(found?.tag_name).toBe("v1.5.9");
    });

    it("ignores pre-releases when running stable", () => {
        const found = findLatestApplicableRelease(
            [release("v1.5.0"), release("v1.6.1", true)],
            "1.5.0",
        );
        expect(found).toBeNull();
    });

    it("picks the newest newer stable for stable builds", () => {
        const found = findLatestApplicableRelease(
            [release("v1.5.0"), release("v1.6.0"), release("v1.7.0")],
            "1.5.0",
        );
        expect(found?.tag_name).toBe("v1.7.0");
    });

    it("returns null when nothing is newer", () => {
        expect(
            findLatestApplicableRelease([release("v1.5.0")], "1.5.8"),
        ).toBeNull();
    });

    it("skips drafts and unparseable tags", () => {
        const draft = { ...release("v9.9.9"), draft: true };
        const found = findLatestApplicableRelease(
            [draft, { ...release("v1.5.0"), tag_name: "nightly" }],
            "1.5.0",
        );
        expect(found).toBeNull();
    });
});

// ─── #109: shelf selection + batch store actions (static guards) ───

describe("shelf multi-select wiring", () => {
    const shelves = readFileSync(
        resolve("src/features/library/Shelves.tsx"),
        "utf-8",
    );

    it("shelf detail supports selection mode with range select", () => {
        expect(shelves).toContain('data-action="toggle-select-mode"');
        expect(shelves).toContain("handleToggleSelect");
        expect(shelves).toContain("shiftKey");
        expect(shelves).toContain("handleSelectAll");
    });

    it("cards receive live selection state, not hardcoded false", () => {
        expect(shelves).toContain("isSelecting={isSelecting}");
        expect(shelves).toContain("selectedBookIds.has(");
        expect(shelves).not.toContain("isSelecting={false}");
    });

    it("shelf-aware toolbar covers remove/move/read/unread/delete", () => {
        expect(shelves).toContain("Remove from Shelf");
        expect(shelves).toContain("Add to Shelf");
        expect(shelves).toContain("Mark Read");
        expect(shelves).toContain("Mark Unread");
        expect(shelves).toContain("batchDeleteIds");
    });
});

describe("sync bridge persistent identity indexes", () => {
    const orchestrator = readFileSync(
        resolve("src/core/lib/sync-orchestrator.ts"),
        "utf-8",
    );

    it("diffs via persistent indexes, not per-notification Map rebuilds", () => {
        expect(orchestrator).toContain("bookIndex");
        expect(orchestrator).toContain("annoIndex");
        expect(orchestrator).toContain("collectionIndex");
        expect(orchestrator).not.toContain("const oldMap");
        expect(orchestrator).not.toContain("const newIdSet");
        expect(orchestrator).not.toContain("_bookSerializedCache");
    });

    it("rebuilds membership only on the guarded stale-sweep path", () => {
        expect(orchestrator).toContain("if (bookIndex.size > ");
    });

    it("skips re-serialization on referential identity", () => {
        expect(orchestrator).toContain("entry.ref ===");
    });

    it("keeps exact deletion semantics with persistent membership", () => {
        expect(orchestrator).toContain("prevAnnoIds");
        expect(orchestrator).toContain("prevCollectionIds");
        expect(orchestrator).toContain("sweepStaleIndex");
    });
});
describe("sync live path batches gossip bursts", () => {
    const orchestrator = readFileSync(
        resolve("src/core/lib/sync-orchestrator.ts"),
        "utf-8",
    );

    it("coalesces annotation and collection entries progressively", () => {
        expect(orchestrator).toContain("_progressiveAnnoBatch");
        expect(orchestrator).toContain("_progressiveCollectionBatch");
        expect(orchestrator).toContain("_flushProgressiveAnnos");
        expect(orchestrator).toContain("_flushProgressiveCollections");
    });

    it("defers tombstone re-merges off the event loop", () => {
        expect(orchestrator).toContain("_pendingTombstonesValue");
        expect(orchestrator).toContain("scheduleIdleTask(_flushPendingTombstones)");
    });

    it("skips no-op flushes by ordered reference equality", () => {
        expect(orchestrator).toContain("isSameOrderedList");
    });

    it("looks up merged books by index, not per-item find", () => {
        expect(orchestrator).toContain("mergedById");
        expect(orchestrator).not.toContain("merged.find(");
    });
});
describe("batch store actions", () => {
    const store = readFileSync(
        resolve("src/core/store/libraryStore.ts"),
        "utf-8",
    );

    it("exposes single-set batch completion and removal", () => {
        expect(store).toContain("markBooksCompleted");
        expect(store).toContain("markBooksUnread");
        expect(store).toContain("removeBooksFromCollection");
        expect(store).toContain("removeBooks: (bookIds");
    });

    it("updater falls back to GitHub prereleases for beta builds", () => {
        const settings = readFileSync(
            resolve("src/features/settings/Settings.tsx"),
            "utf-8",
        );
        expect(settings).toContain("fetchLatestApplicableRelease");
        expect(settings).toContain("View Beta Release");
    });
});
