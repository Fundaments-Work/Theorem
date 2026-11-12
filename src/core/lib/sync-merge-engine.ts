import {
    useLibraryStore,
    useVocabularyStore,
    useRssStore,
    useSettingsStore,
    toSqliteVocabularyTerm,
    fromSqliteVocabularyTerm,
} from "../store";
import type { Book, DeletionTombstone, RssArticle } from "../types";
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
import { loadStoredAnnotations } from "./annotation-load";
import { acquireBookEditLock } from "./book-edit-lock";
import { parseSyncEntityEntry, reportMalformedSyncEntry } from "./sync-entries";
import {
    sqliteDeleteVocabularyTerm,
    sqliteGetVocabularyTerms,
    sqliteMergeSyncEntries,
    sqliteSaveBookMetadata,
    sqliteSaveVocabularyTerm,
    type SyncMergeResult,
} from "./sqlite-storage";
import { diffVocabularyForSqlite } from "./vocab-sqlite-diff";
import {
    applyIncomingCover,
    COVER_KEY_PREFIX,
    coverEntryKey,
    coverMarker,
    parseCoverEntry,
    type CoverEntry,
} from "./sync-covers";
import {
    applyRemote,
    debug,
    type DocDeletion,
    epochOf,
    rememberProvisioned,
    reportConflicts,
    RSS_ARTICLE_KEY_PREFIX,
    RSS_FEED_KEY_PREFIX,
    TOMBSTONE_KEY_PREFIX,
    VOCAB_KEY_PREFIX,
    warnMergeFailure,
    withMergeLock,
} from "./sync-runtime-state";

/**
 * Deletion records for doc deletions of items this device still has.
 * Doc deletions never expire (deletion records do, after 90 days), so this
 * is how a device that was away longer still drops what was deleted
 * meanwhile instead of sending it back. An item changed here after it was
 * deleted there is kept, like an edit made after the deletion anywhere.
 */
export function tombstonesForDocDeletions(deletions: DocDeletion[]): DeletionTombstone[] {
    if (deletions.length === 0) return [];
    const lib = useLibraryStore.getState();
    const rss = useRssStore.getState();
    const vocab = useVocabularyStore.getState();
    const now = new Date().toISOString();
    const out: DeletionTombstone[] = [];
    const add = (entityType: DeletionTombstone["entityType"], entityId: string, lastChange: number, at: number) => {
        if (lastChange > at) return;
        out.push({ entityType, entityId, deletedAt: now });
    };
    for (const { key, at } of deletions) {
        if (key.startsWith("book:")) {
            const id = key.slice("book:".length);
            const b = lib.getBook(id);
            if (b) add("book", id, Math.max(epochOf(b.addedAt), epochOf(b.metadataUpdatedAt), epochOf(b.lastReadAt)), at);
        } else if (key.startsWith("anno:") || key.startsWith("annotation:")) {
            const id = key.startsWith("anno:") ? key.split(":").slice(2).join(":") : key.slice("annotation:".length);
            const a = lib.annotations.find((x) => x.id === id);
            if (a) add("annotation", id, Math.max(epochOf(a.createdAt), epochOf(a.updatedAt)), at);
        } else if (key.startsWith("collection:")) {
            const id = key.slice("collection:".length);
            const c = lib.collections.find((x) => x.id === id);
            if (c) add("collection", id, Math.max(epochOf(c.createdAt), epochOf(c.updatedAt)), at);
        } else if (key.startsWith(RSS_ARTICLE_KEY_PREFIX)) {
            const id = key.slice(RSS_ARTICLE_KEY_PREFIX.length);
            if (rss.articles.some((x) => x.id === id)) add("rss_article", id, 0, at);
        } else if (key.startsWith(RSS_FEED_KEY_PREFIX)) {
            const id = key.slice(RSS_FEED_KEY_PREFIX.length);
            if (rss.feeds.some((x) => x.id === id)) add("feed", id, 0, at);
        } else if (key.startsWith(VOCAB_KEY_PREFIX) || key.startsWith("vocabulary:")) {
            const id = key.slice(key.indexOf(":") + 1);
            const t = vocab.vocabularyTerms.find((x) => x.id === id);
            if (t) add("vocabulary", id, Math.max(epochOf(t.createdAt), epochOf(t.updatedAt)), at);
        }
    }
    return out;
}

/**
 * The incoming entries with the per-item entries folded into the lists the
 * merge works on: `tomb:*` (and deletions of items, `deletions`) into
 * `deletion_tombstones`, `rss_feed:*` into `rss_feeds`. Older devices' lists
 * are kept in.
 */
