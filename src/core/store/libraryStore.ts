import { create } from "zustand";
import { persist } from "zustand/middleware";
import { triggerVaultAutoSync } from "../lib/vault-sync";
import { deferredJsonStorage, memoizePartialize } from "../lib/persist-storage";
import { scheduleMutationSync } from "../lib/sync-orchestrator";
import { deleteBookStorage } from "../lib/storage-manager";
import { coverDisplayUrl, getCoverImage, INLINE_COVER_MAX_CHARS } from "../lib/storage";
import { persistBookLocations } from "../lib/book-locations";
import {
    sqliteSaveBookMetadata,
    sqliteDeleteBookMetadata,
    sqliteLoadAllBooks,
    sqliteUpdateBookProgress,
    sqliteSaveBookAnnotations,
    sqliteGetAllAnnotations,
    sqliteUpsertAnnotation,
    sqliteDeleteAnnotation,
    sqliteListCoverVersions,
    sqliteIndexBooksFtsBatch,
    sqliteIndexBookFts,
    sqliteGetKv,
    sqliteSetKv,
} from "../lib/sqlite-storage";
import { isTauri } from "../lib/env";

function persistBookToSqlite(book: Book): void {
    if (!isTauri()) return;
    sqliteSaveBookMetadata(book.id, JSON.stringify(book)).catch((e) => console.error("[catch]", e));
}
import type {
    Annotation,
    Book,
    BookAudioTrack,
    Collection,
    DeletionTombstone,
    HighlightColor,
    PdfViewState,
} from "../types";

interface CachedBookMetadata {
    id: string;
    title: string;
    author: string;
    coverPath?: string;
    currentLocation?: string;
    progress: number;
    lastClickFraction?: number;
    pageProgress?: {
        currentPage: number;
        endPage?: number;
        totalPages: number;
        range: string;
    };
    pdfViewState?: PdfViewState;
    lastReadAt: Date;
}

type CompletionUpdateSource = "auto" | "manual";

const createCacheEntry = (book: Book): CachedBookMetadata => ({
    id: book.id,
    title: book.title,
    author: book.author,
    coverPath: book.coverPath,
    currentLocation: book.currentLocation,
    progress: book.progress,
    lastClickFraction: book.lastClickFraction,
    pageProgress: book.pageProgress,
    pdfViewState: book.pdfViewState,
    lastReadAt: book.lastReadAt || new Date(),
});

function updateBookById(
    books: Book[],
    bookId: string,
    updater: (book: Book) => Book,
): { books: Book[]; updatedBook: Book | null } {
    const index = books.findIndex((book) => book.id === bookId);
    if (index === -1) {
        return { books, updatedBook: null };
    }

    const currentBook = books[index];
    const nextBook = updater(currentBook);
    if (nextBook === currentBook) {
        return { books, updatedBook: currentBook };
    }

    const nextBooks = books.slice();
    nextBooks[index] = nextBook;
    return { books: nextBooks, updatedBook: nextBook };
}

const bookLookupCache = new WeakMap<Book[], Map<string, Book>>();

const cachedBookLookupCache = new WeakMap<CachedBookMetadata[], Map<string, CachedBookMetadata>>();

const annotationsByBookCache = new WeakMap<Annotation[], Map<string, Annotation[]>>();

const recentBooksResultCache = new WeakMap<Book[], Book[]>();
const favoriteBooksResultCache = new WeakMap<Book[], Book[]>();
const booksByCategoryResultCache = new WeakMap<Book[], Map<string, Book[]>>();
const highlightsResultCache = new WeakMap<Annotation[], Map<string, Annotation[]>>();
const bookmarksResultCache = new WeakMap<Annotation[], Map<string, Annotation[]>>();
const searchBooksResultCache = new WeakMap<Book[], Map<string, Book[]>>();
const COVER_RESTORE_BATCH_SIZE = 48;

function getBookLookup(books: Book[]): Map<string, Book> {
    const existingLookup = bookLookupCache.get(books);
    if (existingLookup) {
        return existingLookup;
    }
    const nextLookup = new Map<string, Book>();
    for (const book of books) {
        nextLookup.set(book.id, book);
    }
    bookLookupCache.set(books, nextLookup);
    return nextLookup;
}

const libraryTitleSetCache = new WeakMap<Book[], Set<string>>();

export function normalizeLibraryTitle(title: string): string {
    return title.toLowerCase().trim();
}

// Shared normalized-title membership index for title-based existence
// checks (e.g. Discover cards). Built once per books-array identity and
// shared across all callers: O(n) once, O(1) per lookup — replacing
// per-card O(n) .find/.some scans on every store notification.
export function getLibraryTitleSet(books: Book[]): Set<string> {
    const existing = libraryTitleSetCache.get(books);
    if (existing) {
        return existing;
    }
    const next = new Set<string>();
    for (const book of books) {
        next.add(normalizeLibraryTitle(book.title));
    }
    libraryTitleSetCache.set(books, next);
    return next;
}

function getCachedBookLookup(cache: CachedBookMetadata[]): Map<string, CachedBookMetadata> {
    const existingLookup = cachedBookLookupCache.get(cache);
    if (existingLookup) {
        return existingLookup;
    }
    const nextLookup = new Map(cache.map((book) => [book.id, book]));
    cachedBookLookupCache.set(cache, nextLookup);
    return nextLookup;
}

function getAnnotationsByBookLookup(annotations: Annotation[]): Map<string, Annotation[]> {
    const existingLookup = annotationsByBookCache.get(annotations);
    if (existingLookup) {
        return existingLookup;
    }

    const nextLookup = new Map<string, Annotation[]>();
    for (const annotation of annotations) {
        const existingAnnotations = nextLookup.get(annotation.bookId);
        if (existingAnnotations) {
            existingAnnotations.push(annotation);
            continue;
        }
        nextLookup.set(annotation.bookId, [annotation]);
    }

    annotationsByBookCache.set(annotations, nextLookup);
    return nextLookup;
}

function getBookAnnotationSlice(annotations: Annotation[], bookId: string): Annotation[] {
    return getAnnotationsByBookLookup(annotations).get(bookId) ?? [];
}

function mergeBookIntoCachedEntry(entry: CachedBookMetadata, book: Book): CachedBookMetadata {
    return {
        ...entry,
        title: book.title,
        author: book.author,
        coverPath: book.coverPath,
        currentLocation: book.currentLocation,
        progress: book.progress,
        lastClickFraction: book.lastClickFraction,
        pageProgress: book.pageProgress,
        pdfViewState: book.pdfViewState,
        lastReadAt: book.lastReadAt || entry.lastReadAt,
    };
}

