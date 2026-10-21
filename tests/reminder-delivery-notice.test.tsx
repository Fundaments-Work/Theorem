// @vitest-environment jsdom
/**
 * Settings on a phone says why the daily reminder cannot arrive or may be late, with the one
 * tap that fixes it, and otherwise when the next reminder is due.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReminderDeliveryStatus } from "../src/core/lib/daily-reminder";

let status: ReminderDeliveryStatus;
const openExactAlarmSettings = vi.fn(async () => undefined);
const openNotificationSettings = vi.fn(async () => undefined);
vi.mock("../src/core/lib/daily-reminder", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../src/core/lib/daily-reminder")>()),
    reminderDeliveryStatus: async () => status,
    openExactAlarmSettings: () => openExactAlarmSettings(),
    openNotificationSettings: () => openNotificationSettings(),
}));
const requestNotificationPermission = vi.fn();
vi.mock("../src/core/lib/notifications", () => ({ requestNotificationPermission: () => requestNotificationPermission() }));
const refreshScheduledReminders = vi.fn();
vi.mock("../src/features/reader/hooks/useDailyGoalReminder", () => ({
    REMINDER_CONFIGURED_EVENT: "theorem:reminder-configured",
    refreshScheduledReminders: () => refreshScheduledReminders(),
}));

import { ReminderDeliveryNotice, formatNextReminder } from "../src/features/settings/ReminderDeliveryNotice";

const NEXT = new Date(2026, 9, 22, 20, 0);
const ok: ReminderDeliveryStatus = { notificationsAllowed: true, exactAlarms: true, canRequestExactAlarms: true, nextReminderAt: NEXT };

let host: HTMLDivElement;
let root: Root;
async function render(enabled = true) {
    await act(async () => root.render(<ReminderDeliveryNotice enabled={enabled} />));
    await act(async () => await new Promise((r) => setTimeout(r, 0)));
}
const button = () => host.querySelector("button") as HTMLButtonElement | null;

beforeEach(() => {
    vi.clearAllMocks();
    status = { ...ok };
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
});

describe("reminder delivery notice", () => {
    it("shows when the next reminder is due when all is well", async () => {
        await render();
        expect(host.querySelector("[data-reminder-next]")?.textContent).toBe(`Next reminder: ${formatNextReminder(NEXT)}`);
        expect(button()).toBeNull();
    });

    it("shows nothing while reminders are off", async () => {
        await render(false);
        expect(host.textContent).toBe("");
    });

    it("offers exact reminders when Android may be an hour late", async () => {
        status = { ...ok, exactAlarms: false };
        await render();
        expect(host.textContent).toContain("up to an hour late");
        expect(button()?.textContent).toBe("Remind me on time");
        await act(async () => button()!.click());
        expect(openExactAlarmSettings).toHaveBeenCalledTimes(1);
    });

    it("says nothing about exact timing where it cannot be requested (Android 11 and older)", async () => {
        status = { ...ok, exactAlarms: false, canRequestExactAlarms: false };
        await render();
        expect(host.textContent).not.toContain("hour late");
    });

    it("asks for notifications first, and re-schedules once allowed", async () => {
        status = { ...ok, notificationsAllowed: false, exactAlarms: false };
        requestNotificationPermission.mockResolvedValue("granted");
        await render();
        expect(host.textContent).toContain("Notifications are off");
        expect(button()?.textContent).toBe("Allow notifications");
        await act(async () => button()!.click());
        expect(requestNotificationPermission).toHaveBeenCalledTimes(1);
        expect(openNotificationSettings).not.toHaveBeenCalled();
        expect(refreshScheduledReminders).toHaveBeenCalledTimes(1);
    });

    it("opens the system settings when Android no longer shows the prompt", async () => {
        status = { ...ok, notificationsAllowed: false };
        requestNotificationPermission.mockResolvedValue("denied");
        await render();
        await act(async () => button()!.click());
        expect(openNotificationSettings).toHaveBeenCalledTimes(1);
    });

    it("updates after Android gets new settings and on return from system settings", async () => {
        status = { ...ok, exactAlarms: false };
        await render();
        expect(button()).not.toBeNull();
        status = { ...ok };
        await act(async () => {
            Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
            document.dispatchEvent(new Event("visibilitychange"));
            await new Promise((r) => setTimeout(r, 0));
        });
        expect(button()).toBeNull();
        status = { ...ok, nextReminderAt: new Date(2026, 9, 22, 6, 30) };
        await act(async () => {
            window.dispatchEvent(new Event("theorem:reminder-configured"));
            await new Promise((r) => setTimeout(r, 0));
        });
        expect(host.textContent).toContain(formatNextReminder(new Date(2026, 9, 22, 6, 30)));
    });
});
