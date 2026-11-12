import { normalizeShelfHierarchy } from "../lib/shelf-hierarchy";
import { writeAllReportingFailures } from "../lib/legacy-sqlite-move";
import { loadStoredAnnotations } from "../lib/annotation-load";
import { isTauri } from "../lib/env";
import { coverDisplayUrl, getCoverImage, INLINE_COVER_MAX_CHARS } from "../lib/storage";
import {
    sqliteDeleteAnnotation,
    sqliteGetKv,
    sqliteIndexBooksFtsBatch,
    sqliteListCoverVersions,
    sqliteLoadAllBooks,
    sqliteSaveBookMetadata,
    sqliteSetKv,
    sqliteUpsertAnnotation,
} from "../lib/sqlite-storage";
import {
    applyCoverLookupToBooks,
    applyCoverLookupToRecentCache,
    type CachedBookMetadata,
    collectBookIdsMissingCoverPath,
    computeFtsHash,
    COVER_RESTORE_BATCH_SIZE,
    FTS_HASH_KV_KEY,
    type LegacyCollection,
    normalizeCollectionKind,
    normalizePersistedBook,
    reconcileHydratedAnnotations,
} from "./libraryHelpers";
import type { Annotation, Book, Collection, DeletionTombstone } from "../types";

export interface PersistedLibraryState {
    books: Book[];
    collections: Collection[];
    annotations: Annotation[];
    deletionTombstones: DeletionTombstone[];
    lastScannedAt?: Date;
    recentBooksCache: CachedBookMetadata[];
}

/**
 * Books and annotations that stores older than v7/v8 kept in the persisted KV
 * copy (desktop/mobile). They move to their SQLite tables at hydration, and
 * the KV copy keeps them (see `partialize`) until SQLite is confirmed to hold
 * every one, so a failed write is retried on the next launch instead of
 * losing the records. Reset at the start of each hydration.
 */
let legacyPendingMove: { books: Book[]; annotations: Annotation[] } | null = null;

/** Wraps the post-hydration callback; runs when a hydration starts. */
export function startingHydration<F>(afterHydration: F): F {
    legacyPendingMove = null;
    return afterHydration;
}

function isTombstoned(tombstones: DeletionTombstone[], entityType: "book" | "annotation", id: string): boolean {
    return tombstones.some((t) => t.entityType === entityType && t.entityId === id);
}

/**
 * Write the legacy records SQLite does not hold yet. Rows already there are
 * left alone (they may be newer than the KV copy). Returns the records that
 * were missing, so the caller can show them this session either way.
 */
async function moveMissingLegacyRecords<T extends { id: string }>(
    kind: "books" | "annotations",
    storedIds: ReadonlySet<string>,
    tombstones: DeletionTombstone[],
    write: (record: T) => Promise<unknown>,
    onClearedPendingMove: () => void,
): Promise<T[]> {
    const pending = legacyPendingMove?.[kind] as T[] | undefined;
    if (!pending || pending.length === 0) return [];
    const entityType = kind === "books" ? "book" : "annotation";
    const missing = pending.filter((record) =>
        record && record.id && !storedIds.has(record.id) && !isTombstoned(tombstones, entityType, record.id));
    const moved = missing.length === 0 || await writeAllReportingFailures(`legacy ${kind}`, missing, write);
    if (moved && legacyPendingMove) {
        legacyPendingMove = { ...legacyPendingMove, [kind]: [] };
        if (legacyPendingMove.books.length === 0 && legacyPendingMove.annotations.length === 0) {
            legacyPendingMove = null;
        }
        // Rewrite the persisted copy without the records SQLite now holds.
        onClearedPendingMove();
    }
    return missing;
}

