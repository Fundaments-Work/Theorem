
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
    fromSqliteVocabularyTerm,
} from "../store";
import type { Annotation, Book, DeletionTombstone, DeviceSyncStatus, RssArticle, SyncConflict } from "../types";
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
import {
    sqliteDeleteAnnotation,
    sqliteDeleteVocabularyTerm,
    sqliteGetAllAnnotations,
    sqliteGetVocabularyTerms,
    sqliteMergeSyncEntries,
    sqliteRegisterMaterializedBook,
    sqliteSaveBookMetadata,
    sqliteSaveVocabularyTerm,
    sqliteUpsertAnnotation,
    type SyncMergeResult,
} from "./sqlite-storage";
import { diffVocabularyForSqlite } from "./vocab-sqlite-diff";
import { applyIncomingCover, buildCoverEntry, COVER_KEY_PREFIX, coverEntryKey, coverPathForBookEntry, needsCoverEntry, parseCoverEntry } from "./sync-covers";

/** Sync entry key prefix for one RSS article (`rss_article:<id>`). */
export const RSS_ARTICLE_KEY_PREFIX = "rss_article:";

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
let _docsLiveInit: Promise<() => void> | null = null;

// ── Merge serialization ────────────────────────────────────────────────────
// Every merge (full round, live batch, progressive flush) runs through this
// one promise chain, so two merges never read a snapshot, await, and then
// overwrite each other's result.
let _mergeChain: Promise<unknown> = Promise.resolve();

function withMergeLock<T>(task: () => T | Promise<T>): Promise<T> {
    const run = _mergeChain.then(task, task);
    _mergeChain = run.catch(() => undefined);
    return run;
}

// While > 0, store changes come from a merge of peer data: the Zustand→docs
// bridge keeps its indexes current but does not write them back to the doc.
let _applyingRemote = 0;

function applyRemote(fn: () => void): void {
    _applyingRemote++;
    try {
        fn();
    } finally {
        _applyingRemote--;
    }
}

/**
 * Re-applies a merged list onto the store's *current* list. `base` is what the
 * merge read; anything the user changed, added or removed since then (during
 * the merge's awaits) is kept rather than overwritten by the stale snapshot.
 */
function rebaseMergedList<T extends { id: string }>(
    base: T[],
    merged: T[],
    current: T[],
    remerge: (mergedItem: T, currentItem: T) => T,
): T[] {
    if (current === base) return merged;
    const baseById = new Map(base.map((x) => [x.id, x]));
    const mergedById = new Map(merged.map((x) => [x.id, x]));
    const currentIds = new Set<string>();
    const out: T[] = [];
    for (const cur of current) {
        currentIds.add(cur.id);
        const baseItem = baseById.get(cur.id);
        const mergedItem = mergedById.get(cur.id);
        if (baseItem === undefined) {
            // Added locally while the merge ran.
            out.push(mergedItem ? remerge(mergedItem, cur) : cur);
        } else if (cur === baseItem) {
            // Untouched locally: the merge result stands (or its deletion).
            if (mergedItem) out.push(mergedItem);
        } else if (mergedItem === undefined) {
            // Edited locally, deleted by the merge (tombstone): deletion wins.
            continue;
        } else if (mergedItem === baseItem) {
            out.push(cur);
        } else {
            out.push(remerge(mergedItem, cur));
        }
    }
    for (const item of merged) {
        if (currentIds.has(item.id)) continue;
        // Removed locally while the merge ran: do not resurrect it.
        if (baseById.has(item.id)) continue;
        out.push(item);
    }
    return out;
}

function warnMergeFailure(domain: string, err: unknown): void {
    if (import.meta.env.DEV) console.warn(`[sync-merge] ${domain}: incoming data could not be merged`, err);
}

/**
 * Returns `entries` with its `deletion_tombstones` replaced by the union of the
 * incoming and local tombstones. Unparseable incoming tombstones are treated
 * as empty so a corrupt entry cannot hide local deletions.
 */
export function withLocalTombstones(
    entries: Record<string, string>,
    localTombstones: DeletionTombstone[],
): Record<string, string> {
    if (localTombstones.length === 0) return entries;
    let incoming: DeletionTombstone[] = [];
    const raw = entries["deletion_tombstones"];
    if (raw) {
        try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) incoming = parsed;
        } catch {
            // fall through with no incoming tombstones
        }
    }
    return {
        ...entries,
        deletion_tombstones: JSON.stringify(mergeTombstones(incoming, localTombstones)),
    };
}

interface MergeOutcome {
    domainsUpdated: string[];
    conflicts: SyncConflict[];
    /** False when the native SQLite merge failed: the same entries must be merged again later. */
    persisted: boolean;
}

/** When this device's settings last changed, as the settings merge compares it. */
function localSettingsTimestamp(): string {
    return useSettingsStore.getState().settingsLastModifiedAt || new Date().toISOString();
}

