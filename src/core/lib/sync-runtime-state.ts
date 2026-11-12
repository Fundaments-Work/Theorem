import { useSettingsStore, useUIStore } from "../store";
import type { Annotation, DeletionTombstone, DeviceSyncStatus } from "../types";
import { reportMalformedSyncEntry } from "./sync-entries";

/** Sync entry key prefix for one RSS article (`rss_article:<id>`). */
export const RSS_ARTICLE_KEY_PREFIX = "rss_article:";
/** One deletion record each: `tomb:<entityType>:<entityId>`. */
export const TOMBSTONE_KEY_PREFIX = "tomb:";
/** One vocabulary word each: `vocab:<id>`. */
export const VOCAB_KEY_PREFIX = "vocab:";
/** One RSS feed each: `rss_feed:<id>`. */
export const RSS_FEED_KEY_PREFIX = "rss_feed:";

export const tombstoneEntryKey = (t: DeletionTombstone) => `${TOMBSTONE_KEY_PREFIX}${t.entityType}:${t.entityId}`;
export const annotationEntryKey = (a: Annotation) => `anno:${a.bookId || "global"}:${a.id}`;

export const MAX_PENDING_ENTRIES = 2000;
export const SYNC_PROVISIONED_KV_KEY = "theorem_sync_provisioned";
export const DOCS_DEBOUNCE_MS = 500;
export const FULL_HYDRATE_EVERY_MS = 30 * 60_000;

/** An item another device deleted: its newest doc entry is a deletion. */
export interface DocDeletion {
    key: string;
    /** When it was deleted (ms), by the deleting device's clock. */
    at: number;
}

export interface SyncResult {
    success: boolean;
    domainsUpdated: string[];
    /** Conflicts this round found (listed in Settings → Device Sync). */
    conflicts?: number;
    error?: string;
}

export const debug: (...args: unknown[]) => void = import.meta.env.DEV ? console.log : () => {};

/** Shared mutable coordinator state across the split sync orchestrator modules. */
export const syncRuntime = {
    legacyPeers: true,
    docsLiveUnlisten: null as (() => void) | null,
    docsLiveInit: null as Promise<() => void> | null,
    mergeChain: Promise.resolve() as Promise<unknown>,
    applyingRemote: 0,
    conflictsFound: 0,
    conflictToastTimer: null as ReturnType<typeof setTimeout> | null,
    conflictsToAnnounce: 0,
    initialProvisionDone: false,
    forceReProvision: false,
    responderReadyPromise: null as Promise<void> | null,
    lastProvisionFingerprint: "",
    provisionedValues: new Map<string, string>(),
    lastSyncPeerId: undefined as string | undefined,
    isMerging: false,
    cancelGeneration: 0,
    roundCancelToken: -1,
    bridgePaused: true,
    dataDirty: false,
    purgedTombstonesKey: "",
    lastFullHydrateAt: 0,
    pendingDocsEntries: new Map<string, string>(),
    docsDebounceTimers: new Map<string, ReturnType<typeof setTimeout>>(),
    ownWrites: new Map<string, string>(),
};

/**
 * Whether a paired device runs a version that reads only the old whole-list
 * entries (`annotations`, `vocabulary`...; sync protocol below 2). Only then
 * are those lists written (Rust also sends them only to such devices). Until
 * the paired devices are known, assume one does.
 */
export function noteSyncProtocols(devices: Array<{ protocol?: number }> | null | undefined): void {
    if (!Array.isArray(devices)) return;
    syncRuntime.legacyPeers = devices.some((d) => (d.protocol ?? 0) < 2);
}

export function epochOf(value: unknown): number {
    if (value instanceof Date) return value.getTime();
    if (typeof value === "string" || typeof value === "number") {
        const t = new Date(value).getTime();
        return Number.isNaN(t) ? 0 : t;
    }
    return 0;
}

export async function notifySync(title: string, body?: string, icon?: string) {
    const settings = useSettingsStore.getState().settings;
    if (!settings.syncNotifications) return;
    const { notifyIfGranted } = await import("./notifications");
    await notifyIfGranted(title, body ?? "", icon);
}

