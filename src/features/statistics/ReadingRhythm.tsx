import { useEffect, useState } from "react";
import { useSettingsStore, useUIStore } from "../../core/store";
import { readingRhythmProgress, setWeeklyReadingGoal, type RhythmProgress } from "../../core/lib/reading-rhythm";
import { Button } from "../../ui";

/** One compact view shared by Library, Statistics and goal settings. */
export function ReadingRhythm({ compact = false }: { compact?: boolean }) {
    const setRoute = useUIStore(s => s.setRoute);
    const rhythm = useSettingsStore(s => s.stats.rhythm);
    const hidden = useSettingsStore(s => s.settings.hideReadingMotivation);
    const updateSettings = useSettingsStore(s => s.updateSettings);
    const [progress, setProgress] = useState<RhythmProgress>();
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    const [attempt, setAttempt] = useState(0);
    const [today, setToday] = useState(() => new Date().toDateString());
    useEffect(() => {
        const refresh = () => setToday(new Date().toDateString());
        const interval = setInterval(refresh, 60_000);
        window.addEventListener("focus", refresh);
        return () => { clearInterval(interval); window.removeEventListener("focus", refresh); };
    }, []);
    useEffect(() => {
        if (!rhythm || (compact && hidden)) return;
        let cancelled = false;
        void readingRhythmProgress().then(value => { if (!cancelled) { setProgress(value); setError(""); } })
            .catch(() => { if (!cancelled) setError("Reading progress could not load. Try again."); });
        return () => { cancelled = true; };
    }, [rhythm, today, compact, hidden, attempt]);
    async function choose(days: number) {
        setBusy(true);
        try { await setWeeklyReadingGoal(days); setError(""); }
        catch { setError("Your reading goal could not be saved. Please try again."); }
        finally { setBusy(false); }
    }
    if (compact && hidden) return null;
    return <section aria-label="Reading rhythm" className="mb-4 border border-[var(--color-border)] p-4 text-sm text-[color:var(--color-text-secondary)]">
        {!rhythm ? <div className="flex flex-wrap items-center justify-between gap-3">
            <p>Build a reading rhythm. Start with 4 days a week.</p>
            <Button className="min-h-11" onClick={() => void choose(4)} disabled={busy}>Set a weekly goal</Button>
        </div> : progress ? <>
            <p className="text-[color:var(--color-text-primary)]">
                {progress.targetDays > 0 ? `${progress.qualifyingDays} of ${progress.targetDays} reading days this week${progress.qualifyingDays >= progress.targetDays ? " · Goal reached" : ""}` : "Weekly reading goal is off"}
            </p>
            <p className="mt-1 text-xs">{progress.weekStart} – {progress.weekEnd} · 5 minutes makes a reading day</p>
            {compact && <Button variant="ghost" className="mt-2 min-h-11" onClick={() => setRoute("statistics")}>View reading progress</Button>}
            {!compact && <>
                <p className="mt-4">Level {progress.level} · {progress.xp} lifetime XP</p>
                <progress aria-label="Progress to next reading level" value={progress.xp % 100} max={100} className="mt-2 h-2 w-full accent-[var(--color-accent)]" />
                <p className="mt-1 text-xs">{100 - progress.xp % 100} XP to level {progress.level + 1}. Earn 10 XP per reading day and 20 for reaching a weekly goal.</p>
                <label className="mt-4 flex flex-wrap items-center gap-3">
                    Reading days per week
                    <select aria-label="Reading days per week" value={progress.nextTargetDays} disabled={busy}
                        onChange={e => void choose(Number(e.target.value))}
                        className="ui-input min-h-11 w-auto">
                        <option value={0}>Off</option>
                        {[1,2,3,4,5,6,7].map(days => <option key={days} value={days}>{days} {days === 1 ? "day" : "days"}</option>)}
                    </select>
                </label>
                <p className="mt-2 text-xs">Changes start next Monday. Daily goals and streaks stay separate. Missed weeks never remove XP.</p>
            </>}
        </> : !error && <p role="status">Loading reading progress…</p>}
        {!compact && <label className="mt-4 flex min-h-11 items-center gap-3">
            <input type="checkbox" checked={!!hidden} onChange={e => updateSettings({ hideReadingMotivation: e.target.checked })} />
            Hide motivational progress in Library
        </label>}
        {error && <>
            <p role="alert" className="mt-2 text-[color:var(--color-error)]">{error}</p>
            {rhythm && <Button className="mt-2 min-h-11" onClick={() => setAttempt(value => value + 1)}>Retry</Button>}
        </>}
    </section>;
}
