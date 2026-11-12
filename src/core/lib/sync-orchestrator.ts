import { getPairedDevices, irohStart } from "./device-sync";
import { useLibraryStore, useRssStore, useSettingsStore, useVocabularyStore } from "../store";
import type { DeviceSyncStatus } from "../types";
import { isTauri } from "./env";
import { sqliteRegisterMaterializedBook } from "./sqlite-storage";
import { formatSyncDomainLabel } from "./sync-domain-labels";
import { clearProgressiveBookBatch, flushProgressiveBooksOnRoundEnd, initDocsLiveListener } from "./sync-live-events";
import { mergeIncomingData } from "./sync-merge-engine";
import { hydrateFromIrohDocs, markProvisioningNeeded, provisionToIrohDocs } from "./sync-provision";
import {
    debug,
    docsSyncNow,
    noteSyncProtocols,
    notifySync,
    setStatus,
    syncRuntime,
    type SyncResult,
} from "./sync-runtime-state";

export {
    annotationsByBook,
    __resetHydrateScheduleForTests,
    hydrateFromIrohDocs,
    markProvisioningNeeded,
    provisionBatches,
    provisionToIrohDocs,
    subscribeZustandToIrohDocs,
} from "./sync-provision";
export { initDocsLiveListener } from "./sync-live-events";
export { tombstonesForDocDeletions, withLocalTombstones } from "./sync-merge-engine";
export {
    docsAckEntries,
    docsCreateSyncDoc,
    docsGetAllEntries,
    docsGetChangedEntries,
    docsImportSyncDoc,
    docsSetEntry,
    docsSyncNow,
    RSS_ARTICLE_KEY_PREFIX,
    RSS_FEED_KEY_PREFIX,
    TOMBSTONE_KEY_PREFIX,
    VOCAB_KEY_PREFIX,
    type DocDeletion,
    type SyncResult,
} from "./sync-runtime-state";

export async function ensureResponderSyncReady(): Promise<void> {
    if (!isTauri()) {
        return;
    }

    if (syncRuntime.responderReadyPromise) {
        await syncRuntime.responderReadyPromise;
        return;
    }

    syncRuntime.responderReadyPromise = (async () => {
        for (let i = 0; i < 50; i++) {
            const settingsReady = useSettingsStore.persist?.hasHydrated?.() ?? false;
            const libraryReady = useLibraryStore.persist?.hasHydrated?.() ?? false;
            const vocabReady = useVocabularyStore.persist?.hasHydrated?.() ?? true;
            const rssReady = useRssStore.persist?.hasHydrated?.() ?? true;
            if (settingsReady && libraryReady && vocabReady && rssReady) break;
            await new Promise(r => setTimeout(r, 100));
        }

        await irohStart();

        const { wasAlreadyProvisioned, markProvisioned } = await import("./sync-runtime-state");
        if (!syncRuntime.initialProvisionDone) {
            const alreadyDone = await wasAlreadyProvisioned();
            if (!alreadyDone) {
                syncRuntime.bridgePaused = true;
                try {
                    await provisionToIrohDocs();
                    await markProvisioned();
                } finally {
                    syncRuntime.bridgePaused = false;
                }
            } else {
                debug("[sync] Already provisioned — skipping re-provision");
            }
            syncRuntime.initialProvisionDone = true;
            syncRuntime.bridgePaused = false;
        }

        if (!syncRuntime.docsLiveUnlisten) {
            syncRuntime.docsLiveUnlisten = await initDocsLiveListener();
        }
    })();

    try {
        await syncRuntime.responderReadyPromise;
    } finally {
        syncRuntime.responderReadyPromise = null;
        syncRuntime.bridgePaused = false;
    }
}

/**
 * How long a round waits for the peer's own `docs-sync-finished` before
 * calling it unreachable, counted from the last entry that arrived from that
 * peer (`docs-sync-activity`): a first exchange of a large library takes
 * minutes, and is not an offline peer.
 */
const PEER_SYNC_WAIT_MS = 30_000;
/** However busy the exchange, a round waits at most this long. */
const PEER_SYNC_MAX_WAIT_MS = 20 * 60_000;
/** Once the peer's sync finished, how long to wait for its content downloads to settle. */
const CONTENT_SETTLE_GRACE_MS = 5_000;

interface RunningRound {
    peerDeviceId: string;
    promise: Promise<SyncResult>;
}
let _currentRound: RunningRound | null = null;

