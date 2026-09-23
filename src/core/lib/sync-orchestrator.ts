
import {
    irohStart,
    getPairedDevices,
} from "./device-sync";
import {
    useLibraryStore,
    useVocabularyStore,
    useRssStore,
    useUIStore,
    useSettingsStore,
    toSqliteVocabularyTerm,
} from "../store";
import type { DeviceSyncStatus, SyncConflict } from "../types";
import {
    mergeBooks,
    mergeAnnotations,
    mergeCollections,
    mergeTombstones,
    mergeVocabulary,
    mergeRssFeeds,
    mergeRssArticles,
    mergeSettings,
    mergeReadingStats,
} from "./sync-import";
import { isTauri } from "./env";
import { invokeSqliteInOrder, sqliteDeleteVocabularyTerm, sqliteRegisterMaterializedBook, sqliteSaveVocabularyTerm } from "./sqlite-storage";
import { diffVocabularyForSqlite } from "./vocab-sqlite-diff";
import { applyIncomingCover, buildCoverEntry, COVER_KEY_PREFIX, coverEntryKey, coverPathForBookEntry, needsCoverEntry, parseCoverEntry } from "./sync-covers";

async function notifySync(title: string, body?: string, icon?: string) {
    const settings = useSettingsStore.getState().settings;
    if (!settings.syncNotifications) return;
    const { notifyIfGranted } = await import("./notifications");
    await notifyIfGranted(title, body ?? "", icon);
}

const debug: (...args: unknown[]) => void = import.meta.env.DEV ? console.log : () => {};

function setStatus(status: DeviceSyncStatus, msg?: string) {
    useUIStore.getState().setDeviceSyncStatus(
        status,
        msg,
        status === "synced" ? new Date().toISOString() : undefined,
    );
}

let _docsLiveUnlisten: (() => void) | null = null;

