
import type {
    Book,
    Annotation,
    Collection,
    DeletionTombstone,
    TombstoneEntity,
    VocabularyTerm,
    RssFeed,
    RssArticle,
    AppSettings,
    ReadingStats,
    DailyReadingActivity,
} from "../types";

const TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

function tombstoneIdSet(
    tombstones: DeletionTombstone[],
    entityType: TombstoneEntity,
): Set<string> {
    const ids = new Set<string>();
    for (const t of tombstones) {
        if (t.entityType === entityType) ids.add(t.entityId);
    }
    return ids;
}

function toEpoch(d: Date | string | undefined | null): number {
    if (!d) return 0;
    const ms =
        typeof d === "string" ? new Date(d).getTime() : d.getTime();
    return Number.isNaN(ms) ? 0 : ms;
}

export function mergeTombstones(
    incoming: DeletionTombstone[],
    existing: DeletionTombstone[],
): DeletionTombstone[] {
    const key = (t: DeletionTombstone) => `${t.entityType}::${t.entityId}`;
    const byKey = new Map<string, DeletionTombstone>();

    for (const t of existing) {
        byKey.set(key(t), t);
    }

    for (const t of incoming) {
        const k = key(t);
        const prev = byKey.get(k);
        if (!prev || toEpoch(t.deletedAt) < toEpoch(prev.deletedAt)) {
            byKey.set(k, t);
        }
    }

    const cutoff = Date.now() - TOMBSTONE_TTL_MS;
    const result: DeletionTombstone[] = [];
    for (const t of byKey.values()) {
        if (toEpoch(t.deletedAt) >= cutoff) {
            result.push(t);
        }
    }

    return result;
}

export function mergeBooks(
    incoming: Book[],
    existing: Book[],
    tombstones: DeletionTombstone[] = [],
): Book[] {
    const deletedBookIds = tombstoneIdSet(tombstones, "book");
    const byId = new Map<string, Book>();
    const byHash = new Map<string, Book>();
    const byBlobHash = new Map<string, Book>();

    for (const book of existing) {
        if (deletedBookIds.has(book.id)) continue;
        byId.set(book.id, book);
        if (book.contentHash) byHash.set(book.contentHash, book);
        if (book.blobHash) byBlobHash.set(book.blobHash, book);
    }

    for (const inc of incoming) {
        
        if (deletedBookIds.has(inc.id)) continue;

        const match =
            (inc.contentHash ? byHash.get(inc.contentHash) : undefined) ??
            (inc.blobHash ? byBlobHash.get(inc.blobHash) : undefined) ??
            byId.get(inc.id);

        if (!match) {
            
            const localPlaceholderPath = `sqlite://${inc.id}`;
            
            const incomingCover = (typeof inc.coverPath === "string" && inc.coverPath.startsWith("data:"))
                ? inc.coverPath
                : undefined;
            const remoteBook: Book = {
                ...inc,
                filePath: localPlaceholderPath,
                storagePath: localPlaceholderPath,
                coverPath: incomingCover,
                coverExtractionDone: Boolean(incomingCover),
                syncedWithoutFile: true,
            };
            byId.set(inc.id, remoteBook);
            if (inc.contentHash) byHash.set(inc.contentHash, remoteBook);
            if (inc.blobHash) byBlobHash.set(inc.blobHash, remoteBook);
            continue;
        }

        const remoteIsNewer = toEpoch(inc.lastReadAt) > toEpoch(match.lastReadAt);

        const merged: Book = {
            ...match,

            // Incoming wins for pure descriptive metadata. The doc entry is
            // the peer's latest whole-book snapshot (last-writer-wins), so
            // importing it is what lets edits made after an initial sync
            // propagate to already-populated devices.
            title: (inc.title ?? "") !== "" ? inc.title : match.title,
            author: (inc.author ?? "") !== "" ? inc.author : match.author,
            description: inc.description ?? match.description,
            publisher: inc.publisher ?? match.publisher,
            language: inc.language ?? match.language,
            isbn: inc.isbn ?? match.isbn,
            publishedDate: inc.publishedDate ?? match.publishedDate,
            category: inc.category ?? match.category,
            
            progress: remoteIsNewer
                ? (inc.progress ?? match.progress)
                : Math.max(match.progress ?? 0, inc.progress ?? 0),
            lastReadAt: remoteIsNewer ? inc.lastReadAt : match.lastReadAt,
            currentLocation: remoteIsNewer
                ? inc.currentLocation ?? match.currentLocation
                : match.currentLocation,
            
            readingTime: Math.max(match.readingTime ?? 0, inc.readingTime ?? 0),
            
            isFavorite: match.isFavorite || inc.isFavorite,
            
            tags: [...new Set([...(match.tags ?? []), ...(inc.tags ?? [])])],
            
            rating:
                (match.rating ?? 0) >= (inc.rating ?? 0)
                    ? match.rating
                    : inc.rating,
            
            filePath: match.filePath || match.storagePath || `sqlite://${match.id}`,
            storagePath: match.storagePath || match.filePath || `sqlite://${match.id}`,
            coverPath: inc.coverPath && inc.coverPath.startsWith("data:")
                ? inc.coverPath
                : match.coverPath,
            
            contentHash: match.contentHash || inc.contentHash,
            
            syncedWithoutFile: match.syncedWithoutFile,
            
            blobHash: inc.blobHash || match.blobHash,
            coverBlobHash: inc.coverBlobHash || match.coverBlobHash,
            
            completedAt: match.completedAt || inc.completedAt,
            manualCompletionState: match.manualCompletionState ?? inc.manualCompletionState,
            progressBeforeFinish: match.progressBeforeFinish ?? inc.progressBeforeFinish,
        };

        byId.set(match.id, merged);
        if (merged.blobHash) byBlobHash.set(merged.blobHash, merged);
    }

    return [...byId.values()];
}

