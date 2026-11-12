import { canSetShelfParent } from "../lib/shelf-hierarchy";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { buildBookPageMarkdown } from "../lib/vault-sync";
import { deferredJsonStorage, memoizePartialize } from "../lib/persist-storage";
import { scheduleMutationSync } from "../lib/sync-orchestrator";
import { deleteBookStorage } from "../lib/storage-manager";
import { deleteGeneratedAudiobookFile } from "../lib/audiobook-files";
import { persistBookLocations } from "../lib/book-locations";
import {
    sqliteDeleteBookMetadata,
    sqliteUpdateBookProgress,
    sqliteSaveBookAnnotations,
    sqliteUpsertAnnotation,
    sqliteDeleteAnnotation,
    sqliteIndexBooksFtsBatch,
    sqliteIndexBookFts,
} from "../lib/sqlite-storage";
import { isTauri } from "../lib/env";
import { withMetadataStamp } from "../lib/book-edit-stamp";
import {
    booksByCategoryResultCache,
    bookmarksResultCache,
    type CachedBookMetadata,
    cleanupDiscardedImportedBook,
    type CompletionUpdateSource,
    computeFtsHash,
    createCacheEntry,
    favoriteBooksResultCache,
    findDuplicateBookIndex,
    getBookAnnotationSlice,
    getBookLookup,
    getCachedBookLookup,
    getLibraryTitleSet,
    highlightsResultCache,
    mergeImportedBookMetadata,
    normalizeContentHash,
    normalizeLibraryTitle,
    persistBookToSqlite,
    queueVaultSync,
    recentBooksResultCache,
    reconcileHydratedAnnotations,
    searchBooksResultCache,
    syncRecentBooksCacheWithBook,
    updateBookById,
} from "./libraryHelpers";
import {
    buildPartializedLibraryState,
    getLibraryPartializeDeps,
    handleLibraryRehydrate,
    migrateLibraryPersistedState,
    type PersistedLibraryState,
    startingHydration,
} from "./libraryMigration";
import type {
    Annotation,
    Book,
    BookAudioTrack,
    Collection,
    DeletionTombstone,
    HighlightColor,
    PdfViewState,
} from "../types";

