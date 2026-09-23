import { isTauri } from './env';
import { invoke, type InvokeArgs } from '@tauri-apps/api/core';

export interface SqliteStorageStats {
    total_books: number;
    total_size: number;
    covers_size: number;
    binaries_size: number;
    blob_entries: number;
    blob_size: number;
    idb_books: number;
    tauri_books: number;
}

export interface SqliteCleanupResult {
    removed_books: number;
    removed_covers: number;
    removed_metadata: number;
}

export interface SqliteBlobStats {
    count: number;
    total_size: number;
}

/**
 * SQLite commands run on Rust's blocking thread pool (see
 * `src-tauri/src/offload_commands.rs`) instead of the UI thread, so two calls
 * in flight could finish in either order. Running them one at a time, in
 * call order, keeps the semantics the UI thread used to give: a later write
 * to a key always wins, and a read sees every write issued before it.
 */
let sqliteQueueTail: Promise<unknown> = Promise.resolve();

export function invokeSqliteInOrder<T = unknown>(command: string, args?: InvokeArgs): Promise<T> {
    const run = sqliteQueueTail.then(() => invoke<T>(command, args));
    sqliteQueueTail = run.catch(() => undefined);
    return run;
}

async function getInvoke() {
    if (!isTauri()) {
        throw new Error('SQLite storage commands are only available in Tauri runtime.');
    }
    return invokeSqliteInOrder;
}

export async function sqliteSaveBookData(id: string, data: ArrayBuffer): Promise<string> {
    const invoke = await getInvoke();
    return invoke('sqlite_save_book_data', { id, data: new Uint8Array(data) }) as Promise<string>;
}

export async function sqliteRegisterMaterializedBook(id: string): Promise<void> {
    const invoke = await getInvoke();
    await invoke('sqlite_register_materialized_book', { id });
}

export async function sqliteGetBookData(id: string): Promise<ArrayBuffer | null> {
    const invoke = await getInvoke();
    const result = await invoke('sqlite_get_book_data', { id }) as number[] | null;
    if (!result) {
        return null;
    }
    return new Uint8Array(result).buffer;
}

export async function sqliteDeleteBookData(id: string): Promise<void> {
    const invoke = await getInvoke();
    await invoke('sqlite_delete_book_data', { id });
}

export async function sqliteGetMaterializedBookPath(id: string): Promise<string | null> {
    const invoke = await getInvoke();
    return invoke('sqlite_get_materialized_book_path', { id }) as Promise<string | null>;
}

export async function sqliteSaveCoverImage(bookId: string, dataUrl: string): Promise<void> {
    const invoke = await getInvoke();
    await invoke('sqlite_save_cover_image', {
        bookId,
        dataUrl,
    });
}

export async function sqliteGetCoverImage(bookId: string): Promise<string | null> {
    const invoke = await getInvoke();
    return invoke('sqlite_get_cover_image', {
        bookId,
    }) as Promise<string | null>;
}

export interface CoverVersionRow {
    bookId: string;
    updatedAt: number;
    isSvg: boolean;
    dataUrlLen: number;
}

/** Which books have a stored cover (one IPC call instead of one per cover). */
export async function sqliteListCoverVersions(): Promise<CoverVersionRow[]> {
    const invoke = await getInvoke();
    return invoke('sqlite_list_cover_versions') as Promise<CoverVersionRow[]>;
}

export async function sqliteDeleteCoverImage(bookId: string): Promise<void> {
    const invoke = await getInvoke();
    await invoke('sqlite_delete_cover_image', {
        bookId,
    });
}

export async function sqliteGetStorageStats(): Promise<SqliteStorageStats> {
    const invoke = await getInvoke();
    return invoke('sqlite_get_storage_stats') as Promise<SqliteStorageStats>;
}

export async function sqliteCleanupOrphanedStorage(existingBookIds: string[]): Promise<SqliteCleanupResult> {
    const invoke = await getInvoke();
    return invoke('sqlite_cleanup_orphaned_storage', {
        existingBookIds,
    }) as Promise<SqliteCleanupResult>;
}

