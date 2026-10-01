import { localDateKey } from "../../core/lib/date-keys";
import { useState, useMemo, useCallback, useLayoutEffect, memo } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { rankByFuzzyQuery } from "../../core/lib/search/fuzzy";
import { useLibraryStore, useUIStore, useRssStore } from "../../core/store";
import type { Annotation } from "../../core/types";
import {
    resolveAnnotationSource,
    navigateToAnnotationSource,
    type ResolvedAnnotationSource,
} from "../../core/lib/annotation-source";
import { PageHeader, Dropdown, ConfirmDialog } from "../../ui";
import { Bookmark } from "lucide-react";
import { AnnotationListCard } from "./components/AnnotationListCard";
import { ANNOTATION_ROW_GAP_PX, annotationRowSize, computeCardLayout, type CardLayout } from "./components/annotation-card-layout";
import { useCardTextMeasurer } from "./components/useCardTextMeasurer";
import { bookmarkPositionLabel } from "./components/bookmark-position";

const ALL_BOOKS = "__all__";

function EmptyBookmarks() {
    return (
        <div className="mx-auto w-full max-w-[26rem] min-w-0 px-4 sm:px-6 flex flex-col items-center justify-center py-20 text-center animate-fade-in">
            <div className="w-16 h-16 bg-[var(--color-surface-muted)] flex items-center justify-center mb-6">
                <Bookmark className="w-6 h-6 text-[color:var(--color-text-secondary)]" />
            </div>
            <h2 className="w-full break-words text-balance text-lg font-medium text-[color:var(--color-text-primary)] mb-2">
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

export function BookmarksPage() {
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
    const [sortBy, setSortBy] = useState<"newest" | "oldest" | "book">("newest");
    const [bookFilter, setBookFilter] = useState<string>(ALL_BOOKS);
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
                const source = resolveAnnotationSource(bm.bookId, getBook, rssArticles, rssFeeds);
                if (source) lookup.set(bm.bookId, source);
            }
            return lookup;
        },
        // getBook is stable (store action ref); bookCount re-derives once books load
        [bookmarks, getBook, bookCount, rssArticles, rssFeeds],
    );

    const visibleBookmarks = useMemo(
        () => bookmarks.filter((b) => sourceLookup.has(b.bookId)),
        [bookmarks, sourceLookup],
    );

    const bookOptions = useMemo(() => {
        const counts = new Map<string, number>();
        for (const bm of visibleBookmarks) counts.set(bm.bookId, (counts.get(bm.bookId) ?? 0) + 1);
        const options = [...counts.entries()]
            .map(([bookId, count]) => ({ value: bookId, label: `${sourceLookup.get(bookId)?.title ?? "Unknown source"} (${count})` }))
            .sort((a, b) => a.label.localeCompare(b.label));
        return [{ value: ALL_BOOKS, label: "All sources" }, ...options];
    }, [visibleBookmarks, sourceLookup]);

    // A filtered book whose last bookmark was deleted falls back to all books.
    const activeBookFilter = bookFilter !== ALL_BOOKS && sourceLookup.has(bookFilter)
        && visibleBookmarks.some((b) => b.bookId === bookFilter)
        ? bookFilter
        : ALL_BOOKS;

    const filteredBookmarks = useMemo(() => {
        const filtered = activeBookFilter === ALL_BOOKS
            ? [...visibleBookmarks]
            : visibleBookmarks.filter((b) => b.bookId === activeBookFilter);

        if (searchQuery.trim()) {
            const rankedBookmarks = rankByFuzzyQuery(
                filtered.map((bookmark) => {
                    const source = sourceLookup.get(bookmark.bookId);
                    return {
                        bookmark,
                        selectedText: bookmark.selectedText || "",
                        bookTitle: source?.title || "",
                        bookAuthor: source?.author || "",
                    };
                }),
                searchQuery,
                {
                    keys: [
                        { name: "selectedText", weight: 0.4 },
                        { name: "bookTitle", weight: 0.35 },
                        { name: "bookAuthor", weight: 0.25 },
                    ],
                },
            );
            return rankedBookmarks.map(({ item }) => item.bookmark);
        }

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
    }, [visibleBookmarks, activeBookFilter, searchQuery, sortBy, sourceLookup]);

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

    const handleGoToBookmark = useCallback((sourceId: string, location: string) => {
        navigateToAnnotationSource(sourceId, location, {
            setPendingReaderLocation,
            setRoute,
            openArticleInReader,
            getArticle,
            hasBook,
        });
    }, [setPendingReaderLocation, setRoute, openArticleInReader, getArticle, hasBook]);

    if (visibleBookmarks.length === 0) {
        return (
            <div className="mx-auto w-full max-w-[var(--layout-content-max-width)] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
                <EmptyBookmarks />
            </div>
        );
    }

    const bookTotal = new Set(filteredBookmarks.map((b) => b.bookId)).size;

    return (
        <div className="mx-auto w-full max-w-[var(--layout-content-max-width)] px-4 py-6 pb-[calc(var(--layout-bottom-nav-height)+env(safe-area-inset-bottom)+var(--spacing-xl))] sm:px-6 md:pb-0 lg:px-8 lg:py-8 animate-fade-in">
            <PageHeader
                title="Bookmarks"
                description={`${filteredBookmarks.length} ${filteredBookmarks.length === 1 ? "bookmark" : "bookmarks"} across ${bookTotal} ${bookTotal === 1 ? "source" : "sources"}`}
            />

            <div className="mb-10 flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
                <Dropdown
                    value={activeBookFilter}
                    onChange={(value) => setBookFilter(value)}
                    options={bookOptions}
                    className="w-full max-w-full sm:w-auto sm:max-w-[20rem]"
                />
                <Dropdown
                    value={sortBy}
                    onChange={(value) => setSortBy(value as typeof sortBy)}
                    options={[
                        { value: "newest", label: "Newest First" },
                        { value: "oldest", label: "Oldest First" },
                        { value: "book", label: "By Book" },
                    ]}
                />
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
        </div>
    );
}
