import { useCallback, useEffect, useState } from "react";
import { BookOpen, Highlighter } from "lucide-react";
import { cn } from "../../core/lib/utils";
import { sqliteDismissSyncConflicts, sqliteListSyncConflicts } from "../../core/lib/sqlite-storage";
import { useLibraryStore } from "../../core/store";
import type { SyncConflict } from "../../core/types";

/** Names for the fields a conflict can be about; others are not shown. */
const FIELD_LABELS: Record<string, string> = {
    title: "Title",
    author: "Author",
    description: "Description",
    publisher: "Publisher",
    language: "Language",
    isbn: "ISBN",
    publishedDate: "Published",
    category: "Category",
    isFavorite: "Favourite",
    tags: "Tags",
    rating: "Rating",
    completedAt: "Finished",
    manualCompletionState: "Read status",
    series: "Series",
    seriesIndex: "Volume",
    noteContent: "Note",
    textNoteContent: "Note",
    color: "Colour",
    type: "Kind",
};

const DATE_FIELDS = new Set(["completedAt"]);

function formatValue(field: string, value: unknown): string {
    if (value === null || value === undefined || value === "") return "none";
    if (typeof value === "boolean") return value ? "yes" : "no";
    if (Array.isArray(value)) return value.length > 0 ? value.join(", ") : "none";
    if (DATE_FIELDS.has(field) && (typeof value === "string" || typeof value === "number")) {
        const date = new Date(value);
        if (!Number.isNaN(date.getTime())) return date.toLocaleDateString();
    }
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return text.length > 120 ? `${text.slice(0, 117)}…` : text;
}

/** The replaced values, ready to apply again as an edit. */
function restorableValues(values: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(values)) {
        if (!(field in FIELD_LABELS) && field !== "progressBeforeFinish") continue;
        if (value === null) {
            out[field] = undefined;
        } else if (DATE_FIELDS.has(field) && typeof value === "string") {
            out[field] = new Date(value);
        } else {
            out[field] = value;
        }
    }
    return out;
}

function itemExists(conflict: SyncConflict): boolean {
    const lib = useLibraryStore.getState();
    return conflict.entityType === "book"
        ? Boolean(lib.getBook(conflict.entityId))
        : lib.annotations.some((a) => a.id === conflict.entityId);
}

/**
 * Switches to the replaced version: applied as a new edit, so it becomes
 * the newest one and reaches the other devices like any change.
 */
function restoreReplaced(conflict: SyncConflict): void {
    const values = restorableValues(conflict.discarded);
    const lib = useLibraryStore.getState();
    if (conflict.entityType === "book") {
        lib.updateBook(conflict.entityId, values);
    } else {
        lib.updateAnnotation(conflict.entityId, values);
    }
}

/**
 * The sync conflicts not yet dismissed, kept current as merges find new
 * ones (`theorem:sync-conflicts`).
 */
export function useSyncConflicts(enabled: boolean) {
    const [conflicts, setConflicts] = useState<SyncConflict[]>([]);

    const reload = useCallback(async () => {
        try {
            setConflicts(await sqliteListSyncConflicts());
        } catch {
            setConflicts([]);
        }
    }, []);

    useEffect(() => {
        if (!enabled) return;
        void reload();
        const onFound = () => void reload();
        window.addEventListener("theorem:sync-conflicts", onFound);
        return () => window.removeEventListener("theorem:sync-conflicts", onFound);
    }, [enabled, reload]);

    const dismiss = useCallback(async (ids: string[]) => {
        setConflicts((current) => (ids.length === 0 ? [] : current.filter((c) => !ids.includes(c.id))));
        await sqliteDismissSyncConflicts(ids).catch(() => {});
        void reload();
    }, [reload]);

    const restore = useCallback(async (conflict: SyncConflict) => {
        restoreReplaced(conflict);
        await dismiss([conflict.id]);
    }, [dismiss]);

    return { conflicts, dismiss, restore };
}

const buttonClass = cn(
    "inline-flex items-center justify-center px-3 py-2 min-h-[2.5rem]",
    "border border-[var(--color-border)] text-xs text-[color:var(--color-text-secondary)]",
    "hover:text-[color:var(--color-accent)] hover:border-[color:color-mix(in_srgb,var(--color-accent)_40%,var(--color-border))]",
    "transition-colors",
);

export function SyncConflictList({
    conflicts,
    onRestore,
    onDismiss,
}: {
    conflicts: SyncConflict[];
    onRestore: (conflict: SyncConflict) => void;
    onDismiss: (ids: string[]) => void;
}) {
    return (
        <div className="divide-y divide-[var(--color-border)]">
            <p className="px-4 py-3 text-xs text-[color:var(--color-text-muted)]">
                These were changed on two devices before they synced. The newer change is in use; you can switch to the other one.
            </p>
            {conflicts.map((conflict) => {
                const exists = itemExists(conflict);
                const fields = Object.keys(conflict.kept).filter((f) => f in FIELD_LABELS);
                const replacedHere = conflict.winner === "remote";
                const Icon = conflict.entityType === "book" ? BookOpen : Highlighter;
                return (
                    <div key={conflict.id} className="p-4 space-y-3" data-sync-conflict={conflict.id}>
                        <div className="flex items-start gap-3">
                            <Icon className="w-4 h-4 mt-0.5 text-[color:var(--color-text-muted)] shrink-0" />
                            <div className="flex-1 min-w-0">
                                <p className="text-sm text-[color:var(--color-text-primary)] truncate">
                                    {conflict.label || (conflict.entityType === "book" ? "A book" : "A highlight")}
                                </p>
                                <p className="text-[11px] text-[color:var(--color-text-muted)]">
                                    {replacedHere
                                        ? "Your change on this device was replaced by a newer one from another device"
                                        : "A change from another device was replaced by your newer one"}
                                    {" · "}
                                    {new Date(conflict.detectedAt).toLocaleString()}
                                </p>
                            </div>
                        </div>
                        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                            {fields.map((field) => (
                                <div key={field} className="contents">
                                    <dt className="text-[color:var(--color-text-muted)]">{FIELD_LABELS[field]}</dt>
                                    <dd className="min-w-0 break-words text-[color:var(--color-text-secondary)]">
                                        <span className="text-[color:var(--color-text-primary)]">{formatValue(field, conflict.kept[field])}</span>
                                        <span className="text-[color:var(--color-text-muted)]"> in use · replaced: </span>
                                        <span className="line-through decoration-[color:var(--color-text-muted)]">{formatValue(field, conflict.discarded[field])}</span>
                                    </dd>
                                </div>
                            ))}
                        </dl>
                        <div className="flex flex-col sm:flex-row gap-2">
                            {exists ? (
                                <button className={buttonClass} onClick={() => onRestore(conflict)}>
                                    Use the replaced version
                                </button>
                            ) : (
                                <p className="text-xs text-[color:var(--color-text-muted)] self-center">
                                    This {conflict.entityType === "book" ? "book" : "highlight"} has since been deleted.
                                </p>
                            )}
                            <button className={buttonClass} onClick={() => onDismiss([conflict.id])}>
                                Keep the one in use
                            </button>
                        </div>
                    </div>
                );
            })}
            {conflicts.length > 1 && (
                <div className="p-4">
                    <button className={buttonClass} onClick={() => onDismiss([])}>
                        Keep all as they are
                    </button>
                </div>
            )}
        </div>
    );
}
