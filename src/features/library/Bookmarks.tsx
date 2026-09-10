
import { useState, useMemo, useCallback, memo } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { rankByFuzzyQuery } from "../../core/lib/search/fuzzy";
import { useLibraryStore, useUIStore } from "../../core/store";
import { Dropdown, ConfirmDialog } from "../../ui";
import {
    Bookmark,
    MoreVertical,
} from "lucide-react";

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
    bookmark: {
        id: string;
        bookId: string;
        location: string;
        selectedText?: string;
        noteContent?: string;
        createdAt: Date;
    };
    book: {
        title: string;
        author: string;
        coverPath?: string;
    } | undefined;
    onDelete: (id: string) => void;
    onGoToBookmark: (bookId: string, location: string) => void;
}

const BookmarkCard = memo(function BookmarkCard({ bookmark, book, onDelete, onGoToBookmark }: BookmarkCardProps) {
    const [showMenu, setShowMenu] = useState(false);

    return (
        <div className="group border border-[var(--color-border)] bg-[var(--color-surface)] p-5 transition-colors hover:border-[var(--color-accent)]">
            <div className="flex items-start justify-between mb-4">
                <div className="min-w-0">
                    <div className="flex items-center gap-2">
                        <span className="font-sans text-[11px] font-semibold text-[color:var(--color-text-secondary)]">
                            BOOKMARK
                        </span>
                        <span className="font-sans text-[11px] text-[color:var(--color-text-secondary)]">
                            {new Date(bookmark.createdAt).toISOString().slice(0, 10)}
                        </span>
                    </div>
                    <div className="mt-2 font-sans text-[11px] text-[color:var(--color-text-secondary)]">
                        {book?.title || "Unknown source"} | {book?.author || "Unknown author"}
                    </div>
                </div>
                <div className="relative">
                    <button
                        onClick={() => setShowMenu(!showMenu)}
                        className="border border-[var(--color-border)] p-1.5 text-[color:var(--color-text-muted)] transition-opacity hover:text-[color:var(--color-text-primary)]"
                    >
                        <MoreVertical className="w-4 h-4" />
                    </button>
                    {showMenu && (
                        <>
                            <div className="fixed inset-0 z-10" role="button" tabIndex={-1} aria-label="Close menu" onClick={() => setShowMenu(false)} />
                            <div className="absolute right-0 top-full z-20 mt-1 w-40 border border-[var(--color-border)] bg-[var(--color-surface)] py-1">
                                <button
                                    onClick={() => { book && onGoToBookmark(bookmark.bookId, bookmark.location); setShowMenu(false); }}
                                    className="w-full whitespace-nowrap px-3 py-2 text-left font-sans text-[11px] font-medium text-[color:var(--color-text-primary)] hover:bg-[var(--color-surface-muted)]"
                                >
                                    Go to bookmark
                                </button>
                                <button
                                    onClick={async () => { await onDelete(bookmark.id); setShowMenu(false); }}
                                    className="w-full whitespace-nowrap px-3 py-2 text-left font-sans text-[11px] font-medium text-[color:var(--color-error)] hover:bg-[var(--color-surface-muted)]"
                                >
                                    Delete
                                </button>
                            </div>
                        </>
                    )}
                </div>
            </div>

            <div className="space-y-3">
                {bookmark.selectedText && (
                    <blockquote className="pl-3 font-serif text-[17px] leading-relaxed text-[color:var(--color-text-primary)]">
                        {bookmark.selectedText}
                    </blockquote>
                )}
                {bookmark.noteContent && (
                    <p className="font-serif text-[16px] leading-relaxed text-[color:var(--color-text-primary)] whitespace-pre-wrap">
                        {bookmark.noteContent}
                    </p>
                )}
            </div>
        </div>
    );
});

