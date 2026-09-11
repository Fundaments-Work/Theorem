import { useCallback, useEffect, useRef } from "react";
import { isTauri } from "../../../core/lib/env";
import { useSettingsStore } from "../../../core/store";
import type { DailyReadingActivity, ReadingStats } from "../../../core/types";
import { calculateWpm, computeExponentialMovingAverage } from "../lib/reading-time";

interface UseReadingTimeOptions {
    currentBookId: string | undefined;
    addReadingTime: (bookId: string, minutes: number) => void;
    stats: ReadingStats;
    updateStats: (updates: Partial<ReadingStats>) => void;
    isTtsActive?: boolean;
}

async function notifyGoalMet(minutes: number) {
    const { notifyIfGranted } = await import("../../../core/lib/notifications");
    await notifyIfGranted("Goal Met!", `You've hit your daily reading goal of ${minutes} minutes!`);
    const { toast } = await import("sonner");
    toast.success("Daily goal met!");
}

async function notifyGoalShortfall(shortfall: number) {
    const { notifyIfGranted } = await import("../../../core/lib/notifications");
    await notifyIfGranted(
        "Keep Going!",
        `You're ${shortfall} min short of your daily reading goal — keep going!`,
    );
    const { toast } = await import("sonner");
    toast(`${shortfall} min to go to reach your daily goal`);
}

