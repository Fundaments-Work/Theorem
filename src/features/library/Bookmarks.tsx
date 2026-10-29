import { localDateKey } from "../../core/lib/date-keys";
import { useState, useMemo, useCallback, useEffect, useRef, memo, type ReactNode } from "react";
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
import { PageHeader, Dropdown, ConfirmDialog, TheoremBookCover, HighlightMatch } from "../../ui";
import { Bookmark, Layers, List, MoreVertical, ArrowUpRight, Trash2 } from "lucide-react";
import { ReviewCardStack } from "./components/ReviewCardStack";
import { bookmarkPositionLabel } from "./components/bookmark-position";

const BOOKMARK_ROW_HEIGHT = 88;
const BOOKMARK_ROW_GAP_PX = 8;
const BOOKMARK_TOTAL_ROW_HEIGHT = BOOKMARK_ROW_HEIGHT + BOOKMARK_ROW_GAP_PX;

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
    searchQuery?: string;
    onMenuOpenChange: (id: string | null) => void;
    onDelete: (id: string) => void;
    onGoToBookmark: (sourceId: string, location: string) => void;
}

const BookmarkCard = memo(function BookmarkCard({
    bookmark,
    source,
    menuOpen,
    searchQuery,
    onMenuOpenChange,
    onDelete,
    onGoToBookmark,
}: BookmarkCardProps) {
    const isArticle = source?.isArticle ?? bookmark.bookId.startsWith("rss:");
    const goTo = () => onGoToBookmark(bookmark.bookId, bookmark.location);
    const dateLabel = localDateKey(new Date(bookmark.createdAt));
    const position = bookmarkPositionLabel(bookmark);
    const pointerInsideRef = useRef(false);

    useEffect(() => {
        if (!menuOpen) return;
        const handlePointerDown = () => {
            const inside = pointerInsideRef.current;
            pointerInsideRef.current = false;
            if (!inside) onMenuOpenChange(null);
        };
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") onMenuOpenChange(null);
        };
        document.addEventListener("pointerdown", handlePointerDown);
        document.addEventListener("keydown", handleKeyDown);
        return () => {
            document.removeEventListener("pointerdown", handlePointerDown);
            document.removeEventListener("keydown", handleKeyDown);
        };
    }, [menuOpen, onMenuOpenChange]);

    return (
        <div
            onClick={goTo}
            className="group relative flex items-center justify-between gap-3 sm:gap-4 p-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] hover:border-[var(--color-accent)] hover:shadow-xs transition-all overflow-hidden cursor-pointer h-[88px]"
            title={isArticle ? "Open article at this bookmark" : "Open in reader at this bookmark"}
        >
            {/* Bookmark ribbon tab fold on top-left edge */}
            <div
                className="absolute top-0 left-3 sm:left-4 w-3.5 h-4.5 bg-[var(--color-accent)] shadow-xs pointer-events-none group-hover:h-5 transition-all"
                style={{
                    clipPath: "polygon(0 0, 100% 0, 100% 100%, 50% 72%, 0 100%)",
                }}
            />

            {/* Left Cover Preview Thumbnail */}
            <div className="w-10 sm:w-11 h-14 sm:h-15 shrink-0 rounded-sm overflow-hidden shadow-xs border border-[var(--color-border-subtle)] bg-[var(--color-surface-muted)] flex items-center justify-center">
                <TheoremBookCover
                    title={source?.title || "Book"}
                    author={source?.author}
                    coverUrl={source?.coverPath}
                    className="w-full h-full object-cover"
                />
            </div>

            {/* Middle Content */}
            <div className="min-w-0 flex-1 flex flex-col justify-center">
                <div className="flex items-center gap-2">
                    <h4 className="font-serif text-sm sm:text-[15px] font-medium text-[color:var(--color-text-primary)] truncate group-hover:text-[color:var(--color-accent)] transition-colors">
                        <HighlightMatch text={bookmark.chapterTitle || source?.title || "Bookmark"} query={searchQuery} />
                    </h4>
                </div>

                <div className="text-xs text-[color:var(--color-text-secondary)] truncate flex items-center gap-1.5 mt-0.5">
                    <span className="truncate font-sans">
                        <HighlightMatch text={source?.title || "Unknown source"} query={searchQuery} />
                    </span>
                    {source?.author && (
                        <>
                            <span className="text-[color:var(--color-text-muted)] select-none">·</span>
                            <span className="text-[color:var(--color-text-muted)] truncate font-sans">
                                <HighlightMatch text={source.author} query={searchQuery} />
                            </span>
                        </>
                    )}
                </div>

                {/* Badge row */}
                <div className="flex items-center gap-2 mt-1.5 min-w-0">
                    <span className="inline-flex items-center gap-1 font-mono text-[10px] text-[color:var(--color-text-secondary)] px-2 py-0.5 rounded bg-[var(--color-surface-muted)] border border-[var(--color-border-subtle)] shrink-0">
                        <Bookmark className="w-2.5 h-2.5 text-[color:var(--color-accent)] fill-current" />
                        <span>{position || "Bookmarked position"}</span>
                    </span>

                    <span className="font-mono text-[10px] text-[color:var(--color-text-muted)] shrink-0">
                        {dateLabel}
                    </span>

                    {bookmark.noteContent && (
                        <span className="text-[11px] font-sans text-[color:var(--color-text-muted)] italic truncate hidden md:inline">
                            “{bookmark.noteContent}”
                        </span>
                    )}
                </div>
            </div>

            {/* Right Actions */}
            <div className="flex items-center gap-2 shrink-0">
                <button
                    type="button"
                    onClick={(e) => {
                        e.stopPropagation();
                        goTo();
                    }}
                    className="hidden sm:inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-sans font-medium text-[color:var(--color-accent)] bg-[var(--color-surface-muted)] hover:bg-[var(--color-accent)] hover:text-white rounded-lg border border-[var(--color-border)] hover:border-transparent transition-all shrink-0 cursor-pointer touch-manipulation shadow-2xs"
                >
                    <span>Jump to Page</span>
                    <ArrowUpRight className="w-3.5 h-3.5" />
                </button>

                <div
                    className="relative"
                    onPointerDownCapture={() => {
                        pointerInsideRef.current = true;
                    }}
                >
                    <button
                        type="button"
                        onClick={(e) => {
                            e.stopPropagation();
                            onMenuOpenChange(menuOpen ? null : bookmark.id);
                        }}
                        aria-label="Bookmark options"
                        aria-haspopup="menu"
                        aria-expanded={menuOpen}
                        className="p-1.5 rounded-md text-[color:var(--color-text-muted)] hover:text-[color:var(--color-text-primary)] hover:bg-[var(--color-surface-muted)] transition-colors cursor-pointer"
                    >
                        <MoreVertical className="w-4 h-4" />
                    </button>

                    {menuOpen && (
                        <div
                            role="menu"
                            className="absolute right-0 top-full z-30 mt-1 w-36 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] py-1 shadow-lg"
                        >
                            <button
                                role="menuitem"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onMenuOpenChange(null);
                                    goTo();
                                }}
                                className="w-full text-left px-3 py-1.5 font-sans text-xs text-[color:var(--color-text-primary)] hover:bg-[var(--color-surface-muted)] flex items-center gap-2 cursor-pointer"
                            >
                                <ArrowUpRight className="w-3.5 h-3.5 text-[color:var(--color-accent)]" />
                                <span>{isArticle ? "Open article" : "Go to page"}</span>
                            </button>
                            <button
                                role="menuitem"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onMenuOpenChange(null);
                                    onDelete(bookmark.id);
                                }}
                                className="w-full text-left px-3 py-1.5 font-sans text-xs text-[color:var(--color-error)] hover:bg-[var(--color-surface-muted)] flex items-center gap-2 cursor-pointer"
                            >
                                <Trash2 className="w-3.5 h-3.5" />
                                <span>Delete</span>
                            </button>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
});