export async function sqliteClearAllStorage(): Promise<void> {
    const invoke = await getInvoke();
    await invoke('sqlite_clear_all_storage');
}

export async function sqliteGetKv(key: string): Promise<string | null> {
    const invoke = await getInvoke();
    return invoke('sqlite_get_kv', { key }) as Promise<string | null>;
}

export async function sqliteBatchGetKv(keys: string[]): Promise<Array<[string, string]>> {
    const invoke = await getInvoke();
    return invoke('sqlite_batch_get_kv', { keys }) as Promise<Array<[string, string]>>;
}

export async function sqliteSetKv(key: string, value: string): Promise<void> {
    const invoke = await getInvoke();
    await invoke('sqlite_set_kv', { key, value });
}

export async function sqliteDeleteKv(key: string): Promise<void> {
    const invoke = await getInvoke();
    await invoke('sqlite_delete_kv', { key });
}

export async function sqliteCountKvByPrefix(prefix: string): Promise<number> {
    const invoke = await getInvoke();
    return invoke('sqlite_count_kv_by_prefix', { prefix }) as Promise<number>;
}

export async function sqliteDeleteKvByPrefix(prefix: string): Promise<number> {
    const invoke = await getInvoke();
    return invoke('sqlite_delete_kv_by_prefix', { prefix }) as Promise<number>;
}

export async function sqliteSetBlob(key: string, data: ArrayBuffer): Promise<void> {
    const invoke = await getInvoke();
    await invoke('sqlite_set_blob', { key, data: new Uint8Array(data) });
}

export async function sqliteGetBlob(key: string): Promise<ArrayBuffer | null> {
    const invoke = await getInvoke();
    const result = await invoke('sqlite_get_blob', { key }) as number[] | null;
    if (!result) {
        return null;
    }
    return new Uint8Array(result).buffer;
}

export async function sqliteDeleteBlob(key: string): Promise<void> {
    const invoke = await getInvoke();
    await invoke('sqlite_delete_blob', { key });
}

export async function sqliteDeleteBlobsByPrefix(prefix: string): Promise<number> {
    const invoke = await getInvoke();
    return invoke('sqlite_delete_blobs_by_prefix', { prefix }) as Promise<number>;
}

export async function sqliteGetBlobStats(prefix?: string): Promise<SqliteBlobStats> {
    const invoke = await getInvoke();
    return invoke('sqlite_get_blob_stats', {
        prefix: prefix ?? null,
    }) as Promise<SqliteBlobStats>;
}

export interface SqliteBookSearchResult {
    book_id: string;
    title: string;
}

export async function sqliteSearchBooks(query: string, limit: number = 20): Promise<SqliteBookSearchResult[]> {
    const invoke = await getInvoke();
    return invoke('sqlite_search_books', { query, limit }) as Promise<SqliteBookSearchResult[]>;
}

export async function sqliteIndexBookFts(bookId: string, title: string, author: string): Promise<void> {
    const invoke = await getInvoke();
    await invoke('sqlite_index_book_fts', { bookId, title, author });
}

export async function sqliteIndexBooksFtsBatch(entries: Array<[string, string, string]>): Promise<void> {
    const invoke = await getInvoke();
    await invoke('sqlite_index_books_fts_batch', { entries });
}

export async function sqliteSaveBookMetadata(bookId: string, metadataJson: string): Promise<void> {
    const invoke = await getInvoke();
    await invoke('sqlite_save_book_metadata', { bookId, metadataJson });
}

export async function sqliteGetBookMetadata(bookId: string): Promise<string | null> {
    const invoke = await getInvoke();
    return invoke('sqlite_get_book_metadata', { bookId }) as Promise<string | null>;
}

export async function sqliteSaveBookAnnotations(bookId: string, annotationsJson: string[]): Promise<void> {
    const invoke = await getInvoke();
    await invoke('sqlite_save_book_annotations', { bookId, annotationsJson });
}

export async function sqliteGetBookAnnotations(bookId: string): Promise<string[]> {
    const invoke = await getInvoke();
    return invoke('sqlite_get_book_annotations', { bookId }) as Promise<string[]>;
}

