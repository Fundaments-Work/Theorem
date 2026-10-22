import { invoke } from "@tauri-apps/api/core";
import { isTauri, isTauriMobile } from "./env";
import { localDateKey } from "./date-keys";
import { showOpenFileDialog, showSaveFileDialog } from "./dialogs";
import {
    clearUnloadSnapshots,
    flushAllPersistence,
    resumePersistence,
    suspendPersistence,
} from "./persist-storage";
import type { DbSnapshotInfo } from "./db-health";

/**
 * Frontend side of `src-tauri/src/db_backup.rs`: `.theorem-backup` archives,
 * restore, and the automatic database snapshots. All file work happens in
 * Rust; nothing here holds a book or the database in memory.
 */

export const BACKUP_EXTENSION = "theorem-backup";
export const BACKUP_PROGRESS_EVENT = "db-backup-progress";

export interface BackupCounts {
    books: number;
    annotations: number;
    vocabulary: number;
    rssFeeds: number;
    rssArticles: number;
    readingSessions: number;
    bookFiles: number;
    missingBookFiles: number;
    audiobookFiles: number;
    dictionaryFiles: number;
}

export interface BackupManifest {
    format: string;
    formatVersion: number;
    appVersion: string;
    createdAt: string;
    platform: string;
    schema: { userVersion: number; tables: string[] };
    counts: BackupCounts;
    includesDictionaries: boolean;
    totalBytes: number;
}

export interface BackupProgress {
    operation: "backup" | "restore";
    phase: string;
    current: number;
    total: number;
}

export interface BackupResult {
    location: string;
    manifest: BackupManifest;
    size: number;
}

export interface RestoreResult {
    manifest: BackupManifest | null;
    filesRestored: number;
    migrationError: string | null;
}

/** Backups need the native backend (desktop and Android). */
export function isBackupSupported(): boolean {
    return isTauri();
}

export function defaultBackupFileName(date = new Date()): string {
    return `theorem-${localDateKey(date)}.${BACKUP_EXTENSION}`;
}

/**
 * Write a backup. Desktop asks where to save it; Android streams it into
 * Downloads/Theorem. Returns `null` when the user cancels the save dialog.
 */
export async function createBackup(options: { includeDictionaries: boolean }): Promise<BackupResult | null> {
    let outputPath: string | null = null;
    if (!isTauriMobile()) {
        outputPath = await showSaveFileDialog({
            title: "Save Theorem Backup",
            defaultPath: defaultBackupFileName(),
            filters: [{ name: "Theorem Backup", extensions: [BACKUP_EXTENSION] }],
        });
        if (!outputPath) return null;
    }
    // Whatever the stores still hold in memory belongs in the backup.
    await flushAllPersistence();
    return invoke<BackupResult>("db_backup_create", {
        outputPath,
        includeDictionaries: options.includeDictionaries,
    });
}

/** Ask for a backup file. Returns a local path, or `null` when cancelled. */
export async function pickBackupFile(): Promise<string | null> {
    const mobile = isTauriMobile();
    const picked = await showOpenFileDialog({
        title: "Restore from Backup",
        multiple: false,
        // Android's picker filters by MIME type and knows no .theorem-backup.
        filters: mobile ? undefined : [{ name: "Theorem Backup", extensions: [BACKUP_EXTENSION] }],
    });
    const path = Array.isArray(picked) ? picked[0] : picked;
    if (!path) return null;
    if (path.startsWith("content://")) {
        return invoke<string>("materialize_android_content_uri", {
            uri: path,
            fileName: `restore.${BACKUP_EXTENSION}`,
        });
    }
    return path;
}

export function inspectBackup(path: string): Promise<BackupManifest> {
    return invoke<BackupManifest>("db_backup_inspect", { path });
}

export function listSnapshots(): Promise<DbSnapshotInfo[]> {
    return invoke<DbSnapshotInfo[]>("db_list_snapshots");
}

/**
 * Replace the library, then reload so every store hydrates from the restored
 * database. Pending writes go to the old database first (it is kept as
 * `theorem.db.pre-restore`); after that nothing in memory may be written.
 */
async function replaceDatabase(run: () => Promise<RestoreResult>): Promise<RestoreResult> {
    await flushAllPersistence();
    suspendPersistence();
    try {
        const result = await run();
        clearUnloadSnapshots();
        return result;
    } catch (error) {
        resumePersistence();
        throw error;
    }
}

export function restoreBackup(path: string): Promise<RestoreResult> {
    return replaceDatabase(() => invoke<RestoreResult>("db_backup_restore", { path }));
}

export function restoreSnapshot(name: string): Promise<RestoreResult> {
    return replaceDatabase(() => invoke<RestoreResult>("db_restore_snapshot", { name }));
}

/** Start the app again on the database as it is now. */
export function reloadApp(): void {
    window.location.reload();
}

export async function listenBackupProgress(
    handler: (progress: BackupProgress) => void,
): Promise<() => void> {
    if (!isTauri()) return () => {};
    const { listen } = await import("@tauri-apps/api/event");
    return listen<BackupProgress>(BACKUP_PROGRESS_EVENT, (event) => handler(event.payload));
}

const PHASE_LABELS: Record<string, string> = {
    database: "Copying the library database",
    books: "Copying books",
    audiobooks: "Copying audiobooks",
    dictionaries: "Copying dictionaries",
    finalizing: "Finishing the file",
    files: "Unpacking files",
    applying: "Replacing the library",
};

export function describeBackupProgress(progress: BackupProgress): string {
    const label = PHASE_LABELS[progress.phase] ?? "Working";
    if (progress.total > 1 && progress.phase !== "finalizing") {
        return `${label} (${Math.min(progress.current + 1, progress.total)} of ${progress.total})`;
    }
    return label;
}

export function describeManifest(manifest: BackupManifest): string {
    const created = new Date(manifest.createdAt);
    const when = Number.isNaN(created.getTime()) ? "an unknown date" : created.toLocaleString();
    const { books, annotations, vocabulary } = manifest.counts;
    const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
    return `Made ${when} by Theorem ${manifest.appVersion}: ${plural(books, "book", "books")}, ${plural(annotations, "highlight or note", "highlights and notes")}, ${plural(vocabulary, "vocabulary word", "vocabulary words")}.`;
}
