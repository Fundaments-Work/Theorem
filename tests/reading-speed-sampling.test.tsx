import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";

vi.mock("../src/core/lib/notifications", () => ({ notify: vi.fn(), notifyIfGranted: vi.fn(), requestNotificationPermission: vi.fn() }));

import { useReadingTime } from "../src/features/reader/hooks/useReadingTime";
import { useSettingsStore } from "../src/core/store";
import { computeExponentialMovingAverage } from "../src/features/reader/lib/reading-time";

// @ts-expect-error React act environment flag
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

type Api = ReturnType<typeof useReadingTime>;

describe("reading speed sampling", () => {
    let root: Root;
    let container: HTMLDivElement;
    let api: Api;

    function Probe() {
        api = useReadingTime({ currentBookId: "book-1" } as Parameters<typeof useReadingTime>[0]);
        return null;
    }

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(2026, 8, 23, 20, 0, 0));
        useSettingsStore.getState().updateStats({ averageReadingSpeed: 200 });
        container = document.createElement("div");
        root = createRoot(container);
        act(() => root.render(<Probe />));
    });

    afterEach(() => {
        act(() => root.unmount());
        vi.useRealTimers();
    });

    it("measures the full dwell time: the delayed word sample does not restart the page timer", () => {
        act(() => api.recordPageTurn());                       // turn to page 2 at t=0
        vi.advanceTimersByTime(1000);
        act(() => api.setCurrentPageWordCount(300));           // page 2 has 300 words (sampled at t=1s)
        vi.advanceTimersByTime(29_000);
        act(() => api.recordPageTurn());                       // turn to page 3 at t=30s

        // 300 words in 30s = 600 WPM (the old double-record measured 29s ⇒ 621 WPM).
        expect(useSettingsStore.getState().stats.averageReadingSpeed).toBe(computeExponentialMovingAverage(200, 600));
    });

    it("ignores implausible word counts", () => {
        act(() => api.recordPageTurn());
        act(() => api.setCurrentPageWordCount(3));
        act(() => api.setCurrentPageWordCount(Number.NaN));
        vi.advanceTimersByTime(30_000);
        act(() => api.recordPageTurn());
        // Falls back to the 250-word default page.
        expect(useSettingsStore.getState().stats.averageReadingSpeed).toBe(computeExponentialMovingAverage(200, 500));
    });
});
