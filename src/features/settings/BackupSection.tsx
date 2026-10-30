import { useCallback, useEffect, useState } from "react";
import { Download, History, Upload } from "lucide-react";
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
        <div className="space-y-4">
            <div className="border border-[var(--color-border)] bg-[var(--color-surface)]">
                {/* Create Backup */}
                <div className="p-4 sm:p-5 space-y-3">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                        <div className="flex items-start gap-3 min-w-0 flex-1">
                            <div className="p-2 rounded bg-[var(--color-surface-muted)] text-[color:var(--color-accent)] shrink-0 mt-0.5">
                                <Download className="w-4 h-4" aria-hidden="true" />
                            </div>
                            <div className="min-w-0 flex-1">
                                <h3 className="text-sm font-medium text-[color:var(--color-text-primary)]">
                                    Create Backup File
                                </h3>
                                <p className="text-xs text-[color:var(--color-text-muted)] mt-0.5">
                                    Export your books, highlights, notes, vocabulary, feeds, and settings into one file
                                </p>
                            </div>
                        </div>
                        <button
                            type="button"
                            onClick={handleCreate}
                            disabled={busy !== null}
                            className="ui-btn-primary px-4 py-2 text-xs flex items-center justify-center gap-2 shrink-0 cursor-pointer disabled:opacity-50"
                            aria-label="Create Backup File"
                        >
                            <Download className="w-3.5 h-3.5" aria-hidden="true" />
                            <span>Create Backup File</span>
                        </button>
                    </div>

                    {/* Dictionary option directly attached to Create Backup */}
                    <div className="flex items-center justify-between gap-3 pt-3 mt-1 border-t border-[var(--color-border-subtle)] text-xs">
                        <span id="backup-include-dictionaries" className="text-[color:var(--color-text-secondary)]">
                            Include offline dictionaries (larger file)
                        </span>
                        <div role="group" aria-labelledby="backup-include-dictionaries" className="inline-flex border border-[var(--color-border)] bg-[var(--color-surface-muted)]">
                            {[true, false].map((value) => (
                                <button
                                    key={String(value)}
                                    type="button"
                                    aria-pressed={includeDictionaries === value}
                                    onClick={() => setIncludeDictionaries(value)}
                                    disabled={busy !== null}
                                    className={cn(
                                        "min-h-8 px-3 py-1 font-sans text-xs transition-colors cursor-pointer",
                                        !value && "border-l border-[var(--color-border)]",
                                        includeDictionaries === value ? "ui-selected font-medium" : "text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)]",
                                    )}
                                >
                                    {value ? "On" : "Off"}
                                </button>
                            ))}
                        </div>
                    </div>
                </div>

                {/* Divider */}
                <div className="border-t border-[var(--color-border)]" />

                {/* Restore Backup */}
                <div className="p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                    <div className="flex items-start gap-3 min-w-0 flex-1">
                        <div className="p-2 rounded bg-[var(--color-surface-muted)] text-[color:var(--color-accent)] shrink-0 mt-0.5">
                            <Upload className="w-4 h-4" aria-hidden="true" />
                        </div>
                        <div className="min-w-0 flex-1">
                            <h3 className="text-sm font-medium text-[color:var(--color-text-primary)]">
                                Restore from Backup
                            </h3>
                            <p className="text-xs text-[color:var(--color-text-muted)] mt-0.5">
                                Replace the library on this device with one from a backup file
                            </p>
                        </div>
                    </div>
                    <button
                        type="button"
                        onClick={handlePickBackup}
                        disabled={busy !== null}
                        className="ui-btn px-4 py-2 text-xs flex items-center justify-center gap-2 border shrink-0 cursor-pointer disabled:opacity-50 hover:bg-[var(--color-surface-muted)]"
                        aria-label="Restore from Backup"
                    >
                        <Upload className="w-3.5 h-3.5" aria-hidden="true" />
                        <span>Restore from Backup…</span>
                    </button>
                </div>
            </div>

            {status && (
                <p role="status" aria-live="polite" className="min-h-[1em] px-2 font-sans text-xs text-[color:var(--color-accent)] animate-pulse">
                    {status}…
                </p>
            )}

            {snapshots.length > 0 && (
                <div className="border border-[var(--color-border)] bg-[var(--color-surface)]">
                    <div className="flex items-center gap-2.5 border-b border-[var(--color-border)] px-4 py-3 bg-[var(--color-surface-muted)]">
                        <History className="w-4 h-4 text-[color:var(--color-text-muted)] shrink-0" aria-hidden="true" />
                        <div>
                            <p className="text-xs font-medium text-[color:var(--color-text-primary)]">
                                Automatic Copies
                            </p>
                            <p className="font-sans text-[11px] text-[color:var(--color-text-secondary)]">
                                Automatic copies of the library database, made once a day and before each update
                            </p>
                        </div>
                    </div>
                    <ul className="divide-y divide-[var(--color-border-subtle)]">
                        {snapshots.map((snapshot) => (
                            <li key={snapshot.name} className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-[var(--color-surface-muted)]/40 transition-colors">
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
                                    className="ui-btn-ghost px-3 py-1 text-xs border border-[var(--color-border)] cursor-pointer"
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