export {
    computeFtsHash,
    getLibraryTitleSet,
    normalizeLibraryTitle,
    reconcileHydratedAnnotations,
};

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
    /** Many `updateBook`s in one store change (a folder rescan can touch thousands). */
    updateBooks: (updates: ReadonlyArray<readonly [string, Partial<Book>]>) => void;
    recordBookOpened: (bookId: string) => void;
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
                    sqliteIndexBookFts(mergedBook.id, mergedBook.title, mergedBook.author).catch(e => console.error("[catch]", e));
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

                // Only books kept in the library are written to SQLite and the
                // search index; a discarded duplicate must not come back as a row.
                const addedIndices = new Set<number>();
                const mergedIndices = new Set<number>();
                const ftsReindexIndices = new Set<number>();

                for (const incomingBook of incomingBooks) {
                    const duplicateIndex = findDuplicate(incomingBook);

                    if (duplicateIndex === -1) {
                        if (!booksChanged) {
                            nextBooks = nextBooks.slice();
                            booksChanged = true;
                        }
                        nextBooks.push(incomingBook);
                        addedIndices.add(nextBooks.length - 1);
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
                        mergedIndices.add(duplicateIndex);
                        if (mergedBook.title !== duplicateBook.title || mergedBook.author !== duplicateBook.author) {
                            ftsReindexIndices.add(duplicateIndex);
                        }

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
                    // Final versions only: a book added earlier in this batch
                    // may have been merged with a later copy.
                    for (const index of new Set([...addedIndices, ...mergedIndices])) {
                        persistBookToSqlite(nextBooks[index]);
                    }
                    const indexedIndices = [...new Set([...addedIndices, ...ftsReindexIndices])];
                    if (indexedIndices.length > 0) {
                        const ftsEntries: Array<[string, string, string]> = indexedIndices
                            .map((index) => nextBooks[index])
                            .map(b => [b.id, b.title, b.author]);
                        sqliteIndexBooksFtsBatch(ftsEntries).catch(e => console.error("[catch]", e));
                    }
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
                    if (idSet.has(book.id)) deleteGeneratedAudiobookFile(book.audioTrack?.filePath);
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
                    for (const annId of annotationIds) {
                        void sqliteDeleteAnnotation(annId).catch((e) => console.error("[catch]", e));
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

            updateBooks: (updates) => {
                if (updates.length === 0) return;
                const merged = new Map<string, Partial<Book>>();
                for (const [bookId, update] of updates) {
                    merged.set(bookId, { ...(merged.get(bookId) ?? {}), ...update });
                }
                set((state) => {
                    const lookup = new Map(state.books.map((book, index) => [book.id, index]));
                    let books = state.books;
                    let recentBooksCache = state.recentBooksCache;
                    const changed: Book[] = [];
                    for (const [bookId, update] of merged) {
                        const index = lookup.get(bookId);
                        if (index === undefined) continue;
                        const current = books[index];
                        const next = withMetadataStamp(current, { ...current, ...update });
                        if (next === current) continue;
                        if (books === state.books) books = books.slice();
                        books[index] = next;
                        changed.push(next);
                        recentBooksCache = syncRecentBooksCacheWithBook(recentBooksCache, next);
                    }
                    if (changed.length === 0) return state;
                    for (const book of changed) persistBookToSqlite(book);
                    return recentBooksCache === state.recentBooksCache
                        ? { books }
                        : { books, recentBooksCache };
                });
            },

            recordBookOpened: (bookId) => set((state) => {
                if (!state.getBook(bookId)) return state;
                const { books, updatedBook } = updateBookById(state.books, bookId,
                    book => ({ ...book, lastReadAt: new Date() }));
                if (!updatedBook) return state;
                persistBookToSqlite(updatedBook);
                const recentBooksCache = [createCacheEntry(updatedBook),
                    ...state.recentBooksCache.filter(entry => entry.id !== bookId)].slice(0, 20);
                scheduleMutationSync("reading");
                return { books, recentBooksCache };
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
                // Replacing a generated recording with another file frees the old one.
                const previous = state.getBook(bookId)?.audioTrack?.filePath;
                if (previous && previous !== track.filePath) deleteGeneratedAudiobookFile(previous);
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
                deleteGeneratedAudiobookFile(state.getBook(bookId)?.audioTrack?.filePath);
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
                        return withMetadataStamp(book, {
                            ...book,
                            progress: 1.0,
                            completedAt: book.completedAt || now,
                            ...(!book.completedAt
                                ? { progressBeforeFinish: Math.max(0, Math.min(1, book.progress || 0)) }
                                : {}),
                            manualCompletionState: "read" as const,
                        }, now);
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
                        return withMetadataStamp(book, {
                            ...book,
                            completedAt: undefined,
                            manualCompletionState: "unread" as const,
                            progress: Math.max(0, Math.min(1, book.progressBeforeFinish ?? 0)),
                            progressBeforeFinish: undefined,
                        });
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
                if (get().collections.some(shelf => shelf.id === collection.id)
                    || !canSetShelfParent(get().collections, collection.id, collection.parentId)) return;
                set((state) => ({ collections: [...state.collections, collection] }));
                scheduleMutationSync();
            },

            removeCollection: (collectionId) => {
                set((state) => ({
                    collections: state.collections.filter((c) => c.id !== collectionId).map(c =>
                        c.parentId === collectionId ? { ...c, parentId: undefined, updatedAt: new Date() } : c),
                    deletionTombstones: [
                        ...state.deletionTombstones,
                        { entityId: collectionId, entityType: "collection" as const, deletedAt: new Date().toISOString() },
                    ],
                }));
                scheduleMutationSync();
            },

            updateCollection: (collectionId, updates) => {
                if ("parentId" in updates && !canSetShelfParent(get().collections, collectionId, updates.parentId)) return;
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
                        if (c.id !== collectionId || c.smartRules) return c;
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
                        if (c.id !== collectionId || c.smartRules) return c;
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
                            // The version this edit was made on: sync uses it to
                            // tell a concurrent edit (a conflict) from a later one.
                            const base = a.updatedAt ?? a.createdAt;
                            updatedAnnotation = {
                                ...a,
                                ...updates,
                                updatedAt: new Date(),
                                ...(base ? { baseUpdatedAt: new Date(base) } : {}),
                            };
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

                let markdown = buildBookPageMarkdown(
                    {
                        id: book.id,
                        title: book.title,
                        author: book.author || 'Unknown Author',
                        format: book.format,
                        filePath: book.filePath,
                    },
                    highlights,
                );

                if (bookmarks.length > 0) {
                    markdown += `\n## Bookmarks (${bookmarks.length})\n\n`;
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
            version: 11,
            storage: deferredJsonStorage,
            migrate: (persistedState, version) => migrateLibraryPersistedState(persistedState, version),
            partialize: memoizePartialize(
                (state) => getLibraryPartializeDeps(state),
                (state): PersistedLibraryState => buildPartializedLibraryState(state),
            ),
            onRehydrateStorage: () => startingHydration((state: LibraryStore | undefined) => {
                handleLibraryRehydrate(state, {
                    getState: () => useLibraryStore.getState(),
                    setState: (partial) => useLibraryStore.setState(partial),
                });
            }),
        }
    )
);