async function mergeIncomingData(
    incomingMap: Record<string, string>,
    localSettingsUpdatedAt?: string,
    onConflict?: (conflict: SyncConflict) => void,
): Promise<{ domainsUpdated: string[]; conflicts: SyncConflict[] }> {
    const domainsUpdated: string[] = [];
    const conflicts: SyncConflict[] = [];
    const recordConflict = (entityType: string, entityId: string, winner: "local" | "remote", label?: string) => {
        conflicts.push({ entityType, entityId, winner, label });
        onConflict?.({ entityType, entityId, winner, label });
    };
    const markUpdated = (domain: string) => {
        if (!domainsUpdated.includes(domain)) {
            domainsUpdated.push(domain);
        }
    };

    let safeMap = incomingMap;
    try {
        const { validateSyncPayloads } = await import("./sync-schemas");
        const validated = validateSyncPayloads(incomingMap);
        
        safeMap = {};
        for (const [domain, data] of Object.entries(validated)) {
            safeMap[domain] = JSON.stringify(data);
        }
        
        for (const key of Object.keys(incomingMap)) {
            if (key.startsWith("book:") || key.startsWith("annotation:") || key.startsWith("anno:") || key.startsWith("collection:") || key.startsWith(COVER_KEY_PREFIX)) {
                if (!safeMap[key]) {
                    safeMap[key] = incomingMap[key];
                }
            }
        }
    } catch {
        
    }

    const perEntityBooks: Record<string, unknown>[] = [];
    const perEntityAnnotations: Record<string, unknown>[] = [];
    const perEntityCollections: Record<string, unknown>[] = [];

    for (const key of Object.keys(safeMap)) {
        if (key.startsWith("book:") && key !== "books") {
            try {
                const parsed = JSON.parse(safeMap[key]);
                if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                    perEntityBooks.push(parsed);
                }
            } catch {}
        } else if ((key.startsWith("annotation:") || key.startsWith("anno:")) && key !== "annotations") {
            try {
                const parsed = JSON.parse(safeMap[key]);
                if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                    perEntityAnnotations.push(parsed);
                }
            } catch {}
        } else if (key.startsWith("collection:") && key !== "collections") {
            try {
                const parsed = JSON.parse(safeMap[key]);
                if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                    perEntityCollections.push(parsed);
                }
            } catch {}
        }
    }

    const incomingCovers: Array<{ id: string; dataUrl: string }> = [];
    for (const key of Object.keys(safeMap)) {
        if (!key.startsWith(COVER_KEY_PREFIX)) continue;
        const cover = parseCoverEntry(safeMap[key]);
        if (cover) incomingCovers.push(cover);
    }

    let allTombstones = useLibraryStore.getState().deletionTombstones;

    const libraryPatch: Partial<ReturnType<typeof useLibraryStore.getState>> = {};
    const applyLibraryPatch = (patch: Partial<ReturnType<typeof useLibraryStore.getState>>) => {
        Object.assign(libraryPatch, patch);
    };

    if (safeMap["deletion_tombstones"]) {
        try {
            const incoming = JSON.parse(safeMap["deletion_tombstones"]);
            if (Array.isArray(incoming)) {
                allTombstones = mergeTombstones(incoming, allTombstones);
                applyLibraryPatch({ deletionTombstones: allTombstones });
                markUpdated("deletion_tombstones");
            }
        } catch (e) {
        }
    }

    if (safeMap["deletion_tombstones"]) {
        const libraryState = useLibraryStore.getState();
        const prunedBooks = mergeBooks([], libraryState.books, allTombstones);
        const prunedAnnotations = mergeAnnotations([], libraryState.annotations, allTombstones);
        const prunedCollections = mergeCollections([], libraryState.collections, allTombstones);

        applyLibraryPatch({
            books: prunedBooks,
            annotations: prunedAnnotations,
            collections: prunedCollections,
        });

        if (prunedBooks.length !== libraryState.books.length) markUpdated("books");
        if (prunedAnnotations.length !== libraryState.annotations.length) markUpdated("annotations");
        if (prunedCollections.length !== libraryState.collections.length) markUpdated("collections");

        const rssState = useRssStore.getState();
        const prunedFeeds = mergeRssFeeds([], rssState.feeds, allTombstones);
        const prunedArticles = mergeRssArticles([], rssState.articles, undefined, allTombstones);

        useRssStore.setState({ feeds: prunedFeeds.feeds, articles: prunedArticles });

        if (prunedFeeds.feeds.length !== rssState.feeds.length) markUpdated("rss_feeds");
        if (prunedArticles.length !== rssState.articles.length) markUpdated("rss_articles");

        const vocabState = useVocabularyStore.getState();
        const prunedVocab = mergeVocabulary([], vocabState.vocabularyTerms, allTombstones);
        useVocabularyStore.setState({ vocabularyTerms: prunedVocab });
        if (prunedVocab.length !== vocabState.vocabularyTerms.length) markUpdated("vocabulary");
    }

    let currentLibState = useLibraryStore.getState();
    
    if (Object.keys(libraryPatch).length > 0) {
        currentLibState = { ...currentLibState, ...libraryPatch };
    }

    if (safeMap["books"] || perEntityBooks.length > 0) {
        try {
            const domainBooks = safeMap["books"]
                ? (() => { const p = JSON.parse(safeMap["books"]); return Array.isArray(p) ? p : []; })()
                : [];
            const incoming = [...domainBooks, ...perEntityBooks];
            if (incoming.length > 0) {
                debug(`[sync-merge] books: ${incoming.length} incoming (${domainBooks.length} domain + ${perEntityBooks.length} per-entity), ${currentLibState.books.length} existing`);
                const beforeBookMap = new Map(currentLibState.books.map(b => [b.id, b]));
                const incomingBookMap = new Map(incoming.map(b => [b.id, b]));
                const merged = mergeBooks(incoming, currentLibState.books, allTombstones);
                debug(`[sync-merge] books: ${merged.length} after merge (lost ${incoming.length + currentLibState.books.length - merged.length})`);
                if (merged !== currentLibState.books) {
                    
                    const hashToLocalId = new Map<string, string>();
                    for (const b of merged) {
                        if (!b.syncedWithoutFile && b.contentHash) {
                            hashToLocalId.set(b.contentHash, b.id);
                        }
                        if (!b.syncedWithoutFile && b.blobHash) {
                            hashToLocalId.set(b.blobHash, b.id);
                        }
                    }
                    const deduped = merged.filter(b => {
                        if (!b.syncedWithoutFile) return true;
                        const localId = (b.contentHash && hashToLocalId.get(b.contentHash))
                            ?? (b.blobHash && hashToLocalId.get(b.blobHash));
                        if (localId && localId !== b.id) {
                            debug(`[sync-merge] Dedup safety: removing syncedWithoutFile duplicate "${b.title}" (${b.id.substring(0,8)}...) — matches local book ${localId.substring(0,8)}...`);
                            return false;
                        }
                        return true;
                    });
                    const final = deduped.length !== merged.length ? deduped : merged;
                    applyLibraryPatch({ books: final });
                    markUpdated("books");
                    for (const book of final) {
                        if (beforeBookMap.has(book.id) && incomingBookMap.has(book.id)) {
                            const before = beforeBookMap.get(book.id)!;
                            if (before.progress !== book.progress || before.isFavorite !== book.isFavorite) {
                                const remoteWon = incomingBookMap.get(book.id)!;
                                recordConflict("book", book.id, remoteWon.progress === book.progress && remoteWon.lastReadAt === book.lastReadAt ? "remote" : "local", book.title);
                            }
                        }
                    }
                    currentLibState = { ...currentLibState, books: final };
                }

                const incomingWithCovers = (incoming as { id: string; coverPath?: string }[])
                    .filter((b) => b.coverPath && b.coverPath.startsWith("data:"));

                // Older peers still embed covers in book entries.
                for (const inc of incomingWithCovers) {
                    if (!incomingCovers.some((c) => c.id === inc.id)) {
                        incomingCovers.push({ id: inc.id, dataUrl: inc.coverPath! });
                    }
                }
            }
        } catch (e) {
        }
    }

    if (safeMap["annotations"] || perEntityAnnotations.length > 0) {
        try {
            const domainAnns = safeMap["annotations"]
                ? (() => { const p = JSON.parse(safeMap["annotations"]); return Array.isArray(p) ? p : []; })()
                : [];
            const incoming = [...domainAnns, ...perEntityAnnotations];
            if (incoming.length > 0) {
                const beforeIds = new Set(currentLibState.annotations.map(a => a.id));
                const beforeMap = new Map(currentLibState.annotations.map(a => [a.id, a]));
                const incomingMap = new Map(incoming.map(a => [a.id, a]));
                const incomingIds = new Set(incomingMap.keys());
                const merged = mergeAnnotations(incoming, currentLibState.annotations, allTombstones);
                if (merged !== currentLibState.annotations) {
                    applyLibraryPatch({ annotations: merged });
                    markUpdated("annotations");
                    for (const ann of merged) {
                        if (beforeIds.has(ann.id) && incomingIds.has(ann.id)) {
                            const before = beforeMap.get(ann.id);
                            if (before && JSON.stringify(before) !== JSON.stringify(ann)) {
                                const inc = incomingMap.get(ann.id);
                                const remoteWon = inc !== undefined && JSON.stringify(inc) === JSON.stringify(ann);
                                recordConflict("annotation", ann.id, remoteWon ? "remote" : "local", ann.selectedText?.slice(0, 40));
                            }
                        }
                    }
                }
                currentLibState = { ...currentLibState, annotations: merged };
            }
        } catch (e) {
        }
    }

    if (safeMap["collections"] || perEntityCollections.length > 0) {
        try {
            const domainCols = safeMap["collections"]
                ? (() => { const p = JSON.parse(safeMap["collections"]); return Array.isArray(p) ? p : []; })()
                : [];
            const incoming = [...domainCols, ...perEntityCollections];
            if (incoming.length > 0) {
                const merged = mergeCollections(incoming, currentLibState.collections, allTombstones);
                if (merged !== currentLibState.collections) {
                    applyLibraryPatch({ collections: merged });
                    markUpdated("collections");
                }
                currentLibState = { ...currentLibState, collections: merged };
            }
        } catch (e) {
        }
    }

    if (Object.keys(libraryPatch).length > 0) {
        useLibraryStore.setState(libraryPatch as Parameters<typeof useLibraryStore.setState>[0]);
    }

    if (incomingCovers.length > 0) {
        const updatedCovers = new Map<string, string>();
        for (const cover of incomingCovers) {
            try {
                const path = await applyIncomingCover(cover.id, cover.dataUrl);
                if (path) updatedCovers.set(cover.id, path);
            } catch {}
        }
        if (updatedCovers.size > 0) {
            for (const [id, path] of updatedCovers) {
                // Known to peers already: neither provisioning nor the live bridge re-sends it.
                _provisionedValues.set(coverEntryKey(id), path);
                _receivedCoverPaths.add(path);
            }
            useLibraryStore.setState((state) => ({
                books: state.books.map((book) => {
                    const path = updatedCovers.get(book.id);
                    return path ? { ...book, coverPath: path, coverExtractionDone: true } : book;
                }),
            }));
            markUpdated("covers");
        }
    }

    if (safeMap["vocabulary"]) {
        try {
            const incoming = JSON.parse(safeMap["vocabulary"]);
            if (Array.isArray(incoming)) {
                const current = useVocabularyStore.getState().vocabularyTerms;
                const merged = mergeVocabulary(incoming, current, allTombstones);
                const { upserts, deletes } = diffVocabularyForSqlite(current, merged);
                if (upserts.length > 0 || deletes.length > 0 || merged.length !== current.length) {
                    useVocabularyStore.setState({ vocabularyTerms: merged });
                    if (isTauri()) {
                        // Only what changed (was: every term, one IPC each, on every merge),
                        // and removals too, so deleted terms cannot resurrect on next launch.
                        for (const term of upserts) {
                            void sqliteSaveVocabularyTerm(toSqliteVocabularyTerm(term));
                        }
                        for (const id of deletes) {
                            void sqliteDeleteVocabularyTerm(id);
                        }
                    }
                    markUpdated("vocabulary");
                }
            }
        } catch (e) {
        }
    }

    if (safeMap["settings"]) {
        try {
            const raw = JSON.parse(safeMap["settings"]);
            const settingsStore = useSettingsStore.getState();
            
            const remoteUpdatedAt: string | undefined = raw._settingsUpdatedAt;
            const { _settingsUpdatedAt: _, ...remoteSettings } = raw;
            
            const remoteAsAppSettings = {
                ...remoteSettings,
                deviceSync: settingsStore.settings.deviceSync,
            };
            const merged = mergeSettings(
                remoteAsAppSettings,
                settingsStore.settings,
                remoteUpdatedAt,
                localSettingsUpdatedAt,
            );
            if (JSON.stringify(merged) !== JSON.stringify(settingsStore.settings)) {
                useSettingsStore.setState({ settings: merged });
                markUpdated("settings");
            }
        } catch (e) {
        }
    }

    if (safeMap["reading_stats"]) {
        try {
            const incoming = JSON.parse(safeMap["reading_stats"]);
            if (incoming && typeof incoming === "object") {
                const current = useSettingsStore.getState().stats;
                const merged = mergeReadingStats(incoming, current);
                if (JSON.stringify(merged) !== JSON.stringify(current)) {
                    useSettingsStore.setState({ stats: merged });
                    markUpdated("reading_stats");
                }
            }
        } catch (e) {
        }
    }

    let feedIdMap: Map<string, string> | undefined;

    if (safeMap["rss_feeds"]) {
        try {
            const incoming = JSON.parse(safeMap["rss_feeds"]);
            if (Array.isArray(incoming)) {
                const currentFeeds = useRssStore.getState().feeds;
                debug(`[sync-merge] rss_feeds: ${incoming.length} incoming, ${currentFeeds.length} existing`);
                const result = mergeRssFeeds(incoming, currentFeeds, allTombstones);
                debug(`[sync-merge] rss_feeds: ${result.feeds.length} after merge`);
                if (JSON.stringify(result.feeds) !== JSON.stringify(currentFeeds)) {
                    useRssStore.setState({ feeds: result.feeds });
                    markUpdated("rss_feeds");
                }
                feedIdMap = result.feedIdMap;
            }
        } catch (e) {
        }
    }

    if (safeMap["rss_articles"]) {
        try {
            const incoming = JSON.parse(safeMap["rss_articles"]);
            if (Array.isArray(incoming)) {
                const currentArticles = useRssStore.getState().articles;
                debug(`[sync-merge] rss_articles: ${incoming.length} incoming, ${currentArticles.length} existing`);
                const merged = mergeRssArticles(incoming, currentArticles, feedIdMap, allTombstones);
                debug(`[sync-merge] rss_articles: ${merged.length} after merge`);
                if (JSON.stringify(merged) !== JSON.stringify(currentArticles)) {
                    useRssStore.setState({ articles: merged });
                    markUpdated("rss_articles");
                }
            }
        } catch (e) {
        }
    }

    if (domainsUpdated.includes("rss_feeds") || domainsUpdated.includes("rss_articles")) {
        try {
            const currentRss = useRssStore.getState();
            
            const unreadByFeed = new Map<string, number>();
            for (const a of currentRss.articles) {
                if (!a.isRead && a.feedId) {
                    unreadByFeed.set(a.feedId, (unreadByFeed.get(a.feedId) ?? 0) + 1);
                }
            }
            const updatedFeeds = currentRss.feeds.map((feed) => ({
                ...feed,
                unreadCount: unreadByFeed.get(feed.id) ?? 0,
            }));
            useRssStore.setState({ feeds: updatedFeeds });
        } catch (e) {
        }
    }

    return { domainsUpdated, conflicts };
}