/**
 * The Workbench's Bookmarks tab. Bookmarks are annotations like highlights and notes, so they
 * live on the Workbench page under its title; `tabs` is the Workbench's own tab row, laid out
 * with this tab's filters the way the other tabs lay out theirs.
 */
export function BookmarksPanel({
    tabs,
}: {
    tabs: ReactNode;
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
    const listRef = useRef<HTMLDivElement>(null);

    // Derive lookup from bookmark bookIds only — avoids subscribing to the
    // entire books array which re-renders on every progress tick.
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
            primary: joinFields(bookmark.chapterTitle, bookmark.selectedText),
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

    const bookmarksVirtualizer = useVirtualizer({
        count: filteredBookmarks.length,
        getScrollElement: useCallback(() => document.getElementById('app-main'), []),
        estimateSize: useCallback(() => BOOKMARK_TOTAL_ROW_HEIGHT, []),
        getItemKey: useCallback((index: number) => filteredBookmarks[index]?.id ?? String(index), [filteredBookmarks]),
        overscan: 5,
    });

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
                    description="0 bookmarks across 0 sources"
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
                description={`${filteredBookmarks.length} ${filteredBookmarks.length === 1 ? "bookmark" : "bookmarks"} across ${bookTotal} ${bookTotal === 1 ? "source" : "sources"}`}
            />

            <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                {tabs}

                <div className="flex items-center justify-end gap-2">
                    <button
                        type="button"
                        onClick={() => setViewMode((prev) => (prev === "list" ? "cards" : "list"))}
                        className="inline-flex h-8 w-8 !p-0 shrink-0 items-center justify-center border border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-muted)] text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)] transition-colors touch-manipulation cursor-pointer"
                        title={viewMode === "list" ? "Cards view" : "List view"}
                        aria-label={viewMode === "list" ? "Cards view" : "List view"}
                    >
                        {viewMode === "list" ? <Layers className="w-4 h-4 shrink-0" /> : <List className="w-4 h-4 shrink-0" />}
                    </button>

                    <div className="shrink-0">
                        <Dropdown
                            value={sortBy}
                            onChange={(value) => setSortBy(value as typeof sortBy)}
                            size="sm"
                            align="right"
                            className="h-8 !w-auto min-w-[115px] sm:min-w-[130px] !border !border-[var(--color-border)] !text-xs !py-0 !px-2.5 font-sans"
                            options={[
                                { value: "newest", label: "Newest First" },
                                { value: "oldest", label: "Oldest First" },
                                { value: "book", label: "By Book" },
                            ]}
                        />
                    </div>
                </div>
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
                                    height: `${BOOKMARK_ROW_HEIGHT}px`,
                                    transform: `translateY(${virtualRow.start}px)`,
                                    zIndex: menuOpenId === bookmark.id ? 30 : undefined,
                                }}
                            >
                                <BookmarkCard
                                    bookmark={bookmark}
                                    source={sourceLookup.get(bookmark.bookId)}
                                    menuOpen={menuOpenId === bookmark.id}
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
