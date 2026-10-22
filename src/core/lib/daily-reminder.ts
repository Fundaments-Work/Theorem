/**
 * Daily reading reminders on phones.
 *
 * A timer in the webview cannot remind anyone: Android pauses the page as soon as Theorem
 * leaves the screen and kills it when the app is swiped away. So on Android the reminder lives
 * in native code (`ReadingReminder.kt` in the mobile-folder-scan plugin): the system's alarm
 * service holds the next reminder, which posts the notification and schedules the following
 * day, and it is scheduled again after a reboot, an app update or a clock change.
 *
 * The app only tells Android what to do: on or off, the time, the text, and which day to skip
 * because its goal is already met. It does so whenever any of that could have changed (see
 * `startMobileReminderPlanner`).
 *
 * (tauri-plugin-notification's own scheduling is not used: in 2.6.0 the Android side stores
 * scheduled notifications as "null", so they are lost on reboot and `pending()` throws.)
 *
 * Desktop keeps the in-app check in `useDailyGoalReminder`.
 */

import { invoke } from "@tauri-apps/api/core";
import { localDateKey } from "./date-keys";

export const REMINDER_TITLE = "Time to read";

export function reminderBody(dailyGoal: number): string {
    return `Your daily reading goal is ${dailyGoal} minutes.`;
}

/** "HH:MM" (24-hour) → hours and minutes, or null when the setting is missing or malformed. */
export function parseReminderTime(value: string | undefined | null): { hours: number; minutes: number } | null {
    const match = /^(\d{1,2}):(\d{2})$/.exec((value ?? "").trim());
    if (!match) return null;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (hours > 23 || minutes > 59) return null;
    return { hours, minutes };
}

export interface ReminderSettings {
    enabled: boolean;
    time: string;
    dailyGoal: number;
    todayMinutes: number;
}

/** What Android needs to schedule the reminder (`ReminderConfig` in Rust and Kotlin). */
export interface ReminderConfig {
    enabled: boolean;
    hour: number;
    minute: number;
    title: string;
    body: string;
    /** The local day ("YYYY-MM-DD") with no reminder because its goal is met. */
    skipDate: string | null;
}

export function reminderConfig(settings: ReminderSettings, now: Date = new Date()): ReminderConfig {
    const parsed = parseReminderTime(settings.time);
    const dailyGoal = settings.dailyGoal > 0 ? settings.dailyGoal : 30;
    return {
        // A broken time turns the reminder off rather than guessing one.
        enabled: settings.enabled && parsed !== null,
        hour: parsed?.hours ?? 20,
        minute: parsed?.minutes ?? 0,
        title: REMINDER_TITLE,
        body: reminderBody(dailyGoal),
        skipDate: settings.todayMinutes >= dailyGoal ? localDateKey(now) : null,
    };
}

/** Sends the settings to Android, which replaces the scheduled reminder. */
export function configureReminder(config: ReminderConfig): Promise<void> {
    return invoke("configure_reading_reminder", { config });
}

export interface ReminderDeliveryStatus {
    /** False when the reader has turned Theorem's notifications off. */
    notificationsAllowed: boolean;
    /** False when Android may deliver reminders up to an hour late. */
    exactAlarms: boolean;
    /** True where the reader can allow exact reminders in system settings (Android 12+). */
    canRequestExactAlarms: boolean;
    /** When the next reminder is due, if one is scheduled. */
    nextReminderAt: Date | null;
}

export async function reminderDeliveryStatus(): Promise<ReminderDeliveryStatus> {
    const [notificationsAllowed, status] = await Promise.all([
        import("@tauri-apps/plugin-notification").then((mod) => mod.isPermissionGranted()).catch(() => false),
        invoke<{ exactAlarms: boolean; canRequestExactAlarms: boolean; nextReminderAt?: number | null }>("reminder_status").catch(() => ({
            exactAlarms: true,
            canRequestExactAlarms: false,
            nextReminderAt: null,
        })),
    ]);
    return {
        notificationsAllowed,
        exactAlarms: status.exactAlarms,
        canRequestExactAlarms: status.canRequestExactAlarms,
        nextReminderAt: typeof status.nextReminderAt === "number" ? new Date(status.nextReminderAt) : null,
    };
}

export function openExactAlarmSettings(): Promise<void> {
    return invoke("open_exact_alarm_settings");
}

export function openNotificationSettings(): Promise<void> {
    return invoke("open_notification_settings");
}
