import { getPairedDevices } from "./device-sync";
import { useLibraryStore, useRssStore, useSettingsStore, useVocabularyStore } from "../store";
import type { Annotation, Book, DeletionTombstone } from "../types";
import { buildCoverEntry, coverEntryKey, coverMarker, coverPathForBookEntry, needsCoverEntry } from "./sync-covers";
import { localSettingsTimestamp, mergeIncomingData, tombstonesForDocDeletions } from "./sync-merge-engine";
import {
    alreadyProvisioned,
    annotationEntryKey,
    clearProvisionedFlag,
    type DocDeletion,
    docsAckEntries,
    docsGetChangedEntries,
    docsSetEntries,
    docsSetEntry,
    FULL_HYDRATE_EVERY_MS,
    noteSyncProtocols,
    rememberOwnWrite,
    rememberProvisioned,
    RSS_ARTICLE_KEY_PREFIX,
    RSS_FEED_KEY_PREFIX,
    scheduleDocsWrite,
    syncRuntime,
    TOMBSTONE_KEY_PREFIX,
    tombstoneEntryKey,
    VOCAB_KEY_PREFIX,
    warnMergeFailure,
    writeOwnEntry,
} from "./sync-runtime-state";

export function markProvisioningNeeded(): void {
    syncRuntime.initialProvisionDone = false;
    syncRuntime.forceReProvision = true;
    void clearProvisionedFlag();
}

/**
 * Removes this device's doc entries for deleted items, and its deletion
 * records that expired. The doc then holds a deletion for each item, which
 * never expires: devices that come back later still learn of it. Runs when
 * the set of deletions changed (or the peer set did, which clears
 * `syncRuntime.purgedTombstonesKey`).
 */
async function purgeDeletedDocEntries(tombstones: DeletionTombstone[]): Promise<void> {
    const key = tombstones.map((t) => `${t.entityType}:${t.entityId}`).sort().join("|");
    if (key === syncRuntime.purgedTombstonesKey) return;
    try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke<number>("docs_purge_entities", {
            entities: tombstones.map((t) => ({ entityType: t.entityType, entityId: t.entityId })),
        });
        await invoke<number>("docs_retain_own_entries", {
            prefix: TOMBSTONE_KEY_PREFIX,
            keep: tombstones.map(tombstoneEntryKey),
        });
        syncRuntime.purgedTombstonesKey = key;
    } catch (e) {
        if (import.meta.env.DEV) console.warn("[sync] could not remove deleted items from the sync doc", e);
    }
}

/**
 * Items provisioning held back because another device deleted them (their
 * newest doc entry is a deletion; this device may never have sent them, or
 * not since). Each is deleted here too, unless it changed here after the
 * deletion: then it is written anyway, and stays everywhere. Returns how
 * many could not be written.
 */
async function settleDeletedElsewhere(
    deleted: DocDeletion[],
    pending: Array<{ key: string; value: string; marker: string }>,
): Promise<number> {
    const byKey = new Map(pending.map((e) => [e.key, e]));
    const keep = deleted.filter((d) => tombstonesForDocDeletions([d]).length === 0);
    const drop = deleted.filter((d) => !keep.includes(d));
    if (drop.length > 0) await mergeIncomingData({}, undefined, drop);
    const rewrite = keep.map((d) => byKey.get(d.key)).filter((e): e is NonNullable<typeof e> => Boolean(e));
    if (rewrite.length === 0) return 0;
    if (!(await docsSetEntries(rewrite.map(({ key, value }) => ({ key, value })), true))) return rewrite.length;
    for (const e of rewrite) rememberProvisioned(e.key, e.marker);
    return 0;
}

/** Entries per IPC call when provisioning (a large library goes in parts). */
const PROVISION_BATCH = 400;

/** The book an `anno:{bookId}:{annotationId}` key belongs to; null for other keys. */
function annotationBookOf(key: string): string | null {
    if (!key.startsWith("anno:")) return null;
    const rest = key.slice("anno:".length);
    const end = rest.indexOf(":");
    return end > 0 ? rest.slice(0, end) : null;
}

/** Annotations ordered by book (`global` for those without one), each book's in their own order. */
export function annotationsByBook(annotations: Annotation[]): Annotation[] {
    const book = (a: Annotation) => a.bookId || "global";
    return annotations
        .map((a, i) => ({ a, i }))
        .sort((x, y) => {
            const bx = book(x.a);
            const by = book(y.a);
            return bx < by ? -1 : bx > by ? 1 : x.i - y.i;
        })
        .map(({ a }) => a);
}

/**
 * Splits provisioning into calls of at most `max` entries, keeping a book's
 * annotations (adjacent `anno:{bookId}:…` keys) in one call where they fit:
 * Rust writes them as one entry per book (sync protocol 3), and a book split
 * across calls has that entry written once per call.
 */