function mergeIncomingData(
    incomingMap: Record<string, string>,
    localSettingsUpdatedAt?: string,
    onConflict?: (conflict: SyncConflict) => void,
): Promise<MergeOutcome> {
    return withMergeLock(() => mergeIncomingDataLocked(
        incomingMap,
        // Read when the merge actually runs; without it every incoming
        // settings entry, however old, would replace the local settings.
        localSettingsUpdatedAt ?? localSettingsTimestamp(),
        onConflict,
    ));
}

async function mergeIncomingDataLocked(
    incomingMap: Record<string, string>,
    localSettingsUpdatedAt: string,
    onConflict?: (conflict: SyncConflict) => void,
): Promise<MergeOutcome> {
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
            if (key.startsWith("book:") || key.startsWith("annotation:") || key.startsWith("anno:") || key.startsWith("collection:") || key.startsWith(RSS_ARTICLE_KEY_PREFIX) || key.startsWith(COVER_KEY_PREFIX)) {
                if (!safeMap[key]) {
                    safeMap[key] = incomingMap[key];
                }
            }
        }
    } catch (e) {
        warnMergeFailure("schema validation", e);
    }

    const perEntityBooks: Record<string, unknown>[] = [];
    const perEntityAnnotations: Record<string, unknown>[] = [];
    const perEntityCollections: Record<string, unknown>[] = [];
    const perEntityArticles: unknown[] = [];
    // Lazy like validateSyncPayloads above (zod stays out of the startup chunk).
    const { RssArticleSchema } = await import("./sync-schemas");

    for (const key of Object.keys(safeMap)) {
        if (key.startsWith("book:") && key !== "books") {
            try {
                const parsed = JSON.parse(safeMap[key]);
                if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                    perEntityBooks.push(parsed);
                }
            } catch (e) { warnMergeFailure("book entry", e); }
        } else if ((key.startsWith("annotation:") || key.startsWith("anno:")) && key !== "annotations") {
            try {
                const parsed = JSON.parse(safeMap[key]);
                if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                    perEntityAnnotations.push(parsed);
                }
            } catch (e) { warnMergeFailure("annotation entry", e); }
        } else if (key.startsWith(RSS_ARTICLE_KEY_PREFIX)) {
            try {
                const parsed = RssArticleSchema.safeParse(JSON.parse(safeMap[key]));
                if (parsed.success) perEntityArticles.push(parsed.data);
            } catch (e) { warnMergeFailure("rss article entry", e); }
        } else if (key.startsWith("collection:") && key !== "collections") {
            try {
                const parsed = JSON.parse(safeMap[key]);
                if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                    perEntityCollections.push(parsed);
                }
            } catch (e) { warnMergeFailure("collection entry", e); }
        }
    }

    const incomingCovers: Array<{ id: string; dataUrl: string }> = [];
    for (const key of Object.keys(safeMap)) {
        if (!key.startsWith(COVER_KEY_PREFIX)) continue;
        const cover = parseCoverEntry(safeMap[key]);
        if (cover) incomingCovers.push(cover);
    }

    let nativeReport: SyncMergeResult | null = null;
    let persisted = true;
    if (isTauri()) {
        try {
            // The native merge only knows the tombstones it is handed. Give it
            // the local ones too, or a stale `anno:*` / `book:*` doc entry
            // re-inserts an entity this device already deleted.
            const nativeEntries = withLocalTombstones(
                incomingMap,
                useLibraryStore.getState().deletionTombstones,
            );
            nativeReport = await sqliteMergeSyncEntries(nativeEntries);
            for (const d of nativeReport.domainsUpdated) {
                markUpdated(d);
            }
        } catch (err) {
            persisted = false;
            if (import.meta.env.DEV) {
                console.warn("[sync] Native sqlite_merge_sync_entries failed, falling back to JS merge:", err);
            }
        }
    }

    // What this merge reads; the patch is rebased onto the live store when written.
    const baseLib = useLibraryStore.getState();
    let allTombstones = baseLib.deletionTombstones;

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
            warnMergeFailure("deletion_tombstones", e);
        }
    }

    if (safeMap["deletion_tombstones"]) {
        const libraryState = baseLib;
        if (nativeReport) {
            if (nativeReport.deletedBooks.length > 0) {
                const delSet = new Set(nativeReport.deletedBooks);
                const prunedBooks = libraryState.books.filter((b) => !delSet.has(b.id));
                applyLibraryPatch({ books: prunedBooks });
                markUpdated("books");
            }
            if (nativeReport.deletedAnnotations.length > 0) {
                const delSet = new Set(nativeReport.deletedAnnotations);
                const prunedAnns = libraryState.annotations.filter((a) => !delSet.has(a.id));
                applyLibraryPatch({ annotations: prunedAnns });
                markUpdated("annotations");
            }
            const prunedCollections = mergeCollections([], libraryState.collections, allTombstones);
            applyLibraryPatch({ collections: prunedCollections });
            if (prunedCollections.length !== libraryState.collections.length) markUpdated("collections");

            if (nativeReport.deletedVocabulary.length > 0) {
                const delSet = new Set(nativeReport.deletedVocabulary);
                const vocabState = useVocabularyStore.getState();
                applyRemote(() => useVocabularyStore.setState({
                    vocabularyTerms: vocabState.vocabularyTerms.filter((t) => !delSet.has(t.id)),
                }));
                markUpdated("vocabulary");
            }

            const rssState = useRssStore.getState();
            const prunedFeeds = mergeRssFeeds([], rssState.feeds, allTombstones);
            if (prunedFeeds.feeds.length !== rssState.feeds.length) {
                applyRemote(() => useRssStore.setState({ feeds: prunedFeeds.feeds }));
                markUpdated("rss_feeds");
            }
            if (nativeReport.deletedRssArticles.length > 0) {
                const delSet = new Set(nativeReport.deletedRssArticles);
                applyRemote(() => useRssStore.setState({
                    articles: rssState.articles.filter((a) => !delSet.has(a.id)),
                }));
                markUpdated("rss_articles");
            }
        } else {
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

            applyRemote(() => useRssStore.setState({ feeds: prunedFeeds.feeds, articles: prunedArticles }));

            if (prunedFeeds.feeds.length !== rssState.feeds.length) markUpdated("rss_feeds");
            if (prunedArticles.length !== rssState.articles.length) markUpdated("rss_articles");

            const vocabState = useVocabularyStore.getState();
            const prunedVocab = mergeVocabulary([], vocabState.vocabularyTerms, allTombstones);
            applyRemote(() => useVocabularyStore.setState({ vocabularyTerms: prunedVocab }));
            if (prunedVocab.length !== vocabState.vocabularyTerms.length) markUpdated("vocabulary");
        }
    }

    let currentLibState = baseLib;
    
    if (Object.keys(libraryPatch).length > 0) {
        currentLibState = { ...currentLibState, ...libraryPatch };
    }

    if (safeMap["books"] || perEntityBooks.length > 0) {
        try {
            const domainBooks = safeMap["books"]
                ? (() => { const p = JSON.parse(safeMap["books"]); return Array.isArray(p) ? p : []; })()
                : [];
            let incoming = [...domainBooks, ...perEntityBooks] as Book[];
            if (nativeReport) {
                const updatedIds = new Set(nativeReport.updatedBooks);
                incoming = incoming.filter((b) => updatedIds.has(b.id));
            }
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
            warnMergeFailure("books", e);
        }
    }

    if (safeMap["annotations"] || perEntityAnnotations.length > 0) {
        try {
            if (nativeReport) {
                if (nativeReport.updatedAnnotations.length > 0 || nativeReport.deletedAnnotations.length > 0) {
                    const annStrings = await sqliteGetAllAnnotations();
                    if (annStrings) {
                        const parsed = mergeAnnotations(
                            [],
                            annStrings.map((s) => {
                                try {
                                    const obj = JSON.parse(s);
                                    return {
                                        ...obj,
                                        createdAt: obj.createdAt ? new Date(obj.createdAt) : new Date(),
                                        updatedAt: obj.updatedAt ? new Date(obj.updatedAt) : undefined,
                                    };
                                } catch {
                                    return null;
                                }
                            }).filter(Boolean) as Annotation[],
                            allTombstones,
                        );
                        applyLibraryPatch({ annotations: parsed });
                        currentLibState = { ...currentLibState, annotations: parsed };
                        markUpdated("annotations");
                    }
                }
            } else {
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
            }
        } catch (e) {
            warnMergeFailure("annotations", e);
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
            warnMergeFailure("collections", e);
        }
    }

    if (Object.keys(libraryPatch).length > 0) {
        // Applied against the live state, per id: edits made while this merge
        // awaited (reading progress, a new highlight) must survive it.
        const tombstonesForRemerge = allTombstones;
        applyRemote(() => useLibraryStore.setState((state) => {
            const next: Partial<ReturnType<typeof useLibraryStore.getState>> = {};
            if (libraryPatch.deletionTombstones) {
                next.deletionTombstones = state.deletionTombstones === baseLib.deletionTombstones
                    ? libraryPatch.deletionTombstones
                    : mergeTombstones(libraryPatch.deletionTombstones, state.deletionTombstones);
            }
            if (libraryPatch.books) {
                next.books = rebaseMergedList(baseLib.books, libraryPatch.books, state.books,
                    (merged, current) => mergeBooks([merged], [current], tombstonesForRemerge)[0] ?? current);
            }
            if (libraryPatch.annotations) {
                next.annotations = rebaseMergedList(baseLib.annotations, libraryPatch.annotations, state.annotations,
                    (merged, current) => mergeAnnotations([merged], [current], tombstonesForRemerge)[0] ?? current);
            }
            if (libraryPatch.collections) {
                next.collections = rebaseMergedList(baseLib.collections, libraryPatch.collections, state.collections,
                    (merged, current) => mergeCollections([merged], [current], tombstonesForRemerge)[0] ?? current);
            }
            return next;
        }));
    }

    if (incomingCovers.length > 0) {
        const updatedCovers = new Map<string, string>();
        for (const cover of incomingCovers) {
            try {
                const path = await applyIncomingCover(cover.id, cover.dataUrl);
                if (path) updatedCovers.set(cover.id, path);
            } catch (e) { warnMergeFailure("cover", e); }
        }
        if (updatedCovers.size > 0) {
            for (const [id, path] of updatedCovers) {
                // Known to peers already: neither provisioning nor the live bridge re-sends it.
                _provisionedValues.set(coverEntryKey(id), path);
                _receivedCoverPaths.add(path);
            }
            applyRemote(() => useLibraryStore.setState((state) => ({
                books: state.books.map((book) => {
                    const path = updatedCovers.get(book.id);
                    return path ? { ...book, coverPath: path, coverExtractionDone: true } : book;
                }),
            })));
            markUpdated("covers");
        }
    }

    if (safeMap["vocabulary"] || (nativeReport && (nativeReport.updatedVocabulary.length > 0 || nativeReport.deletedVocabulary.length > 0))) {
        try {
            if (nativeReport) {
                if (nativeReport.updatedVocabulary.length > 0 || nativeReport.deletedVocabulary.length > 0) {
                    const sqliteTerms = await sqliteGetVocabularyTerms();
                    if (sqliteTerms) {
                        applyRemote(() => useVocabularyStore.setState({
                            vocabularyTerms: sqliteTerms.map(fromSqliteVocabularyTerm),
                        }));
                        markUpdated("vocabulary");
                    }
                }
            } else if (safeMap["vocabulary"]) {
                const incoming = JSON.parse(safeMap["vocabulary"]);
                if (Array.isArray(incoming)) {
                    const current = useVocabularyStore.getState().vocabularyTerms;
                    const merged = mergeVocabulary(incoming, current, allTombstones);
                    const { upserts, deletes } = diffVocabularyForSqlite(current, merged);
                    if (upserts.length > 0 || deletes.length > 0 || merged.length !== current.length) {
                        applyRemote(() => useVocabularyStore.setState({ vocabularyTerms: merged }));
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
            }
        } catch (e) {
            warnMergeFailure("vocabulary", e);
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
                applyRemote(() => useSettingsStore.setState({ settings: merged }));
                markUpdated("settings");
            }
        } catch (e) {
            warnMergeFailure("settings", e);
        }
    }

    if (safeMap["reading_stats"]) {
        try {
            const incoming = JSON.parse(safeMap["reading_stats"]);
            if (incoming && typeof incoming === "object") {
                const current = useSettingsStore.getState().stats;
                const merged = mergeReadingStats(incoming, current);
                if (JSON.stringify(merged) !== JSON.stringify(current)) {
                    applyRemote(() => useSettingsStore.setState({ stats: merged }));
                    markUpdated("reading_stats");
                }
            }
        } catch (e) {
            warnMergeFailure("reading_stats", e);
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
                    applyRemote(() => useRssStore.setState({ feeds: result.feeds }));
                    markUpdated("rss_feeds");
                }
                feedIdMap = result.feedIdMap;
            }
        } catch (e) {
            warnMergeFailure("rss_feeds", e);
        }
    }

    if (safeMap["rss_articles"] || perEntityArticles.length > 0) {
        try {
            // Per-article entries plus the legacy whole-list entry (older peers,
            // and deletions, still write it).
            const blob = safeMap["rss_articles"] ? JSON.parse(safeMap["rss_articles"]) : [];
            let incoming = [...(Array.isArray(blob) ? blob : []), ...perEntityArticles] as RssArticle[];
            if (nativeReport) {
                const updatedArtIds = new Set(nativeReport.updatedRssArticles);
                incoming = incoming.filter((a) => updatedArtIds.has(a.id));
            }
            if (incoming.length > 0) {
                const currentArticles = useRssStore.getState().articles;
                debug(`[sync-merge] rss_articles: ${incoming.length} incoming, ${currentArticles.length} existing`);
                const merged = mergeRssArticles(incoming, currentArticles, feedIdMap, allTombstones);
                debug(`[sync-merge] rss_articles: ${merged.length} after merge`);
                if (JSON.stringify(merged) !== JSON.stringify(currentArticles)) {
                    applyRemote(() => useRssStore.setState({ articles: merged }));
                    markUpdated("rss_articles");
                }
            }
        } catch (e) {
            warnMergeFailure("rss_articles", e);
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
            applyRemote(() => useRssStore.setState({ feeds: updatedFeeds }));
        } catch (e) {
            warnMergeFailure("rss unread counts", e);
        }
    }

    return { domainsUpdated, conflicts, persisted };
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