export interface SyncResult {
    success: boolean;
    domainsUpdated: string[];
    conflicts?: SyncConflict[];
    error?: string;
}

let _initialProvisionDone = false;
let _forceReProvision = false;
let _responderReadyPromise: Promise<void> | null = null;

// Track the last successful provision so clean sync rounds don't re-write
// every book/domain over IPC. Keyed by the serialized value; invalidated
// when the paired-device set changes or a re-provision is forced.
let _lastProvisionFingerprint = "";
const _provisionedValues = new Map<string, string>();

export function markProvisioningNeeded(): void {
    _initialProvisionDone = false;
    _forceReProvision = true;
    void clearProvisionedFlag();
}

const SYNC_PROVISIONED_KV_KEY = "theorem_sync_provisioned";

async function wasAlreadyProvisioned(): Promise<boolean> {
    if (_forceReProvision) return false;
    try {
        const { sqliteGetKv } = await import("./sqlite-storage");
        const val = await sqliteGetKv(SYNC_PROVISIONED_KV_KEY);
        return val === "true";
    } catch {
        return false;
    }
}

async function markProvisioned(): Promise<void> {
    try {
        const { sqliteSetKv } = await import("./sqlite-storage");
        await sqliteSetKv(SYNC_PROVISIONED_KV_KEY, "true");
    } catch {}
}

async function clearProvisionedFlag(): Promise<void> {
    try {
        const { sqliteDeleteKv } = await import("./sqlite-storage");
        await sqliteDeleteKv(SYNC_PROVISIONED_KV_KEY);
    } catch {}
}

export async function ensureResponderSyncReady(): Promise<void> {
    if (!isTauri()) {
        return;
    }

    if (_responderReadyPromise) {
        await _responderReadyPromise;
        return;
    }

    _responderReadyPromise = (async () => {
        
        for (let i = 0; i < 50; i++) { 
            const settingsReady = useSettingsStore.persist?.hasHydrated?.() ?? false;
            const libraryReady = useLibraryStore.persist?.hasHydrated?.() ?? false;
            const vocabReady = useVocabularyStore.persist?.hasHydrated?.() ?? true;
            const rssReady = useRssStore.persist?.hasHydrated?.() ?? true;
            if (settingsReady && libraryReady && vocabReady && rssReady) break;
            await new Promise(r => setTimeout(r, 100));
        }

        await irohStart();

        if (!_initialProvisionDone) {
            const alreadyDone = await wasAlreadyProvisioned();
            if (!alreadyDone) {
                
                _bridgePaused = true;
                try {
                    await provisionToIrohDocs();
                    await markProvisioned();
                } finally {
                    _bridgePaused = false;
                }
            } else {
                debug("[sync] Already provisioned — skipping re-provision");
            }
            _initialProvisionDone = true;
            _bridgePaused = false;  
        }

        if (!_docsLiveUnlisten) {
            _docsLiveUnlisten = await initDocsLiveListener();
        }
    })();

    try {
        await _responderReadyPromise;
    } finally {
        _responderReadyPromise = null;
        
        _bridgePaused = false;
    }
}

let _lastSyncPeerId: string | undefined;

