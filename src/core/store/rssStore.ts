import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { theoremPersistStorage } from "../lib/persist-storage";
import {
    fetchAndParseFeed,
    materializeFeed,
    convertMarkdownToHtml,
} from "../services/RssService";
import { scheduleMutationSync } from "../lib/sync-orchestrator";
import type { RssFeed, RssArticle, DeletionTombstone } from "../types";
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
                scheduleMutationSync();
            },

            toggleArticleRead: (articleId: string) => {
                set(state => {
                    const article = state.articles.find(a => a.id === articleId);
                    if (!article) return state;
                    const newRead = !article.isRead;
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
                scheduleMutationSync();
            },

            toggleArticleFavorite: (articleId: string) => {
                set(state => ({
                    articles: state.articles.map(a =>
                        a.id === articleId ? { ...a, isFavorite: !a.isFavorite } : a,
                    ),
                }));
                scheduleMutationSync();
            },

            getArticlesForFeed: (feedId: string) => {
                return getSortedRssArticlesForFeed(get().articles, feedId);
            },

            getAllArticles: () => {
                return getSortedRssArticleLookup(get().articles).allSorted;
            },

            openArticleInReader: (article: RssArticle) => {
                const fresh = get().articles.find(a => a.id === article.id) || article;
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
            storage: createJSONStorage(() => theoremPersistStorage),
            partialize: (state) => {
                const MAX_ARTICLES = 500;
                const MAX_ARTICLE_AGE_DAYS = 30;

                const cutoffDate = new Date();
                cutoffDate.setDate(cutoffDate.getDate() - MAX_ARTICLE_AGE_DAYS);

                const filteredArticles = state.articles
                    .filter(article => {
                        const articleDate = article.publishedAt || article.fetchedAt;
                        return new Date(articleDate) >= cutoffDate;
                    })
                    .slice(0, MAX_ARTICLES);

                const truncatedArticles = filteredArticles.map(article => ({
                    ...article,
                    content: article.content.length > 50000
                        ? article.content.slice(0, 50000) + '... [truncated]'
                        : article.content,
                }));

                return {
                    feeds: state.feeds,
                    articles: truncatedArticles,
                };
            },
        },
    ),
);