export function BookmarksPage() {
    const annotations = useLibraryStore((state) => state.annotations);
    const books = useLibraryStore((state) => state.books);
    const removeAnnotation = useLibraryStore((state) => state.removeAnnotation);
    const setRoute = useUIStore((state) => state.setRoute);
    const setPendingReaderLocation = useUIStore((state) => state.setPendingReaderLocation);
    const searchQuery = useUIStore((state) => state.searchQuery);
    const [sortBy, setSortBy] = useState<"newest" | "oldest" | "book">("newest");
    const bookLookup = useMemo(
        () => new Map(books.map((book) => [book.id, book])),
        [books],
    );

    const bookmarks = useMemo(() => {
        return annotations.filter((a) => a.type === "bookmark");
    }, [annotations]);

    const filteredBookmarks = useMemo(() => {
        let filtered = [...bookmarks];

        if (searchQuery.trim()) {
            const rankedBookmarks = rankByFuzzyQuery(
                filtered.map((bookmark) => {
                    const book = bookLookup.get(bookmark.bookId);
                    return {
                        bookmark,
                        selectedText: bookmark.selectedText || "",
                        bookTitle: book?.title || "",
                        bookAuthor: book?.author || "",
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

        filtered.sort((a, b) => {
            switch (sortBy) {
                case "newest": {
                    const dateA = a.createdAt instanceof Date ? a.createdAt : new Date(a.createdAt);
                    const dateB = b.createdAt instanceof Date ? b.createdAt : new Date(b.createdAt);
                    return dateB.getTime() - dateA.getTime();
                }
                case "oldest": {
                    const dateA = a.createdAt instanceof Date ? a.createdAt : new Date(a.createdAt);
                    const dateB = b.createdAt instanceof Date ? b.createdAt : new Date(b.createdAt);
                    return dateA.getTime() - dateB.getTime();
                }
                case "book":
                    const bookA = bookLookup.get(a.bookId)?.title || "";
                    const bookB = bookLookup.get(b.bookId)?.title || "";
                    return bookA.localeCompare(bookB);
                default:
                    return 0;
            }
        });

        return filtered;
    }, [bookmarks, searchQuery, sortBy, bookLookup]);

    const bookmarksVirtualizer = useVirtualizer({
        count: filteredBookmarks.length,
        getScrollElement: useCallback(() => document.getElementById('app-main'), []),
        estimateSize: useCallback(() => 100, []),
        overscan: 3,
        measureElement: (el) => el.getBoundingClientRect().height,
    });

    const [deleteBookmarkId, setDeleteBookmarkId] = useState<string | null>(null);

    const handleDelete = (id: string) => {
        setDeleteBookmarkId(id);
    };

    const handleDeleteConfirm = () => {
        if (deleteBookmarkId) {
            removeAnnotation(deleteBookmarkId);
            setDeleteBookmarkId(null);
        }
    };

    const handleGoToBookmark = (bookId: string, location: string) => {
        setPendingReaderLocation(location);
        setRoute("reader", bookId);
    };

    const getBookInfo = (bookId: string) => {
        return bookLookup.get(bookId);
    };

    if (bookmarks.length === 0) {
        return (
            <div className="mx-auto w-full max-w-[var(--layout-content-max-width)] px-4 py-6 pb-0 sm:px-6 lg:px-8 lg:py-8">
                <EmptyBookmarks />
            </div>
        );
    }

    return (
        <div className="mx-auto w-full max-w-[var(--layout-content-max-width)] px-4 py-6 sm:px-6 lg:px-8 lg:py-8 animate-fade-in">
            
            <div className="flex items-start justify-between mb-10">
                <div>
                    <h1 className="m-0 font-sans text-[1.45rem] font-semibold uppercase tracking-[0.12em] leading-[1.1] text-[color:var(--color-text-primary)] sm:text-[1.6rem]">
                        Bookmarks
                    </h1>
                    <p className="mt-1 text-sm leading-relaxed text-[color:var(--color-text-secondary)]">
                        {filteredBookmarks.length} {filteredBookmarks.length === 1 ? "bookmark" : "bookmarks"} across{" "}
                        {new Set(filteredBookmarks.map((b) => b.bookId)).size} books
                    </p>
                </div>
            </div>

            <div className="flex items-center justify-between gap-4 mb-8">
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
                <div style={{ height: `${bookmarksVirtualizer.getTotalSize()}px`, position: "relative" }}>
                    <div style={{ paddingTop: `${bookmarksVirtualizer.getVirtualItems()[0]?.start ?? 0}px` }}>
                        {bookmarksVirtualizer.getVirtualItems().map((virtualRow) => (
                            <div key={virtualRow.key} data-index={virtualRow.index} ref={bookmarksVirtualizer.measureElement} className="pb-4">
                                <BookmarkCard
                                    bookmark={filteredBookmarks[virtualRow.index]}
                                    book={getBookInfo(filteredBookmarks[virtualRow.index].bookId)}
                                    onDelete={handleDelete}
                                    onGoToBookmark={handleGoToBookmark}
                                />
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}