export function provisionBatches<T extends { key: string }>(pending: T[], max = PROVISION_BATCH): T[][] {
    const batches: T[][] = [];
    let current: T[] = [];
    const flush = () => {
        if (current.length > 0) batches.push(current);
        current = [];
    };
    let i = 0;
    while (i < pending.length) {
        const book = annotationBookOf(pending[i].key);
        let end = i + 1;
        if (book !== null) {
            while (end < pending.length && annotationBookOf(pending[end].key) === book) end++;
        }
        // A book with more than `max` annotations goes in parts of `max`.
        for (let start = i; start < end; start += max) {
            const part = pending.slice(start, Math.min(end, start + max));
            if (current.length + part.length > max) flush();
            current.push(...part);
        }
        i = end;
    }
    flush();
    return batches;
}

export async function provisionToIrohDocs(): Promise<boolean> {
    try {
        const lib = useLibraryStore.getState();
        const vocab = useVocabularyStore.getState();
        const rss = useRssStore.getState();
        const settings = useSettingsStore.getState();

        const { getPairedDevices: getDevices } = await import("./device-sync");
        const devices = (await getDevices().catch(() => null)) ?? [];
        noteSyncProtocols(devices);
        const peerSet = devices.map((d) => d.deviceId).sort().join("|");

        // A new/changed peer set or a doc re-import means peers may be missing
        // our entries, so write everything rather than only the deltas.
        // The per-key provisionedValues cache avoids re-writing unchanged data
        // while allowing mutations (e.g. reading progress updates) to push to iroh-docs.
        if (peerSet !== syncRuntime.lastProvisionFingerprint || syncRuntime.forceReProvision) {
            syncRuntime.provisionedValues.clear();
            syncRuntime.purgedTombstonesKey = "";
        }
        syncRuntime.lastProvisionFingerprint = peerSet;
        syncRuntime.forceReProvision = false;

        const serializeBook = (book: typeof lib.books[number]) => {
            const { filePath: _f, storagePath: _s, coverPath, locations: _l, ...stripped } = book;
            return JSON.stringify({
                ...stripped,
                ...(book.blobHash ? { blobHash: book.blobHash } : {}),
                ...(book.coverBlobHash ? { coverBlobHash: book.coverBlobHash } : {}),
                ...(coverPathForBookEntry(coverPath) ? { coverPath: coverPathForBookEntry(coverPath) } : {}),
            });
        };

        // Every item is its own entry, and only what changed since the last
        // provisioning is sent (Rust also skips a value equal to the one this
        // device already wrote). `marker` is what the cache compares.
        const pending: Array<{ key: string; value: string; marker: string }> = [];
        const queue = (key: string, value: string, marker: string = value) => {
            if (!alreadyProvisioned(key, marker)) pending.push({ key, value, marker });
        };

        for (const book of lib.books) {
            try {
                queue(`book:${book.id}`, serializeBook(book));
            } catch (e) {
                console.error(`[sync] Failed to provision book ${book.id} (${book.title || "unknown"}): ${e}`);
            }
        }
        // Covers travel as their own entries, re-sent only when the cover changes.
        for (const book of lib.books) {
            if (!needsCoverEntry(book.coverPath, book.coverUpdatedAt)) continue;
            const key = coverEntryKey(book.id);
            const marker = coverMarker(book);
            if (alreadyProvisioned(key, marker)) continue;
            try {
                const entry = await buildCoverEntry(book.id, book);
                if (entry) queue(key, entry, marker);
            } catch {
                // A missing cover must not fail provisioning.
            }
        }
        // Book by book: Rust writes a book's annotations as one entry.
        for (const a of annotationsByBook(lib.annotations)) queue(annotationEntryKey(a), JSON.stringify(a));
        for (const c of lib.collections) queue(`collection:${c.id}`, JSON.stringify(c));
        for (const t of lib.deletionTombstones) queue(tombstoneEntryKey(t), JSON.stringify(t));
        for (const v of vocab.vocabularyTerms) queue(VOCAB_KEY_PREFIX + v.id, JSON.stringify(v));
        for (const f of rss.feeds) queue(RSS_FEED_KEY_PREFIX + f.id, JSON.stringify(f));
        for (const a of rss.articles) queue(RSS_ARTICLE_KEY_PREFIX + a.id, JSON.stringify(a));
        queue("settings", JSON.stringify({
            ...settings.settings,
            _settingsUpdatedAt: settings.settingsLastModifiedAt || new Date().toISOString(),
        }));
        queue("reading_stats", JSON.stringify(settings.stats));
        // Devices on older versions read only the whole lists.
        if (syncRuntime.legacyPeers) {
            queue("annotations", JSON.stringify(lib.annotations));
            queue("collections", JSON.stringify(lib.collections));
            queue("deletion_tombstones", JSON.stringify(lib.deletionTombstones));
            queue("vocabulary", JSON.stringify(vocab.vocabularyTerms));
            queue("rss_feeds", JSON.stringify(rss.feeds));
            queue("rss_articles", JSON.stringify(rss.articles));
        }

        let failed = 0;
        const deletedElsewhere: DocDeletion[] = [];
        for (const batch of provisionBatches(pending)) {
            for (const e of batch) rememberOwnWrite(e.key, e.value);
            const result = await docsSetEntries(batch.map(({ key, value }) => ({ key, value })));
            if (result) {
                const held = new Set(result.deleted.map((d) => d.key));
                deletedElsewhere.push(...result.deleted);
                for (const e of batch) if (!held.has(e.key)) rememberProvisioned(e.key, e.marker);
            } else {
                failed += batch.length;
            }
        }
        if (deletedElsewhere.length > 0) {
            failed += await settleDeletedElsewhere(deletedElsewhere, pending);
        }
        if (failed > 0) {
            console.error(`[sync] Provisioning: ${failed} of ${pending.length} entries could not be written; they are sent again next time`);
        }

        await purgeDeletedDocEntries([...lib.deletionTombstones, ...(rss.deletionTombstones ?? [])]);

        return true;
    } catch (e) {
        console.error(`[sync] Provision failed (unexpected): ${e}`);
        return false;
    }
}