export async function runDeviceSync(
    peerDeviceId: string,
    onProgress?: (msg: string) => void,
    notifyOnComplete = false,
): Promise<SyncResult> {
    if (_isMerging) {
        return { success: false, domainsUpdated: [], error: "Sync already in progress" };
    }
    _isMerging = true;
    _syncCancelled = false; 
    const log = (msg: string) => {
        onProgress?.(msg);
    };

    try {
        setStatus("syncing", "Preparing to sync...");
        log("Connecting to peer...");

        log("Starting P2P transport...");
        await ensureResponderSyncReady();

        {
            if (_syncCancelled) {
                throw new Error("Sync cancelled");
            }
            log("Provisioning local data to sync doc...");
            await provisionToIrohDocs();
        }

        log("Requesting data from peer...");
        setStatus("syncing", "Connecting to peer...");

        let syncResolve: (() => void) | null = null;
        const syncPromise = new Promise<void>((res) => { syncResolve = res; });
        let settled = false;
        const settle = () => { if (!settled) { settled = true; syncResolve?.(); } };

        let contentReadyUnlisten: (() => void) | null = null;
        let syncFinishedUnlisten: (() => void) | null = null;
        let _syncActivityDetected = false;
        const MAX_WAIT_SECS = 30;
        let settleSignals = 0;
        const signalSettle = () => {
            settleSignals++;
            if (settleSignals >= 2) settle();
        };

        log("Syncing with peer via iroh-docs...");
        setStatus("syncing", "Connected, receiving data...");

        try {
            const { listen: evListen } = await import("@tauri-apps/api/event");
            contentReadyUnlisten = await evListen("docs-pending-content-ready", () => {
                _syncActivityDetected = true;
                debug(`[sync] Received docs-pending-content-ready`);
                signalSettle();
            });
            syncFinishedUnlisten = await evListen("docs-sync-finished", () => {
                _syncActivityDetected = true;
                debug("[sync] Received docs-sync-finished");
                signalSettle();
            });
        } catch {}

        const docsSyncError = await docsSyncNow(peerDeviceId);
        if (docsSyncError) {
            log(`Warning: iroh-docs sync failed: ${docsSyncError}`);
            const isOffline = docsSyncError.includes("offline") || docsSyncError.includes("timeout");
            const errorMsg = isOffline
                ? `Peer is offline — try again later`
                : docsSyncError;
            setStatus("error", errorMsg);
            contentReadyUnlisten?.();
            syncFinishedUnlisten?.();
            return { success: false, domainsUpdated: [], error: errorMsg };
        }

        const timeoutId = setTimeout(() => { settle(); }, MAX_WAIT_SECS * 1000);

        await syncPromise;
        clearTimeout(timeoutId);
        contentReadyUnlisten?.();
        syncFinishedUnlisten?.();

        const changedDomains = new Set<string>();
        const changedConflicts: SyncConflict[] = [];

        {
            const updated = await hydrateFromIrohDocs();
            for (const d of updated) changedDomains.add(d);
        }
        if (_syncCancelled) {
            log("Sync cancelled before final merge");
            return { success: false, domainsUpdated: [], error: "Sync cancelled" };
        }

        const liveEntries: Record<string, string> = {};
        for (const [k, v] of _pendingDocsEntries) {
            liveEntries[k] = v;
        }
        _pendingDocsEntries.clear();
        if (Object.keys(liveEntries).length > 0) {
            const { domainsUpdated, conflicts } = await mergeIncomingData(liveEntries);
            for (const d of domainsUpdated) changedDomains.add(d);
            changedConflicts.push(...conflicts);
        }
        
        if (_progressiveBookTimer) clearTimeout(_progressiveBookTimer);
        _flushProgressiveBooks();

        const postWaitBooks = useLibraryStore.getState().books.length;
        debug(`[sync] After wait: ${postWaitBooks} books`);

        if (_syncCancelled) {
            log("Sync cancelled after metadata sync");
            _syncCancelled = false;
            return { success: false, domainsUpdated: [], error: "Sync cancelled" };
        }

        const pendingDownloads = useLibraryStore.getState().books.filter(b => b.syncedWithoutFile === true && b.blobHash).length;
        if (pendingDownloads > 0) {
            log(`${pendingDownloads} book(s) available for on-demand download`);
        }

        if (_syncCancelled) {
            _syncCancelled = false;
            log("Sync cancelled");
            setStatus("idle", "Sync cancelled");
            return { success: false, domainsUpdated: [], error: "Sync cancelled" };
        }

        const domainLabels: Record<string, string> = {
            books: "Books",
            annotations: "Annotations",
            collections: "Collections",
            deletion_tombstones: "Deletions",
            vocabulary: "Vocabulary",
            rss_feeds: "Feeds",
            rss_articles: "Articles",
            settings: "Settings",
            reading_stats: "Stats",
        };

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
                    const label = domainLabels[d] || d;
                    const count = counts[d];
                    return count !== undefined ? `${count} ${label}` : label;
                })
                .join(", ");
            summary = `Synced: ${parts}`;
            if (changedConflicts.length > 0) {
                summary += ` · ${changedConflicts.length} conflict(s) resolved`;
            }
        } else if (pendingDownloads > 0) {
            summary = `Metadata synced, ${pendingDownloads} files available for download`;
        } else if (!_syncActivityDetected) {
            
            summary = "Peer offline";
        } else {
            
            summary = "No data received — peer may not be sharing";
        }

        log(`Sync complete. ${summary}`);
        if (_syncActivityDetected || changedDomains.size > 0) {
            setStatus("synced", summary);
            _lastSyncPeerId = peerDeviceId;

            if (notifyOnComplete) {
                const { resolveNotificationIcon } = await import("./notifications");
                const successIcon = await resolveNotificationIcon("notify-success.png");
                void notifySync("Sync Complete", summary, successIcon);
            }
            
            void prefetchRecentBooks(peerDeviceId);
        } else {
            setStatus("error", summary);
            if (notifyOnComplete) {
                void notifySync("Sync Issue", summary);
            }
        }
        _dataDirty = false;

        return { success: true, domainsUpdated: [...changedDomains], conflicts: changedConflicts.length > 0 ? changedConflicts : undefined };
    } catch (error: unknown) {
        const errMsg = error instanceof Error ? error.message : String(error);
        log(`Sync failed: ${errMsg}`);
        setStatus("error", errMsg);
        if (notifyOnComplete) {
            void notifySync("Sync Error", errMsg);
        }
        return { success: false, domainsUpdated: [], error: errMsg };
    } finally {
        _isMerging = false;
    }
}

let _isMerging = false;

let _syncCancelled = false;

let _bridgePaused = true;

export function cancelRunningSync(): void {
    _syncCancelled = true;
    if (_progressiveBookTimer) clearTimeout(_progressiveBookTimer);
    _progressiveBookBatch = [];
    useUIStore.getState().setDownloadingBook(undefined);
    setStatus("idle", "Sync cancelled");
    debug("[sync] Cancel requested — _syncCancelled = true");
}

