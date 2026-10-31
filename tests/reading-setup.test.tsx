// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { ReadingSetup } from "../src/features/onboarding/ReadingSetup";
import { WeeklyReadingGoal } from "../src/features/settings/WeeklyReadingGoal";
import { localDateKey, addLocalDays } from "../src/core/lib/date-keys";
import { ReadingRhythm } from "../src/features/statistics/ReadingRhythm";
import { useSettingsStore } from "../src/core/store";
import * as rhythmEngine from "../src/core/lib/reading-rhythm";
import { prepareReadingRhythm } from "../src/core/lib/reading-rhythm";

(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
const completed = vi.fn();
function click(name: string) {
    const button = [...host.querySelectorAll("button")].find(b => (b.getAttribute("aria-label") ?? b.textContent?.trim()) === name);
    if (!button) throw new Error(`Missing button: ${name}`);
    button.click();
}
beforeEach(async () => {
    await prepareReadingRhythm();
    useSettingsStore.setState(state => ({readingSetupStep:0, rhythmOutbox:{}, stats:{...state.stats,rhythm:undefined}, settings:{...state.settings,hideReadingMotivation:false}}));
    completed.mockClear();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe("reading setup", () => {
    it("saves a rhythm and hands discovery to the app without a blocking tour", async () => {
        await act(async () => root.render(<ReadingSetup onComplete={completed} />));
        await act(async () => click("Start reading"));
        expect(host.querySelector("#setup-reading-days")?.textContent).toContain("4 days");
        await act(async () => click("Save rhythm"));
        expect(useSettingsStore.getState().stats.rhythm).toBeDefined();
        expect(useSettingsStore.getState().readingSetupStep).toBe(2);
        await act(async () => click("Browse Discover"));
        expect(completed).toHaveBeenCalledExactlyOnceWith("opds");
    });
    it("can skip without enabling a goal or requesting permissions", async () => {
        await act(async () => root.render(<ReadingSetup onComplete={completed} />));
        await act(async () => click("Skip setup"));
        expect(completed).toHaveBeenCalledExactlyOnceWith("library");
        expect(useSettingsStore.getState().stats.rhythm).toBeUndefined();
    });
    it("resumes completed setup steps after remount and allows back navigation", async () => {
        await act(async () => root.render(<ReadingSetup onComplete={completed} />));
        await act(async () => click("Start reading"));
        await act(async () => root.unmount());
        root = createRoot(host);
        await act(async () => root.render(<ReadingSetup onComplete={completed} />));
        expect(host.textContent).toContain("Choose your reading rhythm");
        await act(async () => click("Back"));
        expect(host.textContent).toContain("Make room for reading");
    });
    it("keeps the feature guide available on demand", async () => {
        await act(async () => root.render(<ReadingSetup onComplete={completed} />));
        await act(async () => click("Explore features"));
        expect(host.textContent).toContain("Welcome to Theorem");
        await act(async () => click("Skip"));
        expect(host.textContent).toContain("Make room for reading");
        expect(completed).not.toHaveBeenCalled();
    });
});

describe("reading rhythm presentation", () => {
    it("can retry loading progress without leaving the page", async () => {
        await rhythmEngine.setWeeklyReadingGoal(4);
        vi.spyOn(rhythmEngine,"readingRhythmProgress").mockRejectedValueOnce(new Error("unavailable"));
        await act(async () => root.render(<ReadingRhythm />));
        expect(host.querySelector('[role="alert"]')?.textContent).toContain("could not load");
        await act(async () => click("Retry reading progress"));
        expect(host.querySelector('[role="alert"]')).toBeNull();
        expect(host.querySelector('[aria-label="0 of 4 reading days this week"]')).not.toBeNull();
    });
    it("keeps Statistics read-only even before a goal is configured", async () => {
        await act(async () => root.render(<ReadingRhythm />));
        expect(host.querySelector('[aria-label="Level 1"]')).not.toBeNull();
        expect(host.querySelector("select, input")).toBeNull();
        expect(host.querySelector("button")).toBeNull();
        expect(useSettingsStore.getState().stats.rhythm).toBeUndefined();
    });
    it("edits weekly goals in Settings and shows only their progress in Statistics", async () => {
        await act(async () => root.render(<WeeklyReadingGoal />));
        expect(host.querySelector("#weekly-reading-days")?.textContent).toContain("Off");
        await act(async () => { host.querySelector<HTMLButtonElement>("#weekly-reading-days")!.dispatchEvent(new KeyboardEvent("keydown", {key:"Enter",bubbles:true})); });
        await act(async () => {
            const option=[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item=>item.textContent==="3 days");
            expect(option).toBeDefined();
            option!.click();
        });
        expect(useSettingsStore.getState().stats.rhythm).toBeDefined();
        expect(host.querySelector("#weekly-reading-days")?.textContent).toContain("3 days");
        await act(async () => root.render(<ReadingRhythm />));
        expect(host.querySelector("select, input")).toBeNull();
        expect(host.querySelector('[aria-label="0 of 3 reading days this week"]')).not.toBeNull();
    });
    it("distinguishes this week's goal from the change scheduled for Monday", async () => {
        await rhythmEngine.setWeeklyReadingGoal(4);
        await rhythmEngine.setWeeklyReadingGoal(5);
        await act(async () => root.render(<WeeklyReadingGoal />));
        expect(host.querySelector("#weekly-reading-days")?.textContent).toContain("5 days");
        expect(host.textContent).toContain("This week: 4 days. Next Monday: 5 days.");
        await act(async () => root.render(<ReadingRhythm />));
        expect(host.textContent).toContain("Level 1");
        expect(host.textContent).not.toContain("goal 4");
        expect(host.querySelector('[aria-label="0 of 4 reading days this week"]')).not.toBeNull();
    });
    it("advances the level emblem and resets the next-level track at 100 XP", async () => {
        await rhythmEngine.setWeeklyReadingGoal(0);
        await act(async () => root.render(<ReadingRhythm />));
        expect(host.querySelector('[aria-label="Level 1"]')).not.toBeNull();
        await act(async () => {
            for (let days=9;days>=0;days--) {
                await rhythmEngine.recordReadingRhythm(localDateKey(addLocalDays(new Date(),-days)),`day-${days}`,300);
            }
        });
        expect(host.querySelector('[aria-label="Level 2"]')).not.toBeNull();
        expect(host.querySelector('[aria-label="Next level 3"]')).not.toBeNull();
        expect(host.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("0");
        expect(host.textContent).toContain("100 XP");
    });
});