export function migrateLibraryPersistedState(persistedState: unknown, version: number): PersistedLibraryState {
    const persisted = (
        typeof persistedState === "object" && persistedState !== null
            ? persistedState
            : {}
    ) as Partial<PersistedLibraryState>;

    const books = Array.isArray(persisted.books)
        ? (persisted.books as Book[]).map((book) => normalizePersistedBook(book))
        : [];
    const collections = Array.isArray(persisted.collections)
        ? (persisted.collections as LegacyCollection[])
            .map((collection) => normalizeCollectionKind(collection))
            .filter((collection): collection is Collection => Boolean(collection))
        : [];
    const annotations = Array.isArray(persisted.annotations)
        ? (persisted.annotations as Annotation[]).map((annotation) => ({
            ...annotation,
            referenceId: typeof annotation.referenceId === "string"
                ? annotation.referenceId
                : undefined,
        }))
        : [];
    const deletionTombstones = Array.isArray(persisted.deletionTombstones)
        ? persisted.deletionTombstones as DeletionTombstone[]
        : [];
    const lastScannedAt = persisted.lastScannedAt
        ? new Date(persisted.lastScannedAt)
        : undefined;
    const recentBooksCache = Array.isArray(persisted.recentBooksCache)
        ? persisted.recentBooksCache as CachedBookMetadata[]
        : [];

    // On native platforms books and annotations live in SQLite. Any still in the
    // KV copy stay there until hydration confirms SQLite holds them.
    if (isTauri() && (books.length > 0 || annotations.length > 0)) {
        legacyPendingMove = { books, annotations };
    }

    // When upgrading from < 7 on native platforms, migrate existing annotations into SQLite
    if (version < 7 && isTauri() && annotations.length > 0) {
        for (const ann of annotations) {
            if (ann && ann.id && ann.bookId) {
                void sqliteUpsertAnnotation(
                    ann.id,
                    ann.bookId,
                    JSON.stringify(ann),
                ).catch((e) => console.error("[migration-catch]", e));
            }
        }
    }

    // When upgrading from < 8 on native platforms, migrate existing books into SQLite
    if (version < 8 && isTauri() && books.length > 0) {
        for (const book of books) {
            if (book && book.id) {
                void sqliteSaveBookMetadata(
                    book.id,
                    JSON.stringify(book),
                ).catch((e) => console.error("[migration-catch]", e));
            }
        }
    }

    return {
        books: isTauri() ? [] : books,
        collections: normalizeShelfHierarchy(collections),
        annotations: isTauri() ? [] : annotations,
        deletionTombstones,
        lastScannedAt,
        recentBooksCache,
    };
}

export function getLibraryPartializeDeps(state: PersistedLibraryState): unknown[] {
    return [
        isTauri() ? legacyPendingMove?.books : state.books,
        state.collections,
        isTauri() ? legacyPendingMove?.annotations : state.annotations,
        state.deletionTombstones,
        state.lastScannedAt,
        state.recentBooksCache,
    ];
}

export function buildPartializedLibraryState(state: PersistedLibraryState): PersistedLibraryState {
    return {
        books: isTauri()
            ? legacyPendingMove?.books ?? []
            : (state.books.map(({ coverPath: _, locations: __, ...book }) => book) as Book[]),
        collections: state.collections,
        annotations: isTauri() ? legacyPendingMove?.annotations ?? [] : state.annotations,
        deletionTombstones: state.deletionTombstones,
        lastScannedAt: state.lastScannedAt,
        recentBooksCache: state.recentBooksCache.map(({ coverPath: _, ...book }) => book) as CachedBookMetadata[],
    };
}

export interface LibraryStoreHydrationApi {
    getState: () => {
        books: Book[];
        annotations: Annotation[];
        deletionTombstones: DeletionTombstone[];
        recentBooksCache: CachedBookMetadata[];
    };
    setState: (
        partial:
            | Partial<{ books: Book[]; annotations: Annotation[]; recentBooksCache: CachedBookMetadata[]; coversHydrated: boolean }>
            | ((state: { books: Book[]; recentBooksCache: CachedBookMetadata[] }) => Partial<{ books: Book[]; recentBooksCache: CachedBookMetadata[] }> | { books: Book[]; recentBooksCache: CachedBookMetadata[] }),
    ) => void;
}

function hydrateCoversAndFts(
    books: Book[],
    recentCache: CachedBookMetadata[],
    store: LibraryStoreHydrationApi,
): void {
    const bookIdsMissingCoverPath = collectBookIdsMissingCoverPath(
        books,
        recentCache,
    );

    store.setState({ coversHydrated: true });

    if (bookIdsMissingCoverPath.length > 0) {
        void (async () => {
            try {
                const allCovers = new Map<string, string>();
                if (isTauri()) {
                    const wanted = new Set(bookIdsMissingCoverPath);
                    const versions = await sqliteListCoverVersions();
                    for (const row of versions) {
                        if (!wanted.has(row.bookId)) continue;
                        if (row.dataUrlLen < INLINE_COVER_MAX_CHARS) {
                            const inline = await getCoverImage(row.bookId);
                            if (inline) allCovers.set(row.bookId, inline);
                        } else {
                            allCovers.set(row.bookId, coverDisplayUrl(row.bookId, row.updatedAt, row.isSvg));
                        }
                    }
                }
                for (let i = 0; !isTauri() && i < bookIdsMissingCoverPath.length; i += COVER_RESTORE_BATCH_SIZE) {
                    const batchIds = bookIdsMissingCoverPath.slice(i, i + COVER_RESTORE_BATCH_SIZE);
                    const batchEntries = await Promise.all(
                        batchIds.map(async (bookId) => {
                            const coverPath = await getCoverImage(bookId);
                            return [bookId, coverPath] as const;
                        }),
                    );

                    for (const [bookId, coverPath] of batchEntries) {
                        if (coverPath) {
                            allCovers.set(bookId, coverPath);
                        }
                    }
                }

                if (allCovers.size === 0) return;

                store.setState((currentState) => {
                    const nextBooks = applyCoverLookupToBooks(currentState.books, allCovers);
                    const recentBooksCache = applyCoverLookupToRecentCache(
                        currentState.recentBooksCache,
                        allCovers,
                    );

                    if (
                        nextBooks === currentState.books
                        && recentBooksCache === currentState.recentBooksCache
                    ) {
                        return currentState;
                    }

                    return {
                        books: nextBooks,
                        recentBooksCache,
                    };
                });
            } catch {

            }
        })();
    }

    if (books.length > 0 && isTauri()) {
        const ftsBatch = books.map((b: { id: string; title: string; author: string }) => [
            b.id,
            b.title,
            b.author,
        ] as [string, string, string]);
        void (async () => {
            const newHash = computeFtsHash(books);
            const prevHash = await sqliteGetKv(FTS_HASH_KV_KEY).catch(() => null);
            if (prevHash === newHash) {
                return;
            }
            await sqliteIndexBooksFtsBatch(ftsBatch).catch(e => console.error("[catch]", e));
            await sqliteSetKv(FTS_HASH_KV_KEY, newHash).catch(e => console.error("[catch]", e));
        })();
    }
}

