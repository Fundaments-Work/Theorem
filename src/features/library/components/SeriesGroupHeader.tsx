import { Layers, Play } from "lucide-react";
import type { Book } from "../../../core/types";
import { isBookMarkedRead } from "../../../core/lib/utils";

export interface SeriesGroupHeaderProps {
    seriesName: string;
    group: Book[];
    /** Opens the next unread volume. */
    onContinue: (book: Book) => void;
}

/**
 * Header row for a series group in a shelf.
 *
 * The per-group Edit pencil was removed: the shelf header already carries a
 * "Create / Manage Series from Shelf" button that opens the same
 * AssignSeriesModal, so the row carried a second entry point that also made the
 * header reflow. What is left — the Continue button — appears and disappears as
 * volumes are read, so the row must keep a constant height (see the fixed
 * header box below) or the shelves scroll anchor jumps every time reading
 * progress changes (#128).
 */
export function SeriesGroupHeader({
    seriesName,
    group,
    onContinue,
}: SeriesGroupHeaderProps) {
    const completedCount = group.filter(isBookMarkedRead).length;
    const isAllCompleted = group.length > 0 && completedCount === group.length;
    const nextUnreadBook = group.find((b) => !isBookMarkedRead(b));
    const completionPercent = group.length > 0
        ? Math.round((completedCount / group.length) * 100)
        : 0;

    return (
        // Fixed height + no wrap: the Continue button is conditional, so an
        // auto-height row would collapse when the last unread volume is finished
        // and shift every card below it, breaking the scroll anchor.
        <div className="flex items-center justify-between gap-3 border-b border-[var(--color-border)] pb-3 h-11 sm:h-9">
            <div className="flex items-center gap-2.5 min-w-0 flex-1">
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
            {/* The action cluster is allowed to wrap onto its own row on narrow screens so
                a 44px touch target is never squeezed by the truncating title. */}
            <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
                {nextUnreadBook && (
                    <button
                        onClick={() => onContinue(nextUnreadBook)}
                        className="ui-btn px-3 py-2 sm:px-2.5 sm:py-1 text-xs font-bold border flex items-center gap-1.5 min-h-11 sm:min-h-0 hover:bg-[var(--color-surface-muted)] touch-manipulation"
                        title={`Continue reading ${nextUnreadBook.title}`}
                        aria-label={`Continue reading ${nextUnreadBook.title}`}
                    >
                        <Play className="w-3 h-3 fill-current text-[color:var(--color-accent)]" />
                        <span>
                            Continue
                            {nextUnreadBook.seriesIndex != null ? ` (Vol. ${nextUnreadBook.seriesIndex})` : ""}
                        </span>
                    </button>
                )}
            </div>
        </div>
    );
}