export async function downloadBookOnDemand(bookId: string): Promise<boolean> {
    if (!isTauri()) return false;

    setStatus("syncing", "Downloading book...");
    useUIStore.getState().setDownloadingBook(bookId);
    const { downloadBookFile, getPairedDevices } = await import("./device-sync");
    const { appDataDir } = await import("@tauri-apps/api/path");
    const appDir = await appDataDir();
    const destPath = `${appDir}/book-cache/${bookId}.book`;

    const peerIds: string[] = [];
    if (_lastSyncPeerId) peerIds.push(_lastSyncPeerId);
    const devices = await getPairedDevices().catch(() => []);
    for (const d of devices) {
        if (!peerIds.includes(d.deviceId)) peerIds.push(d.deviceId);
    }

    if (peerIds.length === 0) {
        console.warn(`[file-xfer] No paired devices found to download ${bookId}`);
        useUIStore.getState().setDownloadingBook(undefined);
        setStatus("idle", "Book download failed — no paired devices");
        return false;
    }

    for (const peerId of peerIds) {
        if (_syncCancelled) break;
        try {
            debug(`[file-xfer] Attempting download of ${bookId} from peer ${peerId}...`);
            await downloadBookFile(peerId, bookId, destPath);
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
            useUIStore.getState().setDownloadingBook(undefined);
            setStatus("synced", "Book downloaded");
            return true;
        } catch (e) {
            const errStr = String(e);
            console.error(`[file-xfer] download failed for ${bookId} from ${peerId}: ${errStr}`);
            if (errStr.includes("PEER_BOOK_DELETED")) {
                console.warn(`[file-xfer] Book ${bookId} was deleted on peer; purging ghost card locally`);
                useLibraryStore.getState().removeBook(bookId);
                useUIStore.getState().setDownloadingBook(undefined);
                setStatus("idle", "Book was deleted on peer");
                return false;
            }
        }
    }
    useUIStore.getState().setDownloadingBook(undefined);
    setStatus("idle", "Book download failed — peer not available");
    return false;
}

async function prefetchRecentBooks(peerDeviceId: string): Promise<void> {
    const { downloadBookFile } = await import("./device-sync");
    const { appDataDir } = await import("@tauri-apps/api/path");
    const appDir = await appDataDir();

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
            while (index < books.length && !_syncCancelled) {
                const book = books[index++];
                const destPath = `${appDir}/book-cache/${book.id}.book`;
                try {
                    await downloadBookFile(peerDeviceId, book.id, destPath);
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
                } catch {
                    // download failed silently for prefetch — will retry on-demand
                }
            }
        }),
    );
}

let _docsLiveTimer: ReturnType<typeof setTimeout> | null = null;
const MAX_PENDING_ENTRIES = 2000;
const _pendingDocsEntries = new Map<string, string>();

const DOWNLOAD_CONCURRENCY = 3;

let _progressiveBookBatch: any[] = [];
let _progressiveBookTimer: ReturnType<typeof setTimeout> | null = null;

// Annotations and collections ride the same progressive-batch pattern as
// books: per-entry synchronous merges + setStates inside the gossip event
// loop froze the UI (up to 64 full O(n) merges + store notifications per
// batch). Batches coalesce over 200ms into one merge + one setState each.
let _progressiveAnnoBatch: any[] = [];
let _progressiveAnnoTimer: ReturnType<typeof setTimeout> | null = null;
let _progressiveCollectionBatch: any[] = [];
let _progressiveCollectionTimer: ReturnType<typeof setTimeout> | null = null;

// Tombstone application re-merges the whole library and replaces three
// slices at once; it is never latency-sensitive, so it trails the event
// loop and runs idle. Latest value wins.
let _pendingTombstonesValue: string | null = null;
let _pendingTombstonesTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleIdleTask(task: () => void): void {
    if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(() => task(), { timeout: 1500 });
    } else {
        setTimeout(task, 0);
    }
}

// Order-preserving merges keep untouched refs in place, so index-wise
// reference equality certifies "nothing changed" in O(n) cheap ops.
function isSameOrderedList(a: Array<{ id: string }>, b: Array<{ id: string }>): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

function _flushProgressiveBooks() {
    if (_progressiveBookBatch.length === 0) return;
    const batch = _progressiveBookBatch.splice(0);
    const state = useLibraryStore.getState();
    const beforeBooks = state.books;
    const merged = mergeBooks(batch, beforeBooks, state.deletionTombstones);

    if (merged.length === beforeBooks.length) {
        let changed = false;
        for (let i = 0; i < merged.length; i++) {
            if (merged[i] !== beforeBooks[i] || merged[i].id !== beforeBooks[i].id) {
                changed = true;
                break;
            }
        }
        if (!changed) return;
    }

    useLibraryStore.setState({ books: merged });

    if (!_syncCancelled) {
        const newCount = merged.length - beforeBooks.length;
        if (newCount > 0) {
            setStatus("syncing", `${newCount} books received`);
        }
    }

    const mergedById = new Map(merged.map((b: any) => [b.id, b]));
    for (const book of batch) {
        const added = mergedById.get(book.id);
        if (added && !added.blobHash) {
            debug(`[sync] No blobHash for: ${book.title || book.id} — peer hasn't provisioned this blob`);
        }
    }
}

function _flushProgressiveAnnos() {
    if (_progressiveAnnoBatch.length === 0) return;
    const batch = _progressiveAnnoBatch.splice(0);
    const state = useLibraryStore.getState();
    const beforeAnns = state.annotations;
    const merged = mergeAnnotations(batch, beforeAnns, state.deletionTombstones);
    if (isSameOrderedList(merged, beforeAnns)) return;
    useLibraryStore.setState({ annotations: merged });
}

function _flushProgressiveCollections() {
    if (_progressiveCollectionBatch.length === 0) return;
    const batch = _progressiveCollectionBatch.splice(0);
    const state = useLibraryStore.getState();
    const beforeCols = state.collections;
    const merged = mergeCollections(batch, beforeCols, state.deletionTombstones);
    if (isSameOrderedList(merged, beforeCols)) return;
    useLibraryStore.setState({ collections: merged });
}

function _flushPendingTombstones() {
    const value = _pendingTombstonesValue;
    _pendingTombstonesValue = null;
    if (value == null) return;
    try {
        const incoming = JSON.parse(value);
        if (Array.isArray(incoming)) {
            const state = useLibraryStore.getState();
            const mergedTombstones = mergeTombstones(incoming, state.deletionTombstones);
            const prunedBooks = mergeBooks([], state.books, mergedTombstones);
            const prunedAnns = mergeAnnotations([], state.annotations, mergedTombstones);
            const prunedCols = mergeCollections([], state.collections, mergedTombstones);
            useLibraryStore.setState({
                deletionTombstones: mergedTombstones,
                books: prunedBooks,
                annotations: prunedAnns,
                collections: prunedCols,
            });
        }
    } catch {}
}

