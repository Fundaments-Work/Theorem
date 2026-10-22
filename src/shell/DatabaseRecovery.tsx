import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { cn, formatFileSize } from "../core/lib/utils";
import type { DbHealth, DbSnapshotInfo } from "../core/lib/db-health";
import {
    describeManifest,
    inspectBackup,
    pickBackupFile,
    reloadApp,
    restoreBackup,
    restoreSnapshot,
    type BackupManifest,
} from "../core/lib/db-backup";
import { resumePersistence } from "../core/lib/persist-storage";

/**
 * Shown by `main.tsx` instead of the app when the startup guard found the
 * library database damaged or could not migrate it. Store writes are
 * suspended while it is up, so nothing touches the database until the user
 * picks a way out.
 */

const BUTTON = cn(
    "w-full border border-[var(--color-border)] px-4 py-3 text-left font-sans text-[12px]",
    "text-[color:var(--color-text-primary)] transition-colors hover:bg-[var(--color-surface-muted)]",
    "disabled:cursor-not-allowed disabled:opacity-50",
);

function errorText(error: unknown): string {
    if (error instanceof Error) return error.message;
    return typeof error === "string" ? error : "Something went wrong.";
}

function snapshotDate(snapshot: DbSnapshotInfo): string {
    return new Date(snapshot.createdAt * 1000).toLocaleString();
}

export default function DatabaseRecovery({ health }: { health: DbHealth }) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [status, setStatus] = useState("");
    const [pendingFile, setPendingFile] = useState<{ path: string; manifest: BackupManifest } | null>(null);

    const run = async (label: string, task: () => Promise<unknown>) => {
        setBusy(true);
        setError(null);
        setStatus(label);
        try {
            await task();
            setStatus("Restored. Starting Theorem");
            reloadApp();
        } catch (e) {
            setBusy(false);
            setStatus("");
            setError(errorText(e));
        }
    };

    const chooseFile = async () => {
        setError(null);
        try {
            const path = await pickBackupFile();
            if (!path) return;
            setPendingFile({ path, manifest: await inspectBackup(path) });
        } catch (e) {
            setError(errorText(e));
        }
    };

    const continueAnyway = async () => {
        setBusy(true);
        try {
            await invoke("db_health_dismiss");
        } catch {
            // Continue regardless: the user chose to.
        }
        resumePersistence();
        reloadApp();
    };

    const corrupt = health.status === "corrupt";

    return (
        <main className="flex min-h-screen items-center justify-center bg-[var(--color-background)] px-4 py-10">
            <div className="w-full max-w-lg space-y-6 border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
                <div className="space-y-2">
                    <h1 className="font-sans text-[16px] text-[color:var(--color-text-primary)]">
                        {corrupt ? "Your library database is damaged" : "Theorem could not update your library"}
                    </h1>
                    <p className="font-sans text-[12px] text-[color:var(--color-text-secondary)]">
                        {corrupt
                            ? "Theorem stopped before changing anything. Put back a recent copy, or restore a backup file."
                            : "Updating the library database to this version failed. Your data was not deleted. Put back the copy made before the update, restore a backup file, or continue."}
                    </p>
                    {health.message && (
                        <p className="break-words font-mono text-[11px] text-[color:var(--color-text-muted)]">
                            {health.message}
                        </p>
                    )}
                </div>

                {health.snapshots.length > 0 && (
                    <section className="space-y-2" aria-label="Automatic copies">
                        <h2 className="font-sans text-[12px] text-[color:var(--color-text-primary)]">Automatic copies</h2>
                        {health.snapshots.map((snapshot) => (
                            <button
                                key={snapshot.name}
                                type="button"
                                disabled={busy}
                                className={BUTTON}
                                onClick={() => void run("Restoring the copy", () => restoreSnapshot(snapshot.name))}
                            >
                                Restore the copy from {snapshotDate(snapshot)}
                                <span className="block text-[11px] text-[color:var(--color-text-muted)]">
                                    Theorem {snapshot.appVersion} · {formatFileSize(snapshot.size)}
                                </span>
                            </button>
                        ))}
                    </section>
                )}

                <section className="space-y-2" aria-label="Backup file">
                    {pendingFile ? (
                        <div className="space-y-3 border border-[var(--color-border)] p-4">
                            <p className="font-sans text-[12px] text-[color:var(--color-text-primary)]">
                                {describeManifest(pendingFile.manifest)}
                            </p>
                            <p className="font-sans text-[11px] text-[color:var(--color-text-secondary)]">
                                This replaces the library on this device.
                            </p>
                            <div className="flex gap-2">
                                <button
                                    type="button"
                                    className="ui-btn-ghost"
                                    disabled={busy}
                                    onClick={() => setPendingFile(null)}
                                >
                                    Cancel
                                </button>
                                <button
                                    type="button"
                                    className="ui-btn-danger"
                                    disabled={busy}
                                    onClick={() => void run("Restoring the backup", () => restoreBackup(pendingFile.path))}
                                >
                                    Replace Library
                                </button>
                            </div>
                        </div>
                    ) : (
                        <button type="button" disabled={busy} className={BUTTON} onClick={() => void chooseFile()}>
                            Restore from Backup File…
                        </button>
                    )}
                </section>

                <section className="space-y-2 border-t border-[var(--color-border-subtle)] pt-4">
                    <button type="button" disabled={busy} className={BUTTON} onClick={() => void continueAnyway()}>
                        Continue Anyway
                        <span className="block text-[11px] text-[color:var(--color-text-muted)]">
                            {corrupt
                                ? "Open the library as it is. Some books or notes may be missing, and changes may not save."
                                : "Open the library without the update. Some features may not work."}
                        </span>
                    </button>
                </section>

                <p role="status" aria-live="polite" className="min-h-[1em] font-sans text-[11px] text-[color:var(--color-text-secondary)]">
                    {status}
                </p>
                {error && (
                    <p role="alert" className="font-sans text-[12px] text-[color:var(--color-error)]">
                        {error}
                    </p>
                )}
            </div>
        </main>
    );
}