/** The paired device's iroh node id, which `docs-sync-finished` events carry as `peer`. */
async function peerNodeIdFor(peerDeviceId: string): Promise<string | undefined> {
    const devices = await getPairedDevices().catch(() => []);
    for (const d of devices) {
        if (d.deviceId === peerDeviceId) return d.irohNodeId || undefined;
    }
    return undefined;
}

/**
 * Runs one sync round with a peer. Rounds never overlap: a caller arriving
 * while one runs waits for it (and, for the same peer, simply shares its
 * result) instead of failing with "already in progress".
 */
export async function runDeviceSync(
    peerDeviceId: string,
    onProgress?: (msg: string) => void,
    notifyOnComplete = false,
): Promise<SyncResult> {
    while (_currentRound) {
        const running = _currentRound;
        if (running.peerDeviceId === peerDeviceId) return running.promise;
        await running.promise.catch(() => undefined);
    }
    const promise: Promise<SyncResult> = runDeviceSyncRound(peerDeviceId, onProgress, notifyOnComplete)
        .finally(() => {
            if (_currentRound?.promise === promise) _currentRound = null;
        });
    _currentRound = { peerDeviceId, promise };
    return promise;
}

/** Syncs with every paired device, one after another (the titlebar's quick sync). */
export async function syncAllPairedDevices(
    deviceIds?: string[],
    notifyOnComplete = false,
): Promise<SyncResult[]> {
    const ids = deviceIds ?? (await getPairedDevices().catch(() => [])).map((d) => d.deviceId);
    const results: SyncResult[] = [];
    for (const id of ids) {
        results.push(await runDeviceSync(id, undefined, notifyOnComplete));
    }
    return results;
}

