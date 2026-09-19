
import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn, formatProgress } from "../../core/lib/utils";
import { isTauri } from "../../core/lib/env";
import { useRssStore } from "../../core/store";
import type { RssFeed, RssArticle } from "../../core/types";
import {
    Rss, Plus, RefreshCw, Trash2, Loader2,
    AlertCircle,
    LayoutTemplate, ArrowLeft,
    ExternalLink, BookOpen, CheckCheck, EyeOff, Link2,
} from "lucide-react";
import { AddFeedModal } from "./AddFeedModal";
import { ContextMenu } from "../../ui";
import type { ContextMenuItem } from "../../ui";
import { sanitizeArticleHtml } from "../reader/article-reader/utils";
import { sanitizeHtmlForDisplay } from "../../core/lib/sanitize";

const FEEDS_SELECTED_FEED_STORAGE_KEY = "theorem-feeds:selected-feed-id";
const FEEDS_MOBILE_LIST_STORAGE_KEY = "theorem-feeds:show-mobile-list";

function formatArticleDate(date: Date | string | undefined): string {
    if (!date) return "";
    const d = date instanceof Date ? date : new Date(date);
    if (isNaN(d.getTime())) return "";
    const now = new Date();
    const diff = now.getTime() - d.getTime();
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return "Just now";
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days < 7) return `${days}d ago`;
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function useTouchVisibleActions(): boolean {
    const [touchVisibleActions, setTouchVisibleActions] = useState(() => {
        if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
            return false;
        }
        return window.matchMedia("(hover: none), (pointer: coarse)").matches;
    });

    useEffect(() => {
        if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
            return;
        }

        const mediaQuery = window.matchMedia("(hover: none), (pointer: coarse)");
        const handleChange = () => setTouchVisibleActions(mediaQuery.matches);
        handleChange();

        if (typeof mediaQuery.addEventListener === "function") {
            mediaQuery.addEventListener("change", handleChange);
            return () => mediaQuery.removeEventListener("change", handleChange);
        }

        mediaQuery.addListener(handleChange);
        return () => mediaQuery.removeListener(handleChange);
    }, []);

    return touchVisibleActions;
}

function FeedListItem({
    feed,
    isSelected,
    onSelect,
    onDelete,
    onRefresh,
    isRefreshing,
    showTouchActions,
}: {
    feed: RssFeed;
    isSelected: boolean;
    onSelect: () => void;
    onDelete: () => void;
    onRefresh?: () => void;
    isRefreshing?: boolean;
    showTouchActions: boolean;
}) {
    
    return (
        <div
            onClick={onSelect}
            className={cn(
                "group relative flex items-center gap-2.5 px-3 py-2 cursor-pointer transition-colors",
                isSelected
                    ? "bg-[var(--color-accent)]/10 text-[color:var(--color-accent)]"
                    : "hover:bg-[var(--color-surface-muted)] text-[color:var(--color-text-secondary)]",
                "active:bg-[var(--color-surface-muted)]"
            )}
        >
            
            <div className={cn(
                "w-6 h-6 flex items-center justify-center flex-shrink-0 overlay",
                isSelected
                    ? "text-[color:var(--color-accent)]"
                    : "text-[color:var(--color-text-muted)]",
            )}>
                {feed.iconUrl ? (
                    <img
                        src={feed.iconUrl}
                        alt=""
                        className="w-4 h-4"
                        onError={(e) => {
                            (e.target as HTMLImageElement).style.display = 'none';
                        }}
                    />
                ) : (
                    <Rss className="w-4 h-4" />
                )}
            </div>

            <div className="flex-1 min-w-0">
                <p className={cn(
                    "text-sm font-medium truncate",
                )}>
                    {feed.title}
                </p>
            </div>

            {feed.unreadCount > 0 && (
                <span className={cn(
                    "text-[10px] font-bold px-1.5 py-0.5 flex-shrink-0",
                    isSelected
                        ? "bg-[var(--color-accent)] text-[color:var(--color-accent-contrast)]"
                        : "bg-[var(--color-surface-muted)] text-[color:var(--color-text-muted)]",
                )}>
                    {feed.unreadCount}
                </span>
            )}

            {onRefresh && (
                <button
                    onClick={(event) => {
                        event.stopPropagation();
                        onRefresh();
                    }}
                    disabled={isRefreshing}
                    className={cn(
                        "p-1.5 transition-colors flex-shrink-0",
                        showTouchActions || isRefreshing
                            ? "opacity-100"
                            : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
                        "text-[color:var(--color-text-muted)] hover:text-[color:var(--color-accent)] hover:bg-[var(--color-surface-muted)]"
                    )}
                    title={`Refresh ${feed.title}`}
                    aria-label={`Refresh ${feed.title}`}
                >
                    <RefreshCw className={cn("w-3.5 h-3.5", isRefreshing && "animate-spin")} />
                </button>
            )}

            <button
                onClick={(event) => {
                    event.stopPropagation();
                    onDelete();
                }}
                className={cn(
                    "p-1.5 transition-colors flex-shrink-0",
                    showTouchActions
                        ? "opacity-100"
                        : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
                    "text-[color:var(--color-text-muted)] hover:text-[color:var(--color-error)] hover:bg-[var(--color-error)]/10"
                )}
                title="Remove feed"
                aria-label={`Remove ${feed.title}`}
            >
                <Trash2 className="w-3.5 h-3.5" />
            </button>
        </div>
    );
}

