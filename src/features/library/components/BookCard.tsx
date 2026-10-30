import { memo, useEffect, useMemo, useRef } from "react";
import {
    Heart, Trash2, Star, Check, Headphones, MoreHorizontal, Info, BookMarked, BookOpen,
    Download, CheckSquare, CheckCheck, RotateCcw, CloudOff, Pencil, ExternalLink,
} from "lucide-react";
import { cn, normalizeAuthor, formatProgress, formatFileSize, formatRelativeDate } from "../../../core/lib/utils";
import { toast } from "sonner";
import { isTauri, isTauriDesktop } from "../../../core/lib/env";
import { useMediaQuery } from "../../../core/lib/use-media-query";
import { useLibraryStore, useUIStore } from "../../../core/store";
import type { Book, LibraryViewMode } from "../../../core/types";
import { LIBRARY_LIST_ROW_HEIGHT } from "../row-height";
import { attachAudiobookToBook } from "../audiobook-attach";
import { ContextMenu, TheoremBookCover, HighlightMatch } from "../../../ui";
import type { ContextMenuItem } from "../../../ui";

/** Below this width a context-menu submenu has no room, so it opens as an action sheet. */
const WIDE_VIEWPORT_MEDIA_QUERY = "(min-width: 640px)";

/** True when the book has been finished (marked read). */
export function isBookMarkedRead(book: { completedAt?: string | Date }): boolean {
    return !!book.completedAt;
}

/** Removes whitespace runs so metadata comparisons are stable. */
export function normalizeMetadataText(value: string | undefined): string {
    return (value || "").replace(/\s+/g, " ").trim();
}