async function runDeviceSyncRound(
    peerDeviceId: string,
    onProgress: ((msg: string) => void) | undefined,
    notifyOnComplete: boolean,
): Promise<SyncResult> {
    syncRuntime.isMerging = true;
    const cancelToken = syncRuntime.cancelGeneration;
    syncRuntime.roundCancelToken = cancelToken;
    const cancelled = () => cancelToken !== syncRuntime.cancelGeneration;
    const log = (msg: string) => {
        onProgress?.(msg);
    };

    try {
        setStatus("syncing", "Preparing to sync...");
        log("Connecting to peer...");

        log("Starting P2P transport...");
        await ensureResponderSyncReady();

        {
            if (cancelled()) {
                throw new Error("Sync cancelled");
            }
            log("Provisioning local data to sync doc...");
            await provisionToIrohDocs();
        }

        // Only this peer's `docs-sync-finished` ends the wait: the events are
        // global, and another peer's must not end this round early.
        const peerNodeId = await peerNodeIdFor(peerDeviceId);

        log("Requesting data from peer...");
        setStatus("syncing", "Connecting to peer...");

        let syncResolve: (() => void) | null = null;
        const syncPromise = new Promise<void>((res) => { syncResolve = res; });
        let settled = false;
        const settle = () => { if (!settled) { settled = true; syncResolve?.(); } };

        let contentReadyUnlisten: (() => void) | null = null;
        let syncFinishedUnlisten: (() => void) | null = null;
        let activityUnlisten: (() => void) | null = null;
        let timeoutId: ReturnType<typeof setTimeout> | null = null;
        let waitStartedAt = 0;
        const waitForPeer = () => {
            if (timeoutId) clearTimeout(timeoutId);
            const left = waitStartedAt + PEER_SYNC_MAX_WAIT_MS - Date.now();
            if (left <= 0) {
                settle();
                return;
            }
            timeoutId = setTimeout(() => void waitOver(), Math.min(PEER_SYNC_WAIT_MS, left));
        };
        // No sync-finished yet. The side sending a large library sees no
        // entries arrive, so ask the peer: while it answers, the exchange is
        // still going; when it does not, it is offline.
        const waitOver = async () => {
            if (settled) return;
            let reachable = false;
            try {
                const { invoke } = await import("@tauri-apps/api/core");
                reachable = (await invoke<boolean>("sync_probe_device", { peerDeviceId })) === true;
            } catch {
                reachable = false;
            }
            if (settled) return;
            if (reachable) waitForPeer();
            else settle();
        };
        // Set only by this peer's sync-finished event: the peer was reached.
        let _syncActivityDetected = false;
        let contentSignalled = false;
        let graceTimer: ReturnType<typeof setTimeout> | null = null;
        // Settles at once when the peer's sync finished *and* content downloads
        // reported ready afterwards; otherwise CONTENT_SETTLE_GRACE_MS after the
        // sync finished (content-ready carries no peer, so it is only a hint).
        let settleSignals = 0;
        const signalSettle = () => {
            settleSignals++;
            if (settleSignals >= 2) settle();
        };

        log("Syncing with peer via iroh-docs...");
        setStatus("syncing", "Connected, receiving data...");

        try {
            const { listen: evListen } = await import("@tauri-apps/api/event");
            activityUnlisten = await evListen<{ peer?: string }>("docs-sync-activity", (event) => {
                // Entries are still arriving from this peer: keep waiting.
                if (settled || !timeoutId || !peerNodeId || event.payload?.peer !== peerNodeId) return;
                waitForPeer();
            });
            contentReadyUnlisten = await evListen("docs-pending-content-ready", () => {
                debug(`[sync] Received docs-pending-content-ready`);
                if (_syncActivityDetected && !contentSignalled) {
                    contentSignalled = true;
                    signalSettle();
                }
            });
            syncFinishedUnlisten = await evListen<{ peer?: string; synced?: boolean; received?: number; sent?: number }>("docs-sync-finished", (event) => {
                const { peer, synced } = event.payload ?? {};
                if (peerNodeId && peer !== peerNodeId) {
                    debug(`[sync] Ignoring docs-sync-finished from another peer (${peer})`);
                    return;
                }
                if (_syncActivityDetected) return;
                if (synced === false) {
                    // The exchange with this peer failed: not reached this round.
                    debug("[sync] docs-sync-finished reported a failed exchange");
                    settle();
                    return;
                }
                debug("[sync] Received docs-sync-finished");
                _syncActivityDetected = true;
                signalSettle();
                graceTimer = setTimeout(settle, CONTENT_SETTLE_GRACE_MS);
            });
        } catch {}

        const stopWaiting = () => {
            if (graceTimer) clearTimeout(graceTimer);
            if (timeoutId) clearTimeout(timeoutId);
            contentReadyUnlisten?.();
            syncFinishedUnlisten?.();
            activityUnlisten?.();
        };

        const docsSyncError = await docsSyncNow(peerDeviceId);
        if (docsSyncError) {
            log(`Warning: iroh-docs sync failed: ${docsSyncError}`);
            const isOffline = docsSyncError.includes("offline") || docsSyncError.includes("timeout");
            const errorMsg = isOffline
                ? `Peer is offline — try again later`
                : docsSyncError;
            setStatus("error", errorMsg);
            stopWaiting();
            return { success: false, domainsUpdated: [], error: errorMsg };
        }

        waitStartedAt = Date.now();
        waitForPeer();

        await syncPromise;
        stopWaiting();

        const changedDomains = new Set<string>();
        const conflictsBefore = syncRuntime.conflictsFound;

        {
            const updated = await hydrateFromIrohDocs();
            for (const d of updated) changedDomains.add(d);
        }
        if (cancelled()) {
            log("Sync cancelled before final merge");
            return { success: false, domainsUpdated: [], error: "Sync cancelled" };
        }

        const liveEntries: Record<string, string> = {};
        for (const [k, v] of syncRuntime.pendingDocsEntries) {
            liveEntries[k] = v;
        }
        syncRuntime.pendingDocsEntries.clear();
        if (Object.keys(liveEntries).length > 0) {
            const { domainsUpdated } = await mergeIncomingData(liveEntries);
            for (const d of domainsUpdated) changedDomains.add(d);
        }

        await flushProgressiveBooksOnRoundEnd();

        const postWaitBooks = useLibraryStore.getState().books.length;
        debug(`[sync] After wait: ${postWaitBooks} books`);

        if (cancelled()) {
            log("Sync cancelled after metadata sync");
            setStatus("idle", "Sync cancelled");
            return { success: false, domainsUpdated: [], error: "Sync cancelled" };
        }

        if (!_syncActivityDetected) {
            // The peer never finished a sync with us: it was not reached. Not a
            // success, so the data stays dirty and the next round retries.
            const summary = "Peer offline";
            log(`Sync incomplete. ${summary}`);
            setStatus("error", summary);
            if (notifyOnComplete) {
                void notifySync("Sync Issue", summary);
            }
            return { success: false, domainsUpdated: [...changedDomains], error: summary };
        }

        const pendingDownloads = useLibraryStore.getState().books.filter(b => b.syncedWithoutFile === true && b.blobHash).length;
        if (pendingDownloads > 0) {
            log(`${pendingDownloads} book(s) available for on-demand download`);
        }

        let summary: string;
        if (changedDomains.size > 0) {
            const store = useLibraryStore.getState();
            const counts: Record<string, number> = {
                books: store.books.length,
                annotations: store.annotations.length,
                collections: store.collections.length,
                vocabulary: useVocabularyStore.getState().vocabularyTerms.length,
                rss_feeds: useRssStore.getState().feeds.length,
                rss_articles: useRssStore.getState().articles.length,
            };

            const visibleDomains = [...changedDomains].filter(d => d !== "deletion_tombstones");
            const parts = visibleDomains
                .map(d => {
                    const label = formatSyncDomainLabel(d);
                    const count = counts[d];
                    return count !== undefined ? `${count} ${label}` : label;
                })
                .join(", ");
            summary = `Synced: ${parts}`;
        } else if (pendingDownloads > 0) {
            summary = `Metadata synced, ${pendingDownloads} files available for download`;
        } else {
            summary = "Already up to date";
        }

        const roundConflicts = syncRuntime.conflictsFound - conflictsBefore;
        if (roundConflicts > 0) {
            summary += ` · ${roundConflicts} conflict${roundConflicts === 1 ? "" : "s"} to review`;
        }

        log(`Sync complete. ${summary}`);
        setStatus("synced", summary);
        syncRuntime.lastSyncPeerId = peerDeviceId;

        if (notifyOnComplete) {
            const { resolveNotificationIcon } = await import("./notifications");
            const successIcon = await resolveNotificationIcon("notify-success.png");
            void notifySync("Sync Complete", summary, successIcon);
        }

        void prefetchRecentBooks(peerDeviceId);
        syncRuntime.dataDirty = false;

        return { success: true, domainsUpdated: [...changedDomains], conflicts: roundConflicts > 0 ? roundConflicts : undefined };
    } catch (error: unknown) {
        const errMsg = error instanceof Error ? error.message : String(error);
        log(`Sync failed: ${errMsg}`);
        if (cancelled()) {
            setStatus("idle", "Sync cancelled");
            return { success: false, domainsUpdated: [], error: "Sync cancelled" };
        }
        setStatus("error", errMsg);
        if (notifyOnComplete) {
            void notifySync("Sync Error", errMsg);
        }
        return { success: false, domainsUpdated: [], error: errMsg };
    } finally {
        syncRuntime.isMerging = false;
        syncRuntime.roundCancelToken = -1;
    }
}