/**
 * Merges what the paired docs hold. Normally only entries that changed since
 * the last merge cross the IPC bridge (covers above all are not re-sent every
 * round); they are acknowledged only once merged and persisted, so a failed
 * merge gets them again next round.
 */
export async function hydrateFromIrohDocs(): Promise<string[]> {
    try {
        const full = Date.now() - syncRuntime.lastFullHydrateAt > FULL_HYDRATE_EVERY_MS;
        const read = await docsGetChangedEntries(full);
        if (!read) return [];
        const acknowledge = async () => {
            await docsAckEntries(read.token);
            if (full) syncRuntime.lastFullHydrateAt = Date.now();
        };
        const deleted = read.deleted ?? [];
        if (Object.keys(read.entries).length === 0 && deleted.length === 0) {
            await acknowledge();
            return [];
        }

        const { domainsUpdated, persisted } = await mergeIncomingData(
            read.entries,
            localSettingsTimestamp(),
            deleted,
        );
        if (persisted) await acknowledge();
        return domainsUpdated;
    } catch (e) {
        console.error("[sync] Reading the sync doc failed:", e);
        return [];
    }
}

/** Test hook: forget when the last full read happened. */
export function __resetHydrateScheduleForTests(): void {
    syncRuntime.lastFullHydrateAt = 0;
}