export function handleLibraryRehydrate(
    state: PersistedLibraryState | undefined,
    store: LibraryStoreHydrationApi,
): void {
    if (!state) {
        store.setState({ coversHydrated: true });
        return;
    }

    // A KV copy at the current version (migrate did not run) can still hold
    // records whose move failed on an earlier launch: retry them.
    if (isTauri() && !legacyPendingMove
        && ((state.books?.length ?? 0) > 0 || (state.annotations?.length ?? 0) > 0)) {
        legacyPendingMove = {
            books: (state.books ?? []).map((book) => normalizePersistedBook(book)),
            annotations: state.annotations ?? [],
        };
    }

    state.collections = normalizeShelfHierarchy(state.collections
        .map((collection) => normalizeCollectionKind(collection as LegacyCollection))
        .filter((collection): collection is Collection => Boolean(collection)));

    const clearPersistedCopy = () => store.setState({});

    if (isTauri()) {
        void loadStoredAnnotations().then(async (parsed) => {
            const legacyAnnotations = await moveMissingLegacyRecords<Annotation>(
                "annotations",
                new Set(parsed.map((annotation) => annotation.id)),
                store.getState().deletionTombstones,
                (ann) => sqliteUpsertAnnotation(ann.id, ann.bookId, JSON.stringify(ann)),
                clearPersistedCopy,
            );
            for (const ann of legacyAnnotations) {
                parsed.push({
                    ...ann,
                    createdAt: ann.createdAt ? new Date(ann.createdAt) : new Date(),
                    updatedAt: ann.updatedAt ? new Date(ann.updatedAt) : undefined,
                });
            }
            if (parsed.length === 0) return;
            // Books hydrate concurrently, so "book not loaded yet" must never
            // count as orphaned. Only explicit tombstones remove rows here.
            const current = store.getState();
            const { kept, purgedIds } = reconcileHydratedAnnotations(
                parsed,
                current.annotations,
                current.deletionTombstones,
            );
            store.setState({ annotations: kept });
            for (const id of purgedIds) {
                void sqliteDeleteAnnotation(id).catch((e) => console.error("[catch]", e));
            }
        }).catch((e) => console.error("[catch]", e));
    } else {
        const { kept } = reconcileHydratedAnnotations(state.annotations, [], state.deletionTombstones ?? []);
        state.annotations = kept
            .map((annotation) => ({
                ...annotation,
                referenceId: typeof annotation.referenceId === "string"
                    ? annotation.referenceId
                    : undefined,
            }));
    }

    if (state.deletionTombstones?.length > 0) {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - 90);
        const cutoffStr = cutoff.toISOString();
        state.deletionTombstones = state.deletionTombstones.filter(
            (t: { deletedAt: string }) => t.deletedAt > cutoffStr,
        );
    }

    if (isTauri()) {
        void sqliteLoadAllBooks().then(async (bookStrings) => {
            let loadedBooks: Book[] = [];
            if (bookStrings && bookStrings.length > 0) {
                loadedBooks = bookStrings.map((s) => {
                    try {
                        const obj = JSON.parse(s);
                        return normalizePersistedBook(obj);
                    } catch {
                        return null;
                    }
                }).filter(Boolean) as Book[];
            }
            const legacyBooks = await moveMissingLegacyRecords<Book>(
                "books",
                new Set(loadedBooks.map((book) => book.id)),
                store.getState().deletionTombstones,
                (book) => sqliteSaveBookMetadata(book.id, JSON.stringify(book)),
                clearPersistedCopy,
            );
            loadedBooks = legacyBooks.length > 0 ? [...loadedBooks, ...legacyBooks] : loadedBooks;
            if (loadedBooks.length > 0) {
                store.setState({ books: loadedBooks });
            }
            hydrateCoversAndFts(loadedBooks, store.getState().recentBooksCache, store);
        }).catch((e) => console.error("[catch]", e));
    } else {
        hydrateCoversAndFts(state.books, state.recentBooksCache, store);
    }
}