export function setStatus(status: DeviceSyncStatus, msg?: string) {
    useUIStore.getState().setDeviceSyncStatus(
        status,
        msg,
        status === "synced" ? new Date().toISOString() : undefined,
    );
}

// ── Merge serialization ────────────────────────────────────────────────────
// Every merge (full round, live batch, progressive flush) runs through this
// one promise chain, so two merges never read a snapshot, await, and then
// overwrite each other's result.
export function withMergeLock<T>(task: () => T | Promise<T>): Promise<T> {
    const run = syncRuntime.mergeChain.then(task, task);
    syncRuntime.mergeChain = run.catch(() => undefined);
    return run;
}

// While > 0, store changes come from a merge of peer data: the Zustand→docs
// bridge keeps its indexes current but does not write them back to the doc.
export function applyRemote(fn: () => void): void {
    syncRuntime.applyingRemote++;
    try {
        fn();
    } finally {
        syncRuntime.applyingRemote--;
    }
}

/** Opens Settings → Devices at the Device Sync section. */
export function openDeviceSyncSettings(): void {
    try {
        window.sessionStorage.setItem("theorem-settings:active-tab", "integrations");
        window.sessionStorage.setItem("theorem-settings:focus-section", "device-sync");
    } catch {
        // Settings opens on its last tab.
    }
    useUIStore.getState().setRoute("settings");
}

/**
 * New sync conflicts: the Device Sync settings list refreshes, and the user
 * is told once per burst (a round and its live updates find them together).
 */
export function reportConflicts(count: number): void {
    if (count <= 0) return;
    syncRuntime.conflictsFound += count;
    syncRuntime.conflictsToAnnounce += count;
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("theorem:sync-conflicts"));
    if (syncRuntime.conflictToastTimer) clearTimeout(syncRuntime.conflictToastTimer);
    syncRuntime.conflictToastTimer = setTimeout(() => {
        syncRuntime.conflictToastTimer = null;
        const n = syncRuntime.conflictsToAnnounce;
        syncRuntime.conflictsToAnnounce = 0;
        void import("sonner").then(({ toast }) => {
            toast(n === 1 ? "A sync conflict to review" : `${n} sync conflicts to review`, {
                description: "The same item was changed on two devices. The newer change is in use.",
                action: { label: "Review", onClick: openDeviceSyncSettings },
            });
        }).catch(() => {});
    }, 1000);
}

export function warnMergeFailure(domain: string, err: unknown): void {
    if (import.meta.env.DEV) console.warn(`[sync-merge] ${domain}: incoming data could not be merged`, err);
}

export function roundInProgress(): boolean {
    return syncRuntime.isMerging && syncRuntime.roundCancelToken === syncRuntime.cancelGeneration;
}

/** 53-bit string hash (cyrb53) plus length: compact, so large values are not kept twice. */
export function fingerprint(value: string): string {
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < value.length; i++) {
        const ch = value.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return `${value.length}:${(4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)}`;
}

/** Records that `key` was provisioned as `marker` (kept as a short hash). */
export function rememberProvisioned(key: string, marker: string): void {
    syncRuntime.provisionedValues.set(key, fingerprint(marker));
}

export function alreadyProvisioned(key: string, marker: string): boolean {
    return syncRuntime.provisionedValues.get(key) === fingerprint(marker);
}

export async function wasAlreadyProvisioned(): Promise<boolean> {
    if (syncRuntime.forceReProvision) return false;
    try {
        const { sqliteGetKv } = await import("./sqlite-storage");
        const val = await sqliteGetKv(SYNC_PROVISIONED_KV_KEY);
        return val === "true";
    } catch {
        return false;
    }
}

export async function markProvisioned(): Promise<void> {
    try {
        const { sqliteSetKv } = await import("./sqlite-storage");
        await sqliteSetKv(SYNC_PROVISIONED_KV_KEY, "true");
    } catch {}
}

export async function clearProvisionedFlag(): Promise<void> {
    try {
        const { sqliteDeleteKv } = await import("./sqlite-storage");
        await sqliteDeleteKv(SYNC_PROVISIONED_KV_KEY);
    } catch {}
}

export function rememberOwnWrite(key: string, value: string): void {
    syncRuntime.ownWrites.set(key, fingerprint(value));
}