let lastShrinkMemoryAt = 0;
const SHRINK_MEMORY_THROTTLE_MS = 5000;

export async function sqliteShrinkMemory(): Promise<void> {
    if (!isTauri()) return;
    const now = Date.now();
    if (now - lastShrinkMemoryAt < SHRINK_MEMORY_THROTTLE_MS) return;
    lastShrinkMemoryAt = now;
    try {
        const invoke = await getInvoke();
        // Prefer the single `trim_memory` entry point (SQLite shrink +
        // WAL checkpoint + native malloc trim). Calling `sqlite_shrink_memory`
        // directly from hot paths (visibilitychange, unmount) trips Tauri v2
        // IPC access-control errors in the webview console (#102).
        await invoke('trim_memory');
    } catch {
        try {
            const invoke = await getInvoke();
            await invoke('sqlite_shrink_memory');
        } catch {
            // Ignore if unsupported or pool busy
        }
    }
}

export interface TwoTierSearchResult {
    bookId: string;
    title: string;
    author?: string;
    score: number;
    titleIndices: number[];
    authorIndices: number[];
}

export async function twoTierSearchBooks(
    query: string,
    limit: number = 50,
): Promise<TwoTierSearchResult[]> {
    if (!isTauri() || !query.trim()) return [];
    // Errors propagate: callers fall back to JS matching instead of showing
    // a failed search as "no results".
    const invoke = await getInvoke();
    return (await invoke('two_tier_search_books', { query, limit })) as TwoTierSearchResult[];
}

export interface FuzzyCandidateInput {
    id: string;
    title: string;
    author?: string;
    tags?: string;
    format?: string;
}

export interface FuzzyMatchResult {
    id: string;
    score: number;
    titleIndices: number[];
    authorIndices: number[];
}

export async function fuzzyRankCandidates(
    candidates: FuzzyCandidateInput[],
    query: string,
    limit: number = 50,
): Promise<FuzzyMatchResult[]> {
    if (!isTauri() || !query.trim() || candidates.length === 0) return [];
    try {
        const invoke = await getInvoke();
        return (await invoke('fuzzy_rank_candidates', { candidates, query, limit })) as FuzzyMatchResult[];
    } catch {
        return [];
    }
}

export interface BookWindowResult {
    bookIds: string[];
    totalCount: number;
}

export async function sqliteQueryBooksWindow(
    limit: number,
    offset: number,
): Promise<BookWindowResult> {
    const invoke = await getInvoke();
    return (await invoke('sqlite_query_books_window', { limit, offset })) as BookWindowResult;
}

export interface SqliteRssFeed {
    id: string;
    title: string;
    url: string;
    siteUrl?: string;
    description?: string;
    iconUrl?: string;
    lastFetched?: number;
    addedAt?: number;
    errorMessage?: string;
    unreadCount: number;
}

export interface SqliteRssArticle {
    id: string;
    feedId: string;
    title: string;
    author?: string;
    url: string;
    summary?: string;
    contentSource?: string;
    imageUrl?: string;
    publishedAt?: number;
    fetchedAt?: number;
    isRead: boolean;
    isFavorite: boolean;
    progress?: number;
}

export interface SqliteRssArticleContent {
    articleId: string;
    content: string;
    fullContent?: string;
}

export interface SqliteReadingSession {
    id: string;
    bookId?: string;
    sessionDate: string;
    minutes: number;
    booksReadJson?: string;
    createdAt: number;
}

export async function sqliteGetRssFeeds(): Promise<SqliteRssFeed[]> {
    if (!isTauri()) return [];
    try {
        const invoke = await getInvoke();
        return (await invoke('sqlite_get_rss_feeds')) as SqliteRssFeed[];
    } catch {
        return [];
    }
}

export async function sqliteSaveRssFeed(feed: SqliteRssFeed): Promise<void> {
    if (!isTauri()) return;
    const invoke = await getInvoke();
    await invoke('sqlite_save_rss_feed', { feed });
}

export async function sqliteDeleteRssFeed(feedId: string): Promise<void> {
    if (!isTauri()) return;
    const invoke = await getInvoke();
    await invoke('sqlite_delete_rss_feed', { feedId });
}

