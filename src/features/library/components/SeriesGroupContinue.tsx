import { Play } from "lucide-react";
import type { Book } from "../../../core/types";
import { isBookMarkedRead } from "../../../core/lib/utils";

export interface SeriesGroupContinueProps {
    group: Book[];
    /** Opens the given volume. */
    onContinue: (book: Book) => void;
}

/**
 * "Continue reading" action for a series group, rendered as its own row beneath
 * the group header rather than inside it.
 *
 * Keeping it out of the header means the header's height no longer depends on
 * whether this button exists — the shelves scroll anchor used to jump every time
 * the last unread volume in a series was finished.
 *
 * The row height is reserved unconditionally (a zero-content element still
 * occupies the button's height) so the button appearing or disappearing never
 * moves the cards below it either.
 */
export function SeriesGroupContinue({
    group,
    onContinue,
}: SeriesGroupContinueProps) {
    const nextUnreadBook = group.find((b) => !isBookMarkedRead(b));

    return (
        <div className="flex items-center min-h-11 sm:min-h-9">
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
    );
}