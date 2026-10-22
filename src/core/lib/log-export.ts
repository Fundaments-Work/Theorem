/**
 * "Export logs": the native side zips the app's log files plus the app
 * version and platform (`export_logs_bundle`); this saves the zip the way
 * book export saves files (desktop save dialog, Android Downloads/Theorem).
 */

import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./env";
import { saveFileAs, type ExportResult } from "./book-export";

const pad = (n: number) => String(n).padStart(2, "0");

/** `theorem-logs-YYYY-MM-DD-HHMM.zip`, in local time. */
export function buildLogExportFilename(now: Date = new Date()): string {
    const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    return `theorem-logs-${date}-${pad(now.getHours())}${pad(now.getMinutes())}.zip`;
}

export async function exportLogs(now: Date = new Date()): Promise<ExportResult> {
    if (!isTauri()) {
        return { ok: false, message: "Log files are written by the desktop and Android apps only." };
    }
    try {
        const bytes = await invoke<ArrayBuffer>("export_logs_bundle");
        if (!bytes || bytes.byteLength === 0) {
            return { ok: false, message: "The log bundle came back empty." };
        }
        const blob = new Blob([bytes], { type: "application/zip" });
        return await saveFileAs(buildLogExportFilename(now), blob);
    } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
}
