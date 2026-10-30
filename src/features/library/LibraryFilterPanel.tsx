import { Trash2 } from "lucide-react";
import { cn } from "../../core/lib/utils";
import type { LibrarySortBy, LibrarySortOrder, LibraryStatusFilter } from "../../core/types";
import { type buildSourceFolderIndex, type SourceFolderSelection } from "../../core/lib/source-folders";
import {
    FILTER_CHIP_SELECTED,
    FILTER_CHIP_UNSELECTED,
    FILTER_CHIP_UNSELECTED_ON_SURFACE,
} from "../../ui/filter-chips";

export interface LibraryFilterPanelProps {
    /** "sheet" sits on the page (phones), "popover" on its own surface (desktop). */
    variant: "sheet" | "popover";
    sortBy: LibrarySortBy;
    sortOrder: LibrarySortOrder;
    statusFilter: LibraryStatusFilter;
    favoritesOnly: boolean;
    unshelvedOnly: boolean;
    onSortBy: (sortBy: LibrarySortBy) => void;
    onSortOrder: (order: LibrarySortOrder) => void;
    onStatusFilter: (status: LibraryStatusFilter) => void;
    onFavoritesOnly: (on: boolean) => void;
    onUnshelvedOnly: (on: boolean) => void;
    sourceFolderIndex?: ReturnType<typeof buildSourceFolderIndex>;
    selectedSourceFolder?: SourceFolderSelection | null;
    onSelectSourceFolder?: (folder: SourceFolderSelection | null) => void;
    onRemoveSourceFolder?: (root: string) => void;
}

const SORT_OPTIONS: ReadonlyArray<{ id: LibrarySortBy; label: string }> = [
    { id: "title", label: "Title" },
    { id: "author", label: "Author" },
    { id: "dateAdded", label: "Date added" },
    { id: "lastRead", label: "Last read" },
];

const STATUS_OPTIONS: ReadonlyArray<{ id: LibraryStatusFilter; label: string }> = [
    { id: "all", label: "All" },
    { id: "unread", label: "Unread" },
    { id: "reading", label: "Reading" },
    { id: "completed", label: "Finished" },
];

/** Order labels follow what is sorted: names read A to Z, dates newest first. */
function orderOptions(sortBy: LibrarySortBy): ReadonlyArray<{ id: LibrarySortOrder; label: string }> {
    if (sortBy === "title" || sortBy === "author") {
        return [
            { id: "asc", label: "A to Z" },
            { id: "desc", label: "Z to A" },
        ];
    }
    return [
        { id: "desc", label: "Newest first" },
        { id: "asc", label: "Oldest first" },
    ];
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <div className="p-4">
            <h3 className="text-[11px] text-[color:var(--color-text-muted)] mb-2.5">{title}</h3>
            {children}
        </div>
    );
}

/**
 * Sort and filter controls for the Library, shared by the phone sheet and the desktop popover.
 * Layout as it always was: Sort as a 2x2 grid, Show as one row, Order and Only side by side.
 */
