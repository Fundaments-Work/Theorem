import { Layers, Play, Edit3 } from "lucide-react";
import type { Book } from "../../../core/types";
import { isBookMarkedRead } from "../../../core/lib/utils";

export interface SeriesGroupHeaderProps {
    seriesName: string;
    group: Book[];
    /** Opens the next unread volume. */
    onContinue: (book: Book) => void;
    /** Opens the "Set Book Series" modal for this group. */
    onEdit: () => void;
}

/**
 * Header row for a series group in a shelf.
 *
 * Extracted from Shelves.tsx so the touch-target contract can be regression-tested:
 * once every volume is read the Continue button disappears, leaving the Edit control as
 * the only interactive target in the row. It must therefore keep a 44px hit area on
 * phones or the header reads as unresponsive after reading (#128).
 */
export function SeriesGroupHeader({
    seriesName,
    group,
    onContinue,
    onEdit,
}: SeriesGroupHeaderProps) {
    const completedCount = group.filter(isBookMarkedRead).length;
    const isAllCompleted = group.length > 0 && completedCount === group.length;
    const nextUnreadBook = group.find((b) => !isBookMarkedRead(b));
    const completionPercent = group.length > 0
        ? Math.round((completedCount / group.length) * 100)
        : 0;

    return (
        <div className="flex items-center justify-between gap-3 border-b border-[var(--color-border)] pb-3 flex-wrap">
            <div className="flex items-center gap-2.5 min-w-0 flex-1">
                <Layers className="w-4 h-4 text-[color:var(--color-accent)] shrink-0" />
                <h2 className="text-sm font-bold uppercase tracking-widest text-[color:var(--color-text-primary)] truncate">
                    {seriesName}
                </h2>
                <span className="text-xs text-[color:var(--color-text-muted)] shrink-0">
                    ({group.length} {group.length === 1 ? "vol." : "vols."})
                </span>
                {isAllCompleted ? (
                    <span className="px-2 py-0.5 text-[10px] font-black uppercase tracking-wider bg-[var(--color-accent)] text-[color:var(--color-accent-contrast)] shrink-0">
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
                {/* Sole control once every volume is read — must meet the 44px touch
                    minimum on phones, and keeps its desktop density from sm upwards. */}
                <button
                    onClick={onEdit}
                    className="inline-flex items-center justify-center min-w-11 min-h-11 sm:min-w-0 sm:min-h-0 p-1.5 text-[color:var(--color-text-muted)] hover:text-[color:var(--color-text-primary)] hover:bg-[var(--color-surface-muted)] transition-colors touch-manipulation"
                    title="Edit Series"
                    aria-label={`Edit series ${seriesName}`}
                >
                    <Edit3 className="w-3.5 h-3.5" />
                </button>
            </div>
        </div>
    );
}