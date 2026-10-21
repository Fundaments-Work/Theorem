// @vitest-environment jsdom
/**
 * The mobile reminder planner keeps Android's reminder in step with the app: on start, on
 * every relevant settings change, when today's goal is met, and on return to the app. On a
 * phone the in-app timer must not run at all: it is what never reminded anyone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReminderConfig } from "../src/core/lib/daily-reminder";

const sent: ReminderConfig[] = [];
let inFlight = 0;
let maxInFlight = 0;
let failNext = 0;
vi.mock("../src/core/lib/daily-reminder", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../src/core/lib/daily-reminder")>();
    return {
        ...actual,
        configureReminder: async (config: ReminderConfig) => {
            inFlight++;
            maxInFlight = Math.max(maxInFlight, inFlight);
            try {
                await new Promise((r) => setTimeout(r, 1));
                if (failNext > 0) {
                    failNext--;
                    throw new Error("plugin not ready");
                }
                sent.push(config);
            } finally {
                inFlight--;
            }
        },
    };
});
const toast = vi.fn();
vi.mock("sonner", () => ({ toast: (...a: unknown[]) => toast(...a) }));
const notifyIfGranted = vi.fn();
vi.mock("../src/core/lib/notifications", () => ({ notifyIfGranted: (...a: unknown[]) => notifyIfGranted(...a) }));

import { useSettingsStore } from "../src/core/store";
import { localDateKey } from "../src/core/lib/date-keys";
import {
    refreshScheduledReminders,
    startMobileReminderPlanner,
    useDailyGoalReminder,
} from "../src/features/reader/hooks/useDailyGoalReminder";

const ANDROID = "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36";

/** Lets the planner's queue (dynamic import, then the command) run to the end. */
async function settle() {
    for (let i = 0; i < 30; i++) await act(async () => await new Promise((r) => setTimeout(r, 0)));
}
const last = () => sent[sent.length - 1];

function setReminder(over: Partial<{ goalNotifications: boolean; dailyReminderTime: string }>) {
    useSettingsStore.setState((s) => ({ settings: { ...s.settings, ...over } }));
}

function setTodayMinutes(minutes: number) {
    useSettingsStore.setState((s) => ({
        stats: { ...s.stats, dailyGoal: 30, dailyActivity: [{ date: localDateKey(), minutes, booksRead: [] } as never] },
    }));
}

function returnToApp() {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    document.dispatchEvent(new Event("visibilitychange"));
}