export function isOwnEcho(key: string, value: string): boolean {
    const own = syncRuntime.ownWrites.get(key);
    return own !== undefined && own === fingerprint(value);
}

/**
 * Writes one docs entry from this device. `provisionedAs` is recorded in
 * `syncRuntime.provisionedValues` on success (pass null for keys provisioning
 * never compares), so the next provisioning does not write the same value again.
 */
export async function writeOwnEntry(key: string, value: string, provisionedAs: string | null = value): Promise<boolean> {
    rememberOwnWrite(key, value);
    const ok = await docsSetEntry(key, value);
    if (ok && provisionedAs !== null) rememberProvisioned(key, provisionedAs);
    return ok;
}

export function scheduleDocsWrite(domain: string, fn: () => void): void {
    const existing = syncRuntime.docsDebounceTimers.get(domain);
    if (existing) clearTimeout(existing);
    syncRuntime.docsDebounceTimers.set(domain, setTimeout(() => {
        syncRuntime.docsDebounceTimers.delete(domain);
        fn();
    }, DOCS_DEBOUNCE_MS));
}

export async function docsCreateSyncDoc(peerDeviceId: string): Promise<string | null> {
    try {
        const { invoke } = await import("@tauri-apps/api/core");
        return await invoke<string>("docs_create_sync_doc", { peerDeviceId });
    } catch (e) {
        console.error("[sync] Creating the sync doc failed:", e);
        return null;
    }
}

export async function docsImportSyncDoc(
    peerDeviceId: string,
    ticket: string,
): Promise<boolean> {
    try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("docs_import_sync_doc", { peerDeviceId, ticketStr: ticket });
        return true;
    } catch (e) {
        console.error("[sync] Importing the sync doc failed:", e);
        return false;
    }
}

export async function docsSetEntry(key: string, value: string): Promise<boolean> {
    try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("docs_set_entry", { key, value });
        return true;
    } catch (e) {
        console.error(`[sync] Writing sync entry ${key} failed:`, e);
        return false;
    }
}

/**
 * Only the doc entries whose content changed since the last read that was
 * acknowledged with `docsAckEntries` (the first read after start is complete);
 * with `full`, every entry.
 */
export async function docsGetChangedEntries(full = false): Promise<{ entries: Record<string, string>; deleted?: DocDeletion[]; token: number } | null> {
    try {
        const { invoke } = await import("@tauri-apps/api/core");
        return await invoke<{ entries: Record<string, string>; token: number }>("docs_get_changed_entries", { full });
    } catch { return null; }
}

/** The entries of read `token` are merged: later reads leave them out. */
export async function docsAckEntries(token: number): Promise<void> {
    try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("docs_ack_entries", { token });
    } catch { /* not acknowledged: the next read sends them again */ }
}

export async function docsGetAllEntries(): Promise<Record<string, string> | null> {
    try {
        const { invoke } = await import("@tauri-apps/api/core");
        return await invoke<Record<string, string>>("docs_get_all_entries");
    } catch (e) {
        console.error("[sync] Reading sync entries failed:", e);
        return null;
    }
}

export async function docsSyncNow(peerDeviceId: string): Promise<string | null> {
    try {
        const { invoke } = await import("@tauri-apps/api/core");
        const timeout = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("docs_sync_now timed out")), 20_000)
        );
        await Promise.race([
            invoke("docs_sync_now", { peerDeviceId }),
            timeout,
        ]);
        return null;
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[sync] docsSyncNow failed: ${msg}`);
        return msg;
    }
}

/**
 * Writes entries; null when that failed. Unless `force`, items whose newest
 * doc entry is another device's deletion are not written but returned.
 */
export async function docsSetEntries(
    entries: Array<{ key: string; value: string }>,
    force = false,
): Promise<{ deleted: DocDeletion[] } | null> {
    try {
        const { invoke } = await import("@tauri-apps/api/core");
        const result = await invoke<{ written: number; deleted?: DocDeletion[] } | null>(
            "docs_set_entries", { entries, force },
        );
        return { deleted: result?.deleted ?? [] };
    } catch { return null; }
}

export { reportMalformedSyncEntry };
