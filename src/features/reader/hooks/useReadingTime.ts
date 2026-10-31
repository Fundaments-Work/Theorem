import { useCallback, useEffect, useRef } from "react";
import { isTauri } from "../../../core/lib/env";
import { queueReadingChunk } from "../../../core/lib/reading-records";
import { prepareReadingRhythm, recordReadingRhythm } from "../../../core/lib/reading-rhythm";
import { splitReadingInterval } from "../lib/reading-interval";
import { registerPrePersistFlush } from "../../../core/lib/persist-storage";
import { useSettingsStore, useLibraryStore } from "../../../core/store";
import type { DailyReadingActivity, ReadingStats } from "../../../core/types";
import { calculateWpm, computeExponentialMovingAverage } from "../lib/reading-time";
import { addLocalDays, localDateKey } from "../../../core/lib/date-keys";

interface UseReadingTimeOptions {
    currentBookId: string | undefined;
    addReadingTime: (bookId: string, minutes: number) => void;
    stats?: ReadingStats;
    updateStats?: (updates: Partial<ReadingStats>) => void;
    isTtsActive?: boolean;
}

async function notifyGoalMet(minutes: number) {
    const isVisible = typeof document !== "undefined" && !document.hidden;
    if (isVisible) {
        const { toast } = await import("sonner");
        toast.success(`Daily goal met! (${minutes} min)`);
    } else {
        const { notifyIfGranted } = await import("../../../core/lib/notifications");
        await notifyIfGranted("Goal Met!", `You've hit your daily reading goal of ${minutes} minutes!`);
    }
}