let stop: (() => void) | null = null;

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 21, 9, 0, 0));
    sent.length = 0;
    inFlight = 0;
    maxInFlight = 0;
    failNext = 0;
    toast.mockClear();
    notifyIfGranted.mockClear();
    setReminder({ goalNotifications: true, dailyReminderTime: "20:00" });
    setTodayMinutes(0);
});
afterEach(() => {
    stop?.();
    stop = null;
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe("mobile reminder planner", () => {
    it("tells Android as soon as it starts", async () => {
        stop = startMobileReminderPlanner();
        await settle();
        expect(sent).toHaveLength(1);
        expect(last()).toMatchObject({ enabled: true, hour: 20, minute: 0, skipDate: null });
    });

    it("waits for the settings to load before telling Android anything", async () => {
        const hydrated = vi.spyOn(useSettingsStore.persist, "hasHydrated").mockReturnValue(false);
        let finish: (() => void) | undefined;
        vi.spyOn(useSettingsStore.persist, "onFinishHydration").mockImplementation((cb) => {
            finish = () => cb(useSettingsStore.getState());
            return () => undefined;
        });
        stop = startMobileReminderPlanner();
        await settle();
        expect(sent).toHaveLength(0);
        hydrated.mockReturnValue(true);
        finish!();
        await settle();
        expect(sent).toHaveLength(1);
    });

    it("follows a new reminder time", async () => {
        stop = startMobileReminderPlanner();
        await settle();
        setReminder({ dailyReminderTime: "06:45" });
        await settle();
        expect(last()).toMatchObject({ hour: 6, minute: 45, enabled: true });
    });

    it("sends one update at a time while the time is typed quickly, and the last value wins", async () => {
        stop = startMobileReminderPlanner();
        for (const time of ["2", "21", "21:", "21:3", "21:30", "21:35", "07:05"]) setReminder({ dailyReminderTime: time });
        await settle();
        expect(maxInFlight).toBe(1);
        expect(last()).toMatchObject({ hour: 7, minute: 5, enabled: true });
    });

    it("turns the reminder off and on with the setting", async () => {
        stop = startMobileReminderPlanner();
        await settle();
        setReminder({ goalNotifications: false });
        await settle();
        expect(last().enabled).toBe(false);
        setReminder({ goalNotifications: true });
        await settle();
        expect(last().enabled).toBe(true);
    });

    it("turns it off while the time is broken, and back on once it is fixed", async () => {
        stop = startMobileReminderPlanner();
        await settle();
        setReminder({ dailyReminderTime: "" });
        await settle();
        expect(last().enabled).toBe(false);
        setReminder({ dailyReminderTime: "21:00" });
        await settle();
        expect(last()).toMatchObject({ enabled: true, hour: 21 });
    });

    it("skips today the moment the goal is met", async () => {
        stop = startMobileReminderPlanner();
        await settle();
        setTodayMinutes(29);
        await settle();
        expect(last().skipDate).toBeNull();
        setTodayMinutes(30);
        await settle();
        expect(last().skipDate).toBe("2026-10-21");
    });

    it("does not send anything for reading progress that changes nothing", async () => {
        stop = startMobileReminderPlanner();
        await settle();
        for (const m of [1, 2, 3, 4, 5]) setTodayMinutes(m);
        await settle();
        expect(sent).toHaveLength(1);
    });

    it("updates on return to the app, so yesterday's skip does not carry into today", async () => {
        setTodayMinutes(30);
        stop = startMobileReminderPlanner();
        await settle();
        expect(last().skipDate).toBe("2026-10-21");
        // Next morning: yesterday's minutes are no longer today's.
        vi.setSystemTime(new Date(2026, 9, 22, 8, 0, 0));
        returnToApp();
        await settle();
        expect(last().skipDate).toBeNull();
    });

    it("updates when Settings asks, e.g. after notifications were allowed", async () => {
        stop = startMobileReminderPlanner();
        await settle();
        refreshScheduledReminders();
        await settle();
        expect(sent).toHaveLength(2);
    });

    it("tries again on return to the app after a failed update", async () => {
        failNext = 1;
        vi.spyOn(console, "warn").mockImplementation(() => undefined);
        stop = startMobileReminderPlanner();
        await settle();
        expect(sent).toHaveLength(0);
        returnToApp();
        await settle();
        expect(sent).toHaveLength(1);
    });

    it("tries again on the next settings change after a failed update, even an unrelated one", async () => {
        failNext = 1;
        vi.spyOn(console, "warn").mockImplementation(() => undefined);
        stop = startMobileReminderPlanner();
        await settle();
        setTodayMinutes(3);
        await settle();
        expect(sent).toHaveLength(1);
    });

    it("stops following changes once stopped", async () => {
        stop = startMobileReminderPlanner();
        await settle();
        stop();
        stop = null;
        setReminder({ dailyReminderTime: "05:00" });
        refreshScheduledReminders();
        returnToApp();
        await settle();
        expect(sent).toHaveLength(1);
    });
});

describe("useDailyGoalReminder on a phone", () => {
    it("hands the reminder to Android and never runs the in-app timer", async () => {
        (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
        vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ANDROID);
        const interval = vi.spyOn(window, "setInterval");
        vi.setSystemTime(new Date(2026, 9, 21, 20, 1, 0)); // inside the old in-app window

        function Probe() {
            useDailyGoalReminder();
            return null;
        }
        const host = document.createElement("div");
        const root: Root = createRoot(host);
        act(() => root.render(<Probe />));
        await settle();

        expect(interval).not.toHaveBeenCalled();
        expect(toast).not.toHaveBeenCalled();
        expect(notifyIfGranted).not.toHaveBeenCalled();
        expect(last()).toMatchObject({ enabled: true, hour: 20, minute: 0 });

        act(() => root.unmount());
    });
});