function syncRecentBooksCacheWithBook(
    cache: CachedBookMetadata[],
    book: Book,
): CachedBookMetadata[] {
    const index = cache.findIndex((entry) => entry.id === book.id);
    if (index === -1) {
        return cache;
    }

    const nextCache = cache.slice();
    nextCache[index] = mergeBookIntoCachedEntry(cache[index], book);
    return nextCache;
}

function normalizeContentHash(contentHash?: string): string | undefined {
    if (typeof contentHash !== "string") {
        return undefined;
    }

    const normalized = contentHash.trim().toLowerCase();
    return normalized.length > 0 ? normalized : undefined;
}

const FTS_HASH_KV_KEY = "fts:booksHash";

function fnv1aInto(hash: number, value: string): number {
    let h = hash >>> 0;
    for (let i = 0; i < value.length; i++) {
        h ^= value.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

export function computeFtsHash(books: Array<{ id: string; title: string; author: string }>): string {
    let hash = 0x811c9dc5;
    for (const book of books) {
        hash = fnv1aInto(hash, book.id);
        hash = fnv1aInto(hash, "\u0001");
        hash = fnv1aInto(hash, book.title ?? "");
        hash = fnv1aInto(hash, "\u0001");
        hash = fnv1aInto(hash, book.author ?? "");
        hash = fnv1aInto(hash, "\u0000");
    }
    return (hash >>> 0).toString(36);
}

function findDuplicateBookIndex(books: Book[], incomingBook: Book): number {
    const incomingHash = normalizeContentHash(incomingBook.contentHash);
    if (incomingHash) {
        const byHashIndex = books.findIndex(
            (book) => normalizeContentHash(book.contentHash) === incomingHash,
        );
        if (byHashIndex !== -1) {
            return byHashIndex;
        }
    }

    return books.findIndex((book) => {
        const sameStoragePath = Boolean(
            incomingBook.storagePath
            && book.storagePath
            && incomingBook.storagePath === book.storagePath,
        );
        if (sameStoragePath) {
            return true;
        }

        return (
            incomingBook.filePath === book.filePath
            && incomingBook.format === book.format
            && incomingBook.fileSize === book.fileSize
        );
    });
}

function isPlaceholderTitle(title: string): boolean {
    return title === "Unknown" || title.includes(".");
}

function isPlaceholderAuthor(author: string): boolean {
    return author === "Unknown Author" || author.trim().length === 0;
}

function mergeImportedBookMetadata(existingBook: Book, incomingBook: Book): Book {
    let changed = false;
    const nextBook = { ...existingBook };

    if (existingBook.syncedWithoutFile && incomingBook.storagePath) {
        nextBook.storagePath = incomingBook.storagePath;
        nextBook.filePath = incomingBook.filePath;
        nextBook.syncedWithoutFile = false;
        nextBook.coverExtractionDone = false;
        changed = true;
    }

    if (!existingBook.contentHash && incomingBook.contentHash) {
        nextBook.contentHash = incomingBook.contentHash;
        changed = true;
    }

    if (!existingBook.coverPath && incomingBook.coverPath) {
        nextBook.coverPath = incomingBook.coverPath;
        changed = true;
    }

    if (!existingBook.coverExtractionDone && incomingBook.coverExtractionDone) {
        nextBook.coverExtractionDone = true;
        changed = true;
    }

    if (isPlaceholderTitle(existingBook.title) && incomingBook.title && !isPlaceholderTitle(incomingBook.title)) {
        nextBook.title = incomingBook.title;
        changed = true;
    }

    if (isPlaceholderAuthor(existingBook.author) && incomingBook.author && !isPlaceholderAuthor(incomingBook.author)) {
        nextBook.author = incomingBook.author;
        changed = true;
    }

    if (!existingBook.description && incomingBook.description) {
        nextBook.description = incomingBook.description;
        changed = true;
    }

    if (!existingBook.publisher && incomingBook.publisher) {
        nextBook.publisher = incomingBook.publisher;
        changed = true;
    }

    if (!existingBook.publishedDate && incomingBook.publishedDate) {
        nextBook.publishedDate = incomingBook.publishedDate;
        changed = true;
    }

    if (!existingBook.language && incomingBook.language) {
        nextBook.language = incomingBook.language;
        changed = true;
    }

    if (!existingBook.isbn && incomingBook.isbn) {
        nextBook.isbn = incomingBook.isbn;
        changed = true;
    }

    return changed ? nextBook : existingBook;
}

function cleanupDiscardedImportedBook(book: Book): void {
    if (!book.id) {
        return;
    }

    if (isTauri()) {
        deleteBookStorage(book.id).catch(e => console.error("[catch]", e));
    }
}

function normalizePersistedBook(book: Book): Book {
    const contentHash = normalizeContentHash(book.contentHash);
    const hasLegacyPersistedCoverPath = typeof book.coverPath === "string" && book.coverPath.length > 0;
    const fallbackPath = `sqlite://${book.id}`;
    const normalizedFilePath = (
        typeof book.filePath === "string" && book.filePath.length > 0
    )
        ? book.filePath
        : (
            typeof book.storagePath === "string" && book.storagePath.length > 0
                ? book.storagePath
                : fallbackPath
        );
    const normalizedStoragePath = (
        typeof book.storagePath === "string" && book.storagePath.length > 0
    )
        ? book.storagePath
        : normalizedFilePath;

    return {
        ...book,
        contentHash,
        filePath: normalizedFilePath,
        storagePath: normalizedStoragePath,
        coverExtractionDone: Boolean(book.coverExtractionDone || hasLegacyPersistedCoverPath),
    };
}

function collectBookIdsMissingCoverPath(
    books: Book[],
    recentBooksCache: CachedBookMetadata[],
): string[] {
    const ids = new Set<string>();

    for (const book of books) {
        if (!book.coverPath) {
            ids.add(book.id);
        }
    }

    for (const cachedBook of recentBooksCache) {
        if (!cachedBook.coverPath) {
            ids.add(cachedBook.id);
        }
    }

    return [...ids];
}

function applyCoverLookupToBooks(books: Book[], coverLookup: Map<string, string>): Book[] {
    let changed = false;

    const nextBooks = books.map((book) => {
        if (book.coverPath) {
            return book;
        }

        const restoredCoverPath = coverLookup.get(book.id);
        if (!restoredCoverPath) {
            return book;
        }

        changed = true;
        return {
            ...book,
            coverPath: restoredCoverPath,
        };
    });

    return changed ? nextBooks : books;
}

function applyCoverLookupToRecentCache(
    recentBooksCache: CachedBookMetadata[],
    coverLookup: Map<string, string>,
): CachedBookMetadata[] {
    let changed = false;

    const nextCache = recentBooksCache.map((cachedBook) => {
        if (cachedBook.coverPath) {
            return cachedBook;
        }

        const restoredCoverPath = coverLookup.get(cachedBook.id);
        if (!restoredCoverPath) {
            return cachedBook;
        }

        changed = true;
        return {
            ...cachedBook,
            coverPath: restoredCoverPath,
        };
    });

    return changed ? nextCache : recentBooksCache;
}

type LegacyCollection = Omit<Collection, "kind"> & {
    kind?: "general" | "research";
};

function normalizeCollectionKind(collection: LegacyCollection): Collection | null {
    if (collection.kind === "research") {
        return null;
    }

    return {
        ...collection,
        kind: "general",
    };
}

function queueVaultSync(): void {
    triggerVaultAutoSync();
}

interface LibraryStore {
    books: Book[];
    collections: Collection[];
    annotations: Annotation[];
    deletionTombstones: DeletionTombstone[];
    lastScannedAt?: Date;
    
    recentBooksCache: CachedBookMetadata[];
    
    currentBookId?: string;
    
    coversHydrated: boolean;

    addBook: (book: Book) => void;
    addBooks: (books: Book[]) => void;
    removeBook: (bookId: string) => void;
    removeBooks: (bookIds: string[]) => void;
    updateBook: (bookId: string, updates: Partial<Book>) => void;
    updateProgress: (bookId: string, progress: number, location: string, lastClickFraction?: number, pageProgress?: { currentPage: number; endPage?: number; totalPages: number; range: string }) => void;
    updatePdfReadingState: (bookId: string, state: PdfViewState) => void;
    toggleFavorite: (bookId: string) => void;
    updateBookMetadata: (bookId: string, metadata: Partial<Book>) => void;
    attachAudiobook: (bookId: string, track: BookAudioTrack) => void;
    updateAudiobookProgress: (bookId: string, updates: Partial<Pick<BookAudioTrack, "currentPositionSec" | "playbackSpeed" | "lastListenedAt">>) => void;
    removeAudiobook: (bookId: string) => void;
    saveBookLocations: (bookId: string, locations: string) => void;

    addReadingTime: (bookId: string, minutes: number) => void;

    markBookCompleted: (
        bookId: string,
        source?: CompletionUpdateSource,
    ) => { wasAlreadyCompleted: boolean; completedYear: number } | null;
    markBookUnread: (bookId: string) => boolean;
    markBooksCompleted: (bookIds: string[]) => void;
    markBooksUnread: (bookIds: string[]) => void;

    addCollection: (collection: Collection) => void;
    removeCollection: (collectionId: string) => void;
    updateCollection: (collectionId: string, updates: Partial<Omit<Collection, 'id'>>) => void;
    addBookToCollection: (bookId: string, collectionId: string) => void;
    addBooksToCollection: (bookIds: string[], collectionId: string) => void;
    removeBookFromCollection: (bookId: string, collectionId: string) => void;
    removeBooksFromCollection: (bookIds: string[], collectionId: string) => void;

    addAnnotation: (annotation: Annotation) => void;
    addHighlightWithNote: (cfi: string, text: string, color: HighlightColor, note?: string) => Annotation;
    updateAnnotation: (annotationId: string, updates: Partial<Annotation>) => void;
    removeAnnotation: (annotationId: string) => void;
    getBookAnnotations: (bookId: string) => Annotation[];
    getHighlights: (bookId: string) => Annotation[];
    getBookmarks: (bookId: string) => Annotation[];
    exportAnnotationsToMarkdown: (bookId: string) => string;

    getBook: (bookId: string) => Book | undefined;
    getRecentBooks: (limit?: number) => Book[];
    getFavoriteBooks: () => Book[];
    getBooksByCategory: (category: string) => Book[];
    searchBooks: (query: string) => Book[];
    getCachedBook: (bookId: string) => CachedBookMetadata | undefined;

    setLastScannedAt: (date: Date) => void;

    setCurrentBookId: (bookId: string | undefined) => void;

}

type PersistedLibraryState = Pick<
    LibraryStore,
    "books" | "collections" | "annotations" | "deletionTombstones" | "lastScannedAt" | "recentBooksCache"
>;

export const useLibraryStore = create<LibraryStore>()(
    persist(
        (set, get) => ({
            books: [],
            collections: [],
            annotations: [],
            deletionTombstones: [],
            recentBooksCache: [],
            coversHydrated: false,

            addBook: (book) => {
                const state = get();
                const duplicateIndex = findDuplicateBookIndex(state.books, book);

                if (duplicateIndex === -1) {
                    set({ books: [...state.books, book] });
                    persistBookToSqlite(book);
                    if (isTauri()) {
                        sqliteIndexBookFts(book.id, book.title, book.author).catch(e => console.error("[catch]", e));
                    }
                    return;
                }

                const duplicateBook = state.books[duplicateIndex];
                if (duplicateBook.id !== book.id) {
                    if (!duplicateBook.syncedWithoutFile) {
                        cleanupDiscardedImportedBook(book);
                    }
                }

                const mergedBook = mergeImportedBookMetadata(duplicateBook, book);
                if (mergedBook === duplicateBook) {
                    return;
                }

                const books = state.books.slice();
                books[duplicateIndex] = mergedBook;

                const recentBooksCache = syncRecentBooksCacheWithBook(
                    state.recentBooksCache,
                    mergedBook,
                );

                set(
                    recentBooksCache === state.recentBooksCache
                        ? { books }
                        : { books, recentBooksCache },
                );
                scheduleMutationSync();
                persistBookToSqlite(mergedBook);
                if (isTauri()) {
                    sqliteIndexBookFts(book.id, book.title, book.author).catch(e => console.error("[catch]", e));
                }
            },

            addBooks: (incomingBooks) => {
                if (incomingBooks.length === 0) {
                    return;
                }

                const state = get();
                let nextBooks = state.books;
                let nextRecentBooksCache = state.recentBooksCache;
                let booksChanged = false;
                let cacheChanged = false;

                const contentHashToIndex = new Map<string, number>();
                const storagePathToIndex = new Map<string, number>();
                const fileKeyToIndex = new Map<string, number>();

                for (let i = 0; i < nextBooks.length; i++) {
                    const book = nextBooks[i];
                    const hash = normalizeContentHash(book.contentHash);
                    if (hash) contentHashToIndex.set(hash, i);
                    if (book.storagePath) storagePathToIndex.set(book.storagePath, i);
                    fileKeyToIndex.set(`${book.filePath}:${book.format}:${book.fileSize}`, i);
                }

                const findDuplicate = (incoming: Book): number => {
                    const hash = normalizeContentHash(incoming.contentHash);
                    if (hash && contentHashToIndex.has(hash)) return contentHashToIndex.get(hash)!;
                    if (incoming.storagePath && storagePathToIndex.has(incoming.storagePath)) return storagePathToIndex.get(incoming.storagePath)!;
                    const fileKey = `${incoming.filePath}:${incoming.format}:${incoming.fileSize}`;
                    if (fileKeyToIndex.has(fileKey)) return fileKeyToIndex.get(fileKey)!;
                    return -1;
                };

                for (const incomingBook of incomingBooks) {
                    const duplicateIndex = findDuplicate(incomingBook);

                    if (duplicateIndex === -1) {
                        if (!booksChanged) {
                            nextBooks = nextBooks.slice();
                            booksChanged = true;
                        }
                        nextBooks.push(incomingBook);
                        const idx = nextBooks.length - 1;
                        const hash = normalizeContentHash(incomingBook.contentHash);
                        if (hash) contentHashToIndex.set(hash, idx);
                        if (incomingBook.storagePath) storagePathToIndex.set(incomingBook.storagePath, idx);
                        fileKeyToIndex.set(`${incomingBook.filePath}:${incomingBook.format}:${incomingBook.fileSize}`, idx);
                        continue;
                    }

                    const duplicateBook = nextBooks[duplicateIndex];
                    if (duplicateBook.id !== incomingBook.id) {
                        if (!duplicateBook.syncedWithoutFile) {
                            cleanupDiscardedImportedBook(incomingBook);
                        }
                    }

                    const mergedBook = mergeImportedBookMetadata(duplicateBook, incomingBook);
                    if (mergedBook !== duplicateBook) {
                        if (!booksChanged) {
                            nextBooks = nextBooks.slice();
                            booksChanged = true;
                        }
                        nextBooks[duplicateIndex] = mergedBook;

                        const updatedCache = syncRecentBooksCacheWithBook(
                            nextRecentBooksCache,
                            mergedBook,
                        );
                        if (updatedCache !== nextRecentBooksCache) {
                            nextRecentBooksCache = updatedCache;
                            cacheChanged = true;
                        }
                    }
                }

                if (!booksChanged && !cacheChanged) {
                    return;
                }

                set(
                    cacheChanged
                        ? { books: nextBooks, recentBooksCache: nextRecentBooksCache }
                        : { books: nextBooks },
                );
                scheduleMutationSync();
                if (isTauri()) {
                    for (const book of incomingBooks) {
                        persistBookToSqlite(book);
                    }
                }
                if (isTauri() && incomingBooks.length > 0) {
                    const ftsEntries: Array<[string, string, string]> = incomingBooks.map(b => [b.id, b.title, b.author]);
                    sqliteIndexBooksFtsBatch(ftsEntries).catch(e => console.error("[catch]", e));
                }
            },

            removeBook: async (bookId) => {
                get().removeBooks([bookId]);
            },

            // Batch delete in a single set so the confirm dialog dismisses
            // instantly instead of freezing through N per-book persists.
            removeBooks: (bookIds) => {
                if (bookIds.length === 0) return;
                const idSet = new Set(bookIds);
                const now = new Date().toISOString();

                const state = get();
                for (const book of state.books) {
                    if (!idSet.has(book.id) || book.syncedWithoutFile) continue;
                    if (isTauri()) {
                        deleteBookStorage(book.id).catch(e => console.error("[catch]", e));
                    }
                }

                const annotationIds = state.annotations
                    .filter((a) => a.bookId && idSet.has(a.bookId))
                    .map((a) => a.id);

                const newTombstones: DeletionTombstone[] = [
                    ...bookIds.map((bookId) => ({
                        entityId: bookId,
                        entityType: "book" as const,
                        deletedAt: now,
                    })),
                    ...annotationIds.map((id) => ({
                        entityId: id,
                        entityType: "annotation" as const,
                        deletedAt: now,
                    })),
                ];

                set((prev) => ({
                    books: prev.books.filter((b) => !idSet.has(b.id)),
                    annotations: prev.annotations.filter((a) => !(a.bookId && idSet.has(a.bookId))),
                    recentBooksCache: prev.recentBooksCache.filter((b) => !idSet.has(b.id)),
                    collections: prev.collections.map((c) => ({
                        ...c,
                        bookIds: c.bookIds.filter((id) => !idSet.has(id)),
                    })),
                    deletionTombstones: [...prev.deletionTombstones, ...newTombstones],
                }));
                if (isTauri()) {
                    for (const id of bookIds) {
                        void sqliteSaveBookAnnotations(id, []).catch((e) => console.error("[catch]", e));
                        void sqliteDeleteBookMetadata(id).catch((e) => console.error("[catch]", e));
                    }
                }
                queueVaultSync();
                scheduleMutationSync();
            },

            updateBook: (bookId, updates) =>
                set((state) => {
                    const { books, updatedBook } = updateBookById(state.books, bookId, (book) => ({
                        ...book,
                        ...updates,
                    }));
                    if (!updatedBook) {
                        return { books };
                    }
                    persistBookToSqlite(updatedBook);

                    const recentBooksCache = syncRecentBooksCacheWithBook(
                        state.recentBooksCache,
                        updatedBook,
                    );
                    return recentBooksCache === state.recentBooksCache
                        ? { books }
                        : { books, recentBooksCache };
                }),

            updateProgress: (bookId, progress, location, lastClickFraction, pageProgress) =>
                set((state) => {
                    const { books: updatedBooks, updatedBook } = updateBookById(
                        state.books,
                        bookId,
                        (book) => ({
                            ...book,
                            progress,
                            currentLocation: location,
                            ...(lastClickFraction !== undefined && { lastClickFraction }),
                            ...(pageProgress !== undefined && { pageProgress }),
                            lastReadAt: new Date(),
                        }),
                    );

                    if (updatedBook) {
                        if (isTauri()) {
                            sqliteUpdateBookProgress(bookId, {
                                progress,
                                currentLocation: location,
                                lastReadAt: updatedBook.lastReadAt ? updatedBook.lastReadAt.toISOString() : new Date().toISOString(),
                                lastClickFraction,
                                pageProgressJson: pageProgress ? JSON.stringify(pageProgress) : undefined,
                            }).catch((e) => console.error("[catch]", e));
                        }
                        const existingCache = state.recentBooksCache.filter((book) => book.id !== bookId);
                        const newCache = [createCacheEntry(updatedBook), ...existingCache].slice(0, 20);
                        scheduleMutationSync("reading");
                        return { books: updatedBooks, recentBooksCache: newCache };
                    }

                    return { books: updatedBooks };
                }),

            updatePdfReadingState: (bookId, pdfState) =>
                set((state) => {
                    const safeTotalPages = Math.max(1, Math.floor(pdfState.totalPages || 1));
                    const safePage = Math.max(1, Math.min(Math.floor(pdfState.page || 1), safeTotalPages));
                    const safeZoom = Math.max(0.25, Math.min(5, Number.isFinite(pdfState.zoom) ? pdfState.zoom : 1));
                    const safeProgress = Math.max(0, Math.min(1, safePage / safeTotalPages));
                    const safePdfViewState: PdfViewState = {
                        page: safePage,
                        totalPages: safeTotalPages,
                        zoom: safeZoom,
                        zoomMode: pdfState.zoomMode,
                        presentationMode: pdfState.presentationMode,
                    };

                    const { books: updatedBooks, updatedBook } = updateBookById(
                        state.books,
                        bookId,
                        (book) => {
                            const nextLocation = `pdf:page:${safePage}`;
                            const existingPdfViewState = book.pdfViewState;
                            const hasSamePdfState = !!existingPdfViewState
                                && existingPdfViewState.page === safePdfViewState.page
                                && existingPdfViewState.totalPages === safePdfViewState.totalPages
                                && Math.abs(existingPdfViewState.zoom - safePdfViewState.zoom) < 0.0001
                                && existingPdfViewState.zoomMode === safePdfViewState.zoomMode
                                && existingPdfViewState.presentationMode === safePdfViewState.presentationMode;
                            const hasSameLocation = book.currentLocation === nextLocation;
                            const hasSameProgress = Math.abs((book.progress ?? 0) - safeProgress) < 0.0001;
                            const hasSamePageProgress = !!book.pageProgress
                                && book.pageProgress.currentPage === safePage
                                && book.pageProgress.totalPages === safeTotalPages
                                && book.pageProgress.range === `${safePage}`;

                            if (hasSamePdfState && hasSameLocation && hasSameProgress && hasSamePageProgress) {
                                return book;
                            }

                            return {
                                ...book,
                                currentLocation: nextLocation,
                                progress: safeProgress,
                                pageProgress: {
                                    currentPage: safePage,
                                    totalPages: safeTotalPages,
                                    range: `${safePage}`,
                                },
                                pdfViewState: safePdfViewState,
                                lastReadAt: new Date(),
                            };
                        },
                    );

                    if (updatedBooks === state.books) {
                        return state;
                    }

                    scheduleMutationSync("reading");

                    if (updatedBook) {
                        if (isTauri()) {
                            sqliteUpdateBookProgress(bookId, {
                                progress: updatedBook.progress ?? 0,
                                currentLocation: updatedBook.currentLocation,
                                lastReadAt: updatedBook.lastReadAt ? updatedBook.lastReadAt.toISOString() : new Date().toISOString(),
                                pageProgressJson: updatedBook.pageProgress ? JSON.stringify(updatedBook.pageProgress) : undefined,
                                pdfViewStateJson: updatedBook.pdfViewState ? JSON.stringify(updatedBook.pdfViewState) : undefined,
                            }).catch((e) => console.error("[catch]", e));
                        }
                        const existingCache = state.recentBooksCache.filter((book) => book.id !== bookId);
                        const newCache = [createCacheEntry(updatedBook), ...existingCache].slice(0, 20);
                        return { books: updatedBooks, recentBooksCache: newCache };
                    }

                    return { books: updatedBooks };
                }),

            toggleFavorite: (bookId) => {
                const state = get();
                const { books, updatedBook } = updateBookById(state.books, bookId, (book) => ({
                    ...book,
                    isFavorite: !book.isFavorite,
                }));
                if (!updatedBook) {
                    if (books !== state.books) set({ books });
                    return;
                }
                persistBookToSqlite(updatedBook);
                const newCache = syncRecentBooksCacheWithBook(state.recentBooksCache, updatedBook);
                set({ books, recentBooksCache: newCache });
                scheduleMutationSync();
            },

            updateBookMetadata: (bookId, metadata) => {
                const state = get();
                const { books, updatedBook } = updateBookById(state.books, bookId, (book) => ({
                    ...book,
                    ...metadata,
                }));
                if (!updatedBook) {
                    if (books !== state.books) set({ books });
                    return;
                }
                persistBookToSqlite(updatedBook);

                if (isTauri() && (metadata.title !== undefined || metadata.author !== undefined)) {
                    sqliteIndexBookFts(bookId, updatedBook.title, updatedBook.author).catch(e => console.error("[catch]", e));
                }

                const newCache = syncRecentBooksCacheWithBook(state.recentBooksCache, updatedBook);
                set({ books, recentBooksCache: newCache });
                scheduleMutationSync();
            },

            attachAudiobook: (bookId, track) => {
                const state = get();
                const { books, updatedBook } = updateBookById(state.books, bookId, (book) => ({
                    ...book,
                    audioTrack: track,
                }));
                if (!updatedBook) {
                    if (books !== state.books) set({ books });
                    return;
                }
                persistBookToSqlite(updatedBook);
                const newCache = syncRecentBooksCacheWithBook(state.recentBooksCache, updatedBook);
                set({ books, recentBooksCache: newCache });
                scheduleMutationSync();
            },

            updateAudiobookProgress: (bookId, updates) => {
                const state = get();
                const { books, updatedBook } = updateBookById(state.books, bookId, (book) =>
                    book.audioTrack
                        ? { ...book, audioTrack: { ...book.audioTrack, ...updates } }
                        : book,
                );
                if (!updatedBook) {
                    if (books !== state.books) set({ books });
                    return;
                }
                persistBookToSqlite(updatedBook);
                const newCache = syncRecentBooksCacheWithBook(state.recentBooksCache, updatedBook);
                set({ books, recentBooksCache: newCache });
                scheduleMutationSync();
            },

            removeAudiobook: (bookId) => {
                const state = get();
                const { books, updatedBook } = updateBookById(state.books, bookId, (book) => ({
                    ...book,
                    audioTrack: undefined,
                }));
                if (!updatedBook) {
                    if (books !== state.books) set({ books });
                    return;
                }
                persistBookToSqlite(updatedBook);
                const newCache = syncRecentBooksCacheWithBook(state.recentBooksCache, updatedBook);
                set({ books, recentBooksCache: newCache });
                scheduleMutationSync();
            },

            saveBookLocations: (bookId, locations) => {
                persistBookLocations(bookId, locations);
                return set((state) => {
                    const { books, updatedBook } = updateBookById(state.books, bookId, (book) => ({
                        ...book,
                        locations,
                    }));
                    if (!updatedBook) return { books };
                    persistBookToSqlite(updatedBook);
                    const recentBooksCache = syncRecentBooksCacheWithBook(
                        state.recentBooksCache,
                        updatedBook,
                    );
                    return recentBooksCache === state.recentBooksCache
                        ? { books }
                        : { books, recentBooksCache };
                });
            },

            addReadingTime: (bookId, minutes) =>
                set((state) => {
                    const { books, updatedBook } = updateBookById(state.books, bookId, (book) => ({
                        ...book,
                        readingTime: (book.readingTime || 0) + minutes,
                    }));
                    if (!updatedBook) {
                        return { books };
                    }
                    persistBookToSqlite(updatedBook);
                    scheduleMutationSync();
                    const recentBooksCache = syncRecentBooksCacheWithBook(
                        state.recentBooksCache,
                        updatedBook,
                    );
                    return recentBooksCache === state.recentBooksCache
                        ? { books }
                        : { books, recentBooksCache };
                }),

            markBookCompleted: (bookId, source = "manual") => {
                const book = get().getBook(bookId);
                if (!book) return null;

                if (source === "auto" && book.manualCompletionState === "unread") {
                    return null;
                }

                const now = new Date();
                const currentYear = now.getFullYear();
                const wasAlreadyCompleted = !!book.completedAt;
                let completedYear = currentYear;

                if (wasAlreadyCompleted && book.completedAt) {
                    const completedDate = book.completedAt instanceof Date
                        ? book.completedAt
                        : new Date(book.completedAt);
                    completedYear = completedDate.getFullYear();
                }

                const shouldSetManualRead = source === "manual" && book.manualCompletionState !== "read";
                const shouldSetCompletedAt = !wasAlreadyCompleted;

                if (shouldSetManualRead || shouldSetCompletedAt) {
                    let savedBook: Book | null = null;
                    set((state) => {
                        const { books: updatedBooks, updatedBook } = updateBookById(
                            state.books,
                            bookId,
                            (current) => ({
                                ...current,
                                progress: 1.0,
                                completedAt: current.completedAt || now,
                                ...(
                                    !current.completedAt
                                        ? { progressBeforeFinish: Math.max(0, Math.min(1, current.progress || 0)) }
                                        : {}
                                ),
                                ...(source === "manual" ? { manualCompletionState: "read" as const } : {}),
                            }),
                        );

                        if (!updatedBook) {
                            return { books: updatedBooks };
                        }
                        savedBook = updatedBook;

                        const existingCache = state.recentBooksCache.filter((entry) => entry.id !== bookId);
                        const newCache = [createCacheEntry(updatedBook), ...existingCache].slice(0, 20);

                        return {
                            books: updatedBooks,
                            recentBooksCache: newCache,
                        };
                    });
                    if (savedBook) persistBookToSqlite(savedBook);
                    scheduleMutationSync();
                }

                return { wasAlreadyCompleted, completedYear };
            },

            markBookUnread: (bookId) => {
                const book = get().getBook(bookId);
                if (!book) return false;

                const isAlreadyUnread = !book.completedAt && book.manualCompletionState === "unread";

                if (isAlreadyUnread) {
                    return false;
                }

                let savedBook: Book | null = null;
                set((state) => {
                    const { books: updatedBooks, updatedBook } = updateBookById(
                        state.books,
                        bookId,
                        (current) => ({
                            ...current,
                            completedAt: undefined,
                            manualCompletionState: "unread",
                            progress: Math.max(0, Math.min(1, current.progressBeforeFinish ?? 0)),
                            progressBeforeFinish: undefined,
                        }),
                    );

                    if (!updatedBook) {
                        return { books: updatedBooks };
                    }
                    savedBook = updatedBook;

                    const existingCache = state.recentBooksCache.filter((entry) => entry.id !== bookId);
                    const newCache = [createCacheEntry(updatedBook), ...existingCache].slice(0, 20);

                    return {
                        books: updatedBooks,
                        recentBooksCache: newCache,
                    };
                });
                if (savedBook) persistBookToSqlite(savedBook);
                scheduleMutationSync();

                return true;
            },

            // Batch completion toggles in a single set + single sync so
            // multi-select actions don't freeze the UI with N persists.
            markBooksCompleted: (bookIds) => {
                if (bookIds.length === 0) return;
                const idSet = new Set(bookIds);
                const now = new Date();
                let changed = false;
                let touchedBooks: Book[] = [];
                set((state) => {
                    const books = state.books.map((book) => {
                        if (!idSet.has(book.id)) return book;
                        if (book.completedAt && book.manualCompletionState === "read") return book;
                        changed = true;
                        return {
                            ...book,
                            progress: 1.0,
                            completedAt: book.completedAt || now,
                            ...(!book.completedAt
                                ? { progressBeforeFinish: Math.max(0, Math.min(1, book.progress || 0)) }
                                : {}),
                            manualCompletionState: "read" as const,
                        };
                    });
                    if (!changed) return state;
                    const touched = books.filter((b) => idSet.has(b.id));
                    touchedBooks = touched;
                    const touchedIds = new Set(touched.map((b) => b.id));
                    const existingCache = state.recentBooksCache.filter((entry) => !touchedIds.has(entry.id));
                    const newCache = [
                        ...touched.map(createCacheEntry),
                        ...existingCache,
                    ].slice(0, 20);
                    return { books, recentBooksCache: newCache };
                });
                if (changed) {
                    for (const b of touchedBooks) persistBookToSqlite(b);
                    scheduleMutationSync();
                }
            },

            markBooksUnread: (bookIds) => {
                if (bookIds.length === 0) return;
                const idSet = new Set(bookIds);
                let changed = false;
                let touchedBooks: Book[] = [];
                set((state) => {
                    const books = state.books.map((book) => {
                        if (!idSet.has(book.id)) return book;
                        if (!book.completedAt && book.manualCompletionState === "unread") return book;
                        changed = true;
                        return {
                            ...book,
                            completedAt: undefined,
                            manualCompletionState: "unread" as const,
                            progress: Math.max(0, Math.min(1, book.progressBeforeFinish ?? 0)),
                            progressBeforeFinish: undefined,
                        };
                    });
                    if (!changed) return state;
                    const touched = books.filter((b) => idSet.has(b.id));
                    touchedBooks = touched;
                    const touchedIds = new Set(touched.map((b) => b.id));
                    const existingCache = state.recentBooksCache.filter((entry) => !touchedIds.has(entry.id));
                    const newCache = [
                        ...touched.map(createCacheEntry),
                        ...existingCache,
                    ].slice(0, 20);
                    return { books, recentBooksCache: newCache };
                });
                if (changed) {
                    for (const b of touchedBooks) persistBookToSqlite(b);
                    scheduleMutationSync();
                }
            },

            addCollection: (collection) => {
                set((state) => ({ collections: [...state.collections, collection] }));
                scheduleMutationSync();
            },

            removeCollection: (collectionId) => {
                set((state) => ({
                    collections: state.collections.filter((c) => c.id !== collectionId),
                    deletionTombstones: [
                        ...state.deletionTombstones,
                        { entityId: collectionId, entityType: "collection" as const, deletedAt: new Date().toISOString() },
                    ],
                }));
                scheduleMutationSync();
            },

            updateCollection: (collectionId, updates) => {
                set((state) => ({
                    collections: state.collections.map((c) =>
                        c.id === collectionId ? { ...c, ...updates, updatedAt: new Date() } : c
                    ),
                }));
                scheduleMutationSync();
            },

            addBookToCollection: (bookId, collectionId) => {
                const state = get();
                if (!getBookLookup(state.books).has(bookId)) return;
                get().addBooksToCollection([bookId], collectionId);
            },

            // Batch shelf assignment in a single set + single sync/schedule
            // so multi-select drops don't freeze the UI with N persists (#104).
            addBooksToCollection: (bookIds, collectionId) => {
                if (bookIds.length === 0) return;
                const lookup = getBookLookup(get().books);
                const validIds = bookIds.filter((id) => lookup.has(id));
                if (validIds.length === 0) return;
                let changed = false;
                set((state) => ({
                    collections: state.collections.map((c) => {
                        if (c.id !== collectionId) return c;
                        const existing = new Set(c.bookIds);
                        const merged = [...c.bookIds];
                        for (const id of validIds) {
                            if (!existing.has(id)) {
                                existing.add(id);
                                merged.push(id);
                                changed = true;
                            }
                        }
                        return merged.length === c.bookIds.length
                            ? c
                            : { ...c, bookIds: merged, updatedAt: new Date() };
                    }),
                }));
                if (changed) scheduleMutationSync();
            },

            removeBookFromCollection: (bookId, collectionId) => {
                get().removeBooksFromCollection([bookId], collectionId);
            },

            // Batch shelf removal in a single collections set + single
            // tombstone set + single sync (#109 shelf-aware toolbar).
            removeBooksFromCollection: (bookIds, collectionId) => {
                if (bookIds.length === 0) return;
                const idSet = new Set(bookIds);
                let changed = false;
                const deletedAt = new Date().toISOString();
                set((state) => {
                    const collections = state.collections.map((c) => {
                        if (c.id !== collectionId) return c;
                        const nextIds = c.bookIds.filter((id) => !idSet.has(id));
                        if (nextIds.length === c.bookIds.length) return c;
                        changed = true;
                        return { ...c, bookIds: nextIds, updatedAt: new Date() };
                    });
                    if (!changed) return state;
                    const tombstones: DeletionTombstone[] = bookIds.map((bookId) => ({
                        entityId: `${collectionId}:${bookId}`,
                        entityType: "collection_book" as const,
                        deletedAt,
                    }));
                    return {
                        collections,
                        deletionTombstones: [...state.deletionTombstones, ...tombstones],
                    };
                });
                if (changed) scheduleMutationSync();
            },

            addAnnotation: (annotation) => {
                set((state) => ({ annotations: [...state.annotations, annotation] }));
                queueVaultSync();
                scheduleMutationSync();
                if (isTauri()) {
                    void sqliteUpsertAnnotation(
                        annotation.id,
                        annotation.bookId,
                        JSON.stringify(annotation),
                    ).catch((e) => console.error("[catch]", e));
                }
            },

            addHighlightWithNote: (cfi, text, color, note) => {
                const currentBookId = get().currentBookId || "";
                const annotation: Annotation = {
                    id: crypto.randomUUID(),
                    bookId: currentBookId,
                    referenceId: currentBookId || undefined,
                    type: note ? "note" : "highlight",
                    location: cfi,
                    selectedText: text,
                    color,
                    noteContent: note,
                    createdAt: new Date(),
                };
                set((state) => ({ annotations: [...state.annotations, annotation] }));
                queueVaultSync();
                scheduleMutationSync();
                if (isTauri()) {
                    void sqliteUpsertAnnotation(
                        annotation.id,
                        annotation.bookId,
                        JSON.stringify(annotation),
                    ).catch((e) => console.error("[catch]", e));
                }
                return annotation;
            },

            setCurrentBookId: (bookId) => set({ currentBookId: bookId }),

            updateAnnotation: (annotationId, updates) => {
                let updatedAnnotation: Annotation | undefined;
                set((state) => ({
                    annotations: state.annotations.map((a) => {
                        if (a.id === annotationId) {
                            updatedAnnotation = { ...a, ...updates, updatedAt: new Date() };
                            return updatedAnnotation;
                        }
                        return a;
                    }),
                }));

                queueVaultSync();
                scheduleMutationSync();
                if (isTauri() && updatedAnnotation) {
                    void sqliteUpsertAnnotation(
                        updatedAnnotation.id,
                        updatedAnnotation.bookId,
                        JSON.stringify(updatedAnnotation),
                    ).catch((e) => console.error("[catch]", e));
                }
            },

            removeAnnotation: (annotationId) => {
                set((state) => ({
                    annotations: state.annotations.filter((a) => a.id !== annotationId),
                    deletionTombstones: [
                        ...state.deletionTombstones,
                        { entityId: annotationId, entityType: "annotation" as const, deletedAt: new Date().toISOString() },
                    ],
                }));
                queueVaultSync();
                scheduleMutationSync();
                if (isTauri()) {
                    void sqliteDeleteAnnotation(annotationId).catch((e) => console.error("[catch]", e));
                }
            },

            getBookAnnotations: (bookId) =>
                getBookAnnotationSlice(get().annotations, bookId),

            getHighlights: (bookId) => {
                const annotations = get().annotations;
                let cache = highlightsResultCache.get(annotations);
                if (!cache) {
                    cache = new Map();
                    highlightsResultCache.set(annotations, cache);
                }
                const cached = cache.get(bookId);
                if (cached) return cached;
                const slice = getBookAnnotationSlice(annotations, bookId)
                    .filter((annotation) => annotation.type === 'highlight' || annotation.type === 'note');
                cache.set(bookId, slice);
                return slice;
            },

            getBookmarks: (bookId) => {
                const annotations = get().annotations;
                let cache = bookmarksResultCache.get(annotations);
                if (!cache) {
                    cache = new Map();
                    bookmarksResultCache.set(annotations, cache);
                }
                const cached = cache.get(bookId);
                if (cached) return cached;
                const slice = getBookAnnotationSlice(annotations, bookId)
                    .filter((annotation) => annotation.type === 'bookmark');
                cache.set(bookId, slice);
                return slice;
            },

            exportAnnotationsToMarkdown: (bookId: string) => {
                const book = get().getBook(bookId);
                if (!book) return '';

                const annotations = get().getBookAnnotations(bookId);
                const highlights = annotations.filter(a => a.type === 'highlight' || a.type === 'note');
                const bookmarks = annotations.filter(a => a.type === 'bookmark');

                let markdown = `# Highlights for "${book.title}"\n\n`;
                markdown += `by ${book.author}\n\n`;
                markdown += `---\n\n`;

                if (highlights.length > 0) {
                    markdown += `## Highlights (${highlights.length})\n\n`;

                    highlights.forEach((annotation, index) => {
                        markdown += `### ${index + 1}. ${annotation.color || 'Highlight'}\n\n`;
                        markdown += `> ${annotation.selectedText?.replace(/\n/g, ' ') || ''}\n\n`;

                        if (annotation.noteContent) {
                            markdown += `**Note:** ${annotation.noteContent}\n\n`;
                        }

                        markdown += `\`\`\`\nLocation: ${annotation.location}\n\`\`\`\n\n`;
                        markdown += `---\n\n`;
                    });
                }

                if (bookmarks.length > 0) {
                    markdown += `## Bookmarks (${bookmarks.length})\n\n`;

                    bookmarks.forEach((bookmark, index) => {
                        markdown += `${index + 1}. ${bookmark.selectedText || 'Bookmark'}\n`;
                        markdown += `   - Location: ${bookmark.location}\n\n`;
                    });
                }

                return markdown;
            },

            getBook: (bookId) => getBookLookup(get().books).get(bookId),

            getRecentBooks: (limit = 10) => {
                const books = get().books;
                const cached = recentBooksResultCache.get(books);
                if (cached) return cached.slice(0, limit);
                const sorted = [...books]
                    .filter((b) => b.lastReadAt)
                    .sort((a, b) => {
                        const aDate = a.lastReadAt instanceof Date ? a.lastReadAt : new Date(a.lastReadAt!);
                        const bDate = b.lastReadAt instanceof Date ? b.lastReadAt : new Date(b.lastReadAt!);
                        return (bDate.getTime() || 0) - (aDate.getTime() || 0);
                    });
                recentBooksResultCache.set(books, sorted);
                return sorted.slice(0, limit);
            },

            getFavoriteBooks: () => {
                const books = get().books;
                const cached = favoriteBooksResultCache.get(books);
                if (cached) return cached;
                const result = books.filter((b) => b.isFavorite);
                favoriteBooksResultCache.set(books, result);
                return result;
            },

            getBooksByCategory: (category) => {
                const books = get().books;
                let catCache = booksByCategoryResultCache.get(books);
                if (!catCache) {
                    catCache = new Map();
                    for (const b of books) {
                        if (!b.category) continue;
                        const arr = catCache.get(b.category);
                        if (arr) arr.push(b);
                        else catCache.set(b.category, [b]);
                    }
                    booksByCategoryResultCache.set(books, catCache);
                }
                return catCache.get(category) ?? [];
            },

            searchBooks: (query) => {
                const q = query.toLowerCase();
                if (!q) return [];
                const books = get().books;
                let queryMap = searchBooksResultCache.get(books);
                if (queryMap) {
                    const cached = queryMap.get(q);
                    if (cached) return cached;
                } else {
                    queryMap = new Map();
                    searchBooksResultCache.set(books, queryMap);
                }
                const result = books.filter(
                    (b) =>
                        b.title.toLowerCase().includes(q) ||
                        b.author.toLowerCase().includes(q) ||
                        b.tags.some((t) => t.toLowerCase().includes(q))
                );
                queryMap.set(q, result);
                return result;
            },

            getCachedBook: (bookId) => getCachedBookLookup(get().recentBooksCache).get(bookId),

            setLastScannedAt: (date) => set({ lastScannedAt: date }),

        }),
        {
            name: "theorem-library",
            version: 8,
            storage: deferredJsonStorage,
            migrate: (persistedState, version) => {
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
                    collections,
                    annotations: isTauri() ? [] : annotations,
                    deletionTombstones,
                    lastScannedAt,
                    recentBooksCache,
                } as PersistedLibraryState;
            },
            partialize: memoizePartialize(
                (state) => [isTauri() ? [] : state.books, state.collections, isTauri() ? [] : state.annotations, state.deletionTombstones, state.lastScannedAt, state.recentBooksCache],
                (state): PersistedLibraryState => ({
                    books: isTauri() ? [] : (state.books.map(({ coverPath: _, locations: __, ...book }) => book) as Book[]),
                    collections: state.collections,
                    annotations: isTauri() ? [] : state.annotations,
                    deletionTombstones: state.deletionTombstones,
                    lastScannedAt: state.lastScannedAt,
                    recentBooksCache: state.recentBooksCache.map(({ coverPath: _, ...book }) => book) as CachedBookMetadata[],
                }),
            ),
            onRehydrateStorage: () => (state) => {
                if (!state) {
                    useLibraryStore.setState({ coversHydrated: true });
                    return;
                }

                state.collections = state.collections
                    .map((collection) => normalizeCollectionKind(collection as LegacyCollection))
                    .filter((collection): collection is Collection => Boolean(collection));

                if (isTauri()) {
                    void sqliteGetAllAnnotations().then((annStrings) => {
                        if (annStrings && annStrings.length > 0) {
                            const parsed = annStrings.map((s) => {
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
                            }).filter(Boolean) as Annotation[];
                            useLibraryStore.setState({ annotations: parsed });
                        }
                    }).catch((e) => console.error("[catch]", e));
                } else {
                    state.annotations = state.annotations.map((annotation) => ({
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

                const hydrateCoversAndFts = (books: Book[], recentCache: CachedBookMetadata[]) => {
                    const bookIdsMissingCoverPath = collectBookIdsMissingCoverPath(
                        books,
                        recentCache,
                    );

                    useLibraryStore.setState({ coversHydrated: true });

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

                                useLibraryStore.setState((currentState) => {
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
                };

                if (isTauri()) {
                    void sqliteLoadAllBooks().then((bookStrings) => {
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
                            useLibraryStore.setState({ books: loadedBooks });
                        }
                        hydrateCoversAndFts(loadedBooks, useLibraryStore.getState().recentBooksCache);
                    }).catch((e) => console.error("[catch]", e));
                } else {
                    hydrateCoversAndFts(state.books, state.recentBooksCache);
                }
            },
        }
    )
);