export function mergeAnnotations(
    incoming: Annotation[],
    existing: Annotation[],
    tombstones: DeletionTombstone[] = [],
): Annotation[] {
    const deletedAnnotationIds = tombstoneIdSet(tombstones, "annotation");
    const deletedBookIds = tombstoneIdSet(tombstones, "book");

    const byId = new Map<string, Annotation>();

    for (const ann of existing) {
        if (deletedAnnotationIds.has(ann.id)) continue;
        if (deletedBookIds.has(ann.bookId)) continue;
        byId.set(ann.id, ann);
    }

    for (const inc of incoming) {
        if (deletedAnnotationIds.has(inc.id)) continue;
        if (deletedBookIds.has(inc.bookId)) continue;

        const match = byId.get(inc.id);
        if (!match) {
            
            byId.set(inc.id, inc);
            continue;
        }

        const localTs = toEpoch(match.updatedAt) || toEpoch(match.createdAt);
        const remoteTs = toEpoch(inc.updatedAt) || toEpoch(inc.createdAt);

        if (remoteTs > localTs) {
            byId.set(inc.id, inc);
        }
    }

    return [...byId.values()];
}

export function mergeCollections(
    incoming: Collection[],
    existing: Collection[],
    tombstones: DeletionTombstone[] = [],
): Collection[] {
    const deletedCollectionIds = tombstoneIdSet(tombstones, "collection");
    const deletedBookIds = tombstoneIdSet(tombstones, "book");

    const removedCollectionBookPairs = new Set<string>();
    for (const t of tombstones) {
        if (t.entityType === "collection_book") {
            removedCollectionBookPairs.add(t.entityId); 
        }
    }

    const isBookRemovedFromCollection = (collectionId: string, bookId: string) =>
        removedCollectionBookPairs.has(`${collectionId}:${bookId}`);

    const byId = new Map<string, Collection>();

    for (const col of existing) {
        if (deletedCollectionIds.has(col.id)) continue;
        byId.set(col.id, col);
    }

    for (const inc of incoming) {
        if (deletedCollectionIds.has(inc.id)) continue;

        const match = byId.get(inc.id);
        if (!match) {
            byId.set(inc.id, inc);
            continue;
        }

        const incTs = toEpoch(inc.updatedAt) || toEpoch(inc.createdAt);
        const matchTs = toEpoch(match.updatedAt) || toEpoch(match.createdAt);
        const merged: Collection = {
            ...match,
            name: incTs > matchTs ? inc.name : match.name,
            description:
                incTs > matchTs
                    ? inc.description ?? match.description
                    : match.description ?? inc.description,
            
            bookIds: [...new Set([...match.bookIds, ...inc.bookIds])].filter(
                (id) => !deletedBookIds.has(id) && !isBookRemovedFromCollection(match.id, id),
            ),
            
            updatedAt:
                incTs > matchTs ? inc.updatedAt ?? inc.createdAt : match.updatedAt ?? match.createdAt,
        };

        byId.set(match.id, merged);
    }

    if (deletedBookIds.size > 0 || removedCollectionBookPairs.size > 0) {
        for (const [id, col] of byId) {
            const filtered = col.bookIds.filter((bId) =>
                !deletedBookIds.has(bId) && !isBookRemovedFromCollection(id, bId)
            );
            if (filtered.length !== col.bookIds.length) {
                byId.set(id, { ...col, bookIds: filtered });
            }
        }
    }

    return [...byId.values()];
}

