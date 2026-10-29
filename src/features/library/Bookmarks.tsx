import { localDateKey } from "../../core/lib/date-keys";
import { useState, useMemo, useCallback, useEffect, useLayoutEffect, memo, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { joinFields } from "../../core/lib/search/native-rank";
import { useFuzzyRank } from "../../core/lib/search/useFuzzyRank";
import { useLibraryStore, useUIStore, useRssStore, getRssArticleById } from "../../core/store";
import type { Annotation } from "../../core/types";
import {
    resolveAnnotationSource,
    navigateToAnnotationSource,
    parseAnnotationSourceId,
    type ResolvedAnnotationSource,
} from "../../core/lib/annotation-source";
import { PageHeader, Dropdown, ConfirmDialog } from "../../ui";
import { Bookmark } from "lucide-react";
import { cn } from "../../core/lib/utils";
import { ReviewCardStack } from "./components/ReviewCardStack";
import { AnnotationListCard } from "./components/AnnotationListCard";
import { ANNOTATION_ROW_GAP_PX, annotationRowSize, computeCardLayout, type CardLayout } from "./components/annotation-card-layout";
import { useCardTextMeasurer } from "./components/useCardTextMeasurer";
import { bookmarkPositionLabel } from "./components/bookmark-position";

function EmptyBookmarks() {
    return (
        <div className="mx-auto w-full max-w-[26rem] min-w-0 px-4 sm:px-6 flex flex-col items-center justify-center py-20 text-center animate-fade-in">
            <div className="w-16 h-16 bg-[var(--color-surface-muted)] flex items-center justify-center mb-6">
                <Bookmark className="w-6 h-6 text-[color:var(--color-text-secondary)]" />
            </div>
            <h2 className="w-full break-words text-balance text-lg text-[color:var(--color-text-primary)] mb-2">
                No Bookmarks Yet
            </h2>
            <p className="mx-auto w-full max-w-[24rem] break-words text-[color:var(--color-text-muted)] mb-8 text-sm leading-relaxed">
                Bookmark pages while reading to quickly return to them later.
            </p>
        </div>
    );
}

interface BookmarkCardProps {
    bookmark: Annotation;
    source: ResolvedAnnotationSource | undefined;
    menuOpen: boolean;
    layout: CardLayout;
    onToggleExpanded: (id: string) => void;
    searchQuery?: string;
    onMenuOpenChange: (id: string | null) => void;
    onDelete: (id: string) => void;
    onGoToBookmark: (sourceId: string, location: string) => void;
}

const BookmarkCard = memo(function BookmarkCard({
    bookmark,
    source,
    menuOpen,
    layout,
    onToggleExpanded,
    searchQuery,
    onMenuOpenChange,
    onDelete,
    onGoToBookmark,
}: BookmarkCardProps) {
    const isArticle = source?.isArticle ?? bookmark.bookId.startsWith("rss:");
    const goTo = () => onGoToBookmark(bookmark.bookId, bookmark.location);
    return (
        <AnnotationListCard
            id={bookmark.id}
            typeLabel="bookmark"
            dateLabel={localDateKey(new Date(bookmark.createdAt))}
            sourceTitle={source?.title || "Unknown source"}
            sourceAuthor={source?.author || "Unknown author"}
            quote={bookmark.selectedText}
            note={bookmark.noteContent}
            meta={bookmarkPositionLabel(bookmark)}
            searchQuery={searchQuery}
            menuOpen={menuOpen}
            onMenuOpenChange={onMenuOpenChange}
            layout={layout}
            onToggleExpanded={onToggleExpanded}
            menuItems={[
                { label: isArticle ? "Open article" : "Go to bookmark", onSelect: goTo },
                { label: "Delete", onSelect: () => onDelete(bookmark.id), danger: true },
            ]}
            onOpen={goTo}
            openTitle={isArticle ? "Click to open article at this bookmark" : "Click to open at this bookmark"}
        />
    );
});

function bookmarkBlocks(bookmark: Annotation) {
    return {
        quote: bookmark.selectedText,
        note: bookmark.noteContent,
        meta: bookmarkPositionLabel(bookmark),
    };
}

/**
 * The Workbench's Bookmarks tab. Bookmarks are annotations like highlights and notes, so they
 * live on the Workbench page under its title; `tabs` is the Workbench's own tab row, laid out
 * with this tab's filters the way the other tabs lay out theirs.
 */
export function BookmarksPanel({
    tabs,
    onOpenDailyReview,
    hasDailyReview,
    dailyCardsCount,
}: {
    tabs: ReactNode;
    onOpenDailyReview?: () => void;
    hasDailyReview?: boolean;
    dailyCardsCount?: number;
}) {
    const annotations = useLibraryStore((state) => state.annotations);
    const getBook = useLibraryStore((state) => state.getBook);
    const removeAnnotation = useLibraryStore((state) => state.removeAnnotation);
    const setRoute = useUIStore((state) => state.setRoute);
    const setPendingReaderLocation = useUIStore((state) => state.setPendingReaderLocation);
    const searchQuery = useUIStore((state) => state.searchQuery);
    const rssArticles = useRssStore((state) => state.articles);
    const rssFeeds = useRssStore((state) => state.feeds);
    const openArticleInReader = useRssStore((state) => state.openArticleInReader);
    const getArticle = useRssStore((state) => state.getArticle);
    const loadArticle = useRssStore((state) => state.loadArticle);
    const [viewMode, setViewMode] = useState<"list" | "cards">("list");
    const [sortBy, setSortBy] = useState<"newest" | "oldest" | "book">("newest");
    const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
    const [deleteBookmarkId, setDeleteBookmarkId] = useState<string | null>(null);
    const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(() => new Set());
    const { listRef, measurer } = useCardTextMeasurer();
    const toggleExpanded = useCallback((id: string) => {
        setExpandedIds((prev) => {
            const next = new Set(prev);
            if (!next.delete(id)) next.add(id);
            return next;
        });
    }, []);

    // Derive lookup from bookmark bookIds only — avoids subscribing to the
    // entire books array which re-renders on every progress tick. The book
    // count still invalidates it: books hydrate after annotations, and a lookup
    // built before that would hide every bookmark until annotations change.
    const bookCount = useLibraryStore((state) => state.books.length);
    const bookmarks = useMemo(() => annotations.filter((a) => a.type === "bookmark"), [annotations]);
    const sourceLookup = useMemo(
        () => {
            const lookup = new Map<string, ResolvedAnnotationSource>();
            for (const bm of bookmarks) {
                if (lookup.has(bm.bookId)) continue;
                const source = resolveAnnotationSource(bm.bookId, getBook, rssArticles, rssFeeds, bm.chapterTitle);
                if (source) lookup.set(bm.bookId, source);
            }
            return lookup;
        },
        // getBook is stable (store action ref); bookCount re-derives once books load
        [bookmarks, getBook, bookCount, rssArticles, rssFeeds],
    );

    // If any bookmarks originate from RSS articles not yet loaded into memory,
    // load them from SQLite in the background so full metadata becomes available.
    useEffect(() => {
        for (const bm of bookmarks) {
            const { isArticle, cleanId } = parseAnnotationSourceId(bm.bookId);
            if (isArticle || (!getBook(bm.bookId) && bm.bookId)) {
                if (!getRssArticleById(rssArticles, cleanId)) {
                    loadArticle(cleanId);
                }
            }
        }
    }, [bookmarks, rssArticles, getBook, loadArticle]);

    const visibleBookmarks = useMemo(
        () => bookmarks.filter((b) => sourceLookup.has(b.bookId)),
        [bookmarks, sourceLookup],
    );

    const scopedBookmarks = visibleBookmarks;

    // Search ranks with the native matcher; null while there is no ranking yet.
    const rankedBookmarks = useFuzzyRank(scopedBookmarks, searchQuery, (bookmark) => {
        const source = sourceLookup.get(bookmark.bookId);
        return {
            primary: bookmark.selectedText || "",
            secondary: joinFields(source?.title, source?.author),
        };
    });

    const filteredBookmarks = useMemo(() => {
        if (rankedBookmarks) return rankedBookmarks.map(({ item }) => item);

        const filtered = [...scopedBookmarks];
        const time = (d: Date | string) => (d instanceof Date ? d : new Date(d)).getTime();
        filtered.sort((a, b) => {
            switch (sortBy) {
                case "newest":
                    return time(b.createdAt) - time(a.createdAt);
                case "oldest":
                    return time(a.createdAt) - time(b.createdAt);
                case "book": {
                    const bookA = sourceLookup.get(a.bookId)?.title || "";
                    const bookB = sourceLookup.get(b.bookId)?.title || "";
                    return bookA.localeCompare(bookB) || time(b.createdAt) - time(a.createdAt);
                }
                default:
                    return 0;
            }
        });

        return filtered;
    }, [scopedBookmarks, rankedBookmarks, sortBy, sourceLookup]);

    // Exact, not an estimate: each card renders at its computed layout height.
    const cardLayouts = useMemo(
        () => filteredBookmarks.map((bm) => computeCardLayout(bookmarkBlocks(bm), measurer, expandedIds.has(bm.id))),
        [filteredBookmarks, measurer, expandedIds],
    );
    const estimateBookmarkSize = useCallback((index: number) => annotationRowSize(cardLayouts[index]), [cardLayouts]);

    const bookmarksVirtualizer = useVirtualizer({
        count: filteredBookmarks.length,
        getScrollElement: useCallback(() => document.getElementById('app-main'), []),
        estimateSize: estimateBookmarkSize,
        getItemKey: useCallback((index: number) => filteredBookmarks[index]?.id ?? String(index), [filteredBookmarks]),
        overscan: 5,
    });

    // Sizes come from estimateSize only; recompute offsets when they change.
    useLayoutEffect(() => {
        bookmarksVirtualizer.measure();
    }, [bookmarksVirtualizer, cardLayouts]);

    const handleDelete = useCallback((id: string) => {
        setDeleteBookmarkId(id);
    }, []);

    const handleDeleteConfirm = () => {
        if (deleteBookmarkId) {
            removeAnnotation(deleteBookmarkId);
            setDeleteBookmarkId(null);
        }
    };

    const hasBook = useCallback((id: string) => !!useLibraryStore.getState().getBook(id), []);

    const handleGoToBookmark = useCallback((sourceId: string, location?: string) => {
        const loc = location || bookmarks.find((b) => b.bookId === sourceId)?.location || "";
        const bm = bookmarks.find((b) => b.bookId === sourceId && b.location === loc);
        navigateToAnnotationSource(sourceId, loc, {
            setPendingReaderLocation,
            setRoute,
            openArticleInReader,
            getArticle,
            loadArticle,
            hasBook,
            fallbackTitle: bm?.chapterTitle,
        });
    }, [bookmarks, setPendingReaderLocation, setRoute, openArticleInReader, getArticle, loadArticle, hasBook]);

    if (visibleBookmarks.length === 0) {
        return (
            <>
                <PageHeader
                    title="Workbench"
                    description={
                        <span>
                            0 bookmarks across 0 sources
                            {hasDailyReview && (
                                <>
                                    <span className="text-[color:var(--color-border-strong)] mx-1.5 select-none">·</span>
                                    <button
                                        type="button"
                                        onClick={onOpenDailyReview}
                                        className="inline-flex items-center gap-1 font-medium text-[color:var(--color-accent)] hover:underline transition-colors"
                                        aria-label="Open Daily Review"
                                    >
                                        Daily Review ({dailyCardsCount})
                                    </button>
                                </>
                            )}
                        </span>
                    }
                />
                <div className="mb-6">
                    {tabs}
                </div>
                <EmptyBookmarks />
            </>
        );
    }

    const bookTotal = new Set(filteredBookmarks.map((b) => b.bookId)).size;

    return (
        <>
            <PageHeader
                title="Workbench"
                actionsClassName="w-full sm:w-auto ml-0 sm:ml-auto justify-between sm:justify-end"
                description={
                    <span>
                        {filteredBookmarks.length} {filteredBookmarks.length === 1 ? "bookmark" : "bookmarks"} across {bookTotal} {bookTotal === 1 ? "source" : "sources"}
                        {hasDailyReview && (
                            <>
                                <span className="text-[color:var(--color-border-strong)] mx-1.5 select-none">·</span>
                                <button
                                    type="button"
                                    onClick={onOpenDailyReview}
                                    className="inline-flex items-center gap-1 font-medium text-[color:var(--color-accent)] hover:underline transition-colors"
                                    aria-label="Open Daily Review"
                                >
                                    Daily Review ({dailyCardsCount})
                                </button>
                            </>
                        )}
                    </span>
                }
            >
                <div className="flex items-center gap-2 shrink-0">
                    <div role="group" aria-label="View mode" className="inline-flex h-8 shrink-0 items-center border border-[var(--color-border)] bg-[var(--color-surface)]">
                        <button
                            type="button"
                            aria-pressed={viewMode === "list"}
                            onClick={() => setViewMode("list")}
                            className={cn(
                                "h-full px-2.5 sm:px-3 font-sans text-xs flex items-center transition-colors touch-manipulation",
                                viewMode === "list"
                                    ? "ui-selected"
                                    : "text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)]"
                            )}
                            aria-label="List view"
                        >
                            List
                        </button>
                        <button
                            type="button"
                            aria-pressed={viewMode === "cards"}
                            onClick={() => setViewMode("cards")}
                            className={cn(
                                "h-full border-l border-[var(--color-border)] px-2.5 sm:px-3 font-sans text-xs flex items-center transition-colors touch-manipulation",
                                viewMode === "cards"
                                    ? "ui-selected"
                                    : "text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)]"
                            )}
                            aria-label="Cards view"
                        >
                            Cards
                        </button>
                    </div>

                    <Dropdown
                        value={sortBy}
                        onChange={(value) => setSortBy(value as typeof sortBy)}
                        size="sm"
                        className="h-8 shrink-0 !w-auto min-w-[100px] max-w-[140px] sm:max-w-none !border !border-[var(--color-border)] !text-xs !py-0 !px-2.5 font-sans"
                        options={[
                            { value: "newest", label: "Newest First" },
                            { value: "oldest", label: "Oldest First" },
                            { value: "book", label: "By Book" },
                        ]}
                    />
                </div>
            </PageHeader>

            <div className="mb-6">
                {tabs}
            </div>

            <ConfirmDialog
                isOpen={!!deleteBookmarkId}
                title="Delete Bookmark"
                message="Are you sure you want to delete this bookmark?"
                confirmLabel="Delete"
                cancelLabel="Cancel"
                variant="danger"
                onConfirm={handleDeleteConfirm}
                onCancel={() => setDeleteBookmarkId(null)}
            />

            {filteredBookmarks.length === 0 ? (
                <div className="text-center py-16">
                    <p className="text-[color:var(--color-text-muted)]">
                        No bookmarks found{searchQuery ? " matching your search" : ""}.
                    </p>
                </div>
            ) : viewMode === "cards" ? (
                <div className="w-full max-w-[42rem] mx-auto my-2 sm:my-6">
                    <ReviewCardStack
                        cards={filteredBookmarks}
                        sources={sourceLookup}
                        onGoToSource={handleGoToBookmark}
                        onDelete={handleDelete}
                        deckTitle="Bookmarks"
                        deckSubtitle={`${filteredBookmarks.length} ${filteredBookmarks.length === 1 ? "bookmark" : "bookmarks"}`}
                        completionTitle="All Bookmarks Reviewed"
                        completionDescription="You have reviewed all your bookmarks in this deck."
                        completionActionLabel="Back to List"
                        onCompletionAction={() => setViewMode("list")}
                    />
                </div>
            ) : (
                <div ref={listRef} style={{ height: `${bookmarksVirtualizer.getTotalSize()}px`, position: "relative" }}>
                    {bookmarksVirtualizer.getVirtualItems().map((virtualRow) => {
                        const bookmark = filteredBookmarks[virtualRow.index];
                        if (!bookmark) return null;
                        return (
                            <div
                                key={virtualRow.key}
                                data-index={virtualRow.index}
                                style={{
                                    position: "absolute",
                                    top: 0,
                                    left: 0,
                                    width: "100%",
                                    height: virtualRow.size,
                                    paddingBottom: ANNOTATION_ROW_GAP_PX,
                                    transform: `translateY(${virtualRow.start}px)`,
                                    // Each transformed row is its own stacking context;
                                    // lift the one with an open menu above later rows.
                                    zIndex: menuOpenId === bookmark.id ? 30 : undefined,
                                }}
                            >
                                <BookmarkCard
                                    bookmark={bookmark}
                                    source={sourceLookup.get(bookmark.bookId)}
                                    menuOpen={menuOpenId === bookmark.id}
                                    layout={cardLayouts[virtualRow.index]}
                                    onToggleExpanded={toggleExpanded}
                                    searchQuery={searchQuery}
                                    onMenuOpenChange={setMenuOpenId}
                                    onDelete={handleDelete}
                                    onGoToBookmark={handleGoToBookmark}
                                />
                            </div>
                        );
                    })}
                </div>
            )}
        </>
    );
}
