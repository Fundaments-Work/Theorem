import { X } from "lucide-react";
import type { FolderImportProgress } from "../../../core/lib/folder-import";

const numberFormat = new Intl.NumberFormat();

/** One line while a folder is scanned and imported, with a way to stop it. */
export function FolderImportStatus({ progress, stopping, onStop }: {
    progress: FolderImportProgress;
    stopping: boolean;
    onStop: () => void;
}) {
    const { phase, completed, total } = progress;
    const label = stopping
        ? "Stopping…"
        : phase === "scanning"
            ? "Looking for books…"
            : total === 0
                ? "Everything is already in your library"
                : `Importing ${numberFormat.format(Math.min(completed, total))} of ${numberFormat.format(total)}`;
    const fraction = phase === "importing" && total > 0 ? Math.min(1, completed / total) : 0;

    return (
        <div
            role="status"
            aria-live="polite"
            className="flex w-full min-w-0 items-center gap-3 border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-xs text-[color:var(--color-text-secondary)]"
        >
            <span className="min-w-0 flex-1 truncate">{label}</span>
            <div
                className="h-px w-24 shrink-0 bg-[var(--color-border)] sm:w-40"
                role="progressbar"
                aria-label="Folder import"
                aria-valuemin={0}
                aria-valuemax={total}
                aria-valuenow={Math.min(completed, total)}
            >
                <div className="h-px bg-[var(--color-accent)]" style={{ width: `${fraction * 100}%` }} />
            </div>
            <button
                type="button"
                onClick={onStop}
                disabled={stopping}
                className="inline-flex shrink-0 items-center gap-1 text-[color:var(--color-text-secondary)] transition-colors hover:text-[color:var(--color-accent)] disabled:opacity-50"
                aria-label="Stop importing"
            >
                <X className="h-3.5 w-3.5" />
                <span>Stop</span>
            </button>
        </div>
    );
}