export function mergeVocabulary(
    incoming: VocabularyTerm[],
    existing: VocabularyTerm[],
    tombstones: DeletionTombstone[] = [],
): VocabularyTerm[] {
    const deletedTermIds = tombstoneIdSet(tombstones, "vocabulary");
    const byKey = new Map<string, VocabularyTerm>();

    const key = (t: VocabularyTerm) => `${t.normalizedTerm}::${t.language}`;

    for (const term of existing) {
        if (deletedTermIds.has(term.id)) continue;
        byKey.set(key(term), term);
    }

    for (const inc of incoming) {
        if (deletedTermIds.has(inc.id)) continue;
        const k = key(inc);
        const match = byKey.get(k);
        if (!match) {
            byKey.set(k, inc);
            continue;
        }

        const merged: VocabularyTerm = {
            ...match,
            meanings: mergeMeanings(match.meanings, inc.meanings),
            providerHistory: [
                ...new Set([
                    ...(match.providerHistory ?? []),
                    ...(inc.providerHistory ?? []),
                ]),
            ],
            lookupCount: Math.max(match.lookupCount ?? 1, inc.lookupCount ?? 1),
            tags: [
                ...new Set([
                    ...(match.tags ?? []),
                    ...(inc.tags ?? []),
                ]),
            ],
            contexts: [
                ...new Set([
                    ...(match.contexts ?? []),
                    ...(inc.contexts ?? []),
                ]),
            ],
            updatedAt:
                toEpoch(inc.updatedAt) > toEpoch(match.updatedAt)
                    ? inc.updatedAt
                    : match.updatedAt,
        };

        byKey.set(k, merged);
    }

    return [...byKey.values()];
}

function mergeMeanings(
    a: VocabularyTerm["meanings"],
    b: VocabularyTerm["meanings"],
): VocabularyTerm["meanings"] {
    const byProvider = new Map<string, VocabularyTerm["meanings"][0]>();
    for (const m of a) byProvider.set(m.provider, m);
    for (const m of b) {
        if (!byProvider.has(m.provider)) {
            byProvider.set(m.provider, m);
        }
        
    }
    return [...byProvider.values()];
}

export function mergeRssFeeds(
    incoming: RssFeed[],
    existing: RssFeed[],
    tombstones: DeletionTombstone[] = [],
): { feeds: RssFeed[]; feedIdMap: Map<string, string> } {
    const deletedFeedIds = tombstoneIdSet(tombstones, "feed");
    const byUrl = new Map<string, RssFeed>();
    const feedIdMap = new Map<string, string>();

    for (const feed of existing) {
        if (deletedFeedIds.has(feed.id)) continue;
        byUrl.set(feed.url, feed);
    }

    for (const inc of incoming) {
        if (deletedFeedIds.has(inc.id)) continue;

        const match = byUrl.get(inc.url);
        if (!match) {
            byUrl.set(inc.url, inc);
            continue;
        }

        if (inc.id !== match.id) {
            feedIdMap.set(inc.id, match.id);
        }

        const merged: RssFeed = {
            ...match,
            title: inc.title || match.title,
            description: inc.description || match.description,
            iconUrl: inc.iconUrl || match.iconUrl,
            lastFetched:
                toEpoch(inc.lastFetched) > toEpoch(match.lastFetched)
                    ? inc.lastFetched
                    : match.lastFetched,
        };
        byUrl.set(inc.url, merged);
    }

    return { feeds: [...byUrl.values()], feedIdMap };
}

export function mergeRssArticles(
    incoming: RssArticle[],
    existing: RssArticle[],
    feedIdMap?: Map<string, string>,
    tombstones: DeletionTombstone[] = [],
): RssArticle[] {
    const deletedFeedIds = tombstoneIdSet(tombstones, "feed");
    const deletedArticleIds = tombstoneIdSet(tombstones, "rss_article");
    const byId = new Map<string, RssArticle>();

    for (const article of existing) {
        if (deletedFeedIds.has(article.feedId) || deletedArticleIds.has(article.id)) continue;
        byId.set(article.id, article);
    }

    for (const inc of incoming) {
        if (deletedArticleIds.has(inc.id)) continue;
        const remappedFeedId = feedIdMap?.get(inc.feedId) ?? inc.feedId;
        if (deletedFeedIds.has(remappedFeedId)) continue;

        const remapped = remappedFeedId !== inc.feedId ? { ...inc, feedId: remappedFeedId } : inc;

        const match = byId.get(remapped.id);
        if (!match) {
            byId.set(remapped.id, remapped);
            continue;
        }

        const merged: RssArticle = {
            ...match,
            isRead: match.isRead || remapped.isRead,
            isFavorite: match.isFavorite || remapped.isFavorite,
            progress: Math.max(match.progress || 0, remapped.progress || 0) || undefined,
            fullContent: match.fullContent || remapped.fullContent,
            contentSource: match.contentSource || remapped.contentSource,
            feedId: remappedFeedId,
        };
        byId.set(remapped.id, merged);
    }

    return [...byId.values()];
}

