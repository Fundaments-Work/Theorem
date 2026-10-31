import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/core/lib/env", async original => ({...await original<object>(),isTauri:vi.fn(() => false)}));
vi.mock("@tauri-apps/api/core", async original => ({...await original<object>(),invoke:vi.fn().mockResolvedValue(null)}));
vi.mock("../src/core/lib/theorem-core", () => ({initTheoremCoreWasm:vi.fn().mockRejectedValue(new Error("WASM prohibited"))}));
import { isTauri } from "../src/core/lib/env";
import { invoke } from "@tauri-apps/api/core";
import { initTheoremCoreWasm } from "../src/core/lib/theorem-core";
import { useSettingsStore } from "../src/core/store";
import { localDateKey } from "../src/core/lib/date-keys";
import { setWeeklyReadingGoal, recordReadingRhythm, flushReadingRhythmOutbox, type RhythmProgress } from "../src/core/lib/reading-rhythm";

function result(): RhythmProgress {
    return {state:{version:1,activatedOn:localDateKey(),days:{},goals:{},awards:{}},weekStart:"2026-10-26",weekEnd:"2026-11-01",qualifyingDays:0,targetDays:4,nextTargetDays:4,todaySeconds:0,xp:0,level:1};
}
beforeEach(() => {
    vi.mocked(isTauri).mockReturnValue(true);
    useSettingsStore.setState(current => ({rhythmOutbox:{},stats:{...current.stats,rhythm:undefined}}));
    vi.mocked(invoke).mockResolvedValue(result());
});
describe("native reading rhythm adapter", () => {
    it("uses native Rust without trying to initialize WebAssembly", async () => {
        const response = result();
        vi.mocked(invoke).mockResolvedValue(response);
        await setWeeklyReadingGoal(4);
        expect(invoke).toHaveBeenCalledWith("evaluate_reading_rhythm",{request:expect.objectContaining({goal:expect.objectContaining({days:4})})});
        expect(initTheoremCoreWasm).not.toHaveBeenCalled();
        expect(useSettingsStore.getState().stats.rhythm).toEqual(response.state);
    });
    it("retains counters after IPC failure and replays them after restart", async () => {
        await setWeeklyReadingGoal(4);
        vi.mocked(invoke).mockRejectedValueOnce(new Error("busy"));
        const day=localDateKey();
        await expect(recordReadingRhythm(day,"reader",300)).rejects.toThrow("busy");
        const pending={date:day,source:"reader",seconds:300};
        expect(Object.values(useSettingsStore.getState().rhythmOutbox)).toEqual([pending]);
        vi.mocked(invoke).mockResolvedValue(result());
        await flushReadingRhythmOutbox();
        expect(invoke).toHaveBeenLastCalledWith("evaluate_reading_rhythm",{request:expect.objectContaining({reading:pending})});
        expect(useSettingsStore.getState().rhythmOutbox).toEqual({});
    });
    it("preserves unrelated reading changes while IPC is pending", async () => {
        let resolve!: (value: RhythmProgress) => void;
        let started!: () => void;
        const begun=new Promise<void>(done => {started=done;});
        vi.mocked(invoke).mockImplementationOnce(() => {started();return new Promise(done => {resolve=done as typeof resolve;});});
        const saving=setWeeklyReadingGoal(4);
        await begun;
        useSettingsStore.getState().updateStats({totalReadingTime:123});
        resolve(result());
        await saving;
        expect(useSettingsStore.getState().stats.totalReadingTime).toBe(123);
    });
});
