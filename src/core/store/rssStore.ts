import { create } from "zustand";
import { persist } from "zustand/middleware";
import { deferredJsonStorage, memoizePartialize } from "../lib/persist-storage";
import {
    fetchAndParseFeed,
    materializeFeed,
    convertMarkdownToHtml,
} from "../services/RssService";
import { scheduleMutationSync } from "../lib/sync-orchestrator";
import type { RssFeed, RssArticle, DeletionTombstone } from "../types";
import { isTauri } from "../lib/env";
import { useLibraryStore } from "./libraryStore";
import { useUIStore } from "./uiStore";
import { useSettingsStore } from "./settingsStore";
import { mapSettledWithConcurrency } from "../lib/concurrency";
import { needsMarkdownRender, renderMarkdownBatch } from "../lib/article-markdown";

const RSS_REFRESH_CONCURRENCY = 4;

const rssArticleSortCache = new WeakMap<RssArticle[], {
    allSorted: RssArticle[];
    feedSorted: Map<string, RssArticle[]>;
}>();

const rssArticleIdMapCache = new WeakMap<RssArticle[], Map<string, RssArticle>>();

export function getRssArticleById(articles: RssArticle[], articleId: string): RssArticle | undefined {
    let map = rssArticleIdMapCache.get(articles);
    if (!map) {
        map = new Map();
        for (let i = 0; i < articles.length; i++) {
            map.set(articles[i].id, articles[i]);
        }
        rssArticleIdMapCache.set(articles, map);
    }
    return map.get(articleId);
}

const rssFeedIdMapCache = new WeakMap<RssFeed[], Map<string, RssFeed>>();

export function getRssFeedById(feeds: RssFeed[], feedId: string): RssFeed | undefined {
    let map = rssFeedIdMapCache.get(feeds);
    if (!map) {
        map = new Map();
        for (let i = 0; i < feeds.length; i++) {
            map.set(feeds[i].id, feeds[i]);
        }
        rssFeedIdMapCache.set(feeds, map);
    }
    return map.get(feedId);
}

function getRssArticleTimestamp(article: RssArticle): number {
    const dateValue = article.publishedAt ?? article.fetchedAt;
    const timestamp = new Date(dateValue).getTime();
    return Number.isFinite(timestamp) ? timestamp : 0;
}

const PERSISTED_RSS_ARTICLE_LIMIT = 500;
const PERSISTED_RSS_ARTICLE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function rssArticleTimestamp(article: RssArticle): number {
    const published = new Date(article.publishedAt as unknown as string | Date).getTime();
    if (Number.isFinite(published)) return published;
    const fetched = new Date(article.fetchedAt as unknown as string | Date).getTime();
    return Number.isFinite(fetched) ? fetched : Number.NaN;
}

/**
 * Retention for the persisted article list. Favorites are the user's explicit
 * "keep this" and are never aged out or capped. Everything else keeps the
 * newest PERSISTED_RSS_ARTICLE_LIMIT articles from the last 30 days; an article
 * with no usable date is treated as new rather than silently dropped. The
 * original array order is preserved so the UI does not reshuffle.
 */
/**
 * Articles stored before feeds were converted in Rust may still hold raw
 * Markdown. Render those once (one batched IPC call) and return the patched
 * array, or `null` when nothing needed converting.
 */
export async function convertStoredMarkdownArticles(
    articles: RssArticle[],
    render: (items: string[]) => Promise<string[]> = renderMarkdownBatch,
): Promise<Map<string, Pick<RssArticle, "content" | "summary">> | null> {
    const jobs: Array<{ id: string; field: "content" | "summary" }> = [];
    const inputs: string[] = [];
    for (const article of articles) {
        for (const field of ["content", "summary"] as const) {
            const value = article[field];
            if (needsMarkdownRender(value)) {
                jobs.push({ id: article.id, field });
                inputs.push(value);
            }
        }
    }
    if (jobs.length === 0) return null;
    const rendered = await render(inputs);
    if (rendered.length !== inputs.length) return null;
    const patches = new Map<string, Pick<RssArticle, "content" | "summary">>();
    jobs.forEach((job, index) => {
        const patch = patches.get(job.id) ?? {} as Pick<RssArticle, "content" | "summary">;
        patch[job.field] = rendered[index];
        patches.set(job.id, patch);
    });
    return patches;
}

