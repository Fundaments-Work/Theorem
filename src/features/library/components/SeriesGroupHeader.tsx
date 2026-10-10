import { Layers } from "lucide-react";
import type { Book } from "../../../core/types";
import { isBookMarkedRead } from "../../../core/lib/utils";

export interface SeriesGroupHeaderProps {
    seriesName: string;
    group: Book[];
}

/**
 * Header row for a series group in a shelf.
 *
 * Deliberately contains **no interactive controls**. The Continue button and the
 * per-group edit pencil used to live here and both disturbed the shelves scroll
 * anchor: Continue is conditional, so finishing the last unread volume removed
 * it and collapsed the row, shifting every card below it; the pencil was a
 * duplicate entry point to the AssignSeriesModal that the shelf header already
 * opens. Continue is now rendered by the caller as a separate row beneath this
 * header (see SeriesGroupContinue in Shelves.tsx).
 *
 * With nothing conditional left, this row's height is a pure function of its
 * text, so it can never reflow as reading progress changes (#128).
 */
export function SeriesGroupHeader({
    seriesName,
    group,
}: SeriesGroupHeaderProps) {
    const completedCount = group.filter(isBookMarkedRead).length;
    const isAllCompleted = group.length > 0 && completedCount === group.length;
    const completionPercent = group.length > 0
        ? Math.round((completedCount / group.length) * 100)
        : 0;

    return (
        <div className="flex items-center gap-2.5 min-w-0 border-b border-[var(--color-border)] pb-2">
            <Layers className="w-4 h-4 text-[color:var(--color-accent)] shrink-0" />
            <h2 className="text-sm font-bold uppercase tracking-widest text-[color:var(--color-text-primary)] truncate">
                {seriesName}
            </h2>
            <span className="text-xs text-[color:var(--color-text-muted)] shrink-0">
                ({group.length} {group.length === 1 ? "vol." : "vols."})
            </span>
            {isAllCompleted ? (
                <span className="px-2 py-0.5 text-[10px] font-black uppercase tracking-wider bg-[var(--color-accent)] text-[var(--color-accent-contrast)] shrink-0">
                    Completed
                </span>
            ) : (
                <span className="text-[11px] font-mono text-[color:var(--color-text-muted)] shrink-0">
                    {completedCount}/{group.length} read ({completionPercent}%)
                </span>
            )}
        </div>
    );
}