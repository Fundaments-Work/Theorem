import { useEffect } from "react";
import { isTauri } from "../../../core/lib/env";
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

export function useDailyGoalReminder() {
    useEffect(() => {
        if (!isTauri()) return;

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