/** How long a round waits for the peer's own `docs-sync-finished` before calling it unreachable. */
const PEER_SYNC_WAIT_MS = 30_000;
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
    _isMerging = true;
    const cancelToken = _cancelGeneration;
    _roundCancelToken = cancelToken;
    const cancelled = () => cancelToken !== _cancelGeneration;
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
            contentReadyUnlisten?.();
            syncFinishedUnlisten?.();
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

        const timeoutId = setTimeout(settle, PEER_SYNC_WAIT_MS);

        await syncPromise;
        clearTimeout(timeoutId);
        stopWaiting();

        const changedDomains = new Set<string>();
        const changedConflicts: SyncConflict[] = [];

        {
            const updated = await hydrateFromIrohDocs();
            for (const d of updated) changedDomains.add(d);
        }
        if (cancelled()) {
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
        await withMergeLock(_flushProgressiveBooks);

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
        } else {
            summary = "Already up to date";
        }

        log(`Sync complete. ${summary}`);
        setStatus("synced", summary);
        _lastSyncPeerId = peerDeviceId;

        if (notifyOnComplete) {
            const { resolveNotificationIcon } = await import("./notifications");
            const successIcon = await resolveNotificationIcon("notify-success.png");
            void notifySync("Sync Complete", summary, successIcon);
        }

        void prefetchRecentBooks(peerDeviceId);
        _dataDirty = false;

        return { success: true, domainsUpdated: [...changedDomains], conflicts: changedConflicts.length > 0 ? changedConflicts : undefined };
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
        _isMerging = false;
        _roundCancelToken = -1;
    }
}