export function useReadingTime({
    currentBookId,
    addReadingTime = useLibraryStore.getState().addReadingTime,
    stats: propStats,
    updateStats: propUpdateStats,
    isTtsActive,
}: UseReadingTimeOptions) {
    const startedAtRef = useRef<number | null>(null);
    const accumulatedMsRef = useRef(new Map<string, number>());
    const startedMonotonicRef = useRef<number | null>(null);
    const readingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const updateStats = propUpdateStats ?? useSettingsStore.getState().updateStats;
    const statsRef = useRef(propStats ?? useSettingsStore.getState().stats);
    if (propStats) {
        statsRef.current = propStats;
    }

    const lastPageTurnTimeRef = useRef<number | null>(Date.now());
    const lastWordCountRef = useRef<number>(250);
    const isTtsActiveRef = useRef<boolean>(!!isTtsActive);
    isTtsActiveRef.current = !!isTtsActive;

    /**
     * Words on the page just turned to, sampled after the page settles. Only
     * sets the count used for the next WPM sample; it must not touch the turn
     * time (re-recording the turn here measured every page ~1s short).
     */
    const setCurrentPageWordCount = useCallback((wordsOnPage: number) => {
        if (Number.isFinite(wordsOnPage) && wordsOnPage > 20) lastWordCountRef.current = wordsOnPage;
    }, []);

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

        const currentAvg = useSettingsStore.getState().stats.averageReadingSpeed || 200;
        const newAvg = computeExponentialMovingAverage(currentAvg, instantWpm);

        if (newAvg !== currentAvg) {
            useSettingsStore.getState().updateStats({ averageReadingSpeed: newAvg });
        }
    }, []);

    useEffect(() => {
        if (!currentBookId) return;

        const source = crypto.randomUUID();
        const sourceSeconds = new Map<string, number>();
        if (useSettingsStore.getState().stats.rhythm) {
            void prepareReadingRhythm().catch(error => console.error("[reading] Progress engine unavailable", error));
        }
        const commitMinutes = (elapsedMinutes: number, today: string, silent = false) => {
            addReadingTime(currentBookId, elapsedMinutes);

            const currentStats = useSettingsStore.getState().stats;
            const existingActivity = currentStats.dailyActivity.find(a => a.date === today);
            const previousTodayMinutes = existingActivity?.minutes ?? 0;

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
            const todayStr = localDateKey();
            const yesterdayStr = localDateKey(addLocalDays(new Date(), -1));

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
                lastReadDate: [currentStats.lastReadDate ?? "", today].sort().pop(),
            });

            queueReadingChunk(today, elapsedMinutes, currentBookId);
            const seconds = (sourceSeconds.get(today) ?? 0) + elapsedMinutes * 60;
            sourceSeconds.set(today, seconds);
            void recordReadingRhythm(today, source, Math.min(86400, Math.floor(seconds)))
                .catch(error => console.error("[reading] Could not update reading rhythm", error));

            const todayActivity = newDailyActivity.find(a => a.date === today);
            const todayMinutes = todayActivity?.minutes ?? 0;
            // Only celebrate at the exact moment the threshold is crossed during active reading.
            // Exiting the reader or backgrounding must be completely silent, and never re-notify if goal was already met.
            const justCrossedGoal = today === localDateKey() && previousTodayMinutes < currentStats.dailyGoal && todayMinutes >= currentStats.dailyGoal;
            if (
                !silent &&
                justCrossedGoal &&
                useSettingsStore.getState().settings.goalNotifications &&
                currentStats.lastGoalNotifiedDate !== today
            ) {
                updateStats({ lastGoalNotifiedDate: today });
                notifyGoalMet(currentStats.dailyGoal);
            }
        };

        const flushReadingTime = (silent = false) => {
            if (startedAtRef.current !== null) {
                const now = Date.now();
                const elapsed = Math.max(0, performance.now() - (startedMonotonicRef.current ?? performance.now()));
                // A manual clock correction changes date assignment, never elapsed reading time.
                const intervalStart = Math.abs(now - startedAtRef.current - elapsed) <= 1000 ? startedAtRef.current : now - elapsed;
                for (const part of splitReadingInterval(intervalStart, now)) {
                    accumulatedMsRef.current.set(part.date, (accumulatedMsRef.current.get(part.date) ?? 0) + part.milliseconds);
                }
                startedAtRef.current = now;
                startedMonotonicRef.current = performance.now();
            }
            for (const [day, milliseconds] of accumulatedMsRef.current) {
                const elapsedMinutes = milliseconds / 60000;
                if (elapsedMinutes > 0) {
                    accumulatedMsRef.current.delete(day);
                    commitMinutes(elapsedMinutes, day, silent);
                }
            }
        };

        const pauseReadingTime = (silent = true) => {
            flushReadingTime(silent);
            if (readingIntervalRef.current) {
                clearInterval(readingIntervalRef.current);
                readingIntervalRef.current = null;
            }
            startedAtRef.current = null;
            startedMonotonicRef.current = null;
            lastPageTurnTimeRef.current = null;
        };

        const resumeReadingTime = () => {
            if (startedAtRef.current === null) {
                startedAtRef.current = Date.now();
                startedMonotonicRef.current = performance.now();
            }
            if (lastPageTurnTimeRef.current === null) {
                lastPageTurnTimeRef.current = Date.now();
            }
            if (!readingIntervalRef.current) {
                readingIntervalRef.current = setInterval(flushReadingTime, 60000);
            }
        };

        if (!document.hidden) resumeReadingTime();

        const handleVisibilityChange = () => {
            if (document.hidden) {
                pauseReadingTime(true);
            } else {
                resumeReadingTime();
            }
        };

        document.addEventListener('visibilitychange', handleVisibilityChange);
        const unregisterPreFlush = registerPrePersistFlush(() => flushReadingTime(true));

        let tauriUnlisten: Array<() => void> = [];
        if (isTauri()) {
            (async () => {
                const { listen } = await import('@tauri-apps/api/event');
                const unlistenPause = await listen('tauri://on-pause', () => {
                    pauseReadingTime(true);
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
            unregisterPreFlush();
            tauriUnlisten.forEach((fn) => fn());

            // Exiting the reader flushes time completely silently - never notify on book exit
            flushReadingTime(true);
        };
    }, [currentBookId, addReadingTime, updateStats]);

    return { recordPageTurn, setCurrentPageWordCount };
}