export function cancelRunningSync(): void {
    syncRuntime.cancelGeneration++;
    clearProgressiveBookBatch();
    import("../store").then(({ useUIStore }) => useUIStore.getState().setDownloadingBook(undefined)).catch(() => {});
    setStatus("idle", "Sync cancelled");
    debug("[sync] Cancel requested");
}

const DOWNLOAD_CONCURRENCY = 3;

export async function downloadBookOnDemand(bookId: string): Promise<boolean> {
    if (!isTauri()) return false;

    const { useUIStore } = await import("../store");
    const cancelToken = syncRuntime.cancelGeneration;
    let finalStatus: [DeviceSyncStatus, string] = ["idle", "Book download failed — peer not available"];
    setStatus("syncing", "Downloading book...");
    useUIStore.getState().setDownloadingBook(bookId);

    try {
        const { downloadBookFile, getPairedDevices: getDevices } = await import("./device-sync");

        const peerIds: string[] = [];
        if (syncRuntime.lastSyncPeerId) peerIds.push(syncRuntime.lastSyncPeerId);
        const devices = await getDevices().catch(() => []);
        for (const d of devices) {
            if (!peerIds.includes(d.deviceId)) peerIds.push(d.deviceId);
        }

        if (peerIds.length === 0) {
            console.warn(`[file-xfer] No paired devices found to download ${bookId}`);
            finalStatus = ["idle", "Book download failed — no paired devices"];
            return false;
        }

        for (const peerId of peerIds) {
            if (cancelToken !== syncRuntime.cancelGeneration) {
                finalStatus = ["idle", "Sync cancelled"];
                break;
            }
            try {
                debug(`[file-xfer] Attempting download of ${bookId} from peer ${peerId}...`);
                const destPath = await downloadBookFile(peerId, bookId);
                try {
                    await sqliteRegisterMaterializedBook(bookId);
                } catch (e) {
                    debug(`[file-xfer] failed to register ${bookId} in sqlite: ${e}`);
                }
                useLibraryStore.getState().updateBook(bookId, {
                    syncedWithoutFile: false,
                    filePath: destPath,
                    storagePath: destPath,
                });
                finalStatus = ["synced", "Book downloaded"];
                return true;
            } catch (e) {
                const errStr = String(e);
                console.error(`[file-xfer] download failed for ${bookId} from ${peerId}: ${errStr}`);
                if (errStr.includes("PEER_BOOK_DELETED")) {
                    console.warn(`[file-xfer] Book ${bookId} was deleted on peer; purging ghost card locally`);
                    finalStatus = ["idle", "Book was deleted on peer"];
                    useLibraryStore.getState().removeBook(bookId);
                    return false;
                }
            }
        }
        return false;
    } catch (e) {
        if (import.meta.env.DEV) console.warn(`[file-xfer] download of ${bookId} failed:`, e);
        finalStatus = ["error", "Book download failed"];
        return false;
    } finally {
        // Never leave the spinner or a "syncing" status behind. While a round
        // runs it owns the status and sets the final one itself.
        useUIStore.getState().setDownloadingBook(undefined);
        if (!syncRuntime.isMerging) setStatus(finalStatus[0], finalStatus[1]);
    }
}

