import { useCallback, useEffect, useState } from "react";
import { ChevronRight, Download, History, Upload } from "lucide-react";
import { cn, formatFileSize } from "../../core/lib/utils";
import { ConfirmDialog, AlertDialog } from "../../ui/ConfirmDialog";
import {
    createBackup,
    describeBackupProgress,
    describeManifest,
    inspectBackup,
    isBackupSupported,
    listenBackupProgress,
    listSnapshots,
    pickBackupFile,
    reloadApp,
    restoreBackup,
    restoreSnapshot,
    type BackupManifest,
} from "../../core/lib/db-backup";
import type { DbSnapshotInfo } from "../../core/lib/db-health";

type PendingRestore =
    | { kind: "file"; path: string; manifest: BackupManifest }
    | { kind: "snapshot"; snapshot: DbSnapshotInfo };

const ROW_BUTTON = cn(
    "w-full flex items-center gap-3 p-4 text-left",
    "border border-[var(--color-border)]",
    "text-[color:var(--color-text-primary)] hover:bg-[var(--color-surface-muted)]",
    "transition-colors disabled:opacity-50 disabled:cursor-not-allowed",
);

function errorText(error: unknown): string {
    if (error instanceof Error) return error.message;
    return typeof error === "string" ? error : "Something went wrong.";
}

export function formatSnapshotDate(snapshot: DbSnapshotInfo): string {
    return new Date(snapshot.createdAt * 1000).toLocaleString();
}