function foldPerItemEntries(
    entries: Record<string, string>,
    deletions: DocDeletion[],
): Record<string, string> {
    const tombs: DeletionTombstone[] = tombstonesForDocDeletions(deletions);
    const feeds: unknown[] = [];
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(entries)) {
        if (key.startsWith(TOMBSTONE_KEY_PREFIX)) {
            try {
                const t = JSON.parse(value);
                if (t && typeof t === "object" && !Array.isArray(t) && t.entityId && t.entityType) tombs.push(t);
            } catch (e) { warnMergeFailure("deletion entry", e); }
        } else if (key.startsWith(RSS_FEED_KEY_PREFIX)) {
            try {
                const f = JSON.parse(value);
                if (f && typeof f === "object" && !Array.isArray(f)) feeds.push(f);
            } catch (e) { warnMergeFailure("rss feed entry", e); }
        } else {
            out[key] = value;
        }
    }
    const withList = (key: string, items: unknown[]) => {
        if (items.length === 0) return;
        let list: unknown[] = [];
        if (out[key]) {
            try {
                const parsed = JSON.parse(out[key]);
                if (Array.isArray(parsed)) list = parsed;
            } catch {
                // A corrupt list: the per-item entries still count.
            }
        }
        out[key] = JSON.stringify([...list, ...items]);
    };
    withList("deletion_tombstones", tombs);
    withList("rss_feeds", feeds);
    return out;
}

/**
 * Re-applies a merged list onto the store's *current* list. `base` is what the
 * merge read; anything the user changed, added or removed since then (during
 * the merge's awaits) is kept rather than overwritten by the stale snapshot.
 */
export function rebaseMergedList<T extends { id: string }>(
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
            // Fall through with no incoming tombstones.
            reportMalformedSyncEntry("deletion_tombstones", "not valid JSON");
        }
    }
    return {
        ...entries,
        deletion_tombstones: JSON.stringify(mergeTombstones(incoming, localTombstones)),
    };
}

export interface MergeOutcome {
    domainsUpdated: string[];
    /** New conflicts the native merge recorded (see `sqliteListSyncConflicts`). */
    conflicts: number;
    /** False when the native SQLite merge failed: the same entries must be merged again later. */
    persisted: boolean;
}

/** When this device's settings last changed, as the settings merge compares it. */
export function localSettingsTimestamp(): string {
    return useSettingsStore.getState().settingsLastModifiedAt || new Date().toISOString();
}

export function mergeIncomingData(
    incomingMap: Record<string, string>,
    localSettingsUpdatedAt?: string,
    deletions: DocDeletion[] = [],
): Promise<MergeOutcome> {
    return withMergeLock(() => mergeIncomingDataLocked(
        // Folded when the merge runs: whether a deleted item is still here
        // (and unchanged since) is read from the current stores.
        foldPerItemEntries(incomingMap, deletions),
        // Read when the merge actually runs; without it every incoming
        // settings entry, however old, would replace the local settings.
        localSettingsUpdatedAt ?? localSettingsTimestamp(),
    ));
}