async function prefetchRecentBooks(peerDeviceId: string): Promise<void> {
    const cancelToken = syncRuntime.cancelGeneration;
    const { downloadBookFile } = await import("./device-sync");

    const books = useLibraryStore.getState().books
        .filter((b) => b.syncedWithoutFile && b.lastReadAt)
        .sort((a, b) => {
            const aDate = a.lastReadAt instanceof Date ? a.lastReadAt : new Date(a.lastReadAt!);
            const bDate = b.lastReadAt instanceof Date ? b.lastReadAt : new Date(b.lastReadAt!);
            return bDate.getTime() - aDate.getTime();
        })
        .slice(0, 10);

    if (books.length === 0) return;

    let index = 0;
    await Promise.all(
        Array.from({ length: DOWNLOAD_CONCURRENCY }, async () => {
            while (index < books.length && cancelToken === syncRuntime.cancelGeneration) {
                const book = books[index++];
                try {
                    const destPath = await downloadBookFile(peerDeviceId, book.id);
                    try {
                        await sqliteRegisterMaterializedBook(book.id);
                    } catch (e) {
                        debug(`[file-xfer] failed to register ${book.id} in sqlite: ${e}`);
                    }
                    useLibraryStore.getState().updateBook(book.id, {
                        syncedWithoutFile: false,
                        filePath: destPath,
                        storagePath: destPath,
                    });
                } catch (e) {
                    // Prefetch is best effort: the book downloads on demand when opened.
                    debug(`[file-xfer] prefetch of ${book.id} failed: ${e}`);
                }
            }
        }),
    );
}

const AUTO_SYNC_INTERVAL_MS = 2 * 60 * 1000;
const STARTUP_SYNC_DELAY_MS = 5000;
const MUTATION_SYNC_DEBOUNCE_MS = 2000;
const READING_SYNC_THROTTLE_MS = 30_000;

let _autoSyncTimer: ReturnType<typeof setInterval> | null = null;
let _mutationSyncTimer: ReturnType<typeof setTimeout> | null = null;
let _autoSyncCleanups: Array<() => void> = [];
let _isAutoSyncing = false;

async function autoSyncRound(force = false): Promise<void> {
    if (!isTauri() || _isAutoSyncing) return;
    if (!force && !syncRuntime.dataDirty) return;

    const { settings } = useSettingsStore.getState();
    if (!settings.deviceSync?.autoSyncEnabled) return;

    const devices = await getPairedDevices().catch(() => []);
    if (devices.length === 0) return;

    _isAutoSyncing = true;
    try {
        let anyPeerSynced = false;
        for (const device of devices) {
            const result = await runDeviceSync(device.deviceId);
            if (result.success) {
                anyPeerSynced = true;
            }
        }
        syncRuntime.dataDirty = !anyPeerSynced;
    } catch {

    } finally {
        _isAutoSyncing = false;
        _lastAutoSyncRoundAt = Date.now();
    }
}

