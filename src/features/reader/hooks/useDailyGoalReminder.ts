import { useEffect } from "react";
import { isTauri, isTauriMobile } from "../../../core/lib/env";
import { useSettingsStore } from "../../../core/store";
import { localDateKey } from "../../../core/lib/date-keys";

async function sendReminder(shortfall: number, totalGoal: number) {
    const msg = shortfall >= totalGoal
        ? `Time for your daily reading! Your goal is ${totalGoal} minutes today.`
        : `You're ${shortfall} min short of your daily reading goal — keep going!`;
    const isVisible = typeof document !== "undefined" && !document.hidden;
    if (isVisible) {
        const { toast } = await import("sonner");
        toast(msg);
    } else {
        const { notifyIfGranted } = await import("../../../core/lib/notifications");
        await notifyIfGranted("Reading Goal Reminder", msg);
    }
}

export function isReminderTime(reminderSetting: string, now = new Date()): boolean {
    if (!reminderSetting) return false;
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    const [h, m] = reminderSetting.split(":").map(Number);
    if (isNaN(h) || isNaN(m)) return false;
    const targetMinutes = h * 60 + m;
    // Trigger if within 30 minutes after target time, or within 5 minutes before
    return currentMinutes >= targetMinutes - 5 && currentMinutes <= targetMinutes + 30;
}

/** What the scheduled reminders depend on; the plan is redone only when this changes. */
function reminderInputs() {
    const { settings, stats } = useSettingsStore.getState();
    const today = localDateKey();
    const dailyGoal = stats.dailyGoal || 30;
    const todayMinutes = stats.dailyActivity.find((a) => a.date === today)?.minutes ?? 0;
    return {
        reminder: {
            enabled: settings.goalNotifications,
            time: settings.dailyReminderTime,
            dailyGoal,
            todayMinutes,
        },
        key: [settings.goalNotifications, settings.dailyReminderTime, dailyGoal, todayMinutes >= dailyGoal, today].join("|"),
    };
}

/**
 * Phones: keep Android's scheduled reminder in step with the settings (see
 * `core/lib/daily-reminder.ts`). Sends one update at a time, so rapid changes (typing a time)
 * arrive in order and the last one wins.
 */
/** Fired after Android has the new reminder settings, so Settings can show the next one. */
export const REMINDER_CONFIGURED_EVENT = "theorem:reminder-configured";

let activeReplan: ((force?: boolean) => void) | null = null;

/** Re-plans now, e.g. after the reader allowed notifications from Settings. */
export function refreshScheduledReminders(): void {
    activeReplan?.(true);
}

export function startMobileReminderPlanner(): () => void {
    let lastKey: string | null = null;
    let queue: Promise<unknown> = Promise.resolve();
    let disposed = false;

    const replan = (force = false) => {
        if (disposed || !useSettingsStore.persist.hasHydrated()) return;
        const { key } = reminderInputs();
        if (!force && key === lastKey) return;
        lastKey = key;
        queue = queue
            .then(async () => {
                if (disposed) return;
                const { configureReminder, reminderConfig } = await import("../../../core/lib/daily-reminder");
                // Read the settings now, not when queued, so the last change always wins.
                await configureReminder(reminderConfig(reminderInputs().reminder));
                window.dispatchEvent(new Event(REMINDER_CONFIGURED_EVENT));
            })
            .catch((error) => {
                // Try again on the next change or return to the app.
                lastKey = null;
                if (import.meta.env.DEV) console.warn("[reminders] could not schedule", error);
            });
    };

    const onVisibility = () => {
        // Coming back may follow a permission change in system settings or a new day.
        if (typeof document !== "undefined" && !document.hidden) replan(true);
    };

    activeReplan = replan;
    replan(true);
    const unsubscribe = useSettingsStore.subscribe(() => replan());
    const unsubscribeHydration = useSettingsStore.persist.onFinishHydration(() => replan(true));
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
        disposed = true;
        if (activeReplan === replan) activeReplan = null;
        unsubscribe();
        unsubscribeHydration();
        document.removeEventListener("visibilitychange", onVisibility);
    };
}

export function useDailyGoalReminder() {
    useEffect(() => {
        if (!isTauri()) return;
        // A webview timer cannot run while a phone has the app in the background; the system
        // schedules the reminders instead.
        if (isTauriMobile()) return startMobileReminderPlanner();

        const checkReminder = async () => {
            try {
                if (!useSettingsStore.persist.hasHydrated()) return;
                const { settings, stats, updateStats } = useSettingsStore.getState();
                if (!settings.goalNotifications) return;

                const today = localDateKey();
                if (stats.lastDailyReminderDate === today) return;

                if (!isReminderTime(settings.dailyReminderTime)) return;

                const todayActivity = stats.dailyActivity.find((a) => a.date === today);
                const todayMinutes = todayActivity?.minutes ?? 0;
                const dailyGoal = stats.dailyGoal || 30;

                if (todayMinutes < dailyGoal) {
                    updateStats({ lastDailyReminderDate: today });
                    const shortfall = dailyGoal - todayMinutes;
                    await sendReminder(shortfall, dailyGoal);
                }
            } catch {
                // Silently ignore errors
            }
        };

        // Check immediately on mount and then every 60 seconds
        void checkReminder();
        const intervalId = setInterval(() => {
            void checkReminder();
        }, 60 * 1000);

        return () => clearInterval(intervalId);
    }, []);
}
