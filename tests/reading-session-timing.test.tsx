// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/core/lib/reading-records", () => ({queueReadingChunk:vi.fn()}));
vi.mock("../src/core/lib/reading-rhythm", () => ({prepareReadingRhythm:vi.fn().mockResolvedValue(undefined),recordReadingRhythm:vi.fn().mockResolvedValue(undefined)}));
import { useReadingTime } from "../src/features/reader/hooks/useReadingTime";
import { useSettingsStore } from "../src/core/store";

(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let root: Root | undefined;
const addTime = vi.fn();
function Probe() { useReadingTime({currentBookId:"book",addReadingTime:addTime}); return null; }
function mount() { root=createRoot(document.createElement("div")); act(() => root!.render(<Probe />)); }
beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026,9,31,12));
    Object.defineProperty(document,"hidden",{value:false,configurable:true});
    useSettingsStore.setState(state => ({stats:{...state.stats,totalReadingTime:0,dailyActivity:[],rhythm:undefined}}));
    addTime.mockClear();
});
afterEach(() => { act(() => root?.unmount()); root=undefined; vi.useRealTimers(); });
describe("recording visible reading intervals", () => {
    it("keeps time from short sessions when the reader closes", () => {
        mount();
        act(() => vi.advanceTimersByTime(30_000));
        act(() => root!.unmount()); root=undefined;
        expect(useSettingsStore.getState().stats.totalReadingTime).toBe(0.5);
        expect(addTime).toHaveBeenCalledWith("book",0.5);
    });
    it("assigns both sides of local midnight to their own day", () => {
        vi.setSystemTime(new Date(2026,9,31,23,59,30));
        mount();
        act(() => vi.advanceTimersByTime(60_000));
        expect(useSettingsStore.getState().stats.dailyActivity).toEqual([
            {date:"2026-10-31",minutes:0.5,booksRead:["book"]},
            {date:"2026-11-01",minutes:0.5,booksRead:["book"]},
        ]);
    });
    it("does not start timing a hidden document", () => {
        Object.defineProperty(document,"hidden",{value:true,configurable:true});
        mount();
        act(() => vi.advanceTimersByTime(60_000));
        act(() => root!.unmount()); root=undefined;
        expect(useSettingsStore.getState().stats.totalReadingTime).toBe(0);
    });
    it("uses elapsed time rather than a corrected wall clock", () => {
        mount();
        act(() => vi.advanceTimersByTime(30_000));
        vi.setSystemTime(new Date(2026,9,30,12,0,30));
        act(() => vi.advanceTimersByTime(30_000));
        expect(useSettingsStore.getState().stats.totalReadingTime).toBe(1);
    });
});