/** True while a sync round runs (live merges defer to it). */
let _isMerging = false;

// Cancellation is a generation counter, not a sticky flag: work captures the
// value when it starts and stops once it changes. A cancel with nothing
// running (unpairing calls it) therefore cannot block the next download or
// round, and no code path has to remember to reset it.
let _cancelGeneration = 0;
let _roundCancelToken = -1;

/** A round is running and has not been cancelled. */
function roundInProgress(): boolean {
    return _isMerging && _roundCancelToken === _cancelGeneration;
}

let _bridgePaused = true;

export function cancelRunningSync(): void {
    _cancelGeneration++;
    if (_progressiveBookTimer) clearTimeout(_progressiveBookTimer);
    _progressiveBookBatch = [];
    useUIStore.getState().setDownloadingBook(undefined);
    setStatus("idle", "Sync cancelled");
    debug("[sync] Cancel requested");
}

export async function downloadBookOnDemand(bookId: string): Promise<boolean> {
    if (!isTauri()) return false;

    const cancelToken = _cancelGeneration;
    let finalStatus: [DeviceSyncStatus, string] = ["idle", "Book download failed — peer not available"];
    setStatus("syncing", "Downloading book...");
    useUIStore.getState().setDownloadingBook(bookId);

    try {
        const { downloadBookFile, getPairedDevices } = await import("./device-sync");

        const peerIds: string[] = [];
        if (_lastSyncPeerId) peerIds.push(_lastSyncPeerId);
        const devices = await getPairedDevices().catch(() => []);
        for (const d of devices) {
            if (!peerIds.includes(d.deviceId)) peerIds.push(d.deviceId);
        }

        if (peerIds.length === 0) {
            console.warn(`[file-xfer] No paired devices found to download ${bookId}`);
            finalStatus = ["idle", "Book download failed — no paired devices"];
            return false;
        }

        for (const peerId of peerIds) {
            if (cancelToken !== _cancelGeneration) {
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
        if (!_isMerging) setStatus(finalStatus[0], finalStatus[1]);
    }
}

async function prefetchRecentBooks(peerDeviceId: string): Promise<void> {
    const cancelToken = _cancelGeneration;
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
            while (index < books.length && cancelToken === _cancelGeneration) {
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

    applyRemote(() => useLibraryStore.setState({ books: merged }));
    // Persist what the live batch changed: on desktop and mobile the library
    // is stored in SQLite, so a live-only book was gone after a restart.
    if (isTauri()) {
        const before = new Set(beforeBooks);
        for (const book of merged) {
            if (before.has(book)) continue;
            void sqliteSaveBookMetadata(book.id, JSON.stringify(book)).catch((e) => console.error("[catch]", e));
        }
    }

    // Round progress only while a round runs; a live update outside one must
    // not leave the status stuck on "syncing".
    if (roundInProgress()) {
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
    applyRemote(() => useLibraryStore.setState({ annotations: merged }));
    // Persist what the live batch changed, or it is gone after a reload.
    if (isTauri()) {
        const before = new Set(beforeAnns);
        for (const ann of merged) {
            if (before.has(ann) || !ann.bookId) continue;
            void sqliteUpsertAnnotation(ann.id, ann.bookId, JSON.stringify(ann)).catch((e) => console.error("[catch]", e));
        }
    }
}

function _flushProgressiveCollections() {
    if (_progressiveCollectionBatch.length === 0) return;
    const batch = _progressiveCollectionBatch.splice(0);
    const state = useLibraryStore.getState();
    const beforeCols = state.collections;
    const merged = mergeCollections(batch, beforeCols, state.deletionTombstones);
    if (isSameOrderedList(merged, beforeCols)) return;
    applyRemote(() => useLibraryStore.setState({ collections: merged }));
}

function _flushPendingTombstones() {
    void withMergeLock(_flushPendingTombstonesNow);
}

async function _flushPendingTombstonesNow(): Promise<void> {
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
            applyRemote(() => useLibraryStore.setState({
                deletionTombstones: mergedTombstones,
                books: prunedBooks,
                annotations: prunedAnns,
                collections: prunedCols,
            }));
            if (isTauri() && prunedAnns.length !== state.annotations.length) {
                const keptIds = new Set(prunedAnns.map((a) => a.id));
                for (const ann of state.annotations) {
                    if (keptIds.has(ann.id)) continue;
                    void sqliteDeleteAnnotation(ann.id).catch((e) => console.error("[catch]", e));
                }
            }
            // Apply the deletions to SQLite too (books, their metadata and
            // annotations, words, articles), or a restart before the next
            // round brings the deleted items back from the database.
            if (isTauri()) {
                await sqliteMergeSyncEntries({ deletion_tombstones: JSON.stringify(mergedTombstones) })
                    .catch((e) => warnMergeFailure("deletion_tombstones (SQLite)", e));
            }
        }
    } catch (e) {
        warnMergeFailure("deletion_tombstones", e);
    }
}

export async function initDocsLiveListener(): Promise<() => void> {
    if (!isTauri()) {
        return () => {};
    }

    if (_docsLiveUnlisten) {
        return _docsLiveUnlisten;
    }
    // Two concurrent callers share one registration: the check above runs
    // before the awaits below, so without this both would register.
    if (!_docsLiveInit) {
        _docsLiveInit = registerDocsLiveListener().finally(() => {
            _docsLiveInit = null;
        });
    }
    return _docsLiveInit;
}

async function registerDocsLiveListener(): Promise<() => void> {
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
        try {
            await mergeIncomingData(entries);
        } catch (e) {
            warnMergeFailure("live entries", e);
        }
    };

    // The Rust side batches remote doc entries (deduped per key, flushed every
    // ~300ms or 64 entries) so a bulk sync crosses the IPC bridge in a few
    // `docs-entry-batch` events instead of one event per entry.
    const handleIncomingEntry = (key: string, value: string) => {
        if (isOwnEcho(key, value)) {
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
                    _progressiveBookTimer = setTimeout(() => void withMergeLock(_flushProgressiveBooks), 200);
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
                    _progressiveAnnoTimer = setTimeout(() => void withMergeLock(_flushProgressiveAnnos), 200);
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
                    _progressiveCollectionTimer = setTimeout(() => void withMergeLock(_flushProgressiveCollections), 200);
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

/**
 * Only the doc entries whose content changed since the last read that was
 * acknowledged with `docsAckEntries` (the first read after start is complete);
 * with `full`, every entry.
 */
export async function docsGetChangedEntries(full = false): Promise<{ entries: Record<string, string>; token: number } | null> {
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

let _purgedTombstonesKey = "";

/**
 * Removes this device's doc entries for deleted items. Doc entries outlive a
 * deletion; without this, every device brought the item back once its
 * deletion record expired (90 days). Runs when the set of deletions changed
 * (or the peer set did, which clears `_purgedTombstonesKey`).
 */
async function purgeDeletedDocEntries(tombstones: DeletionTombstone[]): Promise<void> {
    const key = tombstones.map((t) => `${t.entityType}:${t.entityId}`).sort().join("|");
    if (key === _purgedTombstonesKey) return;
    try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke<number>("docs_purge_entities", {
            entities: tombstones.map((t) => ({ entityType: t.entityType, entityId: t.entityId })),
        });
        _purgedTombstonesKey = key;
    } catch (e) {
        if (import.meta.env.DEV) console.warn("[sync] could not remove deleted items from the sync doc", e);
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
            _purgedTombstonesKey = "";
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
                const ok = await writeOwnEntry(key, serialized);
                if (!ok) {
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
                await writeOwnEntry(key, entry, book.coverPath!);
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
                const ok = await writeOwnEntry(key, payload);
                if (!ok) {
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

        await purgeDeletedDocEntries([...lib.deletionTombstones, ...(rss.deletionTombstones ?? [])]);

        return true;
    } catch (e) {
        console.error(`[sync] Provision failed (unexpected): ${e}`);
        return false;
    }
}

/**
 * A full read of every doc entry happens at least this often, as a safety net
 * under the changed-only reads (and the first read after start is full anyway).
 */
const FULL_HYDRATE_EVERY_MS = 30 * 60_000;
let _lastFullHydrateAt = 0;

/**
 * Merges what the paired docs hold. Normally only entries that changed since
 * the last merge cross the IPC bridge (covers above all are not re-sent every
 * round); they are acknowledged only once merged and persisted, so a failed
 * merge gets them again next round.
 */
export async function hydrateFromIrohDocs(): Promise<string[]> {
    try {
        const full = Date.now() - _lastFullHydrateAt > FULL_HYDRATE_EVERY_MS;
        const read = await docsGetChangedEntries(full);
        if (!read) return [];
        const acknowledge = async () => {
            await docsAckEntries(read.token);
            if (full) _lastFullHydrateAt = Date.now();
        };
        if (Object.keys(read.entries).length === 0) {
            await acknowledge();
            return [];
        }

        const { domainsUpdated, persisted } = await mergeIncomingData(
            read.entries,
            localSettingsTimestamp(),
        );
        if (persisted) await acknowledge();
        return domainsUpdated;
    } catch {
        return [];
    }
}

/** Test hook: forget when the last full read happened. */
export function __resetHydrateScheduleForTests(): void {
    _lastFullHydrateAt = 0;
}

const _docsDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const DOCS_DEBOUNCE_MS = 500;

// Echo suppression by value: per key, a fingerprint of what this device last
// wrote. An incoming entry is dropped only if it is exactly that value; a
// peer's different value for the same key (a genuine edit) always gets in,
// however soon after our own write it arrives.
const _ownWrites = new Map<string, string>();

/** 53-bit string hash (cyrb53) plus length: compact, so large values are not kept twice. */
function fingerprint(value: string): string {
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

function rememberOwnWrite(key: string, value: string): void {
    _ownWrites.set(key, fingerprint(value));
}

function isOwnEcho(key: string, value: string): boolean {
    const own = _ownWrites.get(key);
    return own !== undefined && own === fingerprint(value);
}

/**
 * Writes one docs entry from this device. `provisionedAs` is recorded in
 * `_provisionedValues` on success (pass null for keys provisioning never
 * compares), so the next provisioning does not write the same value again.
 */
async function writeOwnEntry(key: string, value: string, provisionedAs: string | null = value): Promise<boolean> {
    rememberOwnWrite(key, value);
    const ok = await docsSetEntry(key, value);
    if (ok && provisionedAs !== null) _provisionedValues.set(key, provisionedAs);
    return ok;
}

function scheduleDocsWrite(domain: string, fn: () => void): void {
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
        // A merge of peer data: keep the indexes current, write nothing back.
        const fromPeer = _applyingRemote > 0;
        if (state.books !== prevBooks) {
            prevBooks = state.books;

            for (const book of state.books) {
                const entry = bookIndex.get(book.id);
                if (entry && entry.ref === book) continue;
                // An existing cover changed (edit, re-extraction): send it. First-time
                // covers (hydration, new imports) go out with the next provisioning.
                const previousCover = (entry?.ref as { coverPath?: string } | undefined)?.coverPath;
                if (!fromPeer && previousCover && book.coverPath !== previousCover && needsCoverEntry(book.coverPath)
                    && !_receivedCoverPaths.has(book.coverPath!)) {
                    const coverKey = coverEntryKey(book.id);
                    const coverPath = book.coverPath!;
                    scheduleDocsWrite(coverKey, () => {
                        void buildCoverEntry(book.id).then((value) => {
                            if (value) return writeOwnEntry(coverKey, value, coverPath);
                        });
                    });
                }
                const serialized = serializeBook(book);
                if (!entry || entry.serialized !== serialized) {
                    bookIndex.set(book.id, { ref: book, serialized });
                    if (!fromPeer) {
                        const bookKey = "book:" + book.id;
                        scheduleDocsWrite(bookKey, () => {
                            rememberOwnWrite(bookKey, serialized);
                            void docsSetEntry("book:" + book.id, serialized).then((ok) => {
                                // Provisioning compares against this: it must not re-send the same book.
                                if (ok) _provisionedValues.set(bookKey, serialized);
                            });
                        });
                    }
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
                    if (!fromPeer) {
                        const annoKey = "anno:" + (ann.bookId || "global") + ":" + ann.id;
                        scheduleDocsWrite(annoKey, () => void writeOwnEntry(annoKey, serialized, null));
                    }
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
            if (annoDeletion && !fromPeer) {
                scheduleDocsWrite("annotations", () => void writeOwnEntry("annotations", JSON.stringify(annotations)));
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
                    if (!fromPeer) {
                        const colKey = "collection:" + col.id;
                        scheduleDocsWrite(colKey, () => void writeOwnEntry(colKey, serialized, null));
                    }
                } else {
                    entry.ref = col;
                }
            }
            let collectionDeletion = false;
            for (const id of prevCollectionIds) {
                if (!seenCollectionIds.has(id)) { collectionDeletion = true; break; }
            }
            prevCollectionIds = seenCollectionIds;
            if (collectionDeletion && !fromPeer) {
                scheduleDocsWrite("collections", () => void writeOwnEntry("collections", JSON.stringify(collections)));
            }
            if (collectionIndex.size > collections.length) {
                sweepStaleIndex(collectionIndex, seenCollectionIds);
            }
        }
        if (state.deletionTombstones !== prevTombstones) {
            prevTombstones = state.deletionTombstones;
            if (!fromPeer) {
                scheduleDocsWrite("deletion_tombstones", () =>
                    void writeOwnEntry("deletion_tombstones", JSON.stringify(state.deletionTombstones)));
            }
        }
    }));

    let prevVocab = useVocabularyStore.getState().vocabularyTerms;
    unsubs.push(useVocabularyStore.subscribe((state) => {
        if (_bridgePaused) return;
        if (state.vocabularyTerms !== prevVocab) {
            prevVocab = state.vocabularyTerms;
            if (_applyingRemote > 0) return;
            scheduleDocsWrite("vocabulary", () => void writeOwnEntry("vocabulary", JSON.stringify(state.vocabularyTerms)));
        }
    }));

    let prevFeeds = useRssStore.getState().feeds;
    let prevArticles = useRssStore.getState().articles;
    // Articles sync one entry each (only changed ones are written); a deletion
    // also rewrites the whole-list entry, like collections, so peers drop it.
    const articleIndex = new Map<string, { ref: unknown; serialized: string }>();
    let prevArticleIds = new Set(prevArticles.map((a) => a.id));
    for (const article of prevArticles) articleIndex.set(article.id, { ref: article, serialized: JSON.stringify(article) });
    unsubs.push(useRssStore.subscribe((state) => {
        if (_bridgePaused) return;
        const fromPeer = _applyingRemote > 0;
        if (state.feeds !== prevFeeds) {
            prevFeeds = state.feeds;
            if (!fromPeer) {
                scheduleDocsWrite("rss_feeds", () => void writeOwnEntry("rss_feeds", JSON.stringify(state.feeds)));
            }
        }
        if (state.articles !== prevArticles) {
            prevArticles = state.articles;
            const articles = state.articles;
            const seenIds = new Set<string>();
            for (const article of articles) {
                seenIds.add(article.id);
                const entry = articleIndex.get(article.id);
                if (entry && entry.ref === article) continue;
                const serialized = JSON.stringify(article);
                if (!entry || entry.serialized !== serialized) {
                    articleIndex.set(article.id, { ref: article, serialized });
                    if (!fromPeer) {
                        const key = RSS_ARTICLE_KEY_PREFIX + article.id;
                        scheduleDocsWrite(key, () => void writeOwnEntry(key, serialized, null));
                    }
                } else {
                    entry.ref = article;
                }
            }
            let deletion = false;
            for (const id of prevArticleIds) {
                if (!seenIds.has(id)) { deletion = true; break; }
            }
            prevArticleIds = seenIds;
            if (deletion) {
                if (!fromPeer) {
                    scheduleDocsWrite("rss_articles", () => void writeOwnEntry("rss_articles", JSON.stringify(articles)));
                }
                for (const id of articleIndex.keys()) if (!seenIds.has(id)) articleIndex.delete(id);
            }
        }
    }));

    let prevSettings = useSettingsStore.getState().settings;
    let prevStats = useSettingsStore.getState().stats;
    unsubs.push(useSettingsStore.subscribe((state) => {
        if (_bridgePaused) return;
        const fromPeer = _applyingRemote > 0;
        if (state.settings !== prevSettings) {
            prevSettings = state.settings;
            if (!fromPeer) {
                scheduleDocsWrite("settings", () => void writeOwnEntry("settings", JSON.stringify({
                    ...state.settings,
                    _settingsUpdatedAt: useSettingsStore.getState().settingsLastModifiedAt || new Date().toISOString(),
                })));
            }
        }
        if (state.stats !== prevStats) {
            prevStats = state.stats;
            if (!fromPeer) {
                scheduleDocsWrite("reading_stats", () => void writeOwnEntry("reading_stats", JSON.stringify(state.stats)));
            }
        }
    }));

    return () => {
        for (const unsub of unsubs) unsub();
        for (const t of _docsDebounceTimers.values()) clearTimeout(t);
        _docsDebounceTimers.clear();
    };
}