export const BookCard = memo(function BookCard({
    book,
    viewMode,
    onOpenBook,
    onToggleFavorite,
    onDeleteBook,
    onShowInfo,
    onAddToShelf,
    onRename,
    onExport,
    renameMenuLabel,
    onMarkAsRead,
    onMarkAsUnread,
    isSelecting,
    isSelected,
    onToggleSelect,
    onStartSelect,
    titleHighlightIndices,
    authorHighlightIndices,
}: {
    book: Book;
    viewMode: LibraryViewMode;
    onOpenBook: (book: Book) => void;
    onToggleFavorite: (bookId: string) => void;
    onDeleteBook: (bookId: string) => void;
    onShowInfo: (book: Book) => void;
    onAddToShelf: (bookId: string) => void;
    onRename: (book: Book) => void;
    onExport: (book: Book) => void;
    renameMenuLabel?: string;
    onMarkAsRead: (bookId: string) => void;
    onMarkAsUnread: (bookId: string) => void;
    isSelecting?: boolean;
    isSelected?: boolean;
    onToggleSelect?: (bookId: string, event?: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) => void;
    onStartSelect?: (bookId: string) => void;
    titleHighlightIndices?: number[];
    authorHighlightIndices?: number[];
}) {
    const clickTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const clickCountRef = useRef(0);
    const isCompleted = isBookMarkedRead(book);

    const collections = useLibraryStore((state) => state.collections);
    const collectionSets = useMemo(() => collections.map(c => ({ ...c, bookIdSet: new Set(c.bookIds) })), [collections]);
    const bookShelves = collectionSets.filter((c) => c.bookIdSet.has(book.id));

    // Phones open nested groups in place instead of as a flyout; see the "more"
    // entry in contextMenuItems. Resolved with matchMedia rather than a CSS class
    // so the branch is deterministic and survives rotation/resize.
    const isWideViewport = useMediaQuery(WIDE_VIEWPORT_MEDIA_QUERY);

    const handleCardClick = (event?: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) => {
        if (isSelecting && onToggleSelect) {
            onToggleSelect(book.id, event);
            return;
        }
        if ((event?.ctrlKey || event?.metaKey) && (onStartSelect || onToggleSelect)) {
            if (onStartSelect) onStartSelect(book.id);
            else onToggleSelect?.(book.id);
            return;
        }
        clickCountRef.current += 1;

        if (clickCountRef.current === 1) {
            clickTimeoutRef.current = setTimeout(() => {
                if (clickCountRef.current === 1) {
                    onOpenBook(book);
                }
                clickCountRef.current = 0;
            }, 250);
        } else if (clickCountRef.current === 2) {
            if (clickTimeoutRef.current) {
                clearTimeout(clickTimeoutRef.current);
            }
            onToggleFavorite(book.id);
            clickCountRef.current = 0;
        }
    };

    useEffect(() => {
        if (clickTimeoutRef.current) clearTimeout(clickTimeoutRef.current);
        clickCountRef.current = 0;
        return () => { if (clickTimeoutRef.current) clearTimeout(clickTimeoutRef.current); };
    }, [isSelecting]);

    const selectionIndicator = isSelecting ? (
        <span aria-hidden="true" className={cn("flex h-6 w-6 shrink-0 items-center justify-center border border-[var(--color-border)]",
            isSelected ? "bg-[var(--color-accent)] text-[color:var(--color-accent-contrast)]" : "bg-[var(--color-surface)]")}>
            {isSelected && <Check className="h-4 w-4" />}
        </span>
    ) : null;

    // Kept to a fixed, short list: the previous menu emitted one "Remove from X"
    // row per shelf, so a book on six shelves showed 17 rows and overflowed a phone
    // screen under the bottom bar. Shelf membership now lives in the single
    // "Shelves…" dialog (which both adds and removes), and the rare actions sit
    // behind "More…".
    const moreItems: ContextMenuItem[] = [
        {
            id: "edit-info",
            label: renameMenuLabel ?? "Edit Info",
            icon: <Pencil className="w-4 h-4" />,
            onClick: () => onRename(book),
        },
        {
            id: "export",
            label: "Export",
            icon: <Download className="w-4 h-4" />,
            onClick: () => onExport(book),
        },
        ...(isTauriDesktop() ? [{
            id: "open-new-window",
            label: "Open in New Window",
            icon: <ExternalLink className="w-4 h-4" />,
            onClick: () => {
                import("@tauri-apps/api/core").then(({ invoke }) => {
                    invoke("open_book_in_new_window", { bookId: book.id, title: book.title }).catch((err) => {
                        toast.error(`Failed to open window: ${err}`);
                    });
                });
            },
        }] : []),
        ...(isTauri() ? [{
            id: "audiobook",
            label: book.audioTrack ? "Detach Audiobook" : "Attach Audiobook...",
            icon: <Headphones className={cn("w-4 h-4", book.audioTrack && "text-[color:var(--color-accent)]")} />,
            onClick: () => {
                if (book.audioTrack) {
                    useLibraryStore.getState().removeAudiobook(book.id);
                    toast.success("Audiobook detached");
                } else {
                    void attachAudiobookToBook(book);
                }
            },
        }] : []),
        ...(book.syncedWithoutFile ? [{
            id: "download-file",
            label: "Download File",
            icon: <Download className="w-4 h-4" />,
            onClick: () => {
                useUIStore.getState().setDownloadingBook(book.id);
                import("../../../core/lib/sync-orchestrator").then(({ downloadBookOnDemand }) => {
                    downloadBookOnDemand(book.id).catch(() => {});
                });
            },
        }] : []),
    ];

    const contextMenuItems: ContextMenuItem[] = [
        {
            id: "select",
            label: isSelecting && isSelected ? "Deselect" : "Select",
            icon: <CheckSquare className="w-4 h-4" />,
            onClick: () => {
                if (!isSelecting) {
                    if (onStartSelect) onStartSelect(book.id);
                    else onToggleSelect?.(book.id);
                } else {
                    onToggleSelect?.(book.id);
                }
            },
        },
        {
            id: "open",
            label: "Open Book",
            icon: <BookOpen className="w-4 h-4" />,
            shortcut: "Enter",
            onClick: () => onOpenBook(book),
        },
        {
            id: "favorite",
            label: book.isFavorite ? "Remove from Favorites" : "Add to Favorites",
            icon: <Heart className={cn("w-4 h-4", book.isFavorite && "fill-current")} />,
            onClick: () => onToggleFavorite(book.id),
        },
        {
            id: isCompleted ? "mark-as-unread" : "mark-as-read",
            label: isCompleted ? "Mark Unread" : "Mark Read",
            icon: isCompleted ? <RotateCcw className="w-4 h-4" /> : <CheckCheck className="w-4 h-4" />,
            onClick: () => {
                if (isCompleted) {
                    onMarkAsUnread(book.id);
                    return;
                }
                onMarkAsRead(book.id);
            },
        },
        {
            id: "shelves",
            // Shows current membership and toggles it, so removing a book from a
            // shelf is possible on a phone without a right-click.
            label: bookShelves.length > 0
                ? `Shelves… (${bookShelves.length})`
                : "Add to Shelf…",
            icon: <BookMarked className="w-4 h-4" />,
            onClick: () => onAddToShelf(book.id),
        },
        {
            id: "info",
            label: "Book Info",
            icon: <Info className="w-4 h-4" />,
            onClick: () => onShowInfo(book),
        },
        {
            id: "separator1",
            label: "",
            separator: true,
        },
        {
            id: "delete",
            label: "Delete from Library",
            icon: <Trash2 className="w-4 h-4" />,
            danger: true,
            onClick: () => onDeleteBook(book.id),
        },
        {
            id: "separator2",
            label: "",
            separator: true,
        },
        {
            id: "more",
            label: "More…",
            icon: <MoreHorizontal className="w-4 h-4" />,
            // A flyout submenu cannot fit a phone: the menu is 180-280px and the
            // submenu needs another 180-280px beside it, which overflows a ~390px
            // viewport (or flips over the parent menu). So on phones the ContextMenu
            // opens this group in place — the same panel swaps contents and offers
            // Back — which keeps the menu you long-pressed instead of becoming a
            // separate dialog. Collision tuning cannot fix horizontal overflow.
            items: moreItems,
        },
    ];

    // Phone presentation of the submenu's contents. Same items, so both paths
    // stay in sync; rendered as a full-width sheet that cannot overflow.
    if (viewMode === "grid") {
        return (
            <ContextMenu items={contextMenuItems} drilldown={!isWideViewport}>
                <div
                    className="group flex flex-col text-left w-full select-none"
                    role={isSelecting ? "checkbox" : "button"}
                    aria-checked={isSelecting ? !!isSelected : undefined}
                    tabIndex={0}
                    aria-label={`${isSelecting ? "Select" : "Open"} ${book.title}`}
                    onClick={handleCardClick}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            if (isSelecting) onToggleSelect?.(book.id, e);
                            else onOpenBook(book);
                        }
                    }}
                >
                    
                    <div
                        className={cn(
                            "relative aspect-[2/3] bg-[var(--color-surface-muted)] mb-3 overflow-hidden",
                            "border",
                            isSelected
                                ? "border-[var(--color-accent)] ring-1 ring-[var(--color-accent)]"
                                : "border-[var(--color-border)]",
                            "transition-colors duration-300 group-hover:-translate-y-1 cursor-pointer"
                        )}
                    >
                        <TheoremBookCover
                            title={book.title}
                            author={book.author}
                            coverUrl={book.coverPath}
                        />

                        {isSelecting && (
                            <div aria-hidden="true" data-selection-indicator className={cn(
                                "absolute top-2 left-2 z-10 flex h-5 w-5 items-center justify-center transition-[background-color,color,transform,box-shadow] duration-200",
                                "ring-1",
                                isSelected
                                    ? "bg-[var(--color-accent)] text-[color:var(--color-accent-contrast)] ring-[var(--color-accent)] scale-100"
                                    : "bg-black/40 text-white ring-white/70 scale-90"
                            )}>
                                {isSelected && <Check className="h-3 w-3" strokeWidth={3} />}
                            </div>
                        )}

                        {book.progress > 0 && (
                            <div className="absolute bottom-0 left-0 right-0 h-1 bg-[var(--color-overlay-subtle)] z-10">
                                <div
                                    className="h-full bg-[var(--color-accent)] transition-colors duration-500"
                                    style={{ width: `${book.progress * 100}%` }}
                                />
                            </div>
                        )}

                        <div
                            className={cn(
                                "absolute top-2 right-2 w-6 h-6 flex items-center justify-center transition-colors duration-300 pointer-events-none z-10",
                                book.isFavorite
                                    ? "bg-[var(--color-accent)] text-[color:var(--color-accent-contrast)] scale-100"
                                    : "bg-white/90 text-[color:var(--color-text-secondary)] scale-0 opacity-0 group-hover:scale-100 group-hover:opacity-100"
                            )}
                        >
                            <Heart className={cn("w-3 h-3", book.isFavorite ? "fill-current" : "")} />
                        </div>

                        {book.syncedWithoutFile && !isSelecting && (
                            <div className="absolute top-2 left-2 w-6 h-6 flex items-center justify-center text-white pointer-events-none z-10"style={{ backgroundColor: 'color-mix(in srgb, var(--color-warning) 90%, transparent)' }} title="Book file not available locally">
                                <CloudOff className="w-3 h-3" />
                            </div>
                        )}
                    </div>

                    <div className="px-0.5">
                        <h3 className="text-[11px] text-[color:var(--color-text-primary)] line-clamp-3 mb-0.5 transition-colors group-hover:text-[color:var(--color-accent)] break-words">
                            <HighlightMatch text={book.title} indices={titleHighlightIndices} />
                        </h3>
                        <p className="text-[10px] text-[color:var(--color-text-secondary)] line-clamp-2 opacity-60">
                            <HighlightMatch text={normalizeAuthor(book.author) || "Unknown Author"} indices={authorHighlightIndices} />
                        </p>
                    </div>
                </div>
            </ContextMenu>
        );
    }

    if (viewMode === "list") {
        return (
            <ContextMenu items={contextMenuItems} drilldown={!isWideViewport}>
                <div
                    // Fixed height shared with the row virtualizer's estimate.
                    // Rows are absolutely positioned from that estimate, so an
                    // auto-height row taller than the estimate overlaps the next
                    // row — which is what made list view collide on phones.
                    className="group flex w-full items-center gap-3 p-3 transition-colors hover:bg-[var(--color-surface-muted)] sm:gap-4 cursor-pointer select-none"
                    style={{ height: `${LIBRARY_LIST_ROW_HEIGHT}px` }}
                    role={isSelecting ? "checkbox" : "button"}
                    aria-checked={isSelecting ? !!isSelected : undefined}
                    tabIndex={0}
                    aria-label={`${isSelecting ? "Select" : "Open"} ${book.title}`}
                    onClick={handleCardClick}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            if (isSelecting) onToggleSelect?.(book.id, e);
                            else onOpenBook(book);
                        }
                    }}
                >
                    
                    {selectionIndicator}
                    <div className={cn(
                        "relative w-12 h-16 flex-shrink-0 bg-[var(--color-surface-muted)] overflow-hidden",
                        "border",
                        isSelected
                            ? "border-[var(--color-accent)] ring-1 ring-[var(--color-accent)]"
                            : "border-[var(--color-border)]"
                    )}>
                        <TheoremBookCover
                            title={book.title}
                            author={book.author}
                            coverUrl={book.coverPath}
                        />
                        {isSelecting && (
                            <div aria-hidden="true" data-selection-indicator className={cn(
                                "absolute top-1 left-1 z-10 flex h-5 w-5 items-center justify-center transition-[background-color,color,transform,box-shadow] duration-200",
                                "ring-1",
                                isSelected
                                    ? "bg-[var(--color-accent)] text-[color:var(--color-accent-contrast)] ring-[var(--color-accent)] scale-100"
                                    : "bg-black/40 text-white ring-white/70 scale-90"
                            )}>
                                {isSelected && <Check className="h-3 w-3" strokeWidth={3} />}
                            </div>
                        )}
                    </div>

                    <div className="flex-1 min-w-0 pr-2 sm:pr-4">
                        <h3 className="text-sm font-medium text-[color:var(--color-text-primary)] line-clamp-1 break-words transition-colors group-hover:text-[color:var(--color-accent)]">
                            <HighlightMatch text={book.title} indices={titleHighlightIndices} />
                        </h3>
                        <div className="flex items-center gap-1.5 text-xs text-[color:var(--color-text-secondary)] line-clamp-1 mt-0.5">
                            <span className="truncate">
                                <HighlightMatch text={normalizeAuthor(book.author) || "Unknown Author"} indices={authorHighlightIndices} />
                            </span>
                            {book.series && (
                                <>
                                    <span className="text-[color:var(--color-text-muted)] shrink-0">·</span>
                                    <span className="text-[color:var(--color-text-muted)] italic truncate">
                                        {book.series}{book.seriesIndex != null ? ` #${book.seriesIndex}` : ""}
                                    </span>
                                </>
                            )}
                        </div>
                        <div className="flex items-center gap-2 mt-1.5">
                            {book.isFavorite && (
                                <div className="text-[color:var(--color-accent)] pointer-events-none">
                                    <Heart className="w-3 h-3 fill-current" />
                                </div>
                            )}
                            {book.rating && (
                                <div className="flex items-center gap-0.5">
                                    <Star className="w-3 h-3 text-[color:var(--color-warning)] fill-current" />
                                    <span className="text-[var(--font-size-3xs)] text-[color:var(--color-text-muted)]">{book.rating}</span>
                                </div>
                            )}
                            {book.syncedWithoutFile && !isSelecting && (
                                <div className="flex items-center gap-0.5 text-[color:var(--color-warning)]" title="Book file not available locally">
                                    <CloudOff className="w-3 h-3" />
                                    <span className="text-[var(--font-size-3xs)]">No file</span>
                                </div>
                            )}
                            <span className="sm:hidden border border-[var(--color-border)] bg-[var(--color-surface)] px-1 py-0.5 font-mono text-[9px] uppercase tracking-wider text-[color:var(--color-text-secondary)]">
                                {book.format}
                            </span>
                        </div>
                    </div>

                    {/* Format and file size column (tablets & desktops) */}
                    <div className="hidden sm:flex flex-col items-center justify-center w-16 shrink-0 text-center">
                        <span className="border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-[color:var(--color-text-secondary)]">
                            {book.format}
                        </span>
                        {book.fileSize > 0 && (
                            <span className="text-[10px] text-[color:var(--color-text-muted)] mt-1 font-mono">
                                {formatFileSize(book.fileSize)}
                            </span>
                        )}
                    </div>

                    {/* Last read / date added column (desktops) */}
                    <div className="hidden md:flex flex-col items-end justify-center w-28 shrink-0 text-right pr-2">
                        {book.lastReadAt ? (
                            <>
                                <span className="text-xs font-mono text-[color:var(--color-text-secondary)]">
                                    {formatRelativeDate(book.lastReadAt)}
                                </span>
                                <span className="text-[10px] text-[color:var(--color-text-muted)] mt-0.5">Last read</span>
                            </>
                        ) : (
                            <>
                                <span className="text-xs font-mono text-[color:var(--color-text-muted)]">
                                    {formatRelativeDate(book.addedAt)}
                                </span>
                                <span className="text-[10px] text-[color:var(--color-text-muted)] mt-0.5">Added</span>
                            </>
                        )}
                    </div>

                    <div className="shrink-0 text-right">
                        {book.progress > 0 ? (
                            <div className="flex flex-col items-end">
                                <span className="font-mono text-xs text-[color:var(--color-text-primary)]">
                                    {formatProgress(book.progress)}
                                </span>
                                <div className="w-16 sm:w-20 h-1 bg-[var(--color-surface-variant)] mt-1 overflow-hidden">
                                    <div
                                        className="h-full bg-[var(--color-accent)] transition-[width]"
                                        style={{ width: `${Math.min(100, Math.max(0, Math.round(book.progress * 100)))}%` }}
                                    />
                                </div>
                                <span className="text-[10px] text-[color:var(--color-text-muted)] font-mono md:hidden mt-1">
                                    {book.lastReadAt ? formatRelativeDate(book.lastReadAt) : "Started"}
                                </span>
                            </div>
                        ) : (
                            <div className="flex flex-col items-end">
                                <span className="text-xs text-[color:var(--color-text-muted)]">Not started</span>
                                <div className="w-16 sm:w-20 h-1 bg-[var(--color-surface-variant)] mt-1 opacity-30" />
                                <span className="text-[10px] text-[color:var(--color-text-muted)] font-mono md:hidden mt-1">
                                    {book.addedAt ? formatRelativeDate(book.addedAt) : ""}
                                </span>
                            </div>
                        )}
                    </div>
                </div>
            </ContextMenu>
        );
    }

    return (
        <>
        <ContextMenu items={contextMenuItems} drilldown={!isWideViewport}>
            <div
                onClick={handleCardClick}
                className={cn(
                    "group relative aspect-[2/3] bg-[var(--color-surface-muted)] overflow-hidden border transition-colors duration-200 w-full cursor-pointer select-none",
                    isSelected
                        ? "border-[var(--color-accent)] ring-1 ring-[var(--color-accent)]"
                        : "border-[var(--color-border)]"
                )}
                role={isSelecting ? "checkbox" : "button"}
                aria-checked={isSelecting ? !!isSelected : undefined}
                tabIndex={0}
                aria-label={`${isSelecting ? "Select" : "Open"} ${book.title}`}
                onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        if (isSelecting) onToggleSelect?.(book.id, e);
                        else onOpenBook(book);
                    }
                }}
            >
                {isSelecting && <span className="absolute top-1 left-1 z-20">{selectionIndicator}</span>}
                <TheoremBookCover
                    title={book.title}
                    author={book.author}
                    coverUrl={book.coverPath}
                />

                {isSelecting && (
                    <div aria-hidden="true" data-selection-indicator className={cn(
                        "absolute top-1 left-1 z-10 flex h-5 w-5 items-center justify-center transition-[background-color,color,transform,box-shadow] duration-200",
                        "ring-1",
                        isSelected
                            ? "bg-[var(--color-accent)] text-[color:var(--color-accent-contrast)] ring-[var(--color-accent)] scale-100"
                            : "bg-black/40 text-white ring-white/70 scale-90"
                    )}>
                        {isSelected && <Check className="h-3 w-3" strokeWidth={3} />}
                    </div>
                )}

                {book.progress > 0 && (
                    <div className="absolute bottom-0 left-0 right-0 h-1 bg-[var(--color-overlay-subtle)] z-10">
                        <div
                            className="h-full bg-[var(--color-accent)]"
                            style={{ width: `${book.progress * 100}%` }}
                        />
                    </div>
                )}

                <div
                    className={cn(
                        "absolute top-1 right-1 w-5 h-5 flex items-center justify-center transition-colors pointer-events-none z-10",
                        book.isFavorite
                            ? "bg-[var(--color-accent)] text-[color:var(--color-accent-contrast)]"
                            : "opacity-0"
                    )}
                >
                    <Heart className={cn("w-2.5 h-2.5 fill-current")} />
                </div>

                {book.syncedWithoutFile && !isSelecting && (
                    <div className="absolute top-1 left-1 w-5 h-5 flex items-center justify-center text-white pointer-events-none z-10"style={{ backgroundColor: 'color-mix(in srgb, var(--color-warning) 90%, transparent)' }} title="Book file not available locally">
                        <CloudOff className="w-2.5 h-2.5" />
                    </div>
                )}
            </div>
        </ContextMenu>
        </>
    );
});


export const MemoizedBookCard = memo(BookCard, (prev, next) => {
    return prev.book.id === next.book.id &&
        prev.book.progress === next.book.progress &&
        prev.book.isFavorite === next.book.isFavorite &&
        prev.book.coverPath === next.book.coverPath &&
        prev.book.title === next.book.title &&
        prev.book.author === next.book.author &&
        prev.book.syncedWithoutFile === next.book.syncedWithoutFile &&
        prev.book.audioTrack === next.book.audioTrack &&
        prev.book.rating === next.book.rating &&
        prev.viewMode === next.viewMode &&
        prev.isSelecting === next.isSelecting &&
        prev.isSelected === next.isSelected &&
        prev.titleHighlightIndices === next.titleHighlightIndices &&
        prev.authorHighlightIndices === next.authorHighlightIndices;
});
