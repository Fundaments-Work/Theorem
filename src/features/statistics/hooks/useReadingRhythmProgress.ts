import { useEffect, useState } from "react";
import { useSettingsStore } from "../../../core/store";
import { readingRhythmProgress, type RhythmProgress } from "../../../core/lib/reading-rhythm";

/** Presentation only: evaluating progress never changes a goal or awards data. */
export function useReadingRhythmProgress() {
    const rhythm = useSettingsStore(state => state.stats.rhythm);
    const [progress, setProgress] = useState<RhythmProgress>();
    const [error, setError] = useState(false);
    const [attempt, setAttempt] = useState(0);
    const [today, setToday] = useState(() => new Date().toDateString());
    useEffect(() => {
        const refresh = () => setToday(new Date().toDateString());
        const interval = setInterval(refresh, 60_000);
        window.addEventListener("focus", refresh);
        return () => { clearInterval(interval); window.removeEventListener("focus", refresh); };
    }, []);
    useEffect(() => {
        let cancelled = false;
        void readingRhythmProgress().then(value => {
            if (!cancelled) { setProgress(value); setError(false); }
        }).catch(() => { if (!cancelled) setError(true); });
        return () => { cancelled = true; };
    }, [rhythm, today, attempt]);
    return { progress, error, retry: () => setAttempt(value => value + 1) };
}
