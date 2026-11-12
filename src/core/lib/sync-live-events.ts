import { useLibraryStore, useRssStore, useVocabularyStore } from "../store";
import type { Annotation, Book, Collection, DeletionTombstone } from "../types";
import { isTauri } from "./env";
import { parseSyncEntityEntry } from "./sync-entries";
import {
    mergeAnnotations,
    mergeBooks,
    mergeCollections,
    mergeRssArticles,
    mergeRssFeeds,
    mergeTombstones,
    mergeVocabulary,
} from "./sync-import";
import {
    sqliteDeleteAnnotation,
    sqliteMergeSyncEntries,
    sqliteSaveBookMetadata,
    sqliteUpsertAnnotation,
} from "./sqlite-storage";
import { rebaseMergedList, tombstonesForDocDeletions, withLocalTombstones } from "./sync-merge-engine";
import {
    annotationEntryKey,
    applyRemote,
    debug,
    type DocDeletion,
    isOwnEcho,
    MAX_PENDING_ENTRIES,
    reportConflicts,
    roundInProgress,
    setStatus,
    syncRuntime,
    TOMBSTONE_KEY_PREFIX,
    warnMergeFailure,
    withMergeLock,
} from "./sync-runtime-state";
import { mergeIncomingData } from "./sync-merge-engine";

let _docsLiveTimer: ReturnType<typeof setTimeout> | null = null;
let _progressiveBookBatch: Book[] = [];
let _progressiveBookTimer: ReturnType<typeof setTimeout> | null = null;
/** The entries behind the live batches, as received, for the native merge. */
const _progressiveRawEntries = new Map<string, string>();

// Annotations and collections ride the same progressive-batch pattern as
// books: per-entry synchronous merges + setStates inside the gossip event
// loop froze the UI (up to 64 full O(n) merges + store notifications per
// batch). Batches coalesce over 200ms into one merge + one setState each.
let _progressiveAnnoBatch: Annotation[] = [];
let _progressiveAnnoTimer: ReturnType<typeof setTimeout> | null = null;
let _progressiveCollectionBatch: Collection[] = [];
let _progressiveCollectionTimer: ReturnType<typeof setTimeout> | null = null;

// Tombstone application re-merges the whole library and replaces three
// slices at once; it is never latency-sensitive, so it trails the event
// loop and runs idle. Deletion records and deleted doc entries collect here.
let _pendingTombstones: DeletionTombstone[] = [];
let _pendingDocDeletions: DocDeletion[] = [];
let _pendingTombstonesTimer: ReturnType<typeof setTimeout> | null = null;

export function clearProgressiveBookBatch(): void {
    if (_progressiveBookTimer) clearTimeout(_progressiveBookTimer);
    _progressiveBookTimer = null;
    _progressiveBookBatch = [];
    for (const key of [..._progressiveRawEntries.keys()]) {
        if (key.startsWith("book:")) _progressiveRawEntries.delete(key);
    }
}

export async function flushProgressiveBooksOnRoundEnd(): Promise<void> {
    if (_progressiveBookTimer) clearTimeout(_progressiveBookTimer);
    await withMergeLock(flushProgressiveBooks);
}

/**
 * Persists live-merged entries through the native merge, which also records
 * conflicts. Returns false when it failed (the caller then saves directly).
 */
async function persistLiveEntries(keys: string[]): Promise<boolean> {
    const entries: Record<string, string> = {};
    for (const key of keys) {
        const value = _progressiveRawEntries.get(key);
        _progressiveRawEntries.delete(key);
        if (value !== undefined) entries[key] = value;
    }
    if (!isTauri() || Object.keys(entries).length === 0) return true;
    try {
        const report = await sqliteMergeSyncEntries(
            withLocalTombstones(entries, useLibraryStore.getState().deletionTombstones),
        );
        reportConflicts(report?.conflicts ?? 0);
        return true;
    } catch (e) {
        warnMergeFailure("live entries (SQLite)", e);
        return false;
    }
}

