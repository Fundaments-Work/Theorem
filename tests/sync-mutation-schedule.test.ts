import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const settingsState = { settings: { deviceSync: { autoSyncEnabled: true } } };
vi.mock("../src/core/store", () => ({
    useSettingsStore: { getState: () => settingsState },
    useLibraryStore: { getState: () => ({}), setState: () => {}, subscribe: () => () => {} },
    useVocabularyStore: { getState: () => ({}), setState: () => {}, subscribe: () => () => {} },
    useRssStore: { getState: () => ({}), setState: () => {}, subscribe: () => () => {} },
    useUIStore: { getState: () => ({}), setState: () => {} },
}));

type Orchestrator = typeof import("../src/core/lib/sync-orchestrator");

/** Delays of the sync timers that are still pending (fired or cleared ones drop out). */
function pendingSyncDelays(spy: ReturnType<typeof vi.spyOn>, cleared: Set<unknown>): number[] {
    return spy.mock.results
        .map((r, i) => ({ handle: r.value, delay: spy.mock.calls[i][1] as number }))
        .filter(({ handle, delay }) => (delay === 2000 || delay === 30_000) && !cleared.has(handle))
        .map(({ delay }) => delay);
}

describe("scheduleMutationSync", () => {
    let orchestrator: Orchestrator;
    let setSpy: ReturnType<typeof vi.spyOn>;
    let cleared: Set<unknown>;

    beforeEach(async () => {
        vi.useFakeTimers();
        vi.resetModules();
        settingsState.settings.deviceSync.autoSyncEnabled = true;
        orchestrator = await import("../src/core/lib/sync-orchestrator");
        cleared = new Set();
        setSpy = vi.spyOn(globalThis, "setTimeout");
        const realClear = globalThis.clearTimeout;
        vi.spyOn(globalThis, "clearTimeout").mockImplementation((h) => { cleared.add(h); return realClear(h as never); });
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it("throttles reading updates: a burst of page turns schedules one round, 30s out", () => {
        for (let i = 0; i < 50; i++) {
            orchestrator.scheduleMutationSync("reading");
            vi.advanceTimersByTime(500);
        }
        // 25s of turning pages: exactly one pending round, not reset by each turn.
        expect(pendingSyncDelays(setSpy, cleared)).toEqual([30_000]);
    });

    it("an edit pulls a pending reading round forward to the short debounce", () => {
        orchestrator.scheduleMutationSync("reading");
        orchestrator.scheduleMutationSync();
        expect(pendingSyncDelays(setSpy, cleared)).toEqual([2000]);
    });

    it("a reading update does not delay a pending edit round", () => {
        orchestrator.scheduleMutationSync();
        orchestrator.scheduleMutationSync("reading");
        expect(pendingSyncDelays(setSpy, cleared)).toEqual([2000]);
    });

    it("edits keep the 2s trailing debounce", () => {
        orchestrator.scheduleMutationSync();
        vi.advanceTimersByTime(1500);
        orchestrator.scheduleMutationSync();
        expect(pendingSyncDelays(setSpy, cleared)).toEqual([2000]);
    });

    it("does nothing when auto-sync is off", () => {
        settingsState.settings.deviceSync.autoSyncEnabled = false;
        orchestrator.scheduleMutationSync("reading");
        orchestrator.scheduleMutationSync();
        expect(pendingSyncDelays(setSpy, cleared)).toEqual([]);
    });
});