export function subscribeZustandToIrohDocs(): () => void {
    const unsubs: (() => void)[] = [];
    void getPairedDevices().then(noteSyncProtocols).catch(() => {});

    let prevBooks = useLibraryStore.getState().books;
    const initialCovers = new Map(prevBooks.map((book) => [book.id, coverMarker(book)]));
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
    // entity — optimal for action-agnostic diffing.
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
        if (syncRuntime.bridgePaused) return;
        // A merge of peer data: keep the indexes current, write nothing back.
        const fromPeer = syncRuntime.applyingRemote > 0;
        if (state.books !== prevBooks) {
            prevBooks = state.books;

            for (const book of state.books) {
                const entry = bookIndex.get(book.id);
                if (entry && entry.ref === book) continue;
                // An existing cover changed (edit, re-extraction): send it. First-time
                // covers (hydration, new imports) go out with the next provisioning.
                const previous = entry?.ref as Book | undefined;
                const previousCover = previous ? coverMarker(previous) : initialCovers.get(book.id);
                const marker = coverMarker(book);
                if (!fromPeer && previousCover !== undefined && marker !== previousCover && needsCoverEntry(book.coverPath, book.coverUpdatedAt)) {
                    const coverKey = coverEntryKey(book.id);
                    scheduleDocsWrite(coverKey, () => {
                        void buildCoverEntry(book.id, book).then((value) => {
                            if (value) return writeOwnEntry(coverKey, value, marker);
                        }).catch((error) => warnMergeFailure("cover", error));
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
                                if (ok) rememberProvisioned(bookKey, serialized);
                            });
                        });
                    }
                } else {
                    entry.ref = book;
                }
            }
            initialCovers.clear();
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
                        const annoKey = annotationEntryKey(ann);
                        scheduleDocsWrite(annoKey, () => void writeOwnEntry(annoKey, serialized));
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
            // Deletions travel as deletion records; only older devices still
            // need the whole list.
            if (annoDeletion && !fromPeer && syncRuntime.legacyPeers) {
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
                        scheduleDocsWrite(colKey, () => void writeOwnEntry(colKey, serialized));
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
            if (collectionDeletion && !fromPeer && syncRuntime.legacyPeers) {
                scheduleDocsWrite("collections", () => void writeOwnEntry("collections", JSON.stringify(collections)));
            }
            if (collectionIndex.size > collections.length) {
                sweepStaleIndex(collectionIndex, seenCollectionIds);
            }
        }
        if (state.deletionTombstones !== prevTombstones) {
            const before = new Set(prevTombstones.map(tombstoneEntryKey));
            prevTombstones = state.deletionTombstones;
            if (!fromPeer) {
                for (const t of state.deletionTombstones) {
                    const key = tombstoneEntryKey(t);
                    if (before.has(key)) continue;
                    const value = JSON.stringify(t);
                    scheduleDocsWrite(key, () => void writeOwnEntry(key, value));
                }
                if (syncRuntime.legacyPeers) {
                    scheduleDocsWrite("deletion_tombstones", () =>
                        void writeOwnEntry("deletion_tombstones", JSON.stringify(state.deletionTombstones)));
                }
            }
        }
    }));

    // One entry per word, written when that word changes (deletions travel
    // as deletion records).
    let prevVocab = useVocabularyStore.getState().vocabularyTerms;
    const vocabIndex = new Map<string, { ref: unknown; serialized: string }>();
    for (const term of prevVocab) vocabIndex.set(term.id, { ref: term, serialized: JSON.stringify(term) });
    unsubs.push(useVocabularyStore.subscribe((state) => {
        if (syncRuntime.bridgePaused) return;
        if (state.vocabularyTerms !== prevVocab) {
            prevVocab = state.vocabularyTerms;
            const fromPeer = syncRuntime.applyingRemote > 0;
            const seen = new Set<string>();
            for (const term of state.vocabularyTerms) {
                seen.add(term.id);
                const entry = vocabIndex.get(term.id);
                if (entry && entry.ref === term) continue;
                const serialized = JSON.stringify(term);
                if (entry && entry.serialized === serialized) {
                    entry.ref = term;
                    continue;
                }
                vocabIndex.set(term.id, { ref: term, serialized });
                if (!fromPeer) {
                    const key = VOCAB_KEY_PREFIX + term.id;
                    scheduleDocsWrite(key, () => void writeOwnEntry(key, serialized));
                }
            }
            for (const id of [...vocabIndex.keys()]) if (!seen.has(id)) vocabIndex.delete(id);
            if (!fromPeer && syncRuntime.legacyPeers) {
                scheduleDocsWrite("vocabulary", () => void writeOwnEntry("vocabulary", JSON.stringify(state.vocabularyTerms)));
            }
        }
    }));

    let prevFeeds = useRssStore.getState().feeds;
    let prevArticles = useRssStore.getState().articles;
    // Articles sync one entry each (only changed ones are written); deletions
    // travel as deletion records (older devices also get the whole list).
    const articleIndex = new Map<string, { ref: unknown; serialized: string }>();
    let prevArticleIds = new Set(prevArticles.map((a) => a.id));
    for (const article of prevArticles) articleIndex.set(article.id, { ref: article, serialized: JSON.stringify(article) });
    unsubs.push(useRssStore.subscribe((state) => {
        if (syncRuntime.bridgePaused) return;
        const fromPeer = syncRuntime.applyingRemote > 0;
        if (state.feeds !== prevFeeds) {
            const before = new Map(prevFeeds.map((f) => [f.id, f]));
            prevFeeds = state.feeds;
            if (!fromPeer) {
                for (const feed of state.feeds) {
                    if (before.get(feed.id) === feed) continue;
                    const key = RSS_FEED_KEY_PREFIX + feed.id;
                    const value = JSON.stringify(feed);
                    scheduleDocsWrite(key, () => void writeOwnEntry(key, value));
                }
                if (syncRuntime.legacyPeers) {
                    scheduleDocsWrite("rss_feeds", () => void writeOwnEntry("rss_feeds", JSON.stringify(state.feeds)));
                }
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
                        scheduleDocsWrite(key, () => void writeOwnEntry(key, serialized));
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
                if (!fromPeer && syncRuntime.legacyPeers) {
                    scheduleDocsWrite("rss_articles", () => void writeOwnEntry("rss_articles", JSON.stringify(articles)));
                }
                for (const id of articleIndex.keys()) if (!seenIds.has(id)) articleIndex.delete(id);
            }
        }
    }));

    let prevSettings = useSettingsStore.getState().settings;
    let prevStats = useSettingsStore.getState().stats;
    unsubs.push(useSettingsStore.subscribe((state) => {
        if (syncRuntime.bridgePaused) return;
        const fromPeer = syncRuntime.applyingRemote > 0;
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
        for (const t of syncRuntime.docsDebounceTimers.values()) clearTimeout(t);
        syncRuntime.docsDebounceTimers.clear();
    };
}