export function useReadingTime({
    currentBookId,
    addReadingTime,
    stats,
    updateStats,
    isTtsActive,
}: UseReadingTimeOptions) {
    const startedAtRef = useRef<number | null>(null);
    const accumulatedMsRef = useRef(0);
    const readingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const statsRef = useRef(stats);
    const notifiedGoalDateRef = useRef<string>("");
    statsRef.current = stats;

    const lastPageTurnTimeRef = useRef<number | null>(Date.now());
    const lastWordCountRef = useRef<number>(250);
    const isTtsActiveRef = useRef<boolean>(!!isTtsActive);
    isTtsActiveRef.current = !!isTtsActive;

    const recordPageTurn = useCallback((wordsOnPage?: number) => {
        const now = Date.now();
        const lastTurn = lastPageTurnTimeRef.current;
        const wordsRead = lastWordCountRef.current;

        if (typeof wordsOnPage === "number" && wordsOnPage > 20) {
            lastWordCountRef.current = wordsOnPage;
        } else {
            lastWordCountRef.current = 250;
        }
        lastPageTurnTimeRef.current = now;

        // If immersion TTS is actively reading aloud, machine is narrating, don't contaminate human reading speed
        if (isTtsActiveRef.current) {
            return;
        }

        if (lastTurn === null) {
            return;
        }

        const dwellSeconds = (now - lastTurn) / 1000;
        const instantWpm = calculateWpm(wordsRead, dwellSeconds);
        if (instantWpm === null) {
            return;
        }

        const currentAvg = statsRef.current.averageReadingSpeed || 200;
        const newAvg = computeExponentialMovingAverage(currentAvg, instantWpm);

        if (newAvg !== currentAvg) {
            updateStats({ averageReadingSpeed: newAvg });
        }
    }, [updateStats]);

    useEffect(() => {
        if (!currentBookId) return;

        const commitMinutes = (elapsedMinutes: number) => {
            addReadingTime(currentBookId, elapsedMinutes);

            const currentStats = useSettingsStore.getState().stats;
            const today = new Date().toISOString().split('T')[0];
            const existingActivity = currentStats.dailyActivity.find(a => a.date === today);

            let newDailyActivity: DailyReadingActivity[];
            if (existingActivity) {
                newDailyActivity = currentStats.dailyActivity.map(a =>
                    a.date === today
                        ? { ...a, minutes: a.minutes + elapsedMinutes, booksRead: [...new Set([...a.booksRead, currentBookId])] }
                        : a
                );
            } else {
                newDailyActivity = [...currentStats.dailyActivity, {
                    date: today,
                    minutes: elapsedMinutes,
                    booksRead: [currentBookId],
                }];
            }

            if (newDailyActivity.length > 84) {
                newDailyActivity = newDailyActivity.slice(-84);
            }

            const sortedActivity = [...newDailyActivity].sort((a, b) =>
                new Date(b.date).getTime() - new Date(a.date).getTime()
            );

            let currentStreak = 0;
            const todayStr = new Date().toISOString().split('T')[0];
            const yesterdayStr = new Date(Date.now() - 86400000).toISOString().split('T')[0];

            const lastReadDate = sortedActivity[0]?.date;
            if (lastReadDate === todayStr || lastReadDate === yesterdayStr) {
                currentStreak = 1;
                for (let i = 1; i < sortedActivity.length; i++) {
                    const prevDate = new Date(sortedActivity[i - 1].date);
                    const currDate = new Date(sortedActivity[i].date);
                    const diffDays = (prevDate.getTime() - currDate.getTime()) / 86400000;
                    if (diffDays === 1) {
                        currentStreak++;
                    } else {
                        break;
                    }
                }
            }

            updateStats({
                totalReadingTime: currentStats.totalReadingTime + elapsedMinutes,
                dailyActivity: newDailyActivity,
                currentStreak,
                longestStreak: Math.max(currentStats.longestStreak, currentStreak),
                lastReadDate: today,
            });

            const todayActivity = newDailyActivity.find(a => a.date === today);
            const todayMinutes = todayActivity?.minutes ?? 0;
            if (
                todayMinutes >= currentStats.dailyGoal &&
                useSettingsStore.getState().settings.goalNotifications &&
                notifiedGoalDateRef.current !== today
            ) {
                notifiedGoalDateRef.current = today;
                notifyGoalMet(currentStats.dailyGoal);
            }
        };

        const flushReadingTime = () => {
            if (startedAtRef.current !== null) {
                const now = Date.now();
                accumulatedMsRef.current += now - startedAtRef.current;
                startedAtRef.current = now;
            }
            const elapsedMinutes = Math.floor(accumulatedMsRef.current / 60000);
            if (elapsedMinutes > 0) {
                accumulatedMsRef.current -= elapsedMinutes * 60000;
                commitMinutes(elapsedMinutes);
            }
        };

        const pauseReadingTime = () => {
            flushReadingTime();
            if (readingIntervalRef.current) {
                clearInterval(readingIntervalRef.current);
                readingIntervalRef.current = null;
            }
            startedAtRef.current = null;
            lastPageTurnTimeRef.current = null;
        };

        const resumeReadingTime = () => {
            if (startedAtRef.current === null) {
                startedAtRef.current = Date.now();
            }
            if (lastPageTurnTimeRef.current === null) {
                lastPageTurnTimeRef.current = Date.now();
            }
            if (!readingIntervalRef.current) {
                readingIntervalRef.current = setInterval(flushReadingTime, 60000);
            }
        };

        resumeReadingTime();

        const handleVisibilityChange = () => {
            if (document.hidden) {
                pauseReadingTime();
            } else {
                resumeReadingTime();
            }
        };

        document.addEventListener('visibilitychange', handleVisibilityChange);

        let tauriUnlisten: Array<() => void> = [];
        if (isTauri()) {
            (async () => {
                const { listen } = await import('@tauri-apps/api/event');
                const unlistenPause = await listen('tauri://on-pause', () => {
                    pauseReadingTime();
                });
                const unlistenResume = await listen('tauri://on-resume', () => {
                    resumeReadingTime();
                });
                tauriUnlisten = [unlistenPause, unlistenResume];
            })();
        }

        return () => {
            if (readingIntervalRef.current) {
                clearInterval(readingIntervalRef.current);
                readingIntervalRef.current = null;
            }
            document.removeEventListener('visibilitychange', handleVisibilityChange);
            tauriUnlisten.forEach((fn) => fn());

            flushReadingTime();

            const today = new Date().toISOString().split('T')[0];
            const todayActivity = useSettingsStore.getState().stats.dailyActivity.find(a => a.date === today);
            const todayMinutes = todayActivity?.minutes ?? 0;
            if (
                todayMinutes > 0 &&
                todayMinutes < useSettingsStore.getState().stats.dailyGoal &&
                useSettingsStore.getState().settings.goalNotifications &&
                notifiedGoalDateRef.current !== today
            ) {
                notifiedGoalDateRef.current = today;
                notifyGoalShortfall(useSettingsStore.getState().stats.dailyGoal - todayMinutes);
            }
        };
    }, [currentBookId, addReadingTime, updateStats]);

    return { recordPageTurn };
}
