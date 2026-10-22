import { useCallback, useEffect, useState } from "react";
import {
    openExactAlarmSettings,
    openNotificationSettings,
    reminderDeliveryStatus,
    type ReminderDeliveryStatus,
} from "../../core/lib/daily-reminder";
import { requestNotificationPermission } from "../../core/lib/notifications";
import { REMINDER_CONFIGURED_EVENT, refreshScheduledReminders } from "../reader/hooks/useDailyGoalReminder";

/**
 * Phones only: says when the daily reminder cannot reach the reader, or may come late, and
 * offers the one tap that fixes it. Otherwise it says when the next reminder is due.
 */
export function ReminderDeliveryNotice({ enabled }: { enabled: boolean }) {
    const [status, setStatus] = useState<ReminderDeliveryStatus | null>(null);

    const refresh = useCallback(async () => {
        try {
            setStatus(await reminderDeliveryStatus());
        } catch {
            setStatus(null);
        }
    }, []);

    useEffect(() => {
        void refresh();
        // The reader comes back from system settings to this page.
        const onVisibility = () => {
            if (!document.hidden) void refresh();
        };
        const onConfigured = () => void refresh();
        document.addEventListener("visibilitychange", onVisibility);
        window.addEventListener(REMINDER_CONFIGURED_EVENT, onConfigured);
        return () => {
            document.removeEventListener("visibilitychange", onVisibility);
            window.removeEventListener(REMINDER_CONFIGURED_EVENT, onConfigured);
        };
    }, [refresh]);

    if (!enabled || !status) return null;

    if (!status.notificationsAllowed) {
        return (
            <Notice
                text="Notifications are off for Theorem, so the reminder cannot appear."
                action="Allow notifications"
                onAction={async () => {
                    const result = await requestNotificationPermission();
                    // Once refused, Android stops asking; only its settings page can turn it on.
                    if (result !== "granted") await openNotificationSettings();
                    await refresh();
                    refreshScheduledReminders();
                }}
            />
        );
    }

    if (!status.exactAlarms && status.canRequestExactAlarms) {
        return (
            <Notice
                text="Android may deliver the reminder up to an hour late."
                action="Remind me on time"
                onAction={() => openExactAlarmSettings()}
            />
        );
    }

    if (status.nextReminderAt) {
        return (
            <p data-reminder-next className="text-xs text-[color:var(--color-text-muted)]">
                Next reminder: {formatNextReminder(status.nextReminderAt)}
            </p>
        );
    }

    return null;
}

export function formatNextReminder(at: Date): string {
    return at.toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

function Notice({ text, action, onAction }: { text: string; action: string; onAction: () => Promise<void> }) {
    return (
        <div
            role="status"
            data-reminder-notice
            className="flex flex-wrap items-center justify-between gap-3 border border-[var(--color-border)] px-3 py-2"
        >
            <p className="text-xs leading-relaxed text-[color:var(--color-text-secondary)]">{text}</p>
            <button
                type="button"
                className="text-xs text-[color:var(--color-accent)] transition-opacity duration-200 hover:opacity-80"
                onClick={() => void onAction().catch(() => undefined)}
            >
                {action}
            </button>
        </div>
    );
}
