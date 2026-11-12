import { mergeSourceFolders, normalizeSourceFolders } from "../lib/source-folders";
import { triggerVaultAutoSync } from "../lib/vault-sync";
import { deleteBookStorage } from "../lib/storage-manager";
import { sqliteSaveBookMetadata } from "../lib/sqlite-storage";
import { isTauri } from "../lib/env";
import { withMetadataStamp } from "../lib/book-edit-stamp";
import type {
    Annotation,
    Book,
    Collection,
    DeletionTombstone,
    PdfViewState,
} from "../types";

export function persistBookToSqlite(book: Book): void {
    if (!isTauri()) return;
    sqliteSaveBookMetadata(book.id, JSON.stringify(book)).catch((e) => console.error("[catch]", e));
}

export interface CachedBookMetadata {
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

export type CompletionUpdateSource = "auto" | "manual";

export const createCacheEntry = (book: Book): CachedBookMetadata => ({
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

export function updateBookById(
    books: Book[],
    bookId: string,
    updater: (book: Book) => Book,
): { books: Book[]; updatedBook: Book | null } {
    const index = books.findIndex((book) => book.id === bookId);
    if (index === -1) {
        return { books, updatedBook: null };
    }

    const currentBook = books[index];
    // A user edit to the book's details is stamped, so sync can tell it is newer.
    const nextBook = withMetadataStamp(currentBook, updater(currentBook));
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
const libraryTitleSetCache = new WeakMap<Book[], Set<string>>();

export const recentBooksResultCache = new WeakMap<Book[], Book[]>();
export const favoriteBooksResultCache = new WeakMap<Book[], Book[]>();
export const booksByCategoryResultCache = new WeakMap<Book[], Map<string, Book[]>>();
export const highlightsResultCache = new WeakMap<Annotation[], Map<string, Annotation[]>>();
export const bookmarksResultCache = new WeakMap<Annotation[], Map<string, Annotation[]>>();
export const searchBooksResultCache = new WeakMap<Book[], Map<string, Book[]>>();

export const COVER_RESTORE_BATCH_SIZE = 48;

export function getBookLookup(books: Book[]): Map<string, Book> {
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

export function getCachedBookLookup(cache: CachedBookMetadata[]): Map<string, CachedBookMetadata> {
    const existingLookup = cachedBookLookupCache.get(cache);
    if (existingLookup) {
        return existingLookup;
    }
    const nextLookup = new Map(cache.map((book) => [book.id, book]));
    cachedBookLookupCache.set(cache, nextLookup);
    return nextLookup;
}

export function getAnnotationsByBookLookup(annotations: Annotation[]): Map<string, Annotation[]> {
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

export function getBookAnnotationSlice(annotations: Annotation[], bookId: string): Annotation[] {
    return getAnnotationsByBookLookup(annotations).get(bookId) ?? [];
}

export function annotationTimestamp(annotation: Annotation): number {
    const value = annotation.updatedAt ?? annotation.createdAt;
    const ms = value ? new Date(value).getTime() : 0;
    return Number.isNaN(ms) ? 0 : ms;
}

/**
 * Combine annotations loaded from storage with those already in memory
 * (added or synced while storage was still loading), dropping anything a
 * tombstone says was deleted. `purgedIds` are persisted rows that must be
 * removed from storage. Annotations are never dropped just because their
 * book is not loaded (yet).
 */
export function reconcileHydratedAnnotations(
    persisted: Annotation[],
    inMemory: Annotation[],
    tombstones: DeletionTombstone[],
): { kept: Annotation[]; purgedIds: string[] } {
    const deletedAnnotationIds = new Set<string>();
    const deletedBookIds = new Set<string>();
    for (const t of tombstones) {
        if (t.entityType === "annotation") deletedAnnotationIds.add(t.entityId);
        else if (t.entityType === "book") deletedBookIds.add(t.entityId);
    }
    const isDeleted = (a: Annotation) =>
        deletedAnnotationIds.has(a.id) || (!!a.bookId && deletedBookIds.has(a.bookId));

    const byId = new Map<string, Annotation>();
    const purgedIds: string[] = [];
    for (const annotation of persisted) {
        if (isDeleted(annotation)) {
            purgedIds.push(annotation.id);
            continue;
        }
        byId.set(annotation.id, annotation);
    }
    for (const annotation of inMemory) {
        if (isDeleted(annotation)) continue;
        const stored = byId.get(annotation.id);
        if (!stored || annotationTimestamp(annotation) >= annotationTimestamp(stored)) {
            byId.set(annotation.id, annotation);
        }
    }
    return { kept: [...byId.values()], purgedIds };
}

export function mergeBookIntoCachedEntry(entry: CachedBookMetadata, book: Book): CachedBookMetadata {
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

export function syncRecentBooksCacheWithBook(
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

export function normalizeContentHash(contentHash?: string): string | undefined {
    if (typeof contentHash !== "string") {
        return undefined;
    }

    const normalized = contentHash.trim().toLowerCase();
    return normalized.length > 0 ? normalized : undefined;
}

// Hash of the book list last indexed into `books_fts`. The native startup
// reconcile (`reconcile_books_fts`) deletes this key whenever it had to repair
// the index, so a stale hash never hides an out-of-date index.
export const FTS_HASH_KV_KEY = "fts:booksHash";

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

export function findDuplicateBookIndex(books: Book[], incomingBook: Book): number {
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

export function mergeImportedBookMetadata(existingBook: Book, incomingBook: Book): Book {
    let changed = false;
    const nextBook = { ...existingBook };
    if (incomingBook.sourceFolders?.length) {
        const sourceFolders = mergeSourceFolders(existingBook.sourceFolders, incomingBook.sourceFolders);
        if (JSON.stringify(sourceFolders) !== JSON.stringify(existingBook.sourceFolders ?? [])) {
            nextBook.sourceFolders = sourceFolders;
            changed = true;
        }
    }

    if (existingBook.syncedWithoutFile && (incomingBook.storagePath || incomingBook.filePath)) {
        nextBook.storagePath = incomingBook.storagePath || incomingBook.filePath;
        nextBook.filePath = incomingBook.filePath || incomingBook.storagePath || existingBook.filePath;
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

    if (!existingBook.series && incomingBook.series) {
        nextBook.series = incomingBook.series;
        changed = true;
    }

    if (existingBook.seriesIndex === undefined && incomingBook.seriesIndex !== undefined) {
        nextBook.seriesIndex = incomingBook.seriesIndex;
        changed = true;
    }

    return changed ? nextBook : existingBook;
}

export function cleanupDiscardedImportedBook(book: Book): void {
    if (!book.id) {
        return;
    }

    if (isTauri()) {
        deleteBookStorage(book.id).catch(e => console.error("[catch]", e));
    }
}

export function normalizePersistedBook(book: Book): Book {
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
        sourceFolders: normalizeSourceFolders(book.sourceFolders),
        storagePath: normalizedStoragePath,
        coverExtractionDone: Boolean(book.coverExtractionDone || hasLegacyPersistedCoverPath),
        series: typeof book.series === "string" && book.series.trim().length > 0 ? book.series.trim() : undefined,
        seriesIndex: typeof book.seriesIndex === "number" && !Number.isNaN(book.seriesIndex) ? book.seriesIndex : undefined,
    };
}

export function collectBookIdsMissingCoverPath(
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

export function applyCoverLookupToBooks(books: Book[], coverLookup: Map<string, string>): Book[] {
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

export function applyCoverLookupToRecentCache(
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

export type LegacyCollection = Omit<Collection, "kind"> & {
    kind?: "general" | "research";
};

export function normalizeCollectionKind(collection: LegacyCollection): Collection | null {
    if (collection.kind === "research") {
        return null;
    }

    return {
        ...collection,
        kind: "general",
        groupBySeries: Boolean(collection.groupBySeries),
    };
}

export function queueVaultSync(): void {
    triggerVaultAutoSync();
}
