import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isReminderTime } from "../src/features/reader/hooks/useDailyGoalReminder";

function readSource(relativePath: string): string {
    return readFileSync(resolve(__dirname, "..", relativePath), "utf-8");
}

describe("Daily Goal Reminder — Time Matching", () => {
    it("matches exact reminder time", () => {
        const time = new Date(2026, 8, 11, 20, 0, 0); // 20:00
        expect(isReminderTime("20:00", time)).toBe(true);
    });

    it("matches within 5 minutes before reminder time", () => {
        const time = new Date(2026, 8, 11, 19, 57, 0); // 19:57
        expect(isReminderTime("20:00", time)).toBe(true);
    });

    it("matches within 30 minutes after reminder time", () => {
        const time = new Date(2026, 8, 11, 20, 25, 0); // 20:25
        expect(isReminderTime("20:00", time)).toBe(true);
    });

    it("does not match outside the time window", () => {
        const early = new Date(2026, 8, 11, 19, 50, 0); // 19:50 (10 min before)
        expect(isReminderTime("20:00", early)).toBe(false);

        const late = new Date(2026, 8, 11, 20, 35, 0); // 20:35 (35 min after)
        expect(isReminderTime("20:00", late)).toBe(false);

        const morning = new Date(2026, 8, 11, 8, 0, 0); // 08:00
        expect(isReminderTime("20:00", morning)).toBe(false);
    });

    it("handles invalid or empty strings gracefully", () => {
        const time = new Date(2026, 8, 11, 20, 0, 0);
        expect(isReminderTime("", time)).toBe(false);
        expect(isReminderTime("invalid", time)).toBe(false);
    });
});

describe("Notification Deduplication & Silent Exit Rules", () => {
    it("useReadingTime does NOT contain notifyGoalShortfall or book-close shortfall alerts", () => {
        const source = readSource("src/features/reader/hooks/useReadingTime.ts");
        expect(source).not.toContain("notifyGoalShortfall");
        expect(source).not.toContain("min short");
    });

    it("useReadingTime checks lastGoalNotifiedDate !== today before firing celebration", () => {
        const source = readSource("src/features/reader/hooks/useReadingTime.ts");
        expect(source).toContain("currentStats.lastGoalNotifiedDate !== today");
        expect(source).toContain("updateStats({ lastGoalNotifiedDate: today })");
    });

    it("useDailyGoalReminder checks lastDailyReminderDate === today before firing", () => {
        const source = readSource("src/features/reader/hooks/useDailyGoalReminder.ts");
        expect(source).toContain("if (stats.lastDailyReminderDate === today) return;");
        expect(source).toContain("updateStats({ lastDailyReminderDate: today });");
    });

    it("App.tsx mounts useDailyGoalReminder globally", () => {
        const appSource = readSource("src/App.tsx");
        expect(appSource).toContain("useDailyGoalReminder()");
    });

    it("Reader.tsx does NOT duplicate useDailyGoalReminder", () => {
        const readerSource = readSource("src/features/reader/Reader.tsx");
        expect(readerSource).not.toContain("useDailyGoalReminder");
    });
});
