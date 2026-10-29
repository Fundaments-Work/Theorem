import { memo, type ComponentType } from "react";
import { Bookmark, BookOpenText, Highlighter, StickyNote } from "lucide-react";
import { cn } from "../../../core/lib/utils";
import type { WorkbenchFilter } from "../../../core/types";

export type WorkbenchTab = WorkbenchFilter | "bookmarks";

const TABS: ReadonlyArray<{ id: WorkbenchTab; label: string; icon: ComponentType<{ className?: string }> }> = [
    { id: "highlights", label: "Highlights", icon: Highlighter },
    { id: "notes", label: "Notes", icon: StickyNote },
    { id: "vocabulary", label: "Words", icon: BookOpenText },
    { id: "bookmarks", label: "Bookmarks", icon: Bookmark },
];

/**
 * The row of tabs shared by the Workbench and the Bookmarks page.
 *
 * Highlights, notes, words and bookmarks are the four distinct workspaces of the Workbench.
 * With 4 tabs, they divide evenly across mobile (grid-cols-4) with clear icons, labels and touch targets.
 */
export const WorkbenchTabs = memo(function WorkbenchTabs({
    active,
    onSelect,
    className,
}: {
    active: WorkbenchTab;
    onSelect: (tab: WorkbenchTab) => void;
    className?: string;
}) {
    return (
        <div
            role="tablist"
            aria-label="Workbench sections"
            className={cn("grid w-full max-w-full grid-cols-4 items-stretch gap-1 sm:flex sm:w-fit", className)}
        >
            {TABS.map(({ id, label, icon: Icon }) => {
                const isActive = active === id;
                return (
                    <button
                        key={id}
                        type="button"
                        role="tab"
                        aria-selected={isActive}
                        aria-label={label}
                        title={label}
                        onClick={() => onSelect(id)}
                        className={cn(
                            "flex min-w-0 flex-col sm:flex-row items-center justify-center gap-1 sm:gap-1.5 whitespace-nowrap border border-[var(--color-border)] px-1 py-1.5 sm:px-3.5 sm:py-2 font-sans text-[10px] sm:text-xs transition-colors touch-manipulation",
                            isActive
                                ? "ui-selected"
                                : "bg-[var(--color-surface)] text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)]",
                        )}
                    >
                        <Icon className="w-3.5 h-3.5 shrink-0" />
                        <span className="max-w-full truncate">{label}</span>
                    </button>
                );
            })}
        </div>
    );
});
