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

const rssArticleSortCache = new WeakMap<RssArticle[], {
    allSorted: RssArticle[];
    feedSorted: Map<string, RssArticle[]>;
}>();

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
export function selectPersistedRssArticles(articles: RssArticle[], now: number): RssArticle[] {
    const cutoff = now - PERSISTED_RSS_ARTICLE_MAX_AGE_MS;
    const candidates: Array<{ index: number; time: number }> = [];
    for (let index = 0; index < articles.length; index++) {
        const article = articles[index];
        if (article.isFavorite) continue;
        const time = rssArticleTimestamp(article);
        if (Number.isFinite(time) && time < cutoff) continue;
        candidates.push({ index, time: Number.isFinite(time) ? time : Number.POSITIVE_INFINITY });
    }
    candidates.sort((a, b) => b.time - a.time || a.index - b.index);
    const keep = new Set<number>();
    for (let i = 0; i < candidates.length && i < PERSISTED_RSS_ARTICLE_LIMIT; i++) {
        keep.add(candidates[i].index);
    }
    return articles.filter((article, index) => article.isFavorite || keep.has(index));
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
    getArticlesForFeed: (feedId: string) => RssArticle[];
    getAllArticles: () => RssArticle[];
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
                await Promise.allSettled(feeds.map(f => get().refreshFeed(f.id)));
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
                    };
                });
                if (isTauri()) {
                    import("../lib/sqlite-storage").then(({ sqliteMarkArticleFavorite }) => {
                        sqliteMarkArticleFavorite(articleId, nextFav).catch(() => {});
                    }).catch(() => {});
                }
                scheduleMutationSync();
            },

            getArticlesForFeed: (feedId: string) => {
                return getSortedRssArticlesForFeed(get().articles, feedId);
            },

            getAllArticles: () => {
                return getSortedRssArticleLookup(get().articles).allSorted;
            },

            openArticleInReader: (article: RssArticle) => {
                let fresh = get().articles.find(a => a.id === article.id) || article;
                if ((!fresh.content || !fresh.fullContent) && isTauri()) {
                    import("../lib/sqlite-storage").then(({ sqliteGetRssArticleContent }) => {
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
            partialize: memoizePartialize((state) => [state.feeds, state.articles], (state) => {
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
