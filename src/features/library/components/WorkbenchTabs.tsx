import { memo, type ComponentType } from "react";
import { Bookmark, BookOpenText, Highlighter, Layers, StickyNote } from "lucide-react";
import { cn } from "../../../core/lib/utils";
import type { WorkbenchFilter } from "../../../core/types";

export type WorkbenchTab = WorkbenchFilter | "bookmarks";

const TABS: ReadonlyArray<{ id: WorkbenchTab; label: string; icon: ComponentType<{ className?: string }> }> = [
    { id: "all", label: "All", icon: Layers },
    { id: "highlights", label: "Highlights", icon: Highlighter },
    { id: "notes", label: "Notes", icon: StickyNote },
    { id: "vocabulary", label: "Words", icon: BookOpenText },
    { id: "bookmarks", label: "Bookmarks", icon: Bookmark },
];

/**
 * The one row of tabs shared by the Workbench and the Bookmarks page.
 *
 * Highlights, notes, words and bookmarks are the same thing to a reader — what they marked — so
 * they present as one place with five tabs. On a phone this is also what keeps Bookmarks
 * reachable: the bottom bar has room for one "Workbench" item and the rest lives here.
 *
 * Five text labels need ~350px, more than a small phone has, and a row that scrolls sideways
 * would hide exactly the tab we are trying to expose. So below `sm` only the active tab spells
 * out its name and the others shrink to an icon (every tab keeps its accessible name); from `sm`
 * up it is the plain text row it always was.
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
            className={cn("flex w-full max-w-full items-stretch gap-1 sm:w-fit", className)}
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
                            "flex min-w-10 items-center justify-center gap-1.5 whitespace-nowrap border border-[var(--color-border)] px-2.5 py-2 font-sans text-xs transition-colors sm:min-w-0 sm:flex-none sm:px-3",
                            isActive
                                ? "ui-selected flex-auto"
                                : "flex-none bg-[var(--color-surface)] text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)]",
                        )}
                    >
                        <Icon className="h-3.5 w-3.5 shrink-0 sm:hidden" />
                        <span className={cn(!isActive && "hidden sm:inline")}>{label}</span>
                    </button>
                );
            })}
        </div>
    );
});