function ArticleCard({
    article,
    feedTitle,
    onRead,
    onDelete,
    onToggleRead,
}: {
    article: RssArticle;
    feedTitle?: string;
    onRead: () => void;
    onDelete?: (articleId: string) => void;
    onToggleRead?: (articleId: string) => void;
}) {
    const summaryHtml = useMemo(() => {
        const text = article.summary || article.content || article.fullContent;
        if (!text) return "";
        const html = sanitizeArticleHtml(text);
        return html;
    }, [article.summary, article.content, article.fullContent]);

    const dateStr = formatArticleDate(article.publishedAt ?? article.fetchedAt);

    const contextMenuItems: ContextMenuItem[] = [
        {
            id: "read",
            label: "Read Article",
            icon: <BookOpen className="w-4 h-4" />,
            onClick: onRead,
        },
        ...(article.url ? [{
            id: "open-original",
            label: "Open Original",
            icon: <ExternalLink className="w-4 h-4" />,
            onClick: () => {
                if (isTauri()) {
                    import("@tauri-apps/plugin-opener").then(
                        ({ openUrl }) => openUrl(article.url),
                    );
                } else {
                    window.open(article.url, "_blank", "noopener,noreferrer");
                }
            },
        }] as ContextMenuItem[] : []),
        {
            id: "copy-link",
            label: "Copy Link",
            icon: <Link2 className="w-4 h-4" />,
            onClick: () => {
                navigator.clipboard.writeText(article.url || "").catch(e => console.error("[catch]", e));
            },
        },
        ...(onToggleRead ? [{
            id: "toggle-read",
            label: article.isRead ? "Mark Unread" : "Mark Read",
            icon: article.isRead ? <EyeOff className="w-4 h-4" /> : <CheckCheck className="w-4 h-4" />,
            onClick: () => onToggleRead(article.id),
        }] as ContextMenuItem[] : []),
        ...(onDelete ? [{
            id: "separator",
            label: "",
            separator: true,
        }] as ContextMenuItem[] : []),
        ...(onDelete ? [{
            id: "delete",
            label: "Delete Article",
            icon: <Trash2 className="w-4 h-4" />,
            danger: true,
            onClick: () => onDelete(article.id),
        }] as ContextMenuItem[] : []),
    ];

    return (
        <ContextMenu items={contextMenuItems}>
            <div
                onClick={onRead}
                className={cn(
                    "group p-4 sm:p-5 border transition-colors duration-200 cursor-pointer",
                    article.isRead
                        ? "border-transparent bg-[var(--color-surface-muted)]/30 opacity-70 hover:opacity-100"
                        : "border-[var(--color-border)] bg-[var(--color-surface)] hover:border-[var(--color-accent)]/30 hover:shadow-sm",
                    "active:scale-[0.99]"
                )}
            >
                <div className="flex gap-4 sm:gap-5">
                    
                    <div className="flex-1 min-w-0">
                        
                        <div className="flex items-center gap-2 mb-2 flex-wrap">
                            {feedTitle && (
                                <span className="text-[10px] uppercase font-bold tracking-wider text-[color:var(--color-accent)]">
                                    {feedTitle}
                                </span>
                            )}
                            {dateStr && (
                                <>
                                    <span className="text-[color:var(--color-text-muted)] text-[10px]">•</span>
                                    <span className="text-[10px] font-medium text-[color:var(--color-text-muted)] flex items-center gap-1 uppercase tracking-wide">
                                        {dateStr}
                                    </span>
                                </>
                            )}
                            {article.progress != null && article.progress > 0 && (
                                <>
                                    <span className="text-[color:var(--color-text-muted)] text-[10px]">•</span>
                                    <span className="text-[10px] font-mono font-semibold text-[color:var(--color-accent)]">
                                        {formatProgress(article.progress)} read
                                    </span>
                                </>
                            )}
                            {article.isRead && (!article.progress || article.progress >= 0.95) && (
                                <>
                                    <span className="text-[color:var(--color-text-muted)] text-[10px]">•</span>
                                    <span className="text-[10px] font-medium text-[color:var(--color-text-muted)] uppercase tracking-wide">
                                        Read
                                    </span>
                                </>
                            )}
                        </div>

                        <h3 className={cn(
                            "text-base font-semibold line-clamp-2 mb-2 leading-tight",
                            article.isRead
                                ? "text-[color:var(--color-text-secondary)]"
                                : "text-[color:var(--color-text-primary)]",
                        )}>
                            {article.title}
                        </h3>

                        {summaryHtml && (
                            <div
                                className="text-sm text-[color:var(--color-text-muted)] line-clamp-2 leading-relaxed [&_p]:inline [&_a]:text-[color:var(--color-accent)] [&_a]:underline [&_strong]:font-bold [&_em]:italic [&_img]:hidden [&_figure]:hidden"
                                dangerouslySetInnerHTML={sanitizeHtmlForDisplay(summaryHtml)}
                            />
                        )}

                        {article.progress != null && article.progress > 0 && article.progress < 0.95 && (
                            <div className="w-full bg-[var(--color-surface-muted)] h-1 rounded-full overflow-hidden mt-3 max-w-xs">
                                <div
                                    className="bg-[var(--color-accent)] h-full transition-[width] duration-300"
                                    style={{ width: `${Math.round(article.progress * 100)}%` }}
                                />
                            </div>
                        )}

                        <div className="flex items-center gap-2 mt-3">
                            {article.url && (
                                <button
                                    type="button"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        if (isTauri()) {
                                            import("@tauri-apps/plugin-opener").then(
                                                ({ openUrl }) => openUrl(article.url),
                                            );
                                        } else {
                                            window.open(article.url, "_blank", "noopener,noreferrer");
                                        }
                                    }}
                                    className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-[color:var(--color-text-muted)] hover:text-[color:var(--color-text-primary)] hover:bg-[var(--color-surface-muted)] rounded transition-colors"
                                    title="Open original website in browser"
                                >
                                    <ExternalLink className="w-3.5 h-3.5" />
                                    <span>View Original</span>
                                </button>
                            )}
                        </div>
                    </div>

                    {article.imageUrl && (
                        <div className="hidden sm:block w-24 h-24 flex-shrink-0 overflow-hidden bg-[var(--color-surface-muted)] border border-[var(--color-border)]">
                            <img
                                src={article.imageUrl}
                                alt=""
                                className="w-full h-full object-cover"
                                loading="lazy"
                                onError={(e) => {
                                    (e.target as HTMLImageElement).parentElement!.style.display = 'none';
                                }}
                            />
                        </div>
                    )}
                </div>
            </div>
        </ContextMenu>
    );
}

