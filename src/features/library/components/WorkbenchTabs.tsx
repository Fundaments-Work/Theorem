import { memo } from "react";
import { cn } from "../../../core/lib/utils";
import type { WorkbenchFilter } from "../../../core/types";

export type WorkbenchTab = WorkbenchFilter | "bookmarks";

const TABS: ReadonlyArray<{ id: WorkbenchTab; label: string }> = [
    { id: "all", label: "All" },
    { id: "highlights", label: "Highlights" },
    { id: "notes", label: "Notes" },
    { id: "vocabulary", label: "Words" },
    { id: "bookmarks", label: "Bookmarks" },
];

/**
 * The one row of tabs shared by the Workbench and the Bookmarks page.
 *
 * Highlights, notes, words and bookmarks are the same thing to a reader — what they marked — so
 * they present as one place with five tabs. On a phone this is also what keeps Bookmarks
 * reachable: the bottom bar has room for one "Workbench" item and the rest lives here.
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
            className={cn("flex w-full max-w-full items-stretch gap-1 overflow-x-auto sm:w-fit", className)}
        >
            {TABS.map((tab) => (
                <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    aria-selected={active === tab.id}
                    onClick={() => onSelect(tab.id)}
                    className={cn(
                        "flex-auto whitespace-nowrap border border-[var(--color-border)] px-1.5 py-2 text-center font-sans text-[11px] transition-colors sm:flex-none sm:px-3 sm:text-xs",
                        active === tab.id
                            ? "ui-selected"
                            : "bg-[var(--color-surface)] text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)]",
                    )}
                >
                    {tab.label}
                </button>
            ))}
        </div>
    );
});