export function selectPersistedRssArticles(articles: RssArticle[], now: number): RssArticle[] {
    const cutoff = now - PERSISTED_RSS_ARTICLE_MAX_AGE_MS;
    const candidates: Array<{ index: number; time: number }> = [];
    for (let index = 0; index < articles.length; index++) {
        const article = articles[index];
        if (article.isFavorite || article.isSaved) continue;
        const time = rssArticleTimestamp(article);
        if (Number.isFinite(time) && time < cutoff) continue;
        candidates.push({ index, time: Number.isFinite(time) ? time : Number.POSITIVE_INFINITY });
    }
    candidates.sort((a, b) => b.time - a.time || a.index - b.index);
    const keep = new Set<number>();
    for (let i = 0; i < candidates.length && i < PERSISTED_RSS_ARTICLE_LIMIT; i++) {
        keep.add(candidates[i].index);
    }
    return articles.filter((article, index) => article.isFavorite || article.isSaved || keep.has(index));
}

function sortRssArticlesByDateDesc(articles: RssArticle[]): RssArticle[] {
    const sortable = articles.map((article, index) => ({
        article,
        timestamp: getRssArticleTimestamp(article),
        index,
    }));

    sortable.sort((left, right) => {
        if (right.timestamp !== left.timestamp) {
            return right.timestamp - left.timestamp;
        }
        return left.index - right.index;
    });

    return sortable.map((entry) => entry.article);
}

function getSortedRssArticleLookup(articles: RssArticle[]): {
    allSorted: RssArticle[];
    feedSorted: Map<string, RssArticle[]>;
} {
    const existingLookup = rssArticleSortCache.get(articles);
    if (existingLookup) {
        return existingLookup;
    }

    const allSorted = sortRssArticlesByDateDesc(articles);
    const nextLookup = {
        allSorted,
        feedSorted: new Map<string, RssArticle[]>(),
    };
    rssArticleSortCache.set(articles, nextLookup);
    return nextLookup;
}

function getSortedRssArticlesForFeed(articles: RssArticle[], feedId: string): RssArticle[] {
    const lookup = getSortedRssArticleLookup(articles);
    const existingFeedArticles = lookup.feedSorted.get(feedId);
    if (existingFeedArticles) {
        return existingFeedArticles;
    }

    const nextFeedArticles = lookup.allSorted.filter((article) => article.feedId === feedId);
    lookup.feedSorted.set(feedId, nextFeedArticles);
    return nextFeedArticles;
}

interface RssStore {
    feeds: RssFeed[];
    articles: RssArticle[];
    isLoading: boolean;
    error?: string;
    currentArticle: RssArticle | null;
    deletionTombstones: DeletionTombstone[];

    addFeed: (url: string) => Promise<RssFeed | null>;
    removeFeed: (feedId: string) => void;
    deleteArticle: (articleId: string) => void;
    refreshFeed: (feedId: string) => Promise<void>;
    refreshAll: () => Promise<void>;
    markArticleRead: (articleId: string) => void;
    toggleArticleRead: (articleId: string) => void;
    toggleArticleFavorite: (articleId: string) => void;
    toggleArticleSaved: (articleId: string) => void;
    markArticleSaved: (articleId: string, isSaved: boolean) => void;
    cleanupOldArticles: () => Promise<number>;
    getArticlesForFeed: (feedId: string) => RssArticle[];
    getAllArticles: () => RssArticle[];
    getArticle: (articleId: string) => RssArticle | undefined;
    openArticleInReader: (article: RssArticle) => void;
    closeArticleViewer: () => void;
    setCurrentArticle: (article: RssArticle | null) => void;
    updateArticleContent: (articleId: string, fullContent: string) => void;
    updateArticleProgress: (articleId: string, progress: number) => void;
    fetchFullArticle: (articleId: string) => Promise<string | null>;
    setError: (error?: string) => void;
}