function scheduleIdleTask(task: () => void): void {
    if (typeof window !== "undefined" && typeof window.requestIdleCallback === "function") {
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

async function flushProgressiveBooks(): Promise<void> {
    if (_progressiveBookBatch.length === 0) return;
    const batch = _progressiveBookBatch.splice(0);
    const state = useLibraryStore.getState();
    const beforeBooks = state.books;
    const merged = mergeBooks(batch, beforeBooks, state.deletionTombstones);

    // Persist through the native merge (it keeps SQLite in step with the
    // same rules, and records an edit this device made at the same time as
    // a conflict), even when the store keeps its own newer copy.
    const persisted = await persistLiveEntries(batch.map((b: { id: string }) => `book:${b.id}`));

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

    applyRemote(() => useLibraryStore.setState((current) => ({
        books: rebaseMergedList(beforeBooks, merged, current.books,
            (m, cur) => mergeBooks([m], [cur], current.deletionTombstones)[0] ?? cur),
    })));
    // Without the native merge, save what the live batch changed directly: on
    // desktop and mobile the library is stored in SQLite, so a live-only book
    // was gone after a restart.
    if (isTauri() && !persisted) {
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

    const mergedById = new Map(merged.map((b) => [b.id, b]));
    for (const book of batch) {
        const added = mergedById.get(book.id);
        if (added && !added.blobHash) {
            debug(`[sync] No blobHash for: ${book.title || book.id} — peer hasn't provisioned this blob`);
        }
    }
}

async function flushProgressiveAnnos(): Promise<void> {
    if (_progressiveAnnoBatch.length === 0) return;
    const batch = _progressiveAnnoBatch.splice(0);
    const state = useLibraryStore.getState();
    const beforeAnns = state.annotations;
    const merged = mergeAnnotations(batch, beforeAnns, state.deletionTombstones);
    const persisted = await persistLiveEntries(batch.map((a: Annotation) => annotationEntryKey(a)));
    if (isSameOrderedList(merged, beforeAnns)) return;
    applyRemote(() => useLibraryStore.setState((current) => ({
        annotations: rebaseMergedList(beforeAnns, merged, current.annotations,
            (m, cur) => mergeAnnotations([m], [cur], current.deletionTombstones)[0] ?? cur),
    })));
    // Without the native merge, save what the live batch changed directly,
    // or it is gone after a reload.
    if (isTauri() && !persisted) {
        const before = new Set(beforeAnns);
        for (const ann of merged) {
            if (before.has(ann) || !ann.bookId) continue;
            void sqliteUpsertAnnotation(ann.id, ann.bookId, JSON.stringify(ann)).catch((e) => console.error("[catch]", e));
        }
    }
}

function flushProgressiveCollections() {
    if (_progressiveCollectionBatch.length === 0) return;
    const batch = _progressiveCollectionBatch.splice(0);
    const state = useLibraryStore.getState();
    const beforeCols = state.collections;
    const merged = mergeCollections(batch, beforeCols, state.deletionTombstones);
    if (isSameOrderedList(merged, beforeCols)) return;
    applyRemote(() => useLibraryStore.setState({ collections: merged }));
}

function flushPendingTombstones() {
    void withMergeLock(flushPendingTombstonesNow);
}

async function flushPendingTombstonesNow(): Promise<void> {
    const incoming = _pendingTombstones.splice(0);
    const fromDocs = tombstonesForDocDeletions(_pendingDocDeletions.splice(0));
    if (incoming.length === 0 && fromDocs.length === 0) return;
    try {
        const state = useLibraryStore.getState();
        const mergedTombstones = mergeTombstones([...incoming, ...fromDocs], state.deletionTombstones);
        const prunedBooks = mergeBooks([], state.books, mergedTombstones);
        const prunedAnns = mergeAnnotations([], state.annotations, mergedTombstones);
        const prunedCols = mergeCollections([], state.collections, mergedTombstones);
        applyRemote(() => useLibraryStore.setState({
            deletionTombstones: mergedTombstones,
            books: prunedBooks,
            annotations: prunedAnns,
            collections: prunedCols,
        }));
        const rss = useRssStore.getState();
        const prunedFeeds = mergeRssFeeds([], rss.feeds, mergedTombstones).feeds;
        const prunedArticles = mergeRssArticles([], rss.articles, undefined, mergedTombstones);
        if (prunedFeeds.length !== rss.feeds.length || prunedArticles.length !== rss.articles.length) {
            applyRemote(() => useRssStore.setState({ feeds: prunedFeeds, articles: prunedArticles }));
        }
        const vocab = useVocabularyStore.getState();
        const prunedVocab = mergeVocabulary([], vocab.vocabularyTerms, mergedTombstones);
        if (prunedVocab.length !== vocab.vocabularyTerms.length) {
            applyRemote(() => useVocabularyStore.setState({ vocabularyTerms: prunedVocab }));
        }
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
    } catch (e) {
        warnMergeFailure("deletion_tombstones", e);
    }
}

function scheduleTombstoneFlush(): void {
    if (_pendingTombstonesTimer) clearTimeout(_pendingTombstonesTimer);
    _pendingTombstonesTimer = setTimeout(() => {
        _pendingTombstonesTimer = null;
        scheduleIdleTask(flushPendingTombstones);
    }, 500);
}

export async function initDocsLiveListener(): Promise<() => void> {
    if (!isTauri()) {
        return () => {};
    }

    if (syncRuntime.docsLiveUnlisten) {
        return syncRuntime.docsLiveUnlisten;
    }
    // Two concurrent callers share one registration: the check above runs
    // before the awaits below, so without this both would register.
    if (!syncRuntime.docsLiveInit) {
        syncRuntime.docsLiveInit = registerDocsLiveListener().finally(() => {
            syncRuntime.docsLiveInit = null;
        });
    }
    return syncRuntime.docsLiveInit;
}

async function registerDocsLiveListener(): Promise<() => void> {
    const { listen } = await import("@tauri-apps/api/event");

    const processPendingDocs = async () => {
        if (syncRuntime.isMerging) {
            _docsLiveTimer = setTimeout(processPendingDocs, 500);
            return;
        }
        const entries: Record<string, string> = {};
        for (const [k, v] of syncRuntime.pendingDocsEntries) {
            entries[k] = v;
        }
        syncRuntime.pendingDocsEntries.clear();
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

        if (key === "deletion_tombstones" || key.startsWith(TOMBSTONE_KEY_PREFIX)) {
            // A whole list (older devices) or one record; the full-library
            // re-merge runs idle.
            try {
                const parsed = JSON.parse(value);
                const list = Array.isArray(parsed) ? parsed : [parsed];
                for (const t of list) {
                    if (t && typeof t === "object" && t.entityId && t.entityType) _pendingTombstones.push(t);
                }
                scheduleTombstoneFlush();
            } catch (e) { warnMergeFailure("deletion entry", e); }
            return;
        }

        // Entries are unvalidated peer JSON with an id; the merges tolerate
        // missing fields, as they always have.
        if (key.startsWith("book:")) {
            const parsed = parseSyncEntityEntry(key, value, { requireId: true }) as unknown as Book | null;
            if (parsed) {
                _progressiveBookBatch.push(parsed);
                _progressiveRawEntries.set(`book:${parsed.id}`, value);
                if (_progressiveBookTimer) clearTimeout(_progressiveBookTimer);
                _progressiveBookTimer = setTimeout(() => void withMergeLock(flushProgressiveBooks), 200);
            }
            return;
        }
        if (key.startsWith("annotation:") || key.startsWith("anno:")) {
            const parsed = parseSyncEntityEntry(key, value, { requireId: true }) as unknown as Annotation | null;
            if (parsed) {
                _progressiveAnnoBatch.push(parsed);
                _progressiveRawEntries.set(annotationEntryKey(parsed), value);
                if (_progressiveAnnoTimer) clearTimeout(_progressiveAnnoTimer);
                _progressiveAnnoTimer = setTimeout(() => void withMergeLock(flushProgressiveAnnos), 200);
            }
            return;
        }
        if (key.startsWith("collection:")) {
            const parsed = parseSyncEntityEntry(key, value, { requireId: true }) as unknown as Collection | null;
            if (parsed) {
                _progressiveCollectionBatch.push(parsed);
                if (_progressiveCollectionTimer) clearTimeout(_progressiveCollectionTimer);
                _progressiveCollectionTimer = setTimeout(() => void withMergeLock(flushProgressiveCollections), 200);
            }
            return;
        }

        syncRuntime.pendingDocsEntries.set(key, value);
        if (syncRuntime.pendingDocsEntries.size > MAX_PENDING_ENTRIES) {
            if (_docsLiveTimer) clearTimeout(_docsLiveTimer);
            processPendingDocs();
            return;
        }
        if (_docsLiveTimer) clearTimeout(_docsLiveTimer);
        _docsLiveTimer = setTimeout(processPendingDocs, 500);
    };

    const rawUnlisten = await listen<{ entries: { key: string; value: string }[]; deleted?: DocDeletion[] }>("docs-entry-batch", (event) => {
        for (const { key, value } of event.payload.entries ?? []) {
            handleIncomingEntry(key, value);
        }
        const deleted = event.payload.deleted ?? [];
        if (deleted.length > 0) {
            _pendingDocDeletions.push(...deleted);
            scheduleTombstoneFlush();
        }
    });

    syncRuntime.docsLiveUnlisten = () => {
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
        _pendingTombstones = [];
        _pendingDocDeletions = [];
        _progressiveRawEntries.clear();
        syncRuntime.pendingDocsEntries.clear();
        syncRuntime.docsLiveUnlisten = null;
    };

    return syncRuntime.docsLiveUnlisten;
}
