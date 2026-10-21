/**
 * On phones the daily reminder is kept by Android (ReadingReminder.kt), so it fires with
 * Theorem closed. The app's part is to work out what Android should do (on or off, time, text,
 * which day to skip) and send it; these tests cover that part.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
const isPermissionGranted = vi.fn();
vi.mock("@tauri-apps/plugin-notification", () => ({ isPermissionGranted: () => isPermissionGranted() }));

import {
    REMINDER_TITLE,
    configureReminder,
    parseReminderTime,
    reminderBody,
    reminderConfig,
    reminderDeliveryStatus,
    type ReminderSettings,
} from "../src/core/lib/daily-reminder";

const settings = (over: Partial<ReminderSettings> = {}): ReminderSettings => ({
    enabled: true,
    time: "20:00",
    dailyGoal: 30,
    todayMinutes: 0,
    ...over,
});
const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min, 0, 0);

beforeEach(() => {
    invoke.mockReset();
    isPermissionGranted.mockReset();
});

describe("reminder time setting", () => {
    it.each([
        ["20:00", { hours: 20, minutes: 0 }],
        ["7:05", { hours: 7, minutes: 5 }],
        [" 06:30 ", { hours: 6, minutes: 30 }],
        ["00:00", { hours: 0, minutes: 0 }],
        ["23:59", { hours: 23, minutes: 59 }],
    ])("reads %j", (value, expected) => {
        expect(parseReminderTime(value)).toEqual(expected);
    });

    it.each(["", "24:00", "12:60", "20", "20:0", "20:00:00", "ab:cd", "-1:00", "8 pm"])("rejects %j", (value) => {
        expect(parseReminderTime(value)).toBeNull();
    });

    it("rejects a missing setting", () => {
        expect(parseReminderTime(undefined)).toBeNull();
        expect(parseReminderTime(null)).toBeNull();
    });
});

describe("what Android is told", () => {
    const now = at(2026, 10, 21, 9);

    it("passes the time and the goal in the text", () => {
        expect(reminderConfig(settings({ time: "07:45", dailyGoal: 45 }), now)).toEqual({
            enabled: true,
            hour: 7,
            minute: 45,
            title: REMINDER_TITLE,
            body: reminderBody(45),
            skipDate: null,
        });
    });

    it("skips today once today's goal is met, and only then", () => {
        expect(reminderConfig(settings({ todayMinutes: 29 }), now).skipDate).toBeNull();
        expect(reminderConfig(settings({ todayMinutes: 30 }), now).skipDate).toBe("2026-10-21");
        expect(reminderConfig(settings({ todayMinutes: 300 }), now).skipDate).toBe("2026-10-21");
    });

    it("treats a missing goal as the default 30 minutes", () => {
        const config = reminderConfig(settings({ dailyGoal: 0, todayMinutes: 29 }), now);
        expect(config.body).toBe(reminderBody(30));
        expect(config.skipDate).toBeNull();
    });

    it("turns the reminder off rather than guessing a broken time", () => {
        for (const time of ["", "25:00", "nonsense"]) {
            expect(reminderConfig(settings({ time }), now).enabled).toBe(false);
        }
    });

    it("stays off when the reader turned reminders off", () => {
        expect(reminderConfig(settings({ enabled: false }), now).enabled).toBe(false);
    });

    it("handles midnight and the last minute of the day", () => {
        expect(reminderConfig(settings({ time: "00:00" }), now)).toMatchObject({ hour: 0, minute: 0, enabled: true });
        expect(reminderConfig(settings({ time: "23:59" }), now)).toMatchObject({ hour: 23, minute: 59, enabled: true });
    });

    describe("in a time zone far from UTC", () => {
        const original = process.env.TZ;
        beforeEach(() => {
            process.env.TZ = "Asia/Kathmandu";
        });
        afterEach(() => {
            // Assigning undefined would set the string "undefined", which Node reads as UTC.
            if (original === undefined) delete process.env.TZ;
            else process.env.TZ = original;
        });

        it("skips the reader's local day, not the UTC one", () => {
            // 00:30 on the 22nd in Kathmandu is still the 21st in UTC.
            const config = reminderConfig(settings({ todayMinutes: 30 }), new Date(Date.UTC(2026, 9, 21, 18, 45)));
            expect(config.skipDate).toBe("2026-10-22");
        });
    });
});

describe("sending it to Android", () => {
    it("uses the configure command with the whole config", async () => {
        invoke.mockResolvedValue(undefined);
        const config = reminderConfig(settings(), at(2026, 10, 21, 9));
        await configureReminder(config);
        expect(invoke).toHaveBeenCalledWith("configure_reading_reminder", { config });
    });

    it("lets a failure reach the caller, so it can try again", async () => {
        invoke.mockRejectedValue(new Error("plugin not ready"));
        await expect(configureReminder(reminderConfig(settings()))).rejects.toThrow("plugin not ready");
    });
});

describe("delivery status for Settings", () => {
    it("reports permission, exact alarms and the next reminder", async () => {
        isPermissionGranted.mockResolvedValue(true);
        invoke.mockResolvedValue({ exactAlarms: false, canRequestExactAlarms: true, nextReminderAt: 1792678500000 });
        expect(await reminderDeliveryStatus()).toEqual({
            notificationsAllowed: true,
            exactAlarms: false,
            canRequestExactAlarms: true,
            nextReminderAt: new Date(1792678500000),
        });
    });

    it("has no next reminder when Android reports none", async () => {
        isPermissionGranted.mockResolvedValue(true);
        invoke.mockResolvedValue({ exactAlarms: true, canRequestExactAlarms: true });
        expect((await reminderDeliveryStatus()).nextReminderAt).toBeNull();
    });

    it("assumes nothing is wrong with timing when the status cannot be read, but not that notifications are allowed", async () => {
        isPermissionGranted.mockRejectedValue(new Error("no plugin"));
        invoke.mockRejectedValue(new Error("no command"));
        expect(await reminderDeliveryStatus()).toEqual({
            notificationsAllowed: false,
            exactAlarms: true,
            canRequestExactAlarms: false,
            nextReminderAt: null,
        });
    });
});
