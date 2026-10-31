import { beforeEach, describe, expect, it } from "vitest";
import { initTheoremCoreWasm, evaluateReadingRhythm } from "../src/core/lib/theorem-core";
import { mergeReadingRhythm, prepareReadingRhythm, recordReadingRhythm, setWeeklyReadingGoal } from "../src/core/lib/reading-rhythm";
import { useSettingsStore } from "../src/core/store";
import { splitReadingInterval } from "../src/features/reader/lib/reading-interval";

beforeEach(async () => {
    await initTheoremCoreWasm();
    await prepareReadingRhythm();
    useSettingsStore.setState(state => ({ rhythmOutbox: {}, stats: { ...state.stats, rhythm: undefined, dailyActivity: [] } }));
});

describe("Rust reading rhythm through the browser bridge", () => {
    it("backfills daily awards from retained legacy activity", async () => {
        useSettingsStore.getState().updateStats({ dailyActivity: [{date:"2026-10-01", minutes: 60, booksRead: ["b"]}] });
        await setWeeklyReadingGoal(4);
        expect(useSettingsStore.getState().stats.rhythm?.awards).toEqual({"day:2026-10-01":10});
    });

    it("combines independent sessions once and preserves XP through a legacy peer merge", async () => {
        await setWeeklyReadingGoal(1);
        const day = useSettingsStore.getState().stats.rhythm!.activatedOn;
        await Promise.all([recordReadingRhythm(day, "one", 150), recordReadingRhythm(day, "two", 150)]);
        await recordReadingRhythm(day, "one", 150);
        const before = useSettingsStore.getState().stats.rhythm!;
        expect(before.awards[`day:${day}`]).toBe(10);
        expect(Object.values(before.awards).reduce((a,b) => a+b,0)).toBe(30);
        await mergeReadingRhythm(undefined);
        expect(useSettingsStore.getState().stats.rhythm).toEqual(before);
        await mergeReadingRhythm(before);
        expect(useSettingsStore.getState().stats.rhythm).toEqual(before);
    });

    it("does not overwrite valid progress with corrupt or future-version data", async () => {
        await setWeeklyReadingGoal(4);
        const before = useSettingsStore.getState().stats.rhythm!;
        await expect(mergeReadingRhythm({...before, version: 99} as unknown as typeof before)).rejects.toBeDefined();
        expect(useSettingsStore.getState().stats.rhythm).toEqual(before);
    });

    it("uses Monday weeks through year boundaries", () => {
        const progress = evaluateReadingRhythm({ today: "2027-01-01" });
        expect([progress.weekStart, progress.weekEnd]).toEqual(["2026-12-28", "2027-01-03"]);
    });
});

describe("reading interval assignment", () => {
    it("splits a session across local midnight without dropping fractional minutes", () => {
        const start = new Date(2026,9,31,23,59,30).getTime();
        const end = new Date(2026,10,1,0,0,15).getTime();
        expect(splitReadingInterval(start,end)).toEqual([
            {date:"2026-10-31", milliseconds:30000},
            {date:"2026-11-01", milliseconds:15000},
        ]);
    });
    it("ignores empty, reversed and nonfinite intervals", () => {
        for (const [start,end] of [[0,0],[2,1],[NaN,3],[1,Infinity]]) expect(splitReadingInterval(start,end)).toEqual([]);
    });
    it("handles short sessions", () => {
        const start = new Date(2026,9,31,12).getTime();
        expect(splitReadingInterval(start,start+500)).toEqual([{date:"2026-10-31",milliseconds:500}]);
    });
});

it("migrates existing settings without inventing historical reading awards", async () => {
    const migrate = useSettingsStore.persist.getOptions().migrate!;
    const previous = { settings: useSettingsStore.getState().settings, stats: { ...useSettingsStore.getState().stats, rhythm: undefined } };
    const migrated = await migrate(previous, 13) as {readingSetupStep:number;readingOutbox:object;stats:typeof previous.stats};
    expect(migrated.readingSetupStep).toBe(0);
    expect(migrated.readingOutbox).toEqual({});
    expect((migrated as unknown as {rhythmOutbox:object}).rhythmOutbox).toEqual({});
    expect(migrated.stats.rhythm).toBeUndefined();
    expect(migrated.stats.totalReadingTime).toBe(previous.stats.totalReadingTime);
});