/** Settings → Data & Storage: backup file, restore, automatic snapshots. */
export function BackupSection() {
    const supported = isBackupSupported();
    const [includeDictionaries, setIncludeDictionaries] = useState(false);
    const [busy, setBusy] = useState<"backup" | "restore" | null>(null);
    const [status, setStatus] = useState("");
    const [snapshots, setSnapshots] = useState<DbSnapshotInfo[]>([]);
    const [pending, setPending] = useState<PendingRestore | null>(null);
    const [alert, setAlert] = useState<{ title: string; message: string } | null>(null);

    useEffect(() => {
        if (!supported) return;
        let cancelled = false;
        listSnapshots()
            .then((list) => {
                if (!cancelled) setSnapshots(list);
            })
            .catch(() => {});
        return () => {
            cancelled = true;
        };
    }, [supported]);

    useEffect(() => {
        if (!busy) return;
        let unlisten: (() => void) | null = null;
        let cancelled = false;
        void listenBackupProgress((progress) => setStatus(describeBackupProgress(progress))).then((stop) => {
            if (cancelled) stop();
            else unlisten = stop;
        });
        return () => {
            cancelled = true;
            unlisten?.();
        };
    }, [busy]);

    const handleCreate = useCallback(async () => {
        setBusy("backup");
        setStatus("Preparing the backup");
        try {
            const result = await createBackup({ includeDictionaries });
            if (!result) return;
            const missing = result.manifest.counts.missingBookFiles;
            const missingNote = missing > 0
                ? ` ${missing} ${missing === 1 ? "book is" : "books are"} not on this device and ${missing === 1 ? "was" : "were"} left out.`
                : "";
            setAlert({
                title: "Backup Saved",
                message: `Saved ${formatFileSize(result.size)} to ${result.location}.${missingNote}`,
            });
        } catch (error) {
            setAlert({ title: "Backup Failed", message: errorText(error) });
        } finally {
            setBusy(null);
            setStatus("");
        }
    }, [includeDictionaries]);

    const handlePickBackup = useCallback(async () => {
        try {
            const path = await pickBackupFile();
            if (!path) return;
            const manifest = await inspectBackup(path);
            setPending({ kind: "file", path, manifest });
        } catch (error) {
            setAlert({ title: "Cannot Restore This File", message: errorText(error) });
        }
    }, []);

    const handleConfirmRestore = useCallback(async () => {
        const target = pending;
        setPending(null);
        if (!target) return;
        setBusy("restore");
        setStatus("Checking the backup");
        try {
            if (target.kind === "file") await restoreBackup(target.path);
            else await restoreSnapshot(target.snapshot.name);
            setStatus("Library restored. Reloading");
            reloadApp();
        } catch (error) {
            setBusy(null);
            setStatus("");
            setAlert({ title: "Restore Failed", message: errorText(error) });
        }
    }, [pending]);

    if (!supported) {
        return (
            <p className="font-sans text-[11px] text-[color:var(--color-text-secondary)]">
                Backup files are made and restored in the desktop and Android apps.
            </p>
        );
    }

    const confirmMessage = pending
        ? pending.kind === "file"
            ? `${describeManifest(pending.manifest)} Restoring replaces the books, highlights, notes, vocabulary, feeds and settings on this device. This device stays paired and signed in to its catalogs. Your current library is kept as theorem.db.pre-restore until the next restore.`
            : `Put back the copy of your library from ${formatSnapshotDate(pending.snapshot)} (Theorem ${pending.snapshot.appVersion}). Changes made since then are replaced. Your current library is kept as theorem.db.pre-restore.`
        : "";

    return (
        <div className="space-y-3">
            <button type="button" onClick={handleCreate} disabled={busy !== null} className={ROW_BUTTON}>
                <Download className="w-5 h-5" aria-hidden="true" />
                <div className="flex-1">
                    <p className="text-sm">Create Backup File</p>
                    <p className="text-xs text-[color:var(--color-text-muted)]">
                        One .theorem-backup file with your books, highlights, notes, vocabulary, feeds and settings
                    </p>
                </div>
                <ChevronRight className="w-4 h-4" aria-hidden="true" />
            </button>

            <div className="flex items-center justify-between gap-3 px-4 py-2">
                <span id="backup-include-dictionaries" className="font-sans text-[11px] text-[color:var(--color-text-secondary)]">
                    Include offline dictionaries (larger file)
                </span>
                <div role="group" aria-labelledby="backup-include-dictionaries" className="inline-flex border border-[var(--color-border)] bg-[var(--color-surface)]">
                    {[true, false].map((value) => (
                        <button
                            key={String(value)}
                            type="button"
                            aria-pressed={includeDictionaries === value}
                            onClick={() => setIncludeDictionaries(value)}
                            disabled={busy !== null}
                            className={cn(
                                "min-h-10 px-3 py-2 font-sans text-[11px] sm:min-h-0",
                                !value && "border-l border-[var(--color-border)]",
                                includeDictionaries === value ? "ui-selected" : "text-[color:var(--color-text-secondary)]",
                            )}
                        >
                            {value ? "On" : "Off"}
                        </button>
                    ))}
                </div>
            </div>

            <button type="button" onClick={handlePickBackup} disabled={busy !== null} className={ROW_BUTTON}>
                <Upload className="w-5 h-5" aria-hidden="true" />
                <div className="flex-1">
                    <p className="text-sm">Restore from Backup…</p>
                    <p className="text-xs text-[color:var(--color-text-muted)]">
                        Replace the library on this device with one from a backup file
                    </p>
                </div>
                <ChevronRight className="w-4 h-4" aria-hidden="true" />
            </button>

            <p role="status" aria-live="polite" className="min-h-[1em] px-4 font-sans text-[11px] text-[color:var(--color-text-secondary)]">
                {status}
            </p>

            {snapshots.length > 0 && (
                <div className="border border-[var(--color-border-subtle)]">
                    <div className="flex items-center gap-2 border-b border-[var(--color-border-subtle)] px-4 py-2">
                        <History className="w-4 h-4 text-[color:var(--color-text-muted)]" aria-hidden="true" />
                        <p className="font-sans text-[11px] text-[color:var(--color-text-secondary)]">
                            Automatic copies of the library database, made once a day and before each update
                        </p>
                    </div>
                    <ul>
                        {snapshots.map((snapshot) => (
                            <li key={snapshot.name} className="flex items-center justify-between gap-3 px-4 py-2">
                                <span className="font-sans text-[12px] text-[color:var(--color-text-primary)]">
                                    {formatSnapshotDate(snapshot)}
                                    <span className="ml-2 text-[11px] text-[color:var(--color-text-muted)]">
                                        Theorem {snapshot.appVersion} · {formatFileSize(snapshot.size)}
                                    </span>
                                </span>
                                <button
                                    type="button"
                                    onClick={() => setPending({ kind: "snapshot", snapshot })}
                                    disabled={busy !== null}
                                    className="ui-btn-ghost"
                                    aria-label={`Restore the copy from ${formatSnapshotDate(snapshot)}`}
                                >
                                    Restore
                                </button>
                            </li>
                        ))}
                    </ul>
                </div>
            )}

            <ConfirmDialog
                isOpen={pending !== null}
                title={pending?.kind === "snapshot" ? "Restore Automatic Copy" : "Restore from Backup"}
                message={confirmMessage}
                confirmLabel="Replace Library"
                cancelLabel="Cancel"
                variant="danger"
                onConfirm={() => void handleConfirmRestore()}
                onCancel={() => setPending(null)}
            />

            {alert && (
                <AlertDialog
                    isOpen
                    title={alert.title}
                    message={alert.message}
                    okLabel="OK"
                    onClose={() => setAlert(null)}
                />
            )}
        </div>
    );
}