export const useRssStore = create<RssStore>()(
    persist(
        (set, get) => ({
            feeds: [],
            articles: [],
            isLoading: false,
            error: undefined,
            currentArticle: null,
            deletionTombstones: [],

            addFeed: async (url: string) => {
                set({ isLoading: true, error: undefined });
                try {
                    const parsed = await fetchAndParseFeed(url);
                    const { feed, articles } = await materializeFeed(url, parsed);

                    const normalizeUrl = (u: string) => u.toLowerCase().replace(/\/+$/, '');
                    const normalizedNewUrl = normalizeUrl(url);

                    const existing = get().feeds.find(f => normalizeUrl(f.url) === normalizedNewUrl);
                    if (existing) {
                        set({ isLoading: false, error: 'This feed is already subscribed.' });
                        return null;
                    }

                    set(state => {
                        const existingArticleUrls = new Set(state.articles.map(a => normalizeUrl(a.url)));
                        const uniqueArticles = articles.filter(a => !existingArticleUrls.has(normalizeUrl(a.url)));
                        return {
                            feeds: [...state.feeds, feed],
                            articles: [...state.articles, ...uniqueArticles],
                            isLoading: false,
                        };
                    });

                    if (isTauri()) {
                        import("../lib/sqlite-storage").then(({ sqliteSaveRssFeed, sqliteSaveRssArticle }) => {
                            sqliteSaveRssFeed({
                                id: feed.id,
                                title: feed.title,
                                url: feed.url,
                                siteUrl: feed.siteUrl,
                                description: feed.description,
                                iconUrl: feed.iconUrl,
                                lastFetched: feed.lastFetched ? new Date(feed.lastFetched).getTime() : undefined,
                                addedAt: new Date().getTime(),
                                errorMessage: feed.errorMessage,
                                unreadCount: feed.unreadCount,
                            }).catch(() => {});
                            const existingArticleUrls = new Set(get().articles.map(a => normalizeUrl(a.url)));
                            const unique = articles.filter(a => !existingArticleUrls.has(normalizeUrl(a.url)));
                            for (const a of unique) {
                                sqliteSaveRssArticle({
                                    id: a.id,
                                    feedId: a.feedId,
                                    title: a.title,
                                    author: a.author,
                                    url: a.url,
                                    summary: a.summary,
                                    contentSource: a.contentSource,
                                    imageUrl: a.imageUrl,
                                    publishedAt: a.publishedAt ? new Date(a.publishedAt).getTime() : undefined,
                                    fetchedAt: a.fetchedAt ? new Date(a.fetchedAt).getTime() : undefined,
                                    isRead: a.isRead,
                                    isFavorite: a.isFavorite,
                                    isSaved: a.isSaved ?? false,
                                    progress: a.progress,
                                }, a.content, a.fullContent).catch(() => {});
                            }
                        }).catch(() => {});
                    }

                    scheduleMutationSync();
                    return feed;
                } catch (err) {
                    const message = err instanceof Error ? err.message : 'Failed to add feed';
                    set({ isLoading: false, error: message });
                    return null;
                }
            },

            removeFeed: (feedId: string) => {
                const now = new Date().toISOString();
                set(state => ({
                    feeds: state.feeds.filter(f => f.id !== feedId),
                    articles: state.articles.filter(a => a.feedId !== feedId),
                }));
                if (isTauri()) {
                    import("../lib/sqlite-storage").then(({ sqliteDeleteRssFeed }) => {
                        sqliteDeleteRssFeed(feedId).catch(() => {});
                    }).catch(() => {});
                }
                useLibraryStore.setState(state => ({
                    deletionTombstones: [
                        ...state.deletionTombstones,
                        { entityId: feedId, entityType: "feed", deletedAt: now },
                    ],
                }));
                scheduleMutationSync();
            },

            deleteArticle: (articleId: string) => {
                const now = new Date().toISOString();
                set(state => ({
                    articles: state.articles.filter(a => a.id !== articleId),
                }));
                if (isTauri()) {
                    import("../lib/sqlite-storage").then(({ sqliteDeleteRssArticle }) => {
                        sqliteDeleteRssArticle(articleId).catch(() => {});
                    }).catch(() => {});
                }
                useLibraryStore.setState(state => ({
                    deletionTombstones: [
                        ...state.deletionTombstones,
                        { entityId: articleId, entityType: "rss_article", deletedAt: now },
                    ],
                }));
                scheduleMutationSync();
            },

            refreshFeed: async (feedId: string) => {
                const feed = get().feeds.find(f => f.id === feedId);
                if (!feed) return;

                try {
                    const parsed = await fetchAndParseFeed(feed.url);
                    const now = new Date();

                    const normalizeUrl = (u: string) => u.toLowerCase().replace(/\/+$/, '');

                    const existingUrls = new Set(
                        get().articles.filter(a => a.feedId === feedId).map(a => normalizeUrl(a.url)),
                    );

                    const newArticles: RssArticle[] = await Promise.all(parsed.articles
                        .filter(a => !existingUrls.has(normalizeUrl(a.url)))
                        .map(async a => ({
                            id: crypto.randomUUID(),
                            feedId,
                            title: a.title,
                            author: a.author,
                            url: a.url,
                            content: await convertMarkdownToHtml(a.content),
                            summary: await convertMarkdownToHtml(a.summary ?? ""),
                            imageUrl: a.imageUrl,
                            publishedAt: a.publishedAt,
                            fetchedAt: now,
                            isRead: false,
                            isFavorite: false,
                            isSaved: false,
                        })));

                    set(state => {
                        const feedArticles = state.articles.filter(a => a.feedId === feedId);
                        const unreadCount = feedArticles.filter(a => !a.isRead).length + newArticles.length;
                        return {
                            articles: [...newArticles, ...state.articles],
                            feeds: state.feeds.map(f =>
                                f.id === feedId
                                    ? { ...f, lastFetched: now, errorMessage: undefined, unreadCount, title: parsed.feed.title || f.title }
                                    : f,
                            ),
                        };
                    });

                    if (isTauri()) {
                        import("../lib/sqlite-storage").then(({ sqliteSaveRssFeed, sqliteSaveRssArticle }) => {
                            const updatedFeed = get().feeds.find(f => f.id === feedId);
                            if (updatedFeed) {
                                sqliteSaveRssFeed({
                                    id: updatedFeed.id,
                                    title: updatedFeed.title,
                                    url: updatedFeed.url,
                                    siteUrl: updatedFeed.siteUrl,
                                    description: updatedFeed.description,
                                    iconUrl: updatedFeed.iconUrl,
                                    lastFetched: now.getTime(),
                                    errorMessage: undefined,
                                    unreadCount: updatedFeed.unreadCount,
                                }).catch(() => {});
                            }
                            for (const a of newArticles) {
                                sqliteSaveRssArticle({
                                    id: a.id,
                                    feedId: a.feedId,
                                    title: a.title,
                                    author: a.author,
                                    url: a.url,
                                    summary: a.summary,
                                    contentSource: a.contentSource,
                                    imageUrl: a.imageUrl,
                                    publishedAt: a.publishedAt ? new Date(a.publishedAt).getTime() : undefined,
                                    fetchedAt: a.fetchedAt ? new Date(a.fetchedAt).getTime() : undefined,
                                    isRead: a.isRead,
                                    isFavorite: a.isFavorite,
                                    isSaved: a.isSaved ?? false,
                                    progress: a.progress,
                                }, a.content, a.fullContent).catch(() => {});
                            }
                        }).catch(() => {});
                    }

                    scheduleMutationSync();
                } catch (err) {
                    const message = err instanceof Error ? err.message : 'Refresh failed';
                    set(state => ({
                        feeds: state.feeds.map(f =>
                            f.id === feedId ? { ...f, errorMessage: message } : f,
                        ),
                    }));
                }
            },

            refreshAll: async () => {
                set({ isLoading: true });
                const feeds = get().feeds;
                // Bounded: all feeds at once meant N parallel fetches + parses + markdown
                // conversions competing with the UI.
                await mapSettledWithConcurrency(feeds, RSS_REFRESH_CONCURRENCY, (f) => get().refreshFeed(f.id));
                set({ isLoading: false });
            },

            markArticleRead: (articleId: string) => {
                set(state => {
                    const article = state.articles.find(a => a.id === articleId);
                    if (!article) return state;
                    const wasRead = article.isRead;
                    return {
                        articles: state.articles.map(a =>
                            a.id === articleId ? { ...a, isRead: true } : a,
                        ),
                        feeds: wasRead ? state.feeds : state.feeds.map(f =>
                            f.id === article.feedId
                                ? { ...f, unreadCount: Math.max(0, f.unreadCount - 1) }
                                : f,
                        ),
                    };
                });
                if (isTauri()) {
                    import("../lib/sqlite-storage").then(({ sqliteMarkArticleRead }) => {
                        sqliteMarkArticleRead(articleId, true).catch(() => {});
                    }).catch(() => {});
                }
                scheduleMutationSync();
            },

            toggleArticleRead: (articleId: string) => {
                let nextRead = false;
                set(state => {
                    const article = state.articles.find(a => a.id === articleId);
                    if (!article) return state;
                    const newRead = !article.isRead;
                    nextRead = newRead;
                    return {
                        articles: state.articles.map(a =>
                            a.id === articleId ? { ...a, isRead: newRead } : a,
                        ),
                        feeds: state.feeds.map(f =>
                            f.id === article.feedId
                                ? { ...f, unreadCount: newRead
                                    ? Math.max(0, f.unreadCount - 1)
                                    : f.unreadCount + 1
                                }
                                : f,
                        ),
                    };
                });
                if (isTauri()) {
                    import("../lib/sqlite-storage").then(({ sqliteMarkArticleRead }) => {
                        sqliteMarkArticleRead(articleId, nextRead).catch(() => {});
                    }).catch(() => {});
                }
                scheduleMutationSync();
            },

            toggleArticleFavorite: (articleId: string) => {
                let nextFav = false;
                set(state => {
                    const article = state.articles.find(a => a.id === articleId);
                    nextFav = article ? !article.isFavorite : false;
                    return {
                        articles: state.articles.map(a =>
                            a.id === articleId ? { ...a, isFavorite: !a.isFavorite } : a,
                        ),
                        currentArticle: state.currentArticle?.id === articleId
                            ? { ...state.currentArticle, isFavorite: !state.currentArticle.isFavorite }
                            : state.currentArticle,
                    };
                });
                if (isTauri()) {
                    import("../lib/sqlite-storage").then(({ sqliteMarkArticleFavorite }) => {
                        sqliteMarkArticleFavorite(articleId, nextFav).catch(() => {});
                    }).catch(() => {});
                }
                scheduleMutationSync();
            },

            toggleArticleSaved: (articleId: string) => {
                let nextSaved = false;
                set(state => {
                    const article = state.articles.find(a => a.id === articleId);
                    nextSaved = article ? !article.isSaved : false;
                    return {
                        articles: state.articles.map(a =>
                            a.id === articleId ? { ...a, isSaved: !a.isSaved } : a,
                        ),
                        currentArticle: state.currentArticle?.id === articleId
                            ? { ...state.currentArticle, isSaved: !state.currentArticle.isSaved }
                            : state.currentArticle,
                    };
                });
                if (isTauri()) {
                    import("../lib/sqlite-storage").then(({ sqliteMarkArticleSaved, sqliteSaveRssArticle }) => {
                        sqliteMarkArticleSaved(articleId, nextSaved).catch(() => {});
                        if (nextSaved) {
                            const article = get().articles.find(a => a.id === articleId) || get().currentArticle;
                            if (article && (article.content || article.fullContent)) {
                                sqliteSaveRssArticle({
                                    id: article.id,
                                    feedId: article.feedId,
                                    title: article.title,
                                    author: article.author,
                                    url: article.url,
                                    summary: article.summary,
                                    contentSource: article.contentSource,
                                    imageUrl: article.imageUrl,
                                    publishedAt: article.publishedAt ? new Date(article.publishedAt).getTime() : undefined,
                                    fetchedAt: article.fetchedAt ? new Date(article.fetchedAt).getTime() : undefined,
                                    isRead: article.isRead,
                                    isFavorite: article.isFavorite,
                                    isSaved: true,
                                    progress: article.progress,
                                }, article.content, article.fullContent).catch(() => {});
                            }
                        }
                    }).catch(() => {});
                }
                scheduleMutationSync();
            },

            markArticleSaved: (articleId: string, isSaved: boolean) => {
                set(state => ({
                    articles: state.articles.map(a =>
                        a.id === articleId ? { ...a, isSaved } : a,
                    ),
                    currentArticle: state.currentArticle?.id === articleId
                        ? { ...state.currentArticle, isSaved }
                        : state.currentArticle,
                }));
                if (isTauri()) {
                    import("../lib/sqlite-storage").then(({ sqliteMarkArticleSaved }) => {
                        sqliteMarkArticleSaved(articleId, isSaved).catch(() => {});
                    }).catch(() => {});
                }
                scheduleMutationSync();
            },

            cleanupOldArticles: async () => {
                if (!isTauri()) return 0;
                try {
                    const { sqliteCleanupOldRssArticles, sqliteGetRssArticles } = await import("../lib/sqlite-storage");
                    const settings = useSettingsStore.getState().settings;
                    const cleanedCount = await sqliteCleanupOldRssArticles(
                        settings.rssRetentionDays,
                        settings.rssKeepUnread,
                    );
                    if (cleanedCount > 0) {
                        const dbArticles = await sqliteGetRssArticles(undefined, 1000, 0);
                        const articleMap = new Map(dbArticles.map(a => [a.id, a]));
                        set(state => ({
                            articles: state.articles.filter(a => articleMap.has(a.id)),
                        }));
                    }
                    return cleanedCount;
                } catch {
                    return 0;
                }
            },

            getArticlesForFeed: (feedId: string) => {
                return getSortedRssArticlesForFeed(get().articles, feedId);
            },

            getAllArticles: () => {
                return getSortedRssArticleLookup(get().articles).allSorted;
            },

            getArticle: (articleId: string) => {
                return getRssArticleById(get().articles, articleId);
            },

            openArticleInReader: (article: RssArticle) => {
                let fresh = get().articles.find(a => a.id === article.id) || article;
                if (isTauri()) {
                    import("../lib/sqlite-storage").then(({ sqliteGetRssArticleContent, sqliteSaveRssArticle }) => {
                        sqliteGetRssArticleContent(fresh.id).then((cached) => {
                            if (cached && (cached.content || cached.fullContent)) {
                                set(state => ({
                                    articles: state.articles.map(a =>
                                        a.id === fresh.id
                                            ? { ...a, content: cached.content || a.content, fullContent: cached.fullContent || a.fullContent }
                                            : a
                                    ),
                                    currentArticle: state.currentArticle?.id === fresh.id
                                        ? { ...state.currentArticle, content: cached.content || state.currentArticle.content, fullContent: cached.fullContent || state.currentArticle.fullContent }
                                        : state.currentArticle,
                                }));
                            } else if (fresh.content || fresh.fullContent) {
                                // Save opened article content cleanly into SQLite
                                sqliteSaveRssArticle({
                                    id: fresh.id,
                                    feedId: fresh.feedId,
                                    title: fresh.title,
                                    author: fresh.author,
                                    url: fresh.url,
                                    summary: fresh.summary,
                                    contentSource: fresh.contentSource,
                                    imageUrl: fresh.imageUrl,
                                    publishedAt: fresh.publishedAt ? new Date(fresh.publishedAt).getTime() : undefined,
                                    fetchedAt: fresh.fetchedAt ? new Date(fresh.fetchedAt).getTime() : undefined,
                                    isRead: fresh.isRead,
                                    isFavorite: fresh.isFavorite,
                                    isSaved: fresh.isSaved ?? false,
                                    progress: fresh.progress,
                                }, fresh.content, fresh.fullContent).catch(() => {});
                            }
                        }).catch(() => {});
                    }).catch(() => {});
                }
                set({ currentArticle: fresh });
                useUIStore.getState().setRoute('reader');
            },

            closeArticleViewer: () => {
                set({
                    currentArticle: null,
                });

                const ui = useUIStore.getState();
                if (ui.currentRoute === 'reader') {
                    ui.setRoute('feeds');
                }
            },

            setCurrentArticle: (article: RssArticle | null) => {
                set({ currentArticle: article });
            },

            updateArticleContent: (articleId: string, fullContent: string) => {
                set(state => ({
                    articles: state.articles.map(a =>
                        a.id === articleId
                            ? { ...a, fullContent, contentSource: 'extracted' }
                            : a
                    ),
                    currentArticle: state.currentArticle?.id === articleId
                        ? { ...state.currentArticle, fullContent, contentSource: 'extracted' }
                        : state.currentArticle,
                }));
                if (isTauri()) {
                    import("../lib/sqlite-storage").then(({ sqliteSaveRssArticle }) => {
                        const a = get().articles.find(art => art.id === articleId);
                        if (a) {
                            sqliteSaveRssArticle({
                                id: a.id,
                                feedId: a.feedId,
                                title: a.title,
                                author: a.author,
                                url: a.url,
                                summary: a.summary,
                                contentSource: 'extracted',
                                imageUrl: a.imageUrl,
                                publishedAt: a.publishedAt ? new Date(a.publishedAt).getTime() : undefined,
                                fetchedAt: a.fetchedAt ? new Date(a.fetchedAt).getTime() : undefined,
                                isRead: a.isRead,
                                isFavorite: a.isFavorite,
                                isSaved: a.isSaved ?? false,
                                progress: a.progress,
                            }, a.content, fullContent).catch(() => {});
                        }
                    }).catch(() => {});
                }
                scheduleMutationSync();
            },

            updateArticleProgress: (articleId: string, progress: number) => {
                const safeProgress = Math.max(0, Math.min(1, progress));
                const isCompleted = safeProgress >= 0.95;
                set(state => ({
                    articles: state.articles.map(a =>
                        a.id === articleId
                            ? {
                                ...a,
                                progress: safeProgress,
                                isRead: isCompleted ? true : a.isRead,
                            }
                            : a
                    ),
                    currentArticle: state.currentArticle?.id === articleId
                        ? {
                            ...state.currentArticle,
                            progress: safeProgress,
                            isRead: isCompleted ? true : state.currentArticle.isRead,
                        }
                        : state.currentArticle,
                }));

                if (isTauri()) {
                    import("../lib/sqlite-storage").then(({ sqliteMarkArticleRead, sqliteSaveRssArticle }) => {
                        if (isCompleted) {
                            sqliteMarkArticleRead(articleId, true).catch(() => {});
                        }
                        const a = get().articles.find(art => art.id === articleId) || get().currentArticle;
                        if (a) {
                            sqliteSaveRssArticle({
                                id: a.id,
                                feedId: a.feedId,
                                title: a.title,
                                author: a.author,
                                url: a.url,
                                summary: a.summary,
                                contentSource: a.contentSource,
                                imageUrl: a.imageUrl,
                                publishedAt: a.publishedAt ? new Date(a.publishedAt).getTime() : undefined,
                                fetchedAt: a.fetchedAt ? new Date(a.fetchedAt).getTime() : undefined,
                                isRead: isCompleted ? true : a.isRead,
                                isFavorite: a.isFavorite,
                                isSaved: a.isSaved ?? false,
                                progress: safeProgress,
                            }, a.content, a.fullContent).catch(() => {});
                        }
                    }).catch(() => {});
                }

                scheduleMutationSync();
            },

            fetchFullArticle: async (articleId: string) => {
                const state = get();
                const article = state.articles.find(a => a.id === articleId) || state.currentArticle;
                if (!article || !article.url) {
                    return null;
                }

                if (article.fullContent) {
                    return article.fullContent;
                }

                try {
                    const { ArticleExtractorService } = await import("../services/ArticleExtractorService");
                    const extracted = await ArticleExtractorService.extractFromUrl(article.url);
                    if (extracted && extracted.content) {
                        get().updateArticleContent(articleId, extracted.content);
                        return extracted.content;
                    }
                } catch (err) {
                    console.error("[RssStore] Failed to fetch full article:", err);
                }
                return null;
            },

            setError: (error?: string) => {
                set({ error });
            },
        }),
        {
            name: 'theorem-rss',
            version: 1,
            storage: deferredJsonStorage,
            onRehydrateStorage: () => () => {
                if (!isTauri()) return;
                import("../lib/sqlite-storage").then(async ({ sqliteGetRssFeeds, sqliteGetRssArticles, sqliteCleanupOldRssArticles }) => {
                    try {
                        const settings = useSettingsStore.getState().settings;
                        if (settings?.rssRetentionDays > 0) {
                            sqliteCleanupOldRssArticles(settings.rssRetentionDays, settings.rssKeepUnread).catch(() => {});
                        }

                        const [dbFeeds, dbArticles] = await Promise.all([
                            sqliteGetRssFeeds(),
                            sqliteGetRssArticles(undefined, 1000, 0),
                        ]);

                        if (dbFeeds.length > 0 || dbArticles.length > 0) {
                            useRssStore.setState(current => {
                                const feedMap = new Map(current.feeds.map(f => [f.id, f]));
                                for (const df of dbFeeds) {
                                    if (!feedMap.has(df.id)) {
                                        feedMap.set(df.id, {
                                            id: df.id,
                                            title: df.title,
                                            url: df.url,
                                            siteUrl: df.siteUrl,
                                            description: df.description,
                                            iconUrl: df.iconUrl,
                                            lastFetched: df.lastFetched ? new Date(df.lastFetched) : undefined,
                                            addedAt: df.addedAt ? new Date(df.addedAt) : new Date(),
                                            errorMessage: df.errorMessage,
                                            unreadCount: df.unreadCount,
                                        });
                                    }
                                }

                                const articleMap = new Map(current.articles.map(a => [a.id, a]));
                                for (const da of dbArticles) {
                                    const existing = articleMap.get(da.id);
                                    if (!existing) {
                                        articleMap.set(da.id, {
                                            id: da.id,
                                            feedId: da.feedId,
                                            title: da.title,
                                            author: da.author,
                                            url: da.url,
                                            content: "",
                                            summary: da.summary,
                                            contentSource: da.contentSource as 'feed' | 'extracted' | undefined,
                                            imageUrl: da.imageUrl,
                                            publishedAt: da.publishedAt ? new Date(da.publishedAt) : undefined,
                                            fetchedAt: da.fetchedAt ? new Date(da.fetchedAt) : new Date(),
                                            isRead: da.isRead,
                                            isFavorite: da.isFavorite,
                                            isSaved: da.isSaved,
                                            progress: da.progress,
                                        });
                                    } else {
                                        existing.isRead = da.isRead;
                                        existing.isFavorite = da.isFavorite;
                                        existing.isSaved = da.isSaved;
                                        if (da.progress != null) existing.progress = da.progress;
                                    }
                                }

                                return {
                                    feeds: Array.from(feedMap.values()),
                                    articles: Array.from(articleMap.values()),
                                };
                            });
                        }
                    } catch (e) {
                        console.error("[RssStore] SQLite rehydration failed:", e);
                    }
                }).catch(() => {});
            },
            partialize: memoizePartialize((state) => [state.feeds, state.articles], (state) => {
                if (isTauri()) {
                    // On Tauri, full content resides in SQLite (rss_articles + rss_article_content).
                    // We only serialize feeds and lightweight metadata so theorem-rss KV store is under 15KB.
                    const metadataOnlyArticles = state.articles.slice(0, 300).map(article => ({
                        id: article.id,
                        feedId: article.feedId,
                        title: article.title,
                        author: article.author,
                        url: article.url,
                        summary: article.summary,
                        imageUrl: article.imageUrl,
                        publishedAt: article.publishedAt,
                        fetchedAt: article.fetchedAt,
                        isRead: article.isRead,
                        isFavorite: article.isFavorite,
                        isSaved: article.isSaved,
                        progress: article.progress,
                        content: "",
                    }));

                    return {
                        feeds: state.feeds,
                        articles: metadataOnlyArticles,
                    };
                }

                const filteredArticles = selectPersistedRssArticles(state.articles, Date.now());

                // Decouple full HTML to keep theorem-rss KV store under 50KB instead of 25MB+
                const truncatedArticles = filteredArticles.map(article => ({
                    ...article,
                    fullContent: undefined,
                    content: article.summary
                        ? (article.content.length > 500 ? article.content.slice(0, 500) + '...' : article.content)
                        : (article.content.length > 1000 ? article.content.slice(0, 1000) + '...' : article.content),
                }));

                return {
                    feeds: state.feeds,
                    articles: truncatedArticles,
                };
            }),
        },
    ),
);