/** Returning to the app runs a round when the last one is older than this. */
export const RESUME_SYNC_STALE_MS = 30_000;
let _lastAutoSyncRoundAt = 0;
let _lastResumeSyncAt = 0;

/**
 * The app came back to the foreground (page visible again, or Tauri's
 * `resumed` on phones): run a round when auto sync is on and the last round
 * (or resume request) is older than RESUME_SYNC_STALE_MS. Both signals
 * usually arrive together; the second is dropped here. Returns whether a
 * round was started.
 */
export function syncAfterResume(now = Date.now()): boolean {
    if (!isTauri() || _isAutoSyncing) return false;
    const { settings } = useSettingsStore.getState();
    if (!settings.deviceSync?.autoSyncEnabled) return false;
    if (now - Math.max(_lastAutoSyncRoundAt, _lastResumeSyncAt) < RESUME_SYNC_STALE_MS) return false;
    _lastResumeSyncAt = now;
    void autoSyncRound(true);
    return true;
}

export function __setLastAutoSyncRoundAtForTests(at: number): void {
    _lastAutoSyncRoundAt = at;
    _lastResumeSyncAt = 0;
}

/**
 * Schedule a full sync round after a local change.
 *
 * `"edit"` (default): highlights, notes, shelves, settings… 2s trailing debounce.
 * `"reading"`: progress / reading stats, which change on every page turn. A
 * full round (provision + fetch + merge of every entity, all on the main
 * thread) 2s after each page turn made reading stall whenever the reader
 * paused; the live docs bridge already propagates each change, so these are
 * throttled to at most one round per READING_SYNC_THROTTLE_MS. An edit
 * arriving while a reading round is pending pulls it forward.
 */
export function scheduleMutationSync(kind: "edit" | "reading" = "edit"): void {
    const { settings } = useSettingsStore.getState();
    if (!settings.deviceSync?.autoSyncEnabled) return;

    syncRuntime.dataDirty = true;

    const delay = kind === "reading" ? READING_SYNC_THROTTLE_MS : MUTATION_SYNC_DEBOUNCE_MS;
    if (_mutationSyncTimer) {
        // A pending reading-round keeps its schedule (throttle, not debounce);
        // anything else reschedules to its own, shorter, delay.
        if (kind === "reading") return;
        clearTimeout(_mutationSyncTimer);
    }
    _mutationSyncTimer = setTimeout(async () => {
        _mutationSyncTimer = null;

        if (_isAutoSyncing) {
            syncRuntime.dataDirty = true;
            scheduleMutationSync(kind);
            return;
        }
        void autoSyncRound();
    }, delay);
}

