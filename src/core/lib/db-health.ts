import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./env";

/**
 * Database health as recorded by the startup guard (`db_backup.rs`). Kept
 * apart from `db-backup.ts` so `main.tsx` can ask before rendering without
 * pulling dialogs and the backup UI into the startup bundle.
 */
export type DbHealthStatus = "ok" | "corrupt" | "migration_failed";

export interface DbSnapshotInfo {
    name: string;
    /** Unix seconds. */
    createdAt: number;
    appVersion: string;
    size: number;
}

export interface DbHealth {
    status: DbHealthStatus;
    message: string | null;
    checked: boolean;
    snapshots: DbSnapshotInfo[];
}

/** The health to act on at startup, or `null` when the app may start normally. */
export async function readStartupDbHealth(): Promise<DbHealth | null> {
    if (!isTauri()) return null;
    try {
        const health = await invoke<DbHealth>("db_health_status");
        return health && health.status !== "ok" ? health : null;
    } catch {
        // An older backend or a failed IPC must never block startup.
        return null;
    }
}