async function mergeIncomingDataLocked(
    incomingMap: Record<string, string>,
    localSettingsUpdatedAt: string,
): Promise<MergeOutcome> {
    const domainsUpdated: string[] = [];
    let conflicts = 0;
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
            const parsed = parseSyncEntityEntry(key, safeMap[key]);
            if (parsed) perEntityBooks.push(parsed);
        } else if ((key.startsWith("annotation:") || key.startsWith("anno:")) && key !== "annotations") {
            const parsed = parseSyncEntityEntry(key, safeMap[key]);
            if (parsed) perEntityAnnotations.push(parsed);
        } else if (key.startsWith(RSS_ARTICLE_KEY_PREFIX)) {
            const raw = parseSyncEntityEntry(key, safeMap[key]);
            if (raw) {
                const parsed = RssArticleSchema.safeParse(raw);
                if (parsed.success) perEntityArticles.push(parsed.data);
                else reportMalformedSyncEntry(key, "does not match the article schema");
            }
        } else if (key.startsWith("collection:") && key !== "collections") {
            const parsed = parseSyncEntityEntry(key, safeMap[key]);
            if (parsed) perEntityCollections.push(parsed);
        }
    }

    const incomingCovers: CoverEntry[] = [];
    for (const key of Object.keys(safeMap)) {
        if (!key.startsWith(COVER_KEY_PREFIX)) continue;
        const cover = parseCoverEntry(safeMap[key]);
        if (cover && cover.id === key.slice(COVER_KEY_PREFIX.length)) incomingCovers.push(cover);
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
            conflicts = nativeReport.conflicts ?? 0;
            reportConflicts(conflicts);
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
                    currentLibState = { ...currentLibState, books: final };
                }

                const incomingWithCovers = (incoming as { id: string; coverPath?: string; coverUpdatedAt?: string }[])
                    .filter((b) => b.coverPath && b.coverPath.startsWith("data:"));

                // Older peers still embed covers in book entries.
                for (const inc of incomingWithCovers) {
                    if (!incomingCovers.some((c) => c.id === inc.id)) {
                        incomingCovers.push({ id: inc.id, dataUrl: inc.coverPath!, ...(inc.coverUpdatedAt ? { updatedAt: inc.coverUpdatedAt } : {}) });
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
                    const parsed = mergeAnnotations([], await loadStoredAnnotations(), allTombstones);
                    applyLibraryPatch({ annotations: parsed });
                    currentLibState = { ...currentLibState, annotations: parsed };
                    markUpdated("annotations");
                }
            } else {
                const domainAnns = safeMap["annotations"]
                    ? (() => { const p = JSON.parse(safeMap["annotations"]); return Array.isArray(p) ? p : []; })()
                    : [];
                const incoming = [...domainAnns, ...perEntityAnnotations];
                if (incoming.length > 0) {
                    const merged = mergeAnnotations(incoming, currentLibState.annotations, allTombstones);
                    if (merged !== currentLibState.annotations) {
                        applyLibraryPatch({ annotations: merged });
                        markUpdated("annotations");
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
        const releases: Array<() => void> = [];
        try {
            const coversById = new Map(incomingCovers.map((cover) => [cover.id, cover]));
            const updatedCovers = new Map<string, string>();
            for (const cover of incomingCovers) {
                releases.push(await acquireBookEditLock(cover.id));
                try {
                    const local = useLibraryStore.getState().getBook(cover.id);
                    if (epochOf(local?.coverUpdatedAt) > epochOf(cover.updatedAt)) continue;
                    const path = await applyIncomingCover(cover.id, cover.dataUrl, cover.removed);
                    if (path !== null) updatedCovers.set(cover.id, path);
                    else if (cover.updatedAt && cover.updatedAt !== local?.coverUpdatedAt) updatedCovers.set(cover.id, local?.coverPath ?? "");
                } catch (e) { warnMergeFailure("cover", e); }
            }
            if (updatedCovers.size > 0) {
                for (const [id, path] of updatedCovers) {
                    // Known to peers already: neither provisioning nor the live bridge re-sends it.
                    const cover = coversById.get(id);
                    rememberProvisioned(coverEntryKey(id), coverMarker({ coverPath: path, coverUpdatedAt: cover?.updatedAt }));
                }
                applyRemote(() => useLibraryStore.setState((state) => ({
                    books: state.books.map((book) => {
                        const path = updatedCovers.get(book.id);
                        if (!updatedCovers.has(book.id)) return book;
                        const cover = coversById.get(book.id);
                        return { ...book, coverPath: path, coverExtractionDone: true,
                            ...(cover?.updatedAt ? { coverUpdatedAt: cover.updatedAt } : {}),
                            ...(cover?.removed ? { coverBlobHash: undefined } : {}) };
                    }),
                })));
                if (isTauri()) {
                    for (const id of updatedCovers.keys()) {
                        const book = useLibraryStore.getState().getBook(id);
                        if (book) await sqliteSaveBookMetadata(id, JSON.stringify(book));
                    }
                }
                markUpdated("covers");
            }
        } finally {
            for (const release of releases) release();
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
                            const report = (e: unknown) => console.error("[Sync] Saving a synced vocabulary change failed:", e);
                            for (const term of upserts) {
                                void sqliteSaveVocabularyTerm(toSqliteVocabularyTerm(term)).catch(report);
                            }
                            for (const id of deletes) {
                                void sqliteDeleteVocabularyTerm(id).catch(report);
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
                const { mergeReadingRhythm } = await import("./reading-rhythm");
                await mergeReadingRhythm(incoming.rhythm, rhythm => {
                    const current = useSettingsStore.getState().stats;
                    const merged = mergeReadingStats(incoming, current);
                    merged.rhythm = rhythm;
                    if (JSON.stringify(merged) !== JSON.stringify(current)) {
                        applyRemote(() => useSettingsStore.setState({ stats: merged }));
                        markUpdated("reading_stats");
                    }
                });
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