export async function startAutoSync(): Promise<() => void> {
    stopAutoSync();

    if (!isTauri()) {
        return () => {};
    }

    const cleanups: Array<() => void> = [];

    const startupTimer = setTimeout(() => {
        void autoSyncRound(true);
    }, STARTUP_SYNC_DELAY_MS);
    cleanups.push(() => clearTimeout(startupTimer));

    let tickCount = 0;
    _autoSyncTimer = setInterval(() => {
        tickCount++;
        void autoSyncRound(tickCount % 5 === 0);
    }, AUTO_SYNC_INTERVAL_MS);
    cleanups.push(() => {
        if (_autoSyncTimer) {
            clearInterval(_autoSyncTimer);
            _autoSyncTimer = null;
        }
    });

    const onVisibilityChange = () => {
        if (document.visibilityState === "visible") syncAfterResume();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    cleanups.push(() => document.removeEventListener("visibilitychange", onVisibilityChange));

    // Phones: the activity resumed (the page does not always report a pause
    // as a visibility change). `syncAfterResume` drops the duplicate.
    if (isTauri()) {
        try {
            const { listen } = await import("@tauri-apps/api/event");
            cleanups.push(await listen("tauri://resumed", () => {
                syncAfterResume();
            }));
        } catch (e) {
            console.error("[sync] Resume listener could not be set up:", e);
        }
    }

    if (isTauri()) {
        try {
            const { listen } = await import("@tauri-apps/api/event");
            const unlisten = await listen("tray-sync-now", () => {
                void autoSyncRound(true);
            });
            cleanups.push(unlisten);
        } catch (e) {
            console.error("[sync] Tray sync listener could not be set up:", e);
        }
    }

    if (isTauri()) {
        try {
            const unlisten = await initDocsLiveListener();
            cleanups.push(unlisten);
        } catch (e) {
            console.error("[sync] Live sync listener could not be set up:", e);
        }
    }

    if (isTauri()) {
        try {
            const { listen } = await import("@tauri-apps/api/event");
            let lastPeerOnlineSync = 0;
            const PEER_ONLINE_COOLDOWN_MS = 30_000;
            const peerOnlineUnlisten = await listen<{ peer: string }>("docs-peer-online", async (event) => {
                const nodeId = event.payload.peer;
                if (!nodeId) return;
                const now = Date.now();
                if (now - lastPeerOnlineSync < PEER_ONLINE_COOLDOWN_MS) return;
                lastPeerOnlineSync = now;
                try {
                    const devices = await getPairedDevices();
                    const matched = devices.find(d => d.irohNodeId === nodeId);
                    if (matched) {
                        debug(`[sync] Peer ${matched.deviceName} (${matched.deviceId}) came online — auto-syncing`);
                        void runDeviceSync(matched.deviceId);
                    }
                } catch (e) {
                    console.error("[sync] Syncing with a peer that came online failed:", e);
                }
            });
            cleanups.push(peerOnlineUnlisten);
        } catch (e) {
            console.error("[sync] Peer-online listener could not be set up:", e);
        }
    }

    if (isTauri()) {
        try {
            const { listen } = await import("@tauri-apps/api/event");
            const docReimportedUnlisten = await listen("doc-reimported", () => {
                debug("[sync] Doc re-imported from ticket — marking provisioning needed");
                markProvisioningNeeded();
                void autoSyncRound(true);
            });
            cleanups.push(docReimportedUnlisten);

            const needsReprovisionUnlisten = await listen("sync-needs-reprovision", () => {
                debug("[sync] Iroh store recreated — marking provisioning needed");
                markProvisioningNeeded();
                void autoSyncRound(true);
            });
            cleanups.push(needsReprovisionUnlisten);
        } catch (e) {
            console.error("[sync] Doc re-import listener could not be set up:", e);
        }
    }

    if (isTauri()) {
        try {
            const { listen } = await import("@tauri-apps/api/event");
            const syncDocMissingUnlisten = await listen<{ deviceId: string; deviceName: string }>(
                "sync-doc-missing",
                (event) => {
                    console.warn(
                        `[sync] Paired device "${event.payload.deviceName}" has no sync doc. ` +
                        `Sync will connect but exchange no data. Re-pair to fix.`,
                    );
                    setStatus("error", `Re-pair required with ${event.payload.deviceName}`);
                },
            );
            cleanups.push(syncDocMissingUnlisten);

            // The other device unpaired this one (it told us, or refused us):
            // it is forgotten here too.
            cleanups.push(await listen<{ deviceId: string; deviceName: string }>("sync-peer-removed", (event) => {
                const name = event.payload.deviceName || "A paired device";
                setStatus("idle", `${name} removed this device`);
                void import("sonner").then(({ toast }) => {
                    toast(`${name} removed this device`, { description: "Pair them again to sync." });
                }).catch(() => {});
                void notifySync("Device removed", `${name} removed this device. Pair them again to sync.`);
            }));
            // Names, protocols or the device set changed: older devices may
            // have gone (or come), which decides whether whole lists are written.
            cleanups.push(await listen("paired-devices-changed", () => {
                void getPairedDevices().then(noteSyncProtocols).catch(() => {});
            }));
        } catch (e) {
            console.error("[sync] Sync listeners could not be set up:", e);
        }
    }

    _autoSyncCleanups = cleanups;
    return () => stopAutoSync();
}

export function stopAutoSync(): void {
    for (const cleanup of _autoSyncCleanups) {
        cleanup();
    }
    _autoSyncCleanups = [];
    if (_autoSyncTimer) {
        clearInterval(_autoSyncTimer);
        _autoSyncTimer = null;
    }
    if (_mutationSyncTimer) {
        clearTimeout(_mutationSyncTimer);
        _mutationSyncTimer = null;
    }
    syncRuntime.dataDirty = false;
}