function EmptyFeeds({ onAddFeed }: { onAddFeed: () => void }) {
    return (
        <div className="mx-auto w-full max-w-[26rem] min-w-0 px-4 sm:px-6 flex flex-col items-center justify-center py-20 text-center animate-fade-in">
            <div className="mb-5 inline-flex h-16 w-16 items-center justify-center border border-[var(--color-border-subtle)] bg-[var(--color-surface-muted)] text-[color:var(--color-text-secondary)]">
                <Rss className="w-6 h-6" />
            </div>
            <h2 className="w-full break-words text-balance text-lg font-medium text-[color:var(--color-text-primary)] mb-2">
                Your Feed Reader
            </h2>
            <p className="mx-auto w-full max-w-[24rem] break-words text-[color:var(--color-text-muted)] mb-8 text-sm leading-relaxed">
                Subscribe to your favorite blogs, news sites, and newsletters to read them right here in Theorem.
            </p>
            <button
                onClick={onAddFeed}
                className={cn(
                    "min-w-[10.5rem] whitespace-nowrap flex items-center gap-2 px-6 py-2.5",
                    "bg-[var(--color-accent)] text-[color:var(--color-accent-contrast)] text-sm font-medium",
                    "hover:opacity-90 transition-opacity shadow-sm",
                )}
            >
                <Plus className="w-4 h-4" />
                <span>Add First Feed</span>
            </button>
        </div>
    );
}