export async function initDocsLiveListener(): Promise<() => void> {
    if (!isTauri()) {
        return () => {};
    }

    if (_docsLiveUnlisten) {
        return _docsLiveUnlisten;
    }

    const { listen } = await import("@tauri-apps/api/event");

    const _processPendingDocs = async () => {
        if (_isMerging) {
            _docsLiveTimer = setTimeout(_processPendingDocs, 500);
            return;
        }
        const entries: Record<string, string> = {};
        for (const [k, v] of _pendingDocsEntries) {
            entries[k] = v;
        }
        _pendingDocsEntries.clear();
        await mergeIncomingData(entries);
    };

    // The Rust side batches remote doc entries (deduped per key, flushed every
    // ~300ms or 64 entries) so a bulk sync crosses the IPC bridge in a few
    // `docs-entry-batch` events instead of one event per entry.
    const handleIncomingEntry = (key: string, value: string) => {
        if (isSelfOriginatedKey(key)) {
            return;
        }

        if (key === "deletion_tombstones") {
            // Latest value wins; the full-library re-merge runs idle.
            _pendingTombstonesValue = value;
            if (_pendingTombstonesTimer) clearTimeout(_pendingTombstonesTimer);
            _pendingTombstonesTimer = setTimeout(() => {
                _pendingTombstonesTimer = null;
                scheduleIdleTask(_flushPendingTombstones);
            }, 500);
            return;
        }

        if (key.startsWith("book:")) {
            try {
                const parsed = JSON.parse(value);
                if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && parsed.id) {
                    _progressiveBookBatch.push(parsed);
                    if (_progressiveBookTimer) clearTimeout(_progressiveBookTimer);
                    _progressiveBookTimer = setTimeout(_flushProgressiveBooks, 200);
                }
            } catch {}
            return;
        }
        if (key.startsWith("annotation:") || key.startsWith("anno:")) {
            try {
                const parsed = JSON.parse(value);
                if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && parsed.id) {
                    _progressiveAnnoBatch.push(parsed);
                    if (_progressiveAnnoTimer) clearTimeout(_progressiveAnnoTimer);
                    _progressiveAnnoTimer = setTimeout(_flushProgressiveAnnos, 200);
                }
            } catch {}
            return;
        }
        if (key.startsWith("collection:")) {
            try {
                const parsed = JSON.parse(value);
                if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && parsed.id) {
                    _progressiveCollectionBatch.push(parsed);
                    if (_progressiveCollectionTimer) clearTimeout(_progressiveCollectionTimer);
                    _progressiveCollectionTimer = setTimeout(_flushProgressiveCollections, 200);
                }
            } catch {}
            return;
        }

        _pendingDocsEntries.set(key, value);
        if (_pendingDocsEntries.size > MAX_PENDING_ENTRIES) {

            if (_docsLiveTimer) clearTimeout(_docsLiveTimer);
            _processPendingDocs();
            return;
        }
        if (_docsLiveTimer) clearTimeout(_docsLiveTimer);
        _docsLiveTimer = setTimeout(_processPendingDocs, 500);
    };

    const rawUnlisten = await listen<{ entries: { key: string; value: string }[] }>("docs-entry-batch", (event) => {
        for (const { key, value } of event.payload.entries) {
            handleIncomingEntry(key, value);
        }
    });

    _docsLiveUnlisten = () => {
        rawUnlisten();
        if (_docsLiveTimer) clearTimeout(_docsLiveTimer);
        _docsLiveTimer = null;
        if (_progressiveBookTimer) clearTimeout(_progressiveBookTimer);
        _progressiveBookTimer = null;
        _progressiveBookBatch = [];
        if (_progressiveAnnoTimer) clearTimeout(_progressiveAnnoTimer);
        _progressiveAnnoTimer = null;
        _progressiveAnnoBatch = [];
        if (_progressiveCollectionTimer) clearTimeout(_progressiveCollectionTimer);
        _progressiveCollectionTimer = null;
        _progressiveCollectionBatch = [];
        if (_pendingTombstonesTimer) clearTimeout(_pendingTombstonesTimer);
        _pendingTombstonesTimer = null;
        _pendingTombstonesValue = null;
        _pendingDocsEntries.clear();
        _docsLiveUnlisten = null;
    };

    return _docsLiveUnlisten;
}

const AUTO_SYNC_INTERVAL_MS = 2 * 60 * 1000; 

const STARTUP_SYNC_DELAY_MS = 5000;

const MUTATION_SYNC_DEBOUNCE_MS = 2000;
/** Cover paths that arrived from a peer: the live bridge must not echo them back. */
const _receivedCoverPaths = new Set<string>();
const READING_SYNC_THROTTLE_MS = 30_000;

let _autoSyncTimer: ReturnType<typeof setInterval> | null = null;
let _mutationSyncTimer: ReturnType<typeof setTimeout> | null = null;
let _autoSyncCleanups: Array<() => void> = [];
let _isAutoSyncing = false;
let _dataDirty = false;

async function autoSyncRound(force = false): Promise<void> {
    if (!isTauri() || _isAutoSyncing) return;
    if (!force && !_dataDirty) return; 

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
        
        _dataDirty = !anyPeerSynced;
    } catch {
        
    } finally {
        _isAutoSyncing = false;
    }
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

    _dataDirty = true;

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
            
            _dataDirty = true;
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

    let lastVisibilitySync = 0;
    const VISIBILITY_COOLDOWN_MS = 30_000;
    const onVisibilityChange = () => {
        if (document.visibilityState === "visible") {
            const now = Date.now();
            if (now - lastVisibilitySync < VISIBILITY_COOLDOWN_MS) return;
            lastVisibilitySync = now;
            void autoSyncRound(true);
        }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    cleanups.push(() => document.removeEventListener("visibilitychange", onVisibilityChange));

    if (isTauri()) {
        try {
            const { listen } = await import("@tauri-apps/api/event");
            const unlisten = await listen("tray-sync-now", () => {
                void autoSyncRound(true); 
            });
            cleanups.push(unlisten);
        } catch {
            
        }
    }

    if (isTauri()) {
        try {
            const unlisten = await initDocsLiveListener();
            cleanups.push(unlisten);
        } catch {
            
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
                } catch {
                    
                }
            });
            cleanups.push(peerOnlineUnlisten);
        } catch {
            
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
        } catch {
            
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
        } catch {
            
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
    _dataDirty = false;
}

export async function docsCreateSyncDoc(peerDeviceId: string): Promise<string | null> {
    try {
        const { invoke } = await import("@tauri-apps/api/core");
        return await invoke<string>("docs_create_sync_doc", { peerDeviceId });
    } catch { return null; }
}

export async function docsImportSyncDoc(
    peerDeviceId: string,
    ticket: string,
): Promise<boolean> {
    try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("docs_import_sync_doc", { peerDeviceId, ticketStr: ticket });
        return true;
    } catch { return false; }
}

export async function docsSetEntry(key: string, value: string): Promise<boolean> {
    try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("docs_set_entry", { key, value });
        return true;
    } catch { return false; }
}