export function LibraryFilterPanel(props: LibraryFilterPanelProps) {
    const unselected = props.variant === "sheet" ? FILTER_CHIP_UNSELECTED : FILTER_CHIP_UNSELECTED_ON_SURFACE;
    const chip = (selected: boolean, extra?: string) =>
        cn(
            "h-8 w-full px-2 text-xs font-sans whitespace-nowrap border flex items-center justify-center text-center transition-colors touch-manipulation",
            selected ? FILTER_CHIP_SELECTED : unselected,
            extra
        );
    const divider = props.variant === "sheet" ? "divide-y" : "divide-y-2";

    return (
        <div className={cn("grid grid-cols-1", divider, "divide-[var(--color-border)]")}>
            <Section title="Sort by">
                <div className="grid grid-cols-2 gap-1">
                    {SORT_OPTIONS.map((option) => (
                        <button
                            key={option.id}
                            type="button"
                            aria-pressed={props.sortBy === option.id}
                            onClick={() => props.onSortBy(option.id)}
                            className={chip(props.sortBy === option.id)}
                        >
                            {option.label}
                        </button>
                    ))}
                </div>
            </Section>
            <Section title="Show">
                <div className="grid grid-cols-4 gap-1">
                    {STATUS_OPTIONS.map((option) => (
                        <button
                            key={option.id}
                            type="button"
                            aria-pressed={props.statusFilter === option.id}
                            onClick={() => props.onStatusFilter(option.id)}
                            className={chip(props.statusFilter === option.id)}
                        >
                            {option.label}
                        </button>
                    ))}
                </div>
            </Section>
            <div className="grid grid-cols-2 divide-x divide-[var(--color-border)]">
                <Section title="Order">
                    <div className="flex flex-col gap-1">
                        {orderOptions(props.sortBy).map((option) => (
                            <button
                                key={option.id}
                                type="button"
                                aria-pressed={props.sortOrder === option.id}
                                onClick={() => props.onSortOrder(option.id)}
                                className={chip(props.sortOrder === option.id)}
                            >
                                {option.label}
                            </button>
                        ))}
                    </div>
                </Section>
                <Section title="Only">
                    <div className="flex flex-col gap-1">
                        <button
                            type="button"
                            aria-pressed={props.favoritesOnly}
                            onClick={() => props.onFavoritesOnly(!props.favoritesOnly)}
                            className={chip(props.favoritesOnly)}
                        >
                            Favorites
                        </button>
                        <button
                            type="button"
                            aria-pressed={props.unshelvedOnly}
                            onClick={() => props.onUnshelvedOnly(!props.unshelvedOnly)}
                            className={chip(props.unshelvedOnly)}
                        >
                            Not on a shelf
                        </button>
                    </div>
                </Section>
            </div>
            {props.sourceFolderIndex && props.sourceFolderIndex.size > 0 && (
                <Section title="Folder">
                    <div className="flex flex-col gap-1.5 max-h-48 overflow-y-auto overflow-x-hidden">
                        <button
                            type="button"
                            aria-pressed={!props.selectedSourceFolder}
                            onClick={() => props.onSelectSourceFolder?.(null)}
                            className={chip(!props.selectedSourceFolder)}
                        >
                            All library books
                        </button>
                        {Array.from(props.sourceFolderIndex.entries()).map(([root, { name, folders }]) => {
                            const isSelected = props.selectedSourceFolder?.root === root;
                            const displayName =
                                name && name !== root
                                    ? name
                                    : root.replace(/\\/g, "/").split("/").filter(Boolean).pop() || root;
                            const bookCount = folders.get("")?.size ?? 0;
                            return (
                                <div key={root} className="flex items-center gap-1.5 min-w-0 w-full">
                                    <button
                                        key={root}
                                        type="button"
                                        aria-pressed={isSelected}
                                        onClick={() =>
                                            props.onSelectSourceFolder?.(
                                                isSelected ? null : { root, path: "" }
                                            )
                                        }
                                        className={chip(
                                            isSelected,
                                            "flex-1 min-w-0 text-left justify-between px-3 overflow-hidden cursor-pointer"
                                        )}
                                        title={root}
                                    >
                                        <span className="truncate font-medium">{displayName}</span>
                                        <span className="text-[10px] opacity-75 shrink-0 ml-2">
                                            {bookCount} {bookCount === 1 ? "book" : "books"}
                                        </span>
                                    </button>
                                    {props.onRemoveSourceFolder && (
                                        <button
                                            type="button"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                props.onRemoveSourceFolder?.(root);
                                            }}
                                            className="p-1.5 text-[color:var(--color-text-muted)] hover:text-red-500 rounded transition-colors cursor-pointer shrink-0"
                                            title={`Remove ${displayName} folder`}
                                            aria-label={`Remove ${displayName} folder`}
                                        >
                                            <Trash2 className="w-3.5 h-3.5" />
                                        </button>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </Section>
            )}
        </div>
    );
}