export function mergeSettings(
    incoming: AppSettings,
    existing: AppSettings,
    incomingUpdatedAt?: string,
    localUpdatedAt?: string,
): AppSettings {
    const remoteTs = toEpoch(incomingUpdatedAt);
    const localTs = toEpoch(localUpdatedAt);

    const deviceSync = existing.deviceSync;

    if (remoteTs > localTs) {
        return {
            ...existing,
            ...incoming,
            deviceSync,
        };
    }

    return {
        ...incoming,
        ...existing,
        deviceSync,
    };
}

export function mergeReadingStats(
    incoming: ReadingStats,
    existing: ReadingStats,
): ReadingStats {
    
    const activityByDate = new Map<string, DailyReadingActivity>();
    for (const entry of existing.dailyActivity ?? []) {
        activityByDate.set(entry.date, entry);
    }
    for (const inc of incoming.dailyActivity ?? []) {
        const match = activityByDate.get(inc.date);
        if (!match) {
            activityByDate.set(inc.date, inc);
        } else {
            activityByDate.set(inc.date, {
                date: inc.date,
                minutes: Math.max(match.minutes, inc.minutes),
                booksRead: [...new Set([...match.booksRead, ...inc.booksRead])],
            });
        }
    }

    const mergedActivity = [...activityByDate.values()]
        .sort((a, b) => b.date.localeCompare(a.date))
        .slice(0, 84);

    const currentStreak = calculateCurrentStreak(mergedActivity);

    const lastReadDate = [existing.lastReadDate, incoming.lastReadDate]
        .filter(Boolean)
        .sort()
        .pop();

    const lastGoalNotifiedDate = [existing.lastGoalNotifiedDate, incoming.lastGoalNotifiedDate]
        .filter(Boolean)
        .sort()
        .pop();

    const lastDailyReminderDate = [existing.lastDailyReminderDate, incoming.lastDailyReminderDate]
        .filter(Boolean)
        .sort()
        .pop();

    return {
        totalReadingTime: Math.max(existing.totalReadingTime, incoming.totalReadingTime),
        booksCompleted: Math.max(existing.booksCompleted, incoming.booksCompleted),
        averageReadingSpeed: Math.max(existing.averageReadingSpeed, incoming.averageReadingSpeed),
        currentStreak,
        longestStreak: Math.max(existing.longestStreak, incoming.longestStreak, currentStreak),
        dailyGoal: Math.max(existing.dailyGoal, incoming.dailyGoal),
        yearlyBookGoal: Math.max(existing.yearlyBookGoal, incoming.yearlyBookGoal),
        booksReadThisYear: Math.max(existing.booksReadThisYear, incoming.booksReadThisYear),
        dailyActivity: mergedActivity,
        lastReadDate,
        lastGoalNotifiedDate,
        lastDailyReminderDate,
    };
}

function calculateCurrentStreak(
    sortedActivity: DailyReadingActivity[],
): number {
    if (sortedActivity.length === 0) return 0;

    const pad = (n: number) => String(n).padStart(2, "0");
    const toLocalDateStr = (d: Date) =>
        `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStr = toLocalDateStr(today);
    const yesterdayDate = new Date(today);
    yesterdayDate.setDate(yesterdayDate.getDate() - 1);
    const yesterdayStr = toLocalDateStr(yesterdayDate);

    const mostRecent = sortedActivity[0].date;
    if (mostRecent !== todayStr && mostRecent !== yesterdayStr) {
        return 0;
    }

    const activeDates = new Set(sortedActivity.map((a) => a.date));

    let streak = 0;
    const cursor = new Date(mostRecent + "T00:00:00");
    while (true) {
        const dateStr = toLocalDateStr(cursor);
        if (!activeDates.has(dateStr)) break;
        streak++;
        cursor.setDate(cursor.getDate() - 1);
    }

    return streak;
}