export async function docsGetAllEntries(): Promise<Record<string, string> | null> {
    try {
        const { invoke } = await import("@tauri-apps/api/core");
        return await invoke<Record<string, string>>("docs_get_all_entries");
    } catch { return null; }
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

export async function provisionToIrohDocs(): Promise<boolean> {
    try {
        const lib = useLibraryStore.getState();
        const vocab = useVocabularyStore.getState();
        const rss = useRssStore.getState();
        const settings = useSettingsStore.getState();

        const { getPairedDevices } = await import("./device-sync");
        const devices = await getPairedDevices().catch(() => []);
        const fingerprint = devices.map((d) => d.deviceId).sort().join("|");

        // A new/changed peer set or a doc re-import means peers may be missing
        // our entries, so write everything rather than only the deltas.
        // The per-key _provisionedValues cache below avoids re-writing unchanged data
        // while allowing mutations (e.g. reading progress updates) to push to iroh-docs.
        if (fingerprint !== _lastProvisionFingerprint || _forceReProvision) {
            _provisionedValues.clear();
        }
        _lastProvisionFingerprint = fingerprint;
        _forceReProvision = false;

        const serializeBook = (book: typeof lib.books[number]) => {
            const { filePath: _f, storagePath: _s, coverPath, locations: _l, ...stripped } = book;
            return JSON.stringify({
                ...stripped,
                ...(book.blobHash ? { blobHash: book.blobHash } : {}),
                ...(book.coverBlobHash ? { coverBlobHash: book.coverBlobHash } : {}),
                ...(coverPathForBookEntry(coverPath) ? { coverPath: coverPathForBookEntry(coverPath) } : {}),
            });
        };

        const bookErrors: string[] = [];
        for (const book of lib.books) {
            try {
                const key = `book:${book.id}`;
                const serialized = serializeBook(book);
                if (_provisionedValues.get(key) === serialized) continue;
                markSelfOriginated(key);
                const ok = await docsSetEntry(key, serialized);
                if (ok) {
                    _provisionedValues.set(key, serialized);
                } else {
                    const msg = `book ${book.id} (${book.title || "unknown"}): write failed`;
                    bookErrors.push(msg);
                }
            } catch (e) {
                const msg = `book ${book.id} (${book.title || "unknown"}): ${e}`;
                bookErrors.push(msg);
                console.error(`[sync] Failed to provision ${msg}`);
            }
        }

        // Covers travel as their own entries, re-sent only when the cover changes.
        for (const book of lib.books) {
            if (!needsCoverEntry(book.coverPath)) continue;
            const key = coverEntryKey(book.id);
            if (_provisionedValues.get(key) === book.coverPath) continue;
            try {
                const entry = await buildCoverEntry(book.id);
                if (!entry) continue;
                markSelfOriginated(key);
                if (await docsSetEntry(key, entry)) _provisionedValues.set(key, book.coverPath!);
            } catch {
                // A missing cover must not fail provisioning.
            }
        }

        const domains: Array<{ name: string; key: string; payload: string }> = [
            { name: "annotations", key: "annotations", payload: JSON.stringify(lib.annotations) },
            { name: "collections", key: "collections", payload: JSON.stringify(lib.collections) },
            { name: "deletion_tombstones", key: "deletion_tombstones", payload: JSON.stringify(lib.deletionTombstones) },
            { name: "vocabulary", key: "vocabulary", payload: JSON.stringify(vocab.vocabularyTerms) },
            { 
                name: "settings", key: "settings", 
                payload: JSON.stringify({ ...settings.settings,
                    _settingsUpdatedAt: settings.settingsLastModifiedAt || new Date().toISOString(),
                }) 
            },
            { name: "reading_stats", key: "reading_stats", payload: JSON.stringify(settings.stats) },
            { name: "rss_feeds", key: "rss_feeds", payload: JSON.stringify(rss.feeds) },
            { name: "rss_articles", key: "rss_articles", payload: JSON.stringify(rss.articles) },
        ];

        const domainErrors: string[] = [];
        for (const { name, key, payload } of domains) {
            try {
                if (_provisionedValues.get(key) === payload) continue;
                markSelfOriginated(key);
                const ok = await docsSetEntry(key, payload);
                if (ok) {
                    _provisionedValues.set(key, payload);
                } else {
                    const msg = `${name} (${payload.length} bytes): write failed`;
                    domainErrors.push(msg);
                }
            } catch (e) {
                const msg = `${name} (${payload.length} bytes): ${e}`;
                domainErrors.push(msg);
                console.error(`[sync] Failed to provision ${msg}`);
            }
        }

        if (domainErrors.length > 0 || bookErrors.length > 0) {
            const allErrors = [...bookErrors, ...domainErrors];
            console.error(`[sync] Provision completed with ${allErrors.length} error(s):`, allErrors);
        }

        return true;
    } catch (e) {
        console.error(`[sync] Provision failed (unexpected): ${e}`);
        return false;
    }
}

export async function hydrateFromIrohDocs(): Promise<string[]> {
    const domainsUpdated: string[] = [];
    try {
        const entries = await docsGetAllEntries();
        if (!entries || Object.keys(entries).length === 0) return domainsUpdated;

        if (isTauri()) {
            try {
                await invokeSqliteInOrder("sqlite_merge_sync_entries", { entries });
            } catch (err) {
                if (import.meta.env.DEV) {
                    console.warn("[sync] Native sqlite_merge_sync_entries failed, falling back to JS merge:", err);
                }
            }
        }

        const localSettingsUpdatedAt = useSettingsStore.getState().settingsLastModifiedAt || new Date().toISOString();
        const { domainsUpdated: merged } = await mergeIncomingData(
            entries,
            localSettingsUpdatedAt,
        );
        return merged;
    } catch {}

    return domainsUpdated;
}

const _docsDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const DOCS_DEBOUNCE_MS = 500;

const _selfOriginatedKeys = new Set<string>();
const SELF_ORIGINATED_KEY_TTL_MS = 8000;

function isSelfOriginatedKey(key: string): boolean {
    return _selfOriginatedKeys.has(key);
}

function markSelfOriginated(key: string): void {
    _selfOriginatedKeys.add(key);
    setTimeout(() => _selfOriginatedKeys.delete(key), SELF_ORIGINATED_KEY_TTL_MS);
}

function scheduleDocsWrite(domain: string, fn: () => void, selfOriginatedKey?: string): void {
    if (selfOriginatedKey) {
        markSelfOriginated(selfOriginatedKey);
    }
    const existing = _docsDebounceTimers.get(domain);
    if (existing) clearTimeout(existing);
    _docsDebounceTimers.set(domain, setTimeout(() => {
        _docsDebounceTimers.delete(domain);
        fn();
    }, DOCS_DEBOUNCE_MS));
}

export function subscribeZustandToIrohDocs(): () => void {
    const unsubs: (() => void)[] = [];

    let prevBooks = useLibraryStore.getState().books;
    let prevAnnotations = useLibraryStore.getState().annotations;
    let prevCollections = useLibraryStore.getState().collections;
    let prevTombstones = useLibraryStore.getState().deletionTombstones;

    const serializeBook = (book: ReturnType<typeof useLibraryStore.getState>["books"][number]) => {
        const { filePath: _f, storagePath: _s, coverPath, locations: _l, ...stripped } = book;
        return JSON.stringify({
            ...stripped,
            ...(book.blobHash ? { blobHash: book.blobHash } : {}),
            ...(book.coverBlobHash ? { coverBlobHash: book.coverBlobHash } : {}),
            ...(coverPathForBookEntry(coverPath) ? { coverPath: coverPathForBookEntry(coverPath) } : {}),
        });
    };

    // Persistent identity indexes: id -> { ref, serialized }. Zustand
    // immutable updates preserve object identity for untouched entities,
    // so a reference check skips re-serialization in O(1) without touching
    // the payload. Per notification this is one linear pass of cheap
    // pointer comparisons plus one JSON.stringify per actually-changed
    // entity — optimal for action-agnostic diffing (exact blind diff has
    // an Omega(n) lower bound: any skipped slot could hide a change).
    // Stale entries from deleted ids are harmless: a re-added id fails the
    // ref check and is treated as changed. They are swept only when the
    // index outgrows the array, i.e. deletions happened (rare).
    const bookIndex = new Map<string, { ref: unknown; serialized: string }>();
    const annoIndex = new Map<string, { ref: unknown; serialized: string }>();
    const collectionIndex = new Map<string, { ref: unknown; serialized: string }>();
    // Persistent membership for exact deletion detection (a same-size
    // delete+add must still trigger the full-doc rewrite).
    let prevAnnoIds = new Set(useLibraryStore.getState().annotations.map(a => a.id));
    let prevCollectionIds = new Set(useLibraryStore.getState().collections.map(c => c.id));

    function sweepStaleIndex(
        index: Map<string, { ref: unknown; serialized: string }>,
        liveIds: Set<string>,
    ): void {
        for (const id of index.keys()) {
            if (!liveIds.has(id)) index.delete(id);
        }
    }

    unsubs.push(useLibraryStore.subscribe((state) => {
        if (_bridgePaused) return;  
        if (state.books !== prevBooks) {
            prevBooks = state.books;

            for (const book of state.books) {
                const entry = bookIndex.get(book.id);
                if (entry && entry.ref === book) continue;
                // An existing cover changed (edit, re-extraction): send it. First-time
                // covers (hydration, new imports) go out with the next provisioning.
                const previousCover = (entry?.ref as { coverPath?: string } | undefined)?.coverPath;
                if (previousCover && book.coverPath !== previousCover && needsCoverEntry(book.coverPath)
                    && !_receivedCoverPaths.has(book.coverPath!)) {
                    const coverKey = coverEntryKey(book.id);
                    const coverPath = book.coverPath!;
                    scheduleDocsWrite(coverKey, () => {
                        void buildCoverEntry(book.id).then((value) => {
                            if (value) return docsSetEntry(coverKey, value).then((ok) => { if (ok) _provisionedValues.set(coverKey, coverPath); });
                        });
                    }, coverKey);
                }
                const serialized = serializeBook(book);
                if (!entry || entry.serialized !== serialized) {
                    bookIndex.set(book.id, { ref: book, serialized });
                    scheduleDocsWrite("book:" + book.id, () =>
                        docsSetEntry("book:" + book.id, serialized), "book:" + book.id);
                } else {
                    entry.ref = book;
                }
            }
            if (bookIndex.size > state.books.length) {
                sweepStaleIndex(bookIndex, new Set(state.books.map(b => b.id)));
            }
        }
        if (state.annotations !== prevAnnotations) {
            prevAnnotations = state.annotations;
            const annotations = state.annotations;
            const seenAnnoIds = new Set<string>();
            for (const ann of annotations) {
                seenAnnoIds.add(ann.id);
                const entry = annoIndex.get(ann.id);
                if (entry && entry.ref === ann) continue;
                const serialized = JSON.stringify(ann);
                if (!entry || entry.serialized !== serialized) {
                    annoIndex.set(ann.id, { ref: ann, serialized });
                    const annoKey = "anno:" + (ann.bookId || "global") + ":" + ann.id;
                    scheduleDocsWrite(annoKey, () =>
                        docsSetEntry(annoKey, serialized), annoKey);
                } else {
                    entry.ref = ann;
                }
            }
            // Exact deletion detection against persistent membership: a
            // same-size delete+add must still trigger the full-doc rewrite.
            let annoDeletion = false;
            for (const id of prevAnnoIds) {
                if (!seenAnnoIds.has(id)) { annoDeletion = true; break; }
            }
            prevAnnoIds = seenAnnoIds;
            if (annoDeletion) {
                scheduleDocsWrite("annotations", () =>
                    docsSetEntry("annotations", JSON.stringify(annotations)), "annotations");
            }
            if (annoIndex.size > annotations.length) {
                sweepStaleIndex(annoIndex, seenAnnoIds);
            }
        }
        if (state.collections !== prevCollections) {
            prevCollections = state.collections;
            const collections = state.collections;
            const seenCollectionIds = new Set<string>();
            for (const col of collections) {
                seenCollectionIds.add(col.id);
                const entry = collectionIndex.get(col.id);
                if (entry && entry.ref === col) continue;
                const serialized = JSON.stringify(col);
                if (!entry || entry.serialized !== serialized) {
                    collectionIndex.set(col.id, { ref: col, serialized });
                    scheduleDocsWrite("collection:" + col.id, () =>
                        docsSetEntry("collection:" + col.id, serialized), "collection:" + col.id);
                } else {
                    entry.ref = col;
                }
            }
            let collectionDeletion = false;
            for (const id of prevCollectionIds) {
                if (!seenCollectionIds.has(id)) { collectionDeletion = true; break; }
            }
            prevCollectionIds = seenCollectionIds;
            if (collectionDeletion) {
                scheduleDocsWrite("collections", () =>
                    docsSetEntry("collections", JSON.stringify(collections)), "collections");
            }
            if (collectionIndex.size > collections.length) {
                sweepStaleIndex(collectionIndex, seenCollectionIds);
            }
        }
        if (state.deletionTombstones !== prevTombstones) {
            prevTombstones = state.deletionTombstones;
            scheduleDocsWrite("deletion_tombstones", () =>
                docsSetEntry("deletion_tombstones", JSON.stringify(state.deletionTombstones)), "deletion_tombstones");
        }
    }));

    let prevVocab = useVocabularyStore.getState().vocabularyTerms;
    unsubs.push(useVocabularyStore.subscribe((state) => {
        if (_bridgePaused) return;
        if (state.vocabularyTerms !== prevVocab) {
            prevVocab = state.vocabularyTerms;
            scheduleDocsWrite("vocabulary", () => docsSetEntry("vocabulary", JSON.stringify(state.vocabularyTerms)), "vocabulary");
        }
    }));

    let prevFeeds = useRssStore.getState().feeds;
    let prevArticles = useRssStore.getState().articles;
    unsubs.push(useRssStore.subscribe((state) => {
        if (_bridgePaused) return;
        if (state.feeds !== prevFeeds) {
            prevFeeds = state.feeds;
            scheduleDocsWrite("rss_feeds", () => docsSetEntry("rss_feeds", JSON.stringify(state.feeds)), "rss_feeds");
        }
        if (state.articles !== prevArticles) {
            prevArticles = state.articles;
            scheduleDocsWrite("rss_articles", () => docsSetEntry("rss_articles", JSON.stringify(state.articles)), "rss_articles");
        }
    }));

    let prevSettings = useSettingsStore.getState().settings;
    let prevStats = useSettingsStore.getState().stats;
    unsubs.push(useSettingsStore.subscribe((state) => {
        if (_bridgePaused) return;
        if (state.settings !== prevSettings) {
            prevSettings = state.settings;
            scheduleDocsWrite("settings", () => docsSetEntry("settings", JSON.stringify({
                ...state.settings,
                _settingsUpdatedAt: useSettingsStore.getState().settingsLastModifiedAt || new Date().toISOString(),
            })), "settings");
        }
        if (state.stats !== prevStats) {
            prevStats = state.stats;
            scheduleDocsWrite("reading_stats", () => docsSetEntry("reading_stats", JSON.stringify(state.stats)), "reading_stats");
        }
    }));

    return () => {
        for (const unsub of unsubs) unsub();
        for (const t of _docsDebounceTimers.values()) clearTimeout(t);
        _docsDebounceTimers.clear();
    };
}