function EmptyArticles({ feedTitle }: { feedTitle?: string }) {
    return (
        <div className="mx-auto w-full max-w-[26rem] min-w-0 px-4 sm:px-6 flex flex-col items-center justify-center py-24 text-center animate-fade-in">
            <div className="mb-5 inline-flex h-16 w-16 items-center justify-center border border-[var(--color-border-subtle)] bg-[var(--color-surface-muted)] text-[color:var(--color-text-secondary)]">
                <LayoutTemplate className="w-6 h-6" />
            </div>
            <h3 className="w-full break-words text-balance text-lg font-medium text-[color:var(--color-text-primary)] mb-2">
                No Articles Yet
            </h3>
            <p className="mx-auto w-full max-w-[24rem] break-words text-[color:var(--color-text-muted)] text-sm leading-relaxed">
                {feedTitle ? `We couldn't find any new articles for "${feedTitle}".` : "Select a feed from the sidebar to start reading."}
            </p>
        </div>
    );
}

export function FeedsPage() {
    const feeds = useRssStore((s) => s.feeds);
    const articles = useRssStore((s) => s.articles);
    const isLoading = useRssStore((s) => s.isLoading);
    const error = useRssStore((s) => s.error);
    const addFeed = useRssStore((s) => s.addFeed);
    const removeFeed = useRssStore((s) => s.removeFeed);
    const deleteArticle = useRssStore((s) => s.deleteArticle);
    const toggleArticleRead = useRssStore((s) => s.toggleArticleRead);
    const refreshFeed = useRssStore((s) => s.refreshFeed);
    const refreshAll = useRssStore((s) => s.refreshAll);
    const getArticlesForFeed = useRssStore((s) => s.getArticlesForFeed);
    const getAllArticles = useRssStore((s) => s.getAllArticles);
    const openArticleInReader = useRssStore((s) => s.openArticleInReader);
    const setError = useRssStore((s) => s.setError);

    const [selectedFeedId, setSelectedFeedId] = useState<string | null>(() => {
        if (typeof window === "undefined") {
            return null;
        }
        const value = window.sessionStorage.getItem(FEEDS_SELECTED_FEED_STORAGE_KEY);
        return value && value.trim().length > 0 ? value : null;
    });
    const [isAddModalOpen, setIsAddModalOpen] = useState(false);
    const [refreshingFeedIds, setRefreshingFeedIds] = useState<Set<string>>(() => new Set());
    const [isRefreshingAll, setIsRefreshingAll] = useState(false);

    const [showMobileList, setShowMobileList] = useState(() => {
        if (typeof window === "undefined") {
            return true;
        }
        return window.sessionStorage.getItem(FEEDS_MOBILE_LIST_STORAGE_KEY) !== "false";
    });
    const showTouchActions = useTouchVisibleActions();
    const feedListScrollRef = useRef<HTMLDivElement | null>(null);
    const articleListScrollRef = useRef<HTMLDivElement | null>(null);

    const selectedFeed = selectedFeedId ? feeds.find(f => f.id === selectedFeedId) : null;

    useEffect(() => {
        if (selectedFeedId && !feeds.some((feed) => feed.id === selectedFeedId)) {
            setSelectedFeedId(null);
        }
    }, [feeds, selectedFeedId]);

    useEffect(() => {
        if (typeof window === "undefined") {
            return;
        }

        if (selectedFeedId) {
            window.sessionStorage.setItem(FEEDS_SELECTED_FEED_STORAGE_KEY, selectedFeedId);
            return;
        }

        window.sessionStorage.removeItem(FEEDS_SELECTED_FEED_STORAGE_KEY);
    }, [selectedFeedId]);

    useEffect(() => {
        if (typeof window === "undefined") {
            return;
        }
        window.sessionStorage.setItem(
            FEEDS_MOBILE_LIST_STORAGE_KEY,
            showMobileList ? "true" : "false",
        );
    }, [showMobileList]);

    const displayedArticles = useMemo(() => {
        if (selectedFeedId) {
            return getArticlesForFeed(selectedFeedId);
        }
        return getAllArticles();
    }, [selectedFeedId, articles, getArticlesForFeed, getAllArticles]);

    const feedListRows = useMemo(
        () => [{ kind: "all" as const }, ...feeds.map((feed) => ({ kind: "feed" as const, feed }))],
        [feeds],
    );

    const feedVirtualizer = useVirtualizer({
        count: feedListRows.length,
        getScrollElement: () => feedListScrollRef.current,
        estimateSize: () => 46,
        overscan: 10,
        getItemKey: (index) => (
            index === 0
                ? "all-articles"
                : feedListRows[index]?.kind === "feed"
                    ? feedListRows[index].feed.id
                    : String(index)
        ),
    });

    const articleVirtualItemCount = displayedArticles.length > 0
        ? displayedArticles.length + 1
        : 0;
    const articleVirtualizer = useVirtualizer({
        count: articleVirtualItemCount,
        getScrollElement: () => articleListScrollRef.current,
        estimateSize: () => 212,
        overscan: 6,
        getItemKey: (index) => (
            index === displayedArticles.length
                ? "end-of-list"
                : displayedArticles[index]?.id ?? String(index)
        ),
        measureElement: (element) => element?.getBoundingClientRect().height ?? 212,
    });

    useEffect(() => {
        feedVirtualizer.measure();
    }, [feedVirtualizer, feedListRows.length, showMobileList]);

    useEffect(() => {
        articleVirtualizer.measure();
    }, [articleVirtualizer, displayedArticles.length, selectedFeedId, showMobileList]);

    const feedTitleById = useMemo(() => {
        const map = new Map<string, string>();
        for (const feed of feeds) {
            map.set(feed.id, feed.title);
        }
        return map;
    }, [feeds]);

    const handleAddFeed = useCallback(async (url: string) => {
        try {
            const result = await addFeed(url);
            if (result) {
                setIsAddModalOpen(false);
                setSelectedFeedId(result.id);
                setShowMobileList(false); 
            }
        } catch (e) {
            
        }
    }, [addFeed]);

    const handleSelectFeed = useCallback((id: string | null) => {
        setSelectedFeedId(id);
        setShowMobileList(false); 
    }, []);

    const handleRefreshFeed = useCallback(async (feedId: string) => {
        setRefreshingFeedIds((prev) => {
            const next = new Set(prev);
            next.add(feedId);
            return next;
        });
        try {
            await refreshFeed(feedId);
        } finally {
            setRefreshingFeedIds((prev) => {
                const next = new Set(prev);
                next.delete(feedId);
                return next;
            });
        }
    }, [refreshFeed]);

    const handleRefreshHeader = useCallback(async () => {
        if (selectedFeedId) {
            await handleRefreshFeed(selectedFeedId);
        } else {
            setIsRefreshingAll(true);
            try {
                await refreshAll();
            } finally {
                setIsRefreshingAll(false);
            }
        }
    }, [selectedFeedId, handleRefreshFeed, refreshAll]);

    const handleDeleteFeed = useCallback((feedId: string) => {
        if (selectedFeedId === feedId) {
            setSelectedFeedId(null);
            setShowMobileList(true); 
        }
        removeFeed(feedId);
    }, [removeFeed, selectedFeedId]);

    const handleBackToFeeds = () => {
        setShowMobileList(true);
    };

    const isRefreshingCurrent = selectedFeedId
        ? refreshingFeedIds.has(selectedFeedId)
        : isRefreshingAll;

    if (feeds.length === 0 && !isLoading) {
        return (
            <div className="mx-auto w-full max-w-[var(--layout-content-max-width)] px-4 py-6 pb-0 sm:px-6 lg:px-8 lg:py-8 animate-fade-in">
                <EmptyFeeds onAddFeed={() => setIsAddModalOpen(true)} />
                <AddFeedModal
                    isOpen={isAddModalOpen}
                    onClose={() => { setIsAddModalOpen(false); setError(undefined); }}
                    onSubmit={handleAddFeed}
                    isLoading={isLoading}
                    error={error}
                />
            </div>
        );
    }

    return (
        <div className="h-full w-full flex overflow-hidden bg-[var(--color-background)]">
            
            <div className={cn(
                "flex-col border-r border-[var(--color-border)] bg-[var(--color-background)]",
                "h-full flex-shrink-0 transition-colors duration-300",
                
                showMobileList ? "flex w-full" : "hidden",
                
                "md:flex md:w-64"
            )}>
                
                <div className="px-4 pt-8 pb-4 flex items-center justify-between">
                    <h2 className="text-xs font-semibold uppercase tracking-wider text-[color:var(--color-text-muted)]">
                        Subscriptions
                    </h2>
                    <button
                        onClick={() => setIsAddModalOpen(true)}
                        className="p-1.5 text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)] hover:bg-[var(--color-surface-muted)] transition-colors"
                        title="Add Feed"
                    >
                        <Plus className="w-4 h-4" />
                    </button>
                </div>

                <div ref={feedListScrollRef} className="flex-1 overflow-y-auto [content-visibility:auto] overscroll-contain">
                    <div className="p-2">
                        <div
                            className="relative w-full"
                            style={{ height: `${feedVirtualizer.getTotalSize()}px` }}
                        >
                            {feedVirtualizer.getVirtualItems().map((virtualRow) => {
                                const row = feedListRows[virtualRow.index];
                                if (!row) {
                                    return null;
                                }

                                return (
                                    <div
                                        key={virtualRow.key}
                                        ref={feedVirtualizer.measureElement}
                                        data-index={virtualRow.index}
                                        className="absolute left-0 top-0 w-full pb-1"
                                        style={{
                                            transform: `translateY(${virtualRow.start}px)`,
                                        }}
                                    >
                                        {row.kind === "all" ? (
                                            <button
                                                onClick={() => handleSelectFeed(null)}
                                                className={cn(
                                                    "w-full flex items-center gap-3 px-3 py-2 cursor-pointer transition-colors",
                                                    selectedFeedId === null
                                                        ? "bg-[var(--color-accent)]/10 text-[color:var(--color-accent)]"
                                                        : "hover:bg-[var(--color-surface-muted)] text-[color:var(--color-text-secondary)]",
                                                )}
                                            >
                                                <div className={cn(
                                                    "w-6 h-6 flex items-center justify-center transition-colors",
                                                    selectedFeedId === null
                                                        ? "text-[color:var(--color-accent)]"
                                                        : "text-[color:var(--color-text-muted)]",
                                                )}>
                                                    <LayoutTemplate className="w-4 h-4" />
                                                </div>
                                                <span className="text-sm font-medium">All Articles</span>
                                            </button>
                                        ) : (
                                            <FeedListItem
                                                feed={row.feed}
                                                isSelected={selectedFeedId === row.feed.id}
                                                onSelect={() => handleSelectFeed(row.feed.id)}
                                                onDelete={() => handleDeleteFeed(row.feed.id)}
                                                onRefresh={() => handleRefreshFeed(row.feed.id)}
                                                isRefreshing={refreshingFeedIds.has(row.feed.id)}
                                                showTouchActions={showTouchActions}
                                            />
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                </div>
            </div>

            <div className={cn(
                "flex-col min-w-0 bg-[var(--color-background)]",
                "h-full flex-1 transition-colors duration-300",
                
                !showMobileList ? "flex" : "hidden",
                
                "md:flex"
            )}>
                
                <header className="shrink-0 px-4 sm:px-6 pt-8 pb-4 flex items-center justify-between gap-4">
                    <div className="flex items-center gap-2 sm:gap-3 min-w-0">
                        
                        <button
                            onClick={handleBackToFeeds}
                            className="md:hidden -ml-2 p-1.5 shrink-0 text-[color:var(--color-text-secondary)] hover:bg-[var(--color-surface-muted)]"
                        >
                            <ArrowLeft className="w-5 h-5" />
                        </button>

                        <div className="min-w-0">
                            <h1 className="m-0 font-sans text-xl sm:text-[1.45rem] md:text-[1.6rem] font-semibold uppercase tracking-[0.12em] leading-[1.1] text-[color:var(--color-text-primary)] truncate">
                                {selectedFeed ? selectedFeed.title : "All Articles"}
                            </h1>
                            <p className="mt-1 text-sm leading-relaxed text-[color:var(--color-text-secondary)] truncate">
                                {displayedArticles.length} articles
                            </p>
                        </div>
                    </div>

                    <button
                        onClick={handleRefreshHeader}
                        disabled={isRefreshingCurrent || isLoading}
                        className={cn(
                            "ui-btn shrink-0",
                            "disabled:opacity-50",
                        )}
                        title={selectedFeed ? `Refresh ${selectedFeed.title}` : "Refresh all feeds"}
                    >
                        <RefreshCw className={cn("w-4 h-4", (isRefreshingCurrent || isLoading) && "animate-spin")} />
                        <span className="hidden sm:inline">Refresh</span>
                    </button>
                </header>

                <div ref={articleListScrollRef} className="flex-1 overflow-y-auto [content-visibility:auto] overscroll-contain">
                    {isLoading && feeds.length === 0 ? (
                        <div className="flex items-center justify-center h-full">
                            <Loader2 className="w-6 h-6 animate-spin text-[color:var(--color-text-muted)]" />
                        </div>
                    ) : displayedArticles.length === 0 ? (
                        <EmptyArticles feedTitle={selectedFeed?.title} />
                    ) : (
                        <div className="p-4 sm:p-6">
                            <div className="mx-auto max-w-6xl">
                                <div
                                    className="relative w-full"
                                    style={{ height: `${articleVirtualizer.getTotalSize()}px` }}
                                >
                                    {articleVirtualizer.getVirtualItems().map((virtualRow) => {
                                        const article = displayedArticles[virtualRow.index];
                                        const style = { transform: `translateY(${virtualRow.start}px)` };

                                        if (!article) {
                                            return (
                                                <div
                                                    key={virtualRow.key}
                                                    ref={articleVirtualizer.measureElement}
                                                    data-index={virtualRow.index}
                                                    className="absolute left-0 top-0 w-full py-8 text-center text-sm text-[color:var(--color-text-muted)]"
                                                    style={style}
                                                >
                                                    You've reached the end of the list.
                                                </div>
                                            );
                                        }

                                        return (
                                            <div
                                                key={article.id}
                                                ref={articleVirtualizer.measureElement}
                                                data-index={virtualRow.index}
                                                className="absolute left-0 top-0 w-full pb-4"
                                                style={style}
                                            >
                                                <ArticleCard
                                                    article={article}
                                                    feedTitle={!selectedFeedId ? feedTitleById.get(article.feedId) : undefined}
                                                    onRead={() => openArticleInReader(article)}
                                                    onDelete={deleteArticle}
                                                    onToggleRead={toggleArticleRead}
                                                />
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* Error Toast */}
            {error && (
                <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 px-4 py-3 bg-[var(--color-error)] text-[color:var(--color-text-inverse)] text-sm font-medium shadow-xl animate-fade-in-up">
                    <AlertCircle className="w-4 h-4 flex-shrink-0" />
                    <span>{error}</span>
                    <button onClick={() => setError(undefined)} className="ml-2 p-0.5 hover:bg-white/20">✕</button>
                </div>
            )}

            <AddFeedModal
                isOpen={isAddModalOpen}
                onClose={() => { setIsAddModalOpen(false); setError(undefined); }}
                onSubmit={handleAddFeed}
                isLoading={isLoading}
                error={error}
            />
        </div>
    );
}