export async function sqliteGetRssArticles(
    feedId?: string,
    limit?: number,
    offset?: number,
): Promise<SqliteRssArticle[]> {
    if (!isTauri()) return [];
    try {
        const invoke = await getInvoke();
        return (await invoke('sqlite_get_rss_articles', {
            feedId: feedId ?? null,
            limit: limit ?? null,
            offset: offset ?? null,
        })) as SqliteRssArticle[];
    } catch {
        return [];
    }
}

export async function sqliteGetRssArticleContent(
    articleId: string,
): Promise<SqliteRssArticleContent | null> {
    if (!isTauri()) return null;
    try {
        const invoke = await getInvoke();
        return (await invoke('sqlite_get_rss_article_content', {
            articleId,
        })) as SqliteRssArticleContent | null;
    } catch {
        return null;
    }
}

export async function sqliteSaveRssArticle(
    article: SqliteRssArticle,
    content?: string,
    fullContent?: string,
): Promise<void> {
    if (!isTauri()) return;
    const invoke = await getInvoke();
    await invoke('sqlite_save_rss_article', {
        article,
        content: content ?? null,
        fullContent: fullContent ?? null,
    });
}

export async function sqliteMarkArticleRead(articleId: string, isRead: boolean): Promise<void> {
    if (!isTauri()) return;
    const invoke = await getInvoke();
    await invoke('sqlite_mark_article_read', { articleId, isRead });
}

export async function sqliteMarkArticleFavorite(
    articleId: string,
    isFavorite: boolean,
): Promise<void> {
    if (!isTauri()) return;
    const invoke = await getInvoke();
    await invoke('sqlite_mark_article_favorite', { articleId, isFavorite });
}

export async function sqliteDeleteRssArticle(articleId: string): Promise<void> {
    if (!isTauri()) return;
    const invoke = await getInvoke();
    await invoke('sqlite_delete_rss_article', { articleId });
}

export async function sqliteRecordReadingSession(
    sessionId: string,
    date: string,
    minutes: number,
    bookId?: string,
    booksReadJson?: string,
): Promise<void> {
    if (!isTauri()) return;
    try {
        const invoke = await getInvoke();
        await invoke('sqlite_record_reading_session', {
            sessionId,
            date,
            minutes,
            bookId: bookId ?? null,
            booksReadJson: booksReadJson ?? null,
        });
    } catch {
        // Non-blocking background telemetry
    }
}

export async function sqliteGetReadingSessions(
    startDate?: string,
    endDate?: string,
): Promise<SqliteReadingSession[]> {
    if (!isTauri()) return [];
    try {
        const invoke = await getInvoke();
        return (await invoke('sqlite_get_reading_sessions', {
            startDate: startDate ?? null,
            endDate: endDate ?? null,
        })) as SqliteReadingSession[];
    } catch {
        return [];
    }
}

export interface SqliteVocabularyTerm {
    id: string;
    term: string;
    normalizedTerm: string;
    language: string;
    phonetic?: string;
    audioUrl?: string;
    meaningsJson: string;
    providerHistoryJson: string;
    sourceBookId?: string;
    contextSentence?: string;
    createdAt: number;
    updatedAt?: number;
}

export async function sqliteGetVocabularyTerms(): Promise<SqliteVocabularyTerm[]> {
    if (!isTauri()) return [];
    try {
        const invoke = await getInvoke();
        return (await invoke('sqlite_get_vocabulary_terms')) as SqliteVocabularyTerm[];
    } catch {
        return [];
    }
}

export async function sqliteSaveVocabularyTerm(term: SqliteVocabularyTerm): Promise<void> {
    if (!isTauri()) return;
    try {
        const invoke = await getInvoke();
        await invoke('sqlite_save_vocabulary_term', { term });
    } catch {
        // Non-blocking
    }
}

export async function sqliteDeleteVocabularyTerm(termId: string): Promise<void> {
    if (!isTauri()) return;
    try {
        const invoke = await getInvoke();
        await invoke('sqlite_delete_vocabulary_term', { termId });
    } catch {
        // Non-blocking
    }
}


