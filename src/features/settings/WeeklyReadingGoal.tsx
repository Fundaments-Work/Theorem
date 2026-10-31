import { Dropdown } from "../../ui/Dropdown";
import { RefreshCw } from "lucide-react";
import { IconButton } from "../../ui/IconButton";
import { useState } from "react";
import { setWeeklyReadingGoal } from "../../core/lib/reading-rhythm";
import { useReadingRhythmProgress } from "../statistics/hooks/useReadingRhythmProgress";

export function WeeklyReadingGoal() {
    const { progress, error, retry } = useReadingRhythmProgress();
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState(false);
    async function choose(days: number) {
        setSaving(true);
        try { await setWeeklyReadingGoal(days); setSaveError(false); retry(); }
        catch { setSaveError(true); }
        finally { setSaving(false); }
    }
    return <div className="mb-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
            <label htmlFor="weekly-reading-days" className="text-sm text-[color:var(--color-text-primary)]">Reading days per week</label>
            <Dropdown id="weekly-reading-days" aria-label="Reading days per week" value={String(progress?.nextTargetDays ?? 0)} disabled={saving || !progress} onChange={value => void choose(Number(value))} className="min-h-11 w-auto" options={[
                { value: "0", label: "Off" },
                ...[1, 2, 3, 4, 5, 6, 7].map(days => ({ value: String(days), label: `${days} ${days === 1 ? "day" : "days"}` })),
            ]} />
        </div>
        <p className="mt-1 text-xs text-[color:var(--color-text-muted)]">{progress && progress.targetDays !== progress.nextTargetDays
                ? `This week: ${progress.targetDays === 0 ? "Off" : `${progress.targetDays} ${progress.targetDays === 1 ? "day" : "days"}`}. Next Monday: ${progress.nextTargetDays === 0 ? "Off" : `${progress.nextTargetDays} ${progress.nextTargetDays === 1 ? "day" : "days"}`}.`
                : "5 min counts as a day. Goal changes start next Monday."}</p>
        {(error || saveError) && <div className="mt-2 flex items-center gap-2"><p role="alert" className="text-xs text-[color:var(--color-error)]">Reading goal unavailable.</p><IconButton label="Retry reading goal" icon={<RefreshCw aria-hidden="true" className="h-4 w-4" />} onClick={() => { setSaveError(false); retry(); }} /></div>}
    </div>;
}
