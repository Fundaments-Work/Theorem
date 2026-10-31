// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { ReadingSetup } from "../src/features/onboarding/ReadingSetup";
import { ReadingRhythm } from "../src/features/statistics/ReadingRhythm";
import { useSettingsStore } from "../src/core/store";
import * as rhythmEngine from "../src/core/lib/reading-rhythm";
import { prepareReadingRhythm } from "../src/core/lib/reading-rhythm";

(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
const completed = vi.fn();
function click(name: string) {
    const button = [...host.querySelectorAll("button")].find(b => b.textContent?.trim() === name);
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
        expect(host.querySelector("select")?.value).toBe("4");
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
        await act(async () => click("Retry"));
        expect(host.querySelector('[role="alert"]')).toBeNull();
        expect(host.textContent).toContain("0 of 4 reading days");
    });
    it("hides compact motivational content while keeping goal controls available", async () => {
        useSettingsStore.getState().updateSettings({hideReadingMotivation:true});
        await act(async () => root.render(<ReadingRhythm compact />));
        expect(host.textContent).toBe("");
        await act(async () => root.render(<ReadingRhythm />));
        expect(host.textContent).toContain("Set a weekly goal");
        expect(host.querySelector('input[type="checkbox"]')).not.toBeNull();
    });
});
