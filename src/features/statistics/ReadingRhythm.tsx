import { Flag, RefreshCw, Shield, Zap } from "lucide-react";
import { IconButton } from "../../ui/IconButton";
import { useReadingRhythmProgress } from "./hooks/useReadingRhythmProgress";

/** A read-only level journey; configuration belongs in Settings. */
export function ReadingRhythm() {
    const { progress, error, retry } = useReadingRhythmProgress();
    if (error) return <section aria-label="Reading journey" className="mb-6 flex items-center gap-2 text-[color:var(--color-text-muted)]">
        <span role="alert" className="sr-only">Reading progress could not load.</span>
        <IconButton label="Retry reading progress" icon={<RefreshCw aria-hidden="true" className="h-4 w-4" />} onClick={retry} />
    </section>;
    if (!progress) return <div role="status" aria-label="Loading reading journey" className="mb-6 h-20" />;
    const earned = progress.xp % 100;
    return <section aria-label="Reading journey" className="mb-6 flex items-center gap-4 border border-[var(--color-border)] px-4 py-3">
        <div role="img" aria-label={`Level ${progress.level}`} title={`Level ${progress.level}`} className="relative flex h-12 w-10 shrink-0 items-center justify-center text-[color:var(--color-accent)]">
            <Shield aria-hidden="true" className="absolute inset-0 h-full w-full" strokeWidth={1} />
            <span aria-hidden="true" className="pb-0.5 font-mono text-base">{progress.level}</span>
        </div>
        <div className="min-w-0 flex-1">
            <div className="mb-2 flex items-center justify-between gap-3 text-xs text-[color:var(--color-text-secondary)]">
                <span aria-label={`${progress.xp} lifetime XP`} title={`${earned} / 100 XP to level ${progress.level + 1}`} className="inline-flex items-center gap-1.5">
                    <Zap aria-hidden="true" className="h-3.5 w-3.5" />{progress.xp} XP
                </span>
                {progress.targetDays > 0 && <span aria-label={`${progress.qualifyingDays} of ${progress.targetDays} reading days this week`} title={`Read on ${progress.qualifyingDays} days this week · Goal: ${progress.targetDays} days`} className="inline-flex items-center gap-1.5">
                    <Flag aria-hidden="true" className="h-3.5 w-3.5" />{progress.qualifyingDays} {progress.qualifyingDays === 1 ? "day" : "days"} · goal {progress.targetDays}
                </span>}
            </div>
            <div role="progressbar" aria-label={`XP to level ${progress.level + 1}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={earned} aria-valuetext={`${earned} of 100 XP`} className="flex gap-1">
                {Array.from({ length: 10 }, (_, index) => <span key={index} aria-hidden="true" className="h-1.5 flex-1 overflow-hidden bg-[var(--color-surface-muted)]">
                    <span className="block h-full bg-[var(--color-accent)]" style={{ width: `${Math.max(0, Math.min(100, (earned - index * 10) * 10))}%` }} />
                </span>)}
            </div>
        </div>
        <div role="img" aria-label={`Next level ${progress.level + 1}`} title={`Next level ${progress.level + 1}`} className="relative flex h-12 w-10 shrink-0 items-center justify-center text-[color:var(--color-text-muted)]">
            <Shield aria-hidden="true" className="absolute inset-0 h-full w-full" strokeWidth={1} />
            <span aria-hidden="true" className="pb-0.5 font-mono text-base">{progress.level + 1}</span>
        </div>
    </section>;
}
