
import { useState, useCallback, useEffect, useRef, useMemo, memo } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn, normalizeFilePath, normalizeAuthor, formatProgress, formatFileSize, formatRelativeDate } from "../../core/lib/utils";
import { saveCoverImage, getBookData } from "../../core/lib/storage";
import { buildFallbackCoverSvg, shouldUseExtractedTitle, shouldUseExtractedAuthor } from "../../core/lib/cover-extractor";
import { ensureFilenameForFormat, extractFilenameFromPath, importBooksIncremental, pickAndImportBooksIncremental, scanFolderForBooks } from "../../core/lib/import";
import { pickLibraryFolderMobile, scanLibraryFolderMobile } from "../../core/lib/mobile-folder-scan";
import { isMobile, isTauri, isTauriDesktop } from "../../core/lib/env";
import { showOpenDirectoryDialog } from "../../core/lib/dialogs";
import { useLibraryStore, useUIStore, useSettingsStore } from "../../core/store";
import type { Book, BookAudioTrackFormat, Collection, LibraryViewMode, LibrarySortBy, LibrarySortOrder, LibraryStatusFilter } from "../../core/types";
import { FORMAT_DISPLAY_NAMES } from "../../core/types";
import {
    Plus, Filter, BookOpen, Loader2, FolderOpen, RefreshCw,
    Heart, Trash2, BookMarked, Info, LayoutGrid, List, Grid3X3, CheckCheck, RotateCcw,
    ChevronDown, Star, Check, CloudOff, Pencil, Download, ExternalLink, Headphones
} from "lucide-react";
import { ContextMenu, PageHeader, TheoremBookCover } from "../../ui";
import type { ContextMenuItem } from "../../ui";
import { Modal, ModalHeader, ModalBody, ModalFooter, ConfirmDialog, AlertDialog } from "../../ui";
import { getFilteredAndSortedBooks } from "./filtering";
import { useDebounce } from "../../core/lib/useDebounce";
import { sqliteSearchBooks } from "../../core/lib/sqlite-storage";
import { exportBook, exportBooks } from "../../core/lib/book-export";
import { EditBookModal } from "./components/modals/EditBookModal";
import { toast } from "sonner";

const viewModeIcons: Record<LibraryViewMode, React.ReactNode> = {
    grid: <LayoutGrid className="w-4 h-4" />,
    list: <List className="w-4 h-4" />,
    compact: <Grid3X3 className="w-4 h-4" />,
};

const TOOLBAR_BUTTON_BASE =
    "ui-btn disabled:opacity-50";
const TOOLBAR_BUTTON_PRIMARY =
    "ui-btn-primary disabled:opacity-50";
const TOOLBAR_ICON_BUTTON = "h-10 w-10 px-0";

type ExtractMetadataFn = typeof import("../../core/lib/cover-extractor").extractMetadata;

const IMPORT_METADATA_TIMEOUT_MS = isMobile() ? 9000 : 6000;
const IMPORT_COVER_TIMEOUT_MS = isMobile() ? 7000 : 4000;
const IMPORT_METADATA_QUEUE_CONCURRENCY = isMobile() ? 1 : 3;
let extractMetadataPromise: Promise<ExtractMetadataFn> | null = null;

async function getExtractMetadataFn(): Promise<ExtractMetadataFn> {
    if (!extractMetadataPromise) {
        extractMetadataPromise = import("../../core/lib/cover-extractor").then(
            (module) => module.extractMetadata,
        );
    }
    return extractMetadataPromise;
}

function normalizeMetadataText(value: string | undefined): string {
    return (value || "").replace(/\s+/g, " ").trim();
}

function isBookMarkedRead(book: Book): boolean {
    return !!book.completedAt;
}

function sanitizeHtml(html: string): string {
    return html
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
        .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
        .replace(/on\w+\s*=\s*"[^"]*"/gi, "")
        .replace(/on\w+\s*=\s*'[^']*'/gi, "");
}


interface AudiobookMetadataPayload {
    format: string;
    duration_sec: number;
    title: string | null;
    author: string | null;
    cover_data_url: string | null;
    chapters: { id: string; title: string; start_sec: number; end_sec: number }[];
}

async function attachAudiobookToBook(book: Book) {
    const { showOpenFileDialog } = await import("../../core/lib/dialogs");
    const path = await showOpenFileDialog({
        title: "Attach Audiobook",
        filters: [{ name: "Audiobook", extensions: ["m4b", "m4a", "mp3"] }],
    });
    if (typeof path !== "string" || !path) return;
    try {
        const { invoke } = await import("@tauri-apps/api/core");
        const meta = await invoke<AudiobookMetadataPayload>("extract_audiobook_metadata", { path });
        useLibraryStore.getState().attachAudiobook(book.id, {
            filePath: path,
            format: meta.format as BookAudioTrackFormat,
            durationSec: meta.duration_sec,
            currentPositionSec: 0,
            playbackSpeed: 1,
            chapters: meta.chapters.map((c) => ({
                id: c.id,
                title: c.title,
                startSec: c.start_sec,
                endSec: c.end_sec,
            })),
        });
        toast.success(`Audiobook attached to "${book.title}"`);
    } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
    }
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
    onToggleSelect?: (bookId: string) => void;
}) {
    const clickTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const clickCountRef = useRef(0);
    const isCompleted = isBookMarkedRead(book);

    const collections = useLibraryStore((state) => state.collections);
    const collectionSets = useMemo(() => collections.map(c => ({ ...c, bookIdSet: new Set(c.bookIds) })), [collections]);
    const bookShelves = collectionSets.filter((c) => c.bookIdSet.has(book.id));

    const handleCardClick = () => {
        if (isSelecting && onToggleSelect) {
            onToggleSelect(book.id);
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

    const contextMenuItems: ContextMenuItem[] = [
        {
            id: "open",
            label: "Open Book",
            icon: <BookOpen className="w-4 h-4" />,
            shortcut: "Enter",
            onClick: () => onOpenBook(book),
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
        {
            id: "favorite",
            label: book.isFavorite ? "Remove from Favorites" : "Add to Favorites",
            icon: <Heart className={cn("w-4 h-4", book.isFavorite && "fill-current")} />,
            onClick: () => onToggleFavorite(book.id),
        },
        {
            id: isCompleted ? "mark-as-unread" : "mark-as-read",
            label: isCompleted ? "Mark Unfinish" : "Mark Finish",
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
            id: "add-to-shelf",
            label: "Add to Shelf...",
            icon: <BookMarked className="w-4 h-4" />,
            onClick: () => onAddToShelf(book.id),
        },
        
        ...bookShelves.map((shelf) => ({
            id: `shelf-${shelf.id}`,
            label: `Remove from "${shelf.name}"`,
            icon: <BookMarked className="w-4 h-4" />,
            onClick: () => useLibraryStore.getState().removeBookFromCollection(book.id, shelf.id),
        })),
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
        {
            id: "separator1",
            label: "",
            separator: true,
        },
        {
            id: "info",
            label: "Book Info",
            icon: <Info className="w-4 h-4" />,
            onClick: () => onShowInfo(book),
        },
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
        {
            id: "separator2",
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
    ];

    if (viewMode === "grid") {
        return (
            <ContextMenu items={contextMenuItems}>
                <div
                    className="group flex flex-col text-left w-full select-none"
                    role="button"
                    tabIndex={0}
                    aria-label={`Open ${book.title}`}
                    onClick={handleCardClick}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            onOpenBook(book);
                        }
                    }}
                >
                    
                    <div
                        className={cn(
                            "relative aspect-[2/3] bg-[var(--color-surface-muted)] mb-3 overflow-hidden",
                            "border border-[var(--color-border)]",
                            "transition-colors duration-300 group-hover:shadow-lg group-hover:-translate-y-1 cursor-pointer"
                        )}
                    >
                        <TheoremBookCover
                            title={book.title}
                            author={book.author}
                            coverUrl={book.coverPath}
                        />

                        {isSelecting && (
                            <div className={cn(
                                "absolute top-2 left-2 w-6 h-6 flex items-center justify-center transition-colors duration-200 z-10",
                                isSelected
                                    ? "bg-[var(--color-accent)] text-[color:var(--color-accent-contrast)] scale-100"
                                    : "bg-white/80 text-[color:var(--color-text-secondary)] scale-100 border border-[var(--color-border)]"
                            )}>
                                {isSelected && <Check className="w-3.5 h-3.5" />}
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

                        {book.syncedWithoutFile && (
                            <div className="absolute top-2 left-2 w-6 h-6 flex items-center justify-center text-white rounded-sm pointer-events-none z-10" style={{ backgroundColor: 'color-mix(in srgb, var(--color-warning) 90%, transparent)' }} title="Book file not available locally">
                                <CloudOff className="w-3 h-3" />
                            </div>
                        )}
                    </div>

                    <div className="px-0.5">
                        <h3 className="font-bold text-[11px] uppercase tracking-wide text-[color:var(--color-text-primary)] line-clamp-3 mb-0.5 transition-colors group-hover:text-[color:var(--color-accent)] break-words">
                            {book.title}
                        </h3>
                        <p className="text-[10px] font-medium text-[color:var(--color-text-secondary)] line-clamp-2 opacity-60 uppercase tracking-tight">
                            {normalizeAuthor(book.author) || "Unknown Author"}
                        </p>
                    </div>
                </div>
            </ContextMenu>
        );
    }

    if (viewMode === "list") {
        return (
            <ContextMenu items={contextMenuItems}>
                <div
                    className="group flex w-full items-center gap-3 p-3 transition-colors hover:bg-[var(--color-surface-muted)] sm:gap-4 cursor-pointer select-none"
                    role="button"
                    tabIndex={0}
                    aria-label={`Open ${book.title}`}
                    onClick={handleCardClick}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            onOpenBook(book);
                        }
                    }}
                >
                    
                    <div className={cn(
                        "relative w-12 h-16 flex-shrink-0 bg-[var(--color-surface-muted)] overflow-hidden",
                        "border border-[var(--color-border)]"
                    )}>
                        <TheoremBookCover
                            title={book.title}
                            author={book.author}
                            coverUrl={book.coverPath}
                        />
                    </div>

                    <div className="flex-1 min-w-0">
                        <h3 className="font-medium text-sm text-[color:var(--color-text-primary)] line-clamp-2 break-words">
                            {book.title}
                        </h3>
                        <p className="text-xs text-[color:var(--color-text-secondary)] line-clamp-1">
                            {normalizeAuthor(book.author) || "Unknown Author"}
                        </p>
                        <div className="flex items-center gap-2 mt-1">
                            <div
                                className={cn(
                                    "transition-colors pointer-events-none",
                                    book.isFavorite
                                        ? "text-[color:var(--color-accent)]"
                                        : "opacity-0"
                                )}
                            >
                                <Heart className={cn("w-3 h-3 fill-current")} />
                            </div>
                            {book.rating && (
                                <div className="flex items-center gap-0.5">
                                    <Star className="w-3 h-3 text-[color:var(--color-warning)] fill-current" />
                                    <span className="text-[var(--font-size-3xs)] text-[color:var(--color-text-muted)]">{book.rating}</span>
                                </div>
                            )}
                            {book.syncedWithoutFile && (
                                <div className="flex items-center gap-0.5 text-[color:var(--color-warning)]" title="Book file not available locally">
                                    <CloudOff className="w-3 h-3" />
                                    <span className="text-[var(--font-size-3xs)]">No file</span>
                                </div>
                            )}
                        </div>
                        {book.progress > 0 && (
                            <p className="mt-1 text-[0.6875rem] text-[color:var(--color-text-muted)] sm:hidden">
                                {formatProgress(book.progress)}
                            </p>
                        )}
                    </div>

                    <div className="hidden text-right sm:block">
                        {book.progress > 0 ? (
                            <p className="text-sm text-[color:var(--color-text-secondary)]">
                                {formatProgress(book.progress)}
                            </p>
                        ) : (
                            <p className="text-xs text-[color:var(--color-text-muted)]">Not started</p>
                        )}
                    </div>
                </div>
            </ContextMenu>
        );
    }

    return (
        <ContextMenu items={contextMenuItems}>
            <div
                onClick={handleCardClick}
                className="group relative aspect-[2/3] bg-[var(--color-surface-muted)] overflow-hidden border border-[var(--color-border)] hover:shadow-lg transition-colors duration-200 w-full cursor-pointer select-none"
                role="button"
                tabIndex={0}
                aria-label={`Open ${book.title}`}
                onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onOpenBook(book);
                    }
                }}
            >
                <TheoremBookCover
                    title={book.title}
                    author={book.author}
                    coverUrl={book.coverPath}
                />

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

                {book.syncedWithoutFile && (
                    <div className="absolute top-1 left-1 w-5 h-5 flex items-center justify-center text-white rounded-sm pointer-events-none z-10" style={{ backgroundColor: 'color-mix(in srgb, var(--color-warning) 90%, transparent)' }} title="Book file not available locally">
                        <CloudOff className="w-2.5 h-2.5" />
                    </div>
                )}
            </div>
        </ContextMenu>
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
        prev.viewMode === next.viewMode &&
        prev.isSelecting === next.isSelecting &&
        prev.isSelected === next.isSelected;
});

function EmptyLibrary({
    onAddBooks,
    onScanFolder,
    isImporting,
    isScanning,
}: {
    onAddBooks: () => void;
    onScanFolder?: () => void;
    isImporting: boolean;
    isScanning: boolean;
}) {
    return (
        <div className="mx-auto w-full max-w-[26rem] min-w-0 px-4 sm:px-6 flex flex-col items-center justify-center py-24 text-center animate-fade-in">
            <div className="w-16 h-16 bg-[var(--color-surface-muted)] flex items-center justify-center mb-6">
                <BookOpen className="w-6 h-6 text-[color:var(--color-text-secondary)]" />
            </div>
            <h2 className="w-full break-words text-balance text-lg font-medium text-[color:var(--color-text-primary)] mb-2">
                No books yet
            </h2>
            <p className="mx-auto w-full max-w-[24rem] break-words text-[color:var(--color-text-muted)] mb-8 text-sm leading-relaxed">
                Import books to start reading
            </p>
            <div className="flex flex-wrap items-center justify-center gap-3">
                <button
                    onClick={onAddBooks}
                    disabled={isImporting}
                    className={cn(TOOLBAR_BUTTON_PRIMARY, "min-w-[10.5rem] whitespace-nowrap px-6 py-2.5")}
                >
                    {isImporting ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                        <Plus className="w-4 h-4" />
                    )}
                    <span>{isImporting ? "Importing..." : "Import Books"}</span>
                </button>

                {onScanFolder && (
                    <button
                        onClick={onScanFolder}
                        disabled={isScanning}
                        className={cn(TOOLBAR_BUTTON_BASE, "min-w-[10.5rem] whitespace-nowrap px-6 py-2.5")}
                    >
                        {isScanning ? (
                            <RefreshCw className="w-4 h-4 animate-spin" />
                        ) : (
                            <FolderOpen className="w-4 h-4" />
                        )}
                        <span>{isScanning ? "Scanning..." : "Scan Folder"}</span>
                    </button>
                )}
            </div>
        </div>
    );
}

function ImportButton({
    onImport,
    isLoading
}: {
    onImport: () => void;
    isLoading: boolean;
}) {
    return (
        <button
            onClick={onImport}
            disabled={isLoading}
            className={cn(TOOLBAR_BUTTON_PRIMARY, "px-3 py-2 sm:px-4")}
        >
            {isLoading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
                <Plus className="w-4 h-4" />
            )}
            <span className="hidden sm:inline">Add Books</span>
            <span className="sm:hidden">Add</span>
        </button>
    );
}

export function BookInfoModal({ book, isOpen, onClose, onEdit }: { book: Book | null; isOpen: boolean; onClose: () => void; onEdit?: (book: Book) => void }) {
    if (!book) return null;

    return (
        <Modal isOpen={isOpen} onClose={onClose} size="md" showCloseButton={true}>
            <ModalBody className="p-0">
                <div className="p-6">
                    <div className="flex items-start gap-4">
                        <div className="w-24 h-36 shrink-0 overflow-hidden shadow-md">
                            <TheoremBookCover
                                title={book.title}
                                author={book.author}
                                coverUrl={book.coverPath}
                            />
                        </div>
                        <div className="flex-1 min-w-0">
                            <h2 className="text-lg font-semibold text-[color:var(--color-text-primary)] line-clamp-2">
                                {book.title}
                            </h2>
                            <p className="text-sm text-[color:var(--color-text-secondary)] mt-1">
                                {normalizeAuthor(book.author) || "Unknown Author"}
                            </p>
                            {book.rating && (
                                <div className="flex items-center gap-1 mt-2">
                                    {[...Array(5)].map((_, i) => (
                                        <Star
                                            key={i}
                                            className={cn(
                                                "w-4 h-4",
                                                i < book.rating! ? "text-[color:var(--color-warning)] fill-current" : "text-[color:var(--color-border)]"
                                            )}
                                        />
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>

                    <div className="mt-6 space-y-3">
                        {book.description && (
                            <div>
                                <p className="text-xs text-[color:var(--color-text-muted)] uppercase">Description</p>
                                <div
                                    className="text-sm text-[color:var(--color-text-secondary)] mt-1 [&_a]:text-[var(--color-accent)] [&_a]:underline prose prose-sm max-w-none"
                                    dangerouslySetInnerHTML={{ __html: sanitizeHtml(book.description) }}
                                />
                            </div>
                        )}
                        <div className="grid grid-cols-2 gap-3">
                            {book.publisher && (
                                <div>
                                    <p className="text-xs text-[color:var(--color-text-muted)] uppercase">Publisher</p>
                                    <p className="text-sm text-[color:var(--color-text-secondary)]">{book.publisher}</p>
                                </div>
                            )}
                            {book.publishedDate && (
                                <div>
                                    <p className="text-xs text-[color:var(--color-text-muted)] uppercase">Published</p>
                                    <p className="text-sm text-[color:var(--color-text-secondary)]">{book.publishedDate}</p>
                                </div>
                            )}
                            {book.language && (
                                <div>
                                    <p className="text-xs text-[color:var(--color-text-muted)] uppercase">Language</p>
                                    <p className="text-sm text-[color:var(--color-text-secondary)]">{book.language}</p>
                                </div>
                            )}
                            {book.isbn && (
                                <div>
                                    <p className="text-xs text-[color:var(--color-text-muted)] uppercase">ISBN</p>
                                    <p className="text-sm text-[color:var(--color-text-secondary)]">{book.isbn}</p>
                                </div>
                            )}
                            <div>
                                <p className="text-xs text-[color:var(--color-text-muted)] uppercase">Format</p>
                                <p className="text-sm text-[color:var(--color-text-secondary)] uppercase">{FORMAT_DISPLAY_NAMES[book.format] || book.format}</p>
                            </div>
                            <div>
                                <p className="text-xs text-[color:var(--color-text-muted)] uppercase">Size</p>
                                <p className="text-sm text-[color:var(--color-text-secondary)]">{formatFileSize(book.fileSize)}</p>
                            </div>
                            <div>
                                <p className="text-xs text-[color:var(--color-text-muted)] uppercase">Added</p>
                                <p className="text-sm text-[color:var(--color-text-secondary)]">{formatRelativeDate(book.addedAt instanceof Date ? book.addedAt : new Date(book.addedAt))}</p>
                            </div>
                            {book.lastReadAt && (
                                <div>
                                    <p className="text-xs text-[color:var(--color-text-muted)] uppercase">Last Read</p>
                                    <p className="text-sm text-[color:var(--color-text-secondary)]">{book.lastReadAt ? formatRelativeDate(book.lastReadAt instanceof Date ? book.lastReadAt : new Date(book.lastReadAt)) : "Never"}</p>
                                </div>
                            )}
                        </div>
                        {book.progress > 0 && (
                            <div>
                                <p className="text-xs text-[color:var(--color-text-muted)] uppercase">Progress</p>
                                <p className="text-sm text-[color:var(--color-text-secondary)]">{formatProgress(book.progress)}</p>
                            </div>
                        )}
                        {book.tags.length > 0 && (
                            <div>
                                <p className="text-xs text-[color:var(--color-text-muted)] uppercase mb-1">Tags</p>
                                <div className="flex flex-wrap gap-1">
                                    {book.tags.map((tag: string) => (
                                        <span
                                            key={tag}
                                            className="px-2 py-0.5 text-xs bg-[var(--color-surface-muted)] text-[color:var(--color-text-secondary)]"
                                        >
                                            {tag}
                                        </span>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            </ModalBody>
            <ModalFooter>
                {onEdit && (
                    <button
                        onClick={() => {
                            onClose();
                            onEdit(book);
                        }}
                        className="ui-btn px-3 py-1.5 text-xs font-bold uppercase"
                    >
                        <Pencil className="w-3.5 h-3.5" />
                        Edit
                    </button>
                )}
                <button
                    onClick={onClose}
                    className="ui-btn-ghost"
                >
                    Close
                </button>
            </ModalFooter>
        </Modal>
    );
}

export function AddToShelfModal({
    isOpen,
    onClose,
    bookId,
    collections,
    onAddToShelf,
    onCreateShelf,
}: {
    isOpen: boolean;
    onClose: () => void;
    bookId: string | null;
    collections: Collection[];
    onAddToShelf: (bookId: string | null, shelfId: string) => void;
    onCreateShelf: (name: string) => void;
}) {
    const [newShelfName, setNewShelfName] = useState("");

    const handleCreateShelf = () => {
        if (newShelfName.trim()) {
            onCreateShelf(newShelfName.trim());
            setNewShelfName("");
        }
    };

    const [shelfSearch, setShelfSearch] = useState("");

    const filteredShelves = useMemo(
        () => shelfSearch.trim()
            ? collections.filter((s) => s.name.toLowerCase().includes(shelfSearch.toLowerCase()))
            : collections,
        [collections, shelfSearch],
    );

    const renderShelfItem = (shelf: Collection) => (
        <button
            key={shelf.id}
            onClick={() => {
                onAddToShelf(bookId, shelf.id);
                onClose();
            }}
            className="w-full flex items-center gap-2 p-2 hover:bg-[var(--color-surface-muted)] transition-colors text-left"
        >
            <FolderOpen className="w-4 h-4 shrink-0 text-[color:var(--color-text-muted)]" />
            <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-[color:var(--color-text-primary)] truncate">
                    {shelf.name}
                </p>
                <p className="text-[11px] text-[color:var(--color-text-muted)]">
                    {shelf.bookIds.length} {shelf.bookIds.length === 1 ? "book" : "books"}
                </p>
            </div>
        </button>
    );

    return (
        <Modal isOpen={isOpen} onClose={onClose} size="sm" showCloseButton={true}>
            <ModalBody className="p-0">
                <div className="p-4 sm:p-6">
                    <h2 className="text-base sm:text-lg font-semibold text-[color:var(--color-text-primary)] mb-3">
                        Add to Shelf
                    </h2>

                    {collections.length > 0 && (
                        <input
                            type="text"
                            value={shelfSearch}
                            onChange={(e) => setShelfSearch(e.target.value)}
                            placeholder="Search shelves..."
                            className="w-full mb-2 px-2.5 py-1.5 bg-[var(--color-background)] border border-[var(--color-border)] text-sm text-[color:var(--color-text-primary)] focus:outline-none focus:border-[var(--color-accent)]"
                        />
                    )}

                    {collections.length > 0 ? (
                        <div className="max-h-48 sm:max-h-60 overflow-y-auto space-y-0.5 -mx-1 px-1 [content-visibility:auto] overscroll-contain">
                            {filteredShelves.map((shelf) => renderShelfItem(shelf))}
                            {filteredShelves.length === 0 && (
                                <p className="text-sm text-[color:var(--color-text-muted)] text-center py-3">
                                    No shelves match "{shelfSearch}"
                                </p>
                            )}
                        </div>
                    ) : (
                        <p className="text-sm text-[color:var(--color-text-muted)] text-center py-3">
                            No shelves yet. Create one below.
                        </p>
                    )}

                    <div className="mt-3 pt-3 border-t border-[var(--color-border)]">
                        <p className="text-[11px] text-[color:var(--color-text-muted)] uppercase mb-2">Create New Shelf</p>
                        <div className="flex gap-2">
                            <input
                                type="text"
                                value={newShelfName}
                                onChange={(e) => setNewShelfName(e.target.value)}
                                placeholder="Shelf name..."
                                className={cn(
                                    "flex-1 px-2.5 py-1.5",
                                    "bg-[var(--color-background)] border border-[var(--color-border)]",
                                    "text-sm text-[color:var(--color-text-primary)]",
                                    "focus:outline-none focus:border-[var(--color-accent)]"
                                )}
                                onKeyDown={(e) => {
                                    if (e.key === "Enter") handleCreateShelf();
                                }}
                            />
                            <button
                                onClick={handleCreateShelf}
                                disabled={!newShelfName.trim()}
                                className="ui-btn-primary text-xs px-3"
                            >
                                Create
                            </button>
                        </div>
                    </div>
                </div>
            </ModalBody>
            <ModalFooter>
                <button
                    onClick={onClose}
                    className="ui-btn-ghost"
                >
                    Cancel
                </button>
            </ModalFooter>
        </Modal>
    );
}

export function RenameBookModal({
    isOpen,
    book,
    onClose,
    onSave,
}: {
    isOpen: boolean;
    book: Book | null;
    onClose: () => void;
    onSave: (bookId: string, newTitle: string) => void;
}) {
    const [title, setTitle] = useState("");

    useEffect(() => {
        if (isOpen && book) {
            setTitle(book.title);
        }
    }, [isOpen, book]);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (title.trim() && book) {
            onSave(book.id, title.trim());
            onClose();
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            if (title.trim() && book) {
                onSave(book.id, title.trim());
                onClose();
            }
        }
    };

    if (!book) return null;

    return (
        <Modal isOpen={isOpen} onClose={onClose} size="sm" showCloseButton={true}>
            <form onSubmit={handleSubmit}>
                <ModalHeader title="Rename Book" onClose={onClose} showCloseButton={true} />
                <ModalBody>
                    <div>
                        <label htmlFor="rename-title" className="block text-sm font-medium text-[color:var(--color-text-primary)] mb-1.5">
                            Title
                        </label>
                        <input
                            id="rename-title"
                            type="text"
                            value={title}
                            onChange={(e) => setTitle(e.target.value)}
                            onKeyDown={handleKeyDown}
                            className="ui-input"
                            autoFocus
                        />
                    </div>
                </ModalBody>
                <ModalFooter>
                    <button
                        type="button"
                        onClick={onClose}
                        className="ui-btn-ghost"
                    >
                        Cancel
                    </button>
                    <button
                        type="submit"
                        disabled={!title.trim() || title.trim() === book.title}
                        className="ui-btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        Save
                    </button>
                </ModalFooter>
            </form>
        </Modal>
    );
}

export function LibraryPage() {
    const books = useLibraryStore((state) => state.books);
    const collections = useLibraryStore((state) => state.collections);
    const annotations = useLibraryStore((state) => state.annotations);
    const coversHydrated = useLibraryStore((state) => state.coversHydrated);
    const addBook = useLibraryStore((state) => state.addBook);
    const removeBook = useLibraryStore((state) => state.removeBook);
    const updateBook = useLibraryStore((state) => state.updateBook);
    const setLastScannedAt = useLibraryStore((state) => state.setLastScannedAt);
    const toggleFavorite = useLibraryStore((state) => state.toggleFavorite);
    const markBookCompleted = useLibraryStore((state) => state.markBookCompleted);
    const markBookUnread = useLibraryStore((state) => state.markBookUnread);
    const addBookToCollection = useLibraryStore((state) => state.addBookToCollection);
    const addCollection = useLibraryStore((state) => state.addCollection);

    const setRoute = useUIStore((state) => state.setRoute);
    const searchQuery = useUIStore((state) => state.searchQuery);
    const selectedBooks = useUIStore((state) => state.selectedBooks);
    const toggleBookSelection = useUIStore((state) => state.toggleBookSelection);
    const clearSelection = useUIStore((state) => state.clearSelection);
    const settings = useSettingsStore((state) => state.settings);
    const updateSettings = useSettingsStore((state) => state.updateSettings);

    const [isImporting, setIsImporting] = useState(false);
    const [isScanning, setIsScanning] = useState(false);
    const [isExtractingCovers, setIsExtractingCovers] = useState(false);
    const [isSelecting, setIsSelecting] = useState(false);

    const [showFilterDropdown, setShowFilterDropdown] = useState(false);
    const [dismissedHighlight, setDismissedHighlight] = useState(
        () => sessionStorage.getItem("theorem-dismiss-highlight") === new Date().toISOString().split("T")[0]
    );
    const filterDropdownRef = useRef<HTMLDivElement>(null);

    const [infoModalBook, setInfoModalBook] = useState<Book | null>(null);
    const [isInfoModalOpen, setIsInfoModalOpen] = useState(false);
    const [addToShelfBookId, setAddToShelfBookId] = useState<string | null>(null);
    const [isAddToShelfModalOpen, setIsAddToShelfModalOpen] = useState(false);
    const [editBook, setEditBook] = useState<Book | null>(null);
    const [isEditModalOpen, setIsEditModalOpen] = useState(false);
    const [alertInfo, setAlertInfo] = useState<{ title: string; message: string } | null>(null);
    const [deleteConfirm, setDeleteConfirm] = useState<{ bookId?: string; title: string; batch?: boolean } | null>(null);

    const extractedBookIdsRef = useRef<Set<string>>(new Set());
    const pendingImportMetadataQueueRef = useRef<Book[]>([]);
    const queuedImportMetadataIdsRef = useRef<Set<string>>(new Set());
    const activeImportMetadataTasksRef = useRef(0);

    const performImportedBookMetadataExtraction = useCallback(async (book: Book) => {
        const latestBook = useLibraryStore
            .getState()
            .books
            .find((candidate) => candidate.id === book.id) ?? book;

        if (latestBook.coverExtractionDone && latestBook.coverPath) {
            return;
        }

        try {
            const extractMetadata = await getExtractMetadataFn();
            let data: ArrayBuffer | null = null;
            const isContentUri = latestBook.filePath.startsWith("content://");
            const hasOriginalFilePath = (
                !latestBook.filePath.startsWith('browser://')
                && !latestBook.filePath.startsWith('idb://')
                && !latestBook.filePath.startsWith('sqlite://')
                && !isContentUri
            );

            if (hasOriginalFilePath) {
                data = await getBookData('', latestBook.filePath);
            }

            if (!data) {
                const storagePath = latestBook.storagePath || latestBook.filePath;
                data = await getBookData(latestBook.id, storagePath);
            }

            if (!data) {
                
                if (!latestBook.coverPath) {
                    const fallbackSvg = buildFallbackCoverSvg(
                        latestBook.title,
                        latestBook.author || 'Unknown Author',
                    );
                    const blob = new Blob([fallbackSvg], { type: 'image/svg+xml' });
                    const dataUrl = await saveCoverImage(latestBook.id, blob);
                    updateBook(latestBook.id, {
                        coverPath: dataUrl,
                        coverExtractionDone: true,
                    });
                }
                return;
            }

            const filename = ensureFilenameForFormat(
                extractFilenameFromPath(latestBook.filePath),
                latestBook.format,
            );
            const metadata = await extractMetadata(
                data,
                latestBook.format,
                filename,
                latestBook.id,
                {
                    metadataTimeoutMs: IMPORT_METADATA_TIMEOUT_MS,
                    coverTimeoutMs: IMPORT_COVER_TIMEOUT_MS,
                    allowFallbackCover: true,
                },
            );

            const updates: Partial<Book> = {};

            if (metadata.coverDataUrl) {
                updates.coverPath = metadata.coverDataUrl;
            }

            const shouldUpdateTitle = shouldUseExtractedTitle(latestBook.title, metadata.title, latestBook.filePath);
            if (shouldUpdateTitle) {
                updates.title = normalizeMetadataText(metadata.title);
            }

            const shouldUpdateAuthor = shouldUseExtractedAuthor(latestBook.author, metadata.author);
            if (shouldUpdateAuthor) {
                updates.author = normalizeMetadataText(metadata.author);
            }

            if (metadata.description && !latestBook.description) {
                updates.description = metadata.description;
            }
            if (metadata.publisher && !latestBook.publisher) {
                updates.publisher = metadata.publisher;
            }
            if (metadata.language && !latestBook.language) {
                updates.language = metadata.language;
            }
            if (metadata.publishedDate && !latestBook.publishedDate) {
                updates.publishedDate = metadata.publishedDate;
            }

            const hasUsefulMetadataUpdate = (
                Boolean(metadata.coverDataUrl)
                || shouldUpdateTitle
                || shouldUpdateAuthor
                || Boolean(metadata.description && !latestBook.description)
                || Boolean(metadata.publisher && !latestBook.publisher)
                || Boolean(metadata.language && !latestBook.language)
                || Boolean(metadata.publishedDate && !latestBook.publishedDate)
            );

            if (hasUsefulMetadataUpdate) {
                updates.coverExtractionDone = true;
            }

            if (Object.keys(updates).length > 0) {
                updateBook(latestBook.id, updates);
            }

        } catch (error) {
        }
    }, [updateBook]);

    const pumpImportMetadataQueue = useCallback(() => {
        while (
            activeImportMetadataTasksRef.current < IMPORT_METADATA_QUEUE_CONCURRENCY
            && pendingImportMetadataQueueRef.current.length > 0
        ) {
            const nextBook = pendingImportMetadataQueueRef.current.pop();
            if (!nextBook) {
                break;
            }

            if (extractedBookIdsRef.current.has(nextBook.id)) {
                continue;
            }

            activeImportMetadataTasksRef.current += 1;
            extractedBookIdsRef.current.add(nextBook.id);

            void performImportedBookMetadataExtraction(nextBook)
                .catch(e => console.error("[catch]", e))
                .finally(() => {
                    activeImportMetadataTasksRef.current = Math.max(0, activeImportMetadataTasksRef.current - 1);
                    extractedBookIdsRef.current.delete(nextBook.id);
                    queuedImportMetadataIdsRef.current.delete(nextBook.id);
                    if (pendingImportMetadataQueueRef.current.length > 0) {
                        pumpImportMetadataQueue();
                    }
                });
        }
    }, [performImportedBookMetadataExtraction]);

    const extractImportedBookMetadata = useCallback((book: Book) => {
        if (
            book.coverExtractionDone
            || queuedImportMetadataIdsRef.current.has(book.id)
            || extractedBookIdsRef.current.has(book.id)
        ) {
            return;
        }

        queuedImportMetadataIdsRef.current.add(book.id);
        pendingImportMetadataQueueRef.current.push(book);
        pumpImportMetadataQueue();
    }, [pumpImportMetadataQueue]);

    const [selectedShelfId, setSelectedShelfId] = useState<string | null>(null);

    const [showFavoritesOnly, setShowFavoritesOnly] = useState(false);
    const [showUnshelvedOnly, setShowUnshelvedOnly] = useState(false);
    const [statusFilter, setStatusFilter] = useState<LibraryStatusFilter>("all");
    
    useEffect(() => {
        const shelfId = sessionStorage.getItem("theorem-selected-shelf");
        if (shelfId) {
            setSelectedShelfId(shelfId);
        }
    }, []);

    useEffect(() => {
        if (!selectedShelfId) {
            return;
        }
        if (collections.some((collection) => collection.id === selectedShelfId)) {
            return;
        }
        sessionStorage.removeItem("theorem-selected-shelf");
        setSelectedShelfId(null);
    }, [collections, selectedShelfId]);

    const selectedShelf = selectedShelfId ? collections.find(c => c.id === selectedShelfId) : null;
    const selectedShelfBookIds = useMemo(() => {
        if (!selectedShelf) {
            return null;
        }
        return new Set(selectedShelf.bookIds);
    }, [selectedShelf]);

    const allShelvedBookIds = useMemo(() => {
        const set = new Set<string>();
        for (const c of collections) {
            for (const id of c.bookIds) {
                set.add(id);
            }
        }
        return set;
    }, [collections]);

    const debouncedSearchQuery = useDebounce(searchQuery, 250);

    const [ftsSearchIds, setFtsSearchIds] = useState<string[] | undefined>(undefined);
    useEffect(() => {
        if (!isTauri() || !debouncedSearchQuery.trim()) {
            setFtsSearchIds(undefined);
            return;
        }
        let cancelled = false;
        sqliteSearchBooks(debouncedSearchQuery.trim(), 200).then((results) => {
            if (!cancelled) setFtsSearchIds(results.map((r) => r.book_id));
        });
        return () => { cancelled = true; };
    }, [debouncedSearchQuery]);

    const sortedBooks = useMemo(() => {
        return getFilteredAndSortedBooks({
            books,
            searchQuery: debouncedSearchQuery,
            selectedShelfBookIds,
            showFavoritesOnly,
            showUnshelvedOnly,
            allShelvedBookIds,
            statusFilter,
            sortBy: settings.librarySortBy,
            sortOrder: settings.librarySortOrder,
            ftsSearchIds,
        });
    }, [
        books,
        debouncedSearchQuery,
        selectedShelfBookIds,
        settings.librarySortBy,
        settings.librarySortOrder,
        showFavoritesOnly,
        showUnshelvedOnly,
        allShelvedBookIds,
        statusFilter,
        ftsSearchIds,
    ]);

    const scrollRef = useRef<HTMLDivElement>(null);

    const isListView = settings.libraryViewMode === "list";
    const isCompactView = settings.libraryViewMode === "compact";

    const [observedCols, setObservedCols] = useState(() => typeof window !== "undefined" && window.innerWidth >= 1280 ? 7 : 4);

    useEffect(() => {
        const el = scrollRef.current;
        if (!el) return;
        const compute = () => {
            const w = el.clientWidth || (typeof window !== "undefined" ? window.innerWidth : 1280);
            if (isListView) return 1;
            if (isCompactView) {
                if (w >= 1280) return 6;
                if (w >= 1024) return 5;
                if (w >= 640) return 4;
                return 3;
            }
            if (w >= 1536) return 8;
            if (w >= 1280) return 7;
            if (w >= 1024) return 5;
            if (w >= 768) return 4;
            if (w >= 640) return 3;
            return 2;
        };
        setObservedCols(compute());
        const observer = new ResizeObserver(() => setObservedCols(compute()));
        observer.observe(el);
        return () => observer.disconnect();
    }, [isListView, isCompactView]);

    const effectiveCols = isListView ? 1 : observedCols;

    const rowCount = isListView
        ? sortedBooks.length
        : Math.ceil(sortedBooks.length / Math.max(effectiveCols, 1));

    const getEstimateSize = useCallback(() => {
        if (isListView) return 70;
        const el = scrollRef.current;
        if (!el) return 300;
        const gap = isCompactView ? 8 : 20;
        const cardW = Math.max(1, (el.clientWidth - (effectiveCols - 1) * gap) / Math.max(effectiveCols, 1));
        const textH = isCompactView ? 0 : 72;
        return Math.round(cardW * 1.5 + textH + gap);
    }, [isListView, isCompactView, effectiveCols]);

    const rowVirtualizer = useVirtualizer({
        count: rowCount,
        getScrollElement: useCallback(() => scrollRef.current, []),
        estimateSize: getEstimateSize,
        overscan: 3,
        measureElement: (el) => el.getBoundingClientRect().height,
    });

    useEffect(() => {
        if (!coversHydrated || isExtractingCovers || books.length === 0) {
            return;
        }

        const knownBookIds = new Set(books.map((book) => book.id));
        extractedBookIdsRef.current.forEach((bookId) => {
            if (!knownBookIds.has(bookId)) {
                extractedBookIdsRef.current.delete(bookId);
            }
        });

        const booksNeedingFallback = books.filter(
            (book) => (
                !book.coverPath
                && !extractedBookIdsRef.current.has(book.id)
                && !book.syncedWithoutFile
            ),
        );

        if (booksNeedingFallback.length === 0) {
            return;
        }

        let isCancelled = false;

        const generateFallbacks = async () => {
            setIsExtractingCovers(true);
            let processedCount = 0;

            try {
                const extractMetadata = await getExtractMetadataFn();

                for (const book of booksNeedingFallback) {
                    if (isCancelled) break;
                    extractedBookIdsRef.current.add(book.id);

                    try {
                        
                        const isContentUri = book.filePath.startsWith("content://");
                        const hasOriginalFilePath = (
                            !book.filePath.startsWith('browser://')
                            && !book.filePath.startsWith('idb://')
                            && !book.filePath.startsWith('sqlite://')
                            && !isContentUri
                        );

                        let data: ArrayBuffer | null = null;
                        if (hasOriginalFilePath) {
                            data = await getBookData('', book.filePath);
                        }
                        if (!data) {
                            const storagePath = book.storagePath || book.filePath;
                            data = await getBookData(book.id, storagePath);
                        }

                        if (data) {
                            
                            const filename = ensureFilenameForFormat(
                                extractFilenameFromPath(book.filePath),
                                book.format,
                            );
                            const metadata = await extractMetadata(
                                data,
                                book.format,
                                filename,
                                book.id,
                                { allowFallbackCover: true },
                            );
                            const updates: Partial<Book> = {};
                            if (metadata.coverDataUrl) {
                                updates.coverPath = metadata.coverDataUrl;
                            }
                            
                            if (shouldUseExtractedTitle(book.title, metadata.title, book.filePath)) {
                                updates.title = normalizeMetadataText(metadata.title);
                            }
                            if (metadata.author && !book.author) {
                                updates.author = metadata.author;
                            }
                            if (metadata.description && !book.description) {
                                updates.description = metadata.description;
                            }
                            if (metadata.publisher && !book.publisher) {
                                updates.publisher = metadata.publisher;
                            }
                            if (metadata.language && !book.language) {
                                updates.language = metadata.language;
                            }
                            if (metadata.publishedDate && !book.publishedDate) {
                                updates.publishedDate = metadata.publishedDate;
                            }

                            const hasAnyUpdate = (
                                Boolean(metadata.coverDataUrl)
                                || updates.title !== undefined
                                || updates.author !== undefined
                                || updates.description !== undefined
                                || updates.publisher !== undefined
                                || updates.language !== undefined
                                || updates.publishedDate !== undefined
                            );

                            if (hasAnyUpdate) {
                                updates.coverExtractionDone = true;
                                if (!isCancelled) updateBook(book.id, updates);
                            }
                        } else {
                            
                            const fallbackSvg = buildFallbackCoverSvg(
                                book.title,
                                book.author || 'Unknown Author',
                            );
                            const blob = new Blob([fallbackSvg], { type: 'image/svg+xml' });
                            const dataUrl = await saveCoverImage(book.id, blob);
                            if (!isCancelled) {
                                updateBook(book.id, {
                                    coverPath: dataUrl,
                                    coverExtractionDone: true,
                                });
                            }
                        }
                    } catch (error) {
                    }

                    processedCount++;
                }
            } finally {
                if (!isCancelled) {
                    setIsExtractingCovers(false);
                }
            }
        };

        void generateFallbacks();
        return () => { isCancelled = true; };
    }, [coversHydrated, books, updateBook]);

    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            if (filterDropdownRef.current && !filterDropdownRef.current.contains(e.target as Node)) {
                setShowFilterDropdown(false);
            }
        };

        if (showFilterDropdown) {
            document.addEventListener("mousedown", handleClickOutside);
        }

        return () => {
            document.removeEventListener("mousedown", handleClickOutside);
        };
    }, [showFilterDropdown]);

    const handleAddBooks = useCallback(async () => {
        setIsImporting(true);
        const failedImports: Array<{ source: string; message: string }> = [];
        try {
            await pickAndImportBooksIncremental(
                (book) => {
                    addBook(book);
                    void extractImportedBookMetadata(book);
                },
                (source, error) => {
                    failedImports.push({
                        source,
                        message: error instanceof Error ? error.message : String(error),
                    });
                },
            );
        } catch (err) {
        } finally {
            setIsImporting(false);
        }
        if (failedImports.length > 0) {
            const preview = failedImports
                .slice(0, 3)
                .map((failure) => `- ${failure.source}: ${failure.message}`)
                .join('\n');
            setAlertInfo({
                title: "Import Errors",
                message: `Some books failed to import (${failedImports.length}).\n\n${preview}` +
                    (failedImports.length > 3 ? `\n\n(+${failedImports.length - 3} more)` : ''),
            });
        }
    }, [addBook, extractImportedBookMetadata]);

    const importDiscoveredBooks = useCallback(async (bookPaths: string[]) => {
        if (bookPaths.length === 0) {
            setAlertInfo({ title: "No Books Found", message: "No supported books were found in the selected folder." });
            return;
        }

        const failedImports: Array<{ source: string; message: string }> = [];
        await importBooksIncremental(
            bookPaths,
            (book) => {
                addBook(book);
                void extractImportedBookMetadata(book);
            },
            (source, error) => {
                failedImports.push({
                    source,
                    message: error instanceof Error ? error.message : String(error),
                });
            },
        );
        setLastScannedAt(new Date());
        if (failedImports.length > 0) {
            const preview = failedImports
                .slice(0, 3)
                .map((failure) => `- ${failure.source}: ${failure.message}`)
                .join('\n');
            setAlertInfo({
                title: "Import Errors",
                message: `Some books failed to import (${failedImports.length}).\n\n${preview}` +
                    (failedImports.length > 3 ? `\n\n(+${failedImports.length - 3} more)` : ''),
            });
        }
    }, [addBook, extractImportedBookMetadata, setLastScannedAt]);

    const scanAndImportFolder = useCallback(async (folderPath: string) => {
        const normalizedFolderPath = normalizeFilePath(folderPath);
        if (!normalizedFolderPath) {
            return;
        }

        const bookPaths = await scanFolderForBooks(normalizedFolderPath);
        await importDiscoveredBooks(bookPaths);
    }, [importDiscoveredBooks]);

    const handleScanFolder = useCallback(async () => {
        if (!isTauri()) {
            setAlertInfo({ title: "Not Available", message: "Folder scanning requires the desktop app." });
            return;
        }

        try {
            if (isMobile()) {
                setIsScanning(true);

                const pickedFolder = await pickLibraryFolderMobile();
                if (!pickedFolder) {
                    setIsScanning(false);
                    return;
                }

                updateSettings({ scanFolders: [pickedFolder] });

                try {
                    const bookUris = await scanLibraryFolderMobile(pickedFolder);
                    await importDiscoveredBooks(bookUris);
                } catch (err) {
                    
                    updateSettings({ scanFolders: [] });
                    throw err;
                }
                return;
            }

            const defaultDesktopFolder = settings.scanFolders[0]?.startsWith("content://")
                ? undefined
                : settings.scanFolders[0] || undefined;
            const selectedFolder = await showOpenDirectoryDialog({
                title: "Scan Library Folder",
                defaultPath: defaultDesktopFolder,
            });
            if (!selectedFolder) {
                return;
            }

            const normalizedFolderPath = normalizeFilePath(selectedFolder);
            if (!normalizedFolderPath) {
                return;
            }

            updateSettings({ scanFolders: [normalizedFolderPath] });

            setIsScanning(true);
            await scanAndImportFolder(normalizedFolderPath);
        } catch (err) {
            setAlertInfo({ title: "Scan Error", message: err instanceof Error ? err.message : 'Failed to scan selected folder.' });
        } finally {
            setIsScanning(false);
        }
    }, [
        importDiscoveredBooks,
        scanAndImportFolder,
        settings.scanFolders,
        updateSettings,
    ]);

    const handleOpenBook = useCallback((book: Book) => {
        import("../../features/reader"); 
        if (book.syncedWithoutFile) {
            useUIStore.getState().setDownloadingBook(book.id);
            setRoute("reader", book.id);
            import("../../core/lib/sync-orchestrator").then(({ downloadBookOnDemand }) => {
                downloadBookOnDemand(book.id).catch(() => {});
            });
            return;
        }
        setRoute("reader", book.id);
    }, [setRoute]);

    const handleToggleFavorite = useCallback((bookId: string) => {
        toggleFavorite(bookId);
    }, [toggleFavorite]);

    const handleDeleteBook = useCallback((bookId: string) => {
        const book = useLibraryStore.getState().getBook(bookId);
        setDeleteConfirm({ bookId, title: book?.title || "this book", batch: false });
    }, []);

    const handleBatchDelete = useCallback(() => {
        if (selectedBooks.length === 0) return;
        setDeleteConfirm({ title: `${selectedBooks.length} selected book(s)`, batch: true });
    }, [selectedBooks]);

    const handleBatchAddToShelf = useCallback(() => {
        setAddToShelfBookId(null); 
        setIsAddToShelfModalOpen(true);
    }, []);

    const handleBatchMarkRead = useCallback(() => {
        for (const id of selectedBooks) {
            markBookCompleted(id, "manual");
        }
        clearSelection();
        setIsSelecting(false);
    }, [selectedBooks, markBookCompleted, clearSelection]);

    const handleBatchMarkUnread = useCallback(() => {
        for (const id of selectedBooks) {
            markBookUnread(id);
        }
        clearSelection();
        setIsSelecting(false);
    }, [selectedBooks, markBookUnread, clearSelection]);

    const handleShowInfo = useCallback((book: Book) => {
        setInfoModalBook(book);
        setIsInfoModalOpen(true);
    }, []);

    const handleRename = useCallback((book: Book) => {
        setEditBook(book);
        setIsEditModalOpen(true);
    }, []);

    const handleExport = useCallback(async (book: Book) => {
        const result = await exportBook(book);
        if (result.ok) {
            toast.success(result.message || "Book exported successfully.");
        } else {
            toast.error(result.message || "Something went wrong while exporting the book.");
        }
    }, []);

    const handleBatchExport = useCallback(async () => {
        const booksToExport = useLibraryStore
            .getState()
            .books
            .filter((b) => selectedBooks.includes(b.id));
        if (booksToExport.length === 0) return;

        const result = await exportBooks(booksToExport);
        if (result.succeeded > 0) {
            const failedNote = result.failed.length > 0 ? `\n\n${result.failed.length} book(s) failed to export.` : "";
            toast.success(`Exported ${result.succeeded} of ${booksToExport.length} book(s).${failedNote}`);
        } else {
            toast.error(result.failed[0]?.reason || "No books were exported.");
        }
        clearSelection();
        setIsSelecting(false);
    }, [selectedBooks, clearSelection]);

    const handleAddToShelf = useCallback((bookId: string) => {
        setAddToShelfBookId(bookId);
        setIsAddToShelfModalOpen(true);
    }, []);

    const handleMarkAsRead = useCallback((bookId: string) => {
        markBookCompleted(bookId, "manual");
    }, [markBookCompleted]);

    const handleMarkAsUnread = useCallback((bookId: string) => {
        markBookUnread(bookId);
    }, [markBookUnread]);

    const handleAddBookToShelf = useCallback((bookId: string | null, shelfId: string) => {
        if (bookId) {
            addBookToCollection(bookId, shelfId);
        } else {
            
            for (const id of selectedBooks) {
                addBookToCollection(id, shelfId);
            }
            clearSelection();
            setIsSelecting(false);
        }
    }, [addBookToCollection, selectedBooks, clearSelection]);

    const handleCreateShelf = useCallback((name: string) => {
        const newShelf: Collection = {
            id: crypto.randomUUID(),
            name,
            bookIds: addToShelfBookId ? [addToShelfBookId] : isSelecting ? [...selectedBooks] : [],
            kind: "general",
            createdAt: new Date(),
        };
        addCollection(newShelf);
        setIsAddToShelfModalOpen(false);
        setAddToShelfBookId(null);
        if (isSelecting) {
            clearSelection();
            setIsSelecting(false);
        }
    }, [addCollection, addToShelfBookId, isSelecting, selectedBooks, clearSelection]);

    const cardProps = useMemo(() => ({
        onOpenBook: handleOpenBook,
        onToggleFavorite: handleToggleFavorite,
        onDeleteBook: handleDeleteBook,
        onShowInfo: handleShowInfo,
        onAddToShelf: handleAddToShelf,
        onRename: handleRename,
        onExport: handleExport,
        onMarkAsRead: handleMarkAsRead,
        onMarkAsUnread: handleMarkAsUnread,
        isSelecting,
        onToggleSelect: toggleBookSelection,
    }), [handleOpenBook, handleToggleFavorite, handleDeleteBook, handleShowInfo, handleAddToShelf, handleRename, handleExport, handleMarkAsRead, handleMarkAsUnread, isSelecting, toggleBookSelection]);

    const toggleViewMode = () => {
        const modes: LibraryViewMode[] = ["grid", "list", "compact"];
        const currentIndex = modes.indexOf(settings.libraryViewMode);
        const nextMode = modes[(currentIndex + 1) % modes.length];
        updateSettings({ libraryViewMode: nextMode });
    };

    if (books.length === 0) {
        return (
            <EmptyLibrary
                onAddBooks={handleAddBooks}
                onScanFolder={isTauri() ? handleScanFolder : undefined}
                isImporting={isImporting}
                isScanning={isScanning}
            />
        );
    }

    return (
        <div className="mx-auto flex h-full w-full max-w-[var(--layout-content-max-width)] flex-col px-4 py-3 pb-0 sm:px-6 lg:px-8 lg:py-8 animate-fade-in">
            
            <div className="-mb-4">
            <PageHeader
                title={selectedShelf ? selectedShelf.name : showFavoritesOnly ? "Favorites" : showUnshelvedOnly ? "Unshelved" : "Library"}
                description={`${sortedBooks.length} ${sortedBooks.length === 1 ? 'book' : 'books'}${(selectedShelf || showFavoritesOnly || showUnshelvedOnly) ? '' : ''}`}
            >
                {(selectedShelf || showFavoritesOnly || showUnshelvedOnly) && (
                    <button
                        onClick={() => {
                            sessionStorage.removeItem("theorem-selected-shelf");
                            setSelectedShelfId(null);
                            setShowFavoritesOnly(false);
                            setShowUnshelvedOnly(false);
                        }}
                        className="text-xs font-medium text-[color:var(--color-accent)] hover:underline"
                    >
                        Clear filter
                    </button>
                )}
                <ImportButton onImport={handleAddBooks} isLoading={isImporting} />

                <div className="flex items-center gap-2 sm:gap-4 ml-auto">
                    <button
                        onClick={() => {
                            if (isSelecting) {
                                clearSelection();
                            }
                            setIsSelecting(!isSelecting);
                        }}
                        className={cn(
                            TOOLBAR_BUTTON_BASE, TOOLBAR_ICON_BUTTON, "border-2",
                            isSelecting && "bg-[var(--color-accent)] text-[color:var(--color-accent-contrast)] border-[var(--color-accent)]"
                        )}
                        title={isSelecting ? "Cancel Selection" : "Select Books"}
                    >
                        <CheckCheck className="w-4 h-4" />
                    </button>

                    <button
                        onClick={toggleViewMode}
                        className={cn(TOOLBAR_BUTTON_BASE, TOOLBAR_ICON_BUTTON, "border-2")}
                        title={`View: ${settings.libraryViewMode}`}
                    >
                        {viewModeIcons[settings.libraryViewMode]}
                    </button>

                    <div className="h-6 w-px bg-[var(--color-border)]" />

                    {isTauri() && (
                        <button
                            onClick={handleScanFolder}
                            disabled={isScanning}
                            className={cn(TOOLBAR_BUTTON_BASE, "px-3 py-2 sm:px-4 border-2")}
                            title="Scan Folder"
                        >
                            {isScanning ? <RefreshCw className="w-4 h-4 animate-spin" /> : <FolderOpen className="w-4 h-4" />}
                            <span className="hidden sm:inline font-bold text-xs uppercase">Scan</span>
                        </button>
                    )}

                    <button
                        onClick={() => setShowFilterDropdown(!showFilterDropdown)}
                        className={cn(
                            "ui-btn h-10 px-3 sm:px-5 transition-colors duration-200 border-2",
                            showFilterDropdown
                                ? "bg-[var(--color-accent)] text-[color:var(--color-accent-contrast)] border-[var(--color-accent)]"
                                : "bg-[var(--color-surface)] text-[color:var(--color-text-secondary)] border-[var(--color-border)] hover:border-[var(--color-text-primary)]"
                        )}
                    >
                        <Filter className="w-4 h-4" />
                        <span className="hidden sm:inline font-black tracking-tight uppercase text-xs">Filter</span>
                        <ChevronDown className={cn("w-3.5 h-3.5 transition-transform duration-300", showFilterDropdown && "rotate-180")} />
                    </button>
                </div>
            </PageHeader>
            </div>

            <div className="flex min-h-0 flex-1 flex-col md:flex-row gap-6 md:gap-10 relative">
                <div className="flex min-h-0 flex-1 flex-col w-full">
                    
                    <div className={cn(
                        "md:hidden overflow-hidden transition-colors duration-300",
                        showFilterDropdown ? "max-h-[800px] mb-8 opacity-100" : "max-h-0 opacity-0 mb-0"
                    )}>
                        <div className="w-full border-t-2 border-b-2 border-[var(--color-border)] bg-[var(--color-surface-muted)]">
                            <div className="grid grid-cols-1 divide-y divide-[var(--color-border)]">
                                
                                <div className="p-4">
                                    <h3 className="text-[10px] font-black uppercase tracking-[0.2em] text-[color:var(--color-text-muted)] mb-3">Sort By</h3>
                                    <div className="grid grid-cols-2 gap-1">
                                        {[
                                            { id: "title", label: "Title" },
                                            { id: "author", label: "Author" },
                                            { id: "dateAdded", label: "Added" },
                                            { id: "lastRead", label: "Read" },
                                        ].map((option) => (
                                            <button
                                                key={option.id}
                                                onClick={() => updateSettings({ librarySortBy: option.id as LibrarySortBy })}
                                                className={cn(
                                                    "flex items-center justify-between px-3 py-2 text-xs font-bold transition-colors border",
                                                    settings.librarySortBy === option.id
                                                        ? "bg-[var(--color-accent)] text-[color:var(--color-accent-contrast)] border-[var(--color-accent)]"
                                                        : "text-[color:var(--color-text-secondary)] border-transparent hover:border-[var(--color-border)] hover:bg-[var(--color-surface)]"
                                                )}
                                            >
                                                {option.label}
                                                {settings.librarySortBy === option.id && <Check className="w-3 h-3" />}
                                            </button>
                                        ))}
                                    </div>
                                </div>

                                <div className="p-4">
                                    <h3 className="text-[10px] font-black uppercase tracking-[0.2em] text-[color:var(--color-text-muted)] mb-3">Status</h3>
                                    <div className="grid grid-cols-4 gap-1">
                                        {([
                                            { id: "all", label: "All" },
                                            { id: "unread", label: "New" },
                                            { id: "reading", label: "Reading" },
                                            { id: "completed", label: "Done" },
                                        ] as const).map((option) => (
                                            <button
                                                key={option.id}
                                                onClick={() => setStatusFilter(option.id as LibraryStatusFilter)}
                                                className={cn(
                                                    "px-2 py-2 text-[10px] font-bold border transition-colors",
                                                    statusFilter === option.id
                                                        ? "bg-[var(--color-accent)] text-[color:var(--color-accent-contrast)] border-[var(--color-accent)]"
                                                        : "text-[color:var(--color-text-secondary)] border-transparent hover:border-[var(--color-border)] hover:bg-[var(--color-surface)]"
                                                )}
                                            >
                                                {option.label}
                                            </button>
                                        ))}
                                    </div>
                                </div>

                                <div className="grid grid-cols-2 divide-x divide-[var(--color-border)]">
                                    <div className="p-4">
                                        <h3 className="text-[10px] font-black uppercase tracking-[0.2em] text-[color:var(--color-text-muted)] mb-3">Order</h3>
                                        <div className="flex flex-col gap-1">
                                            {["asc", "desc"].map((id) => (
                                                <button
                                                    key={id}
                                                    onClick={() => updateSettings({ librarySortOrder: id as LibrarySortOrder })}
                                                    className={cn(
                                                        "px-3 py-2 text-[10px] font-bold border transition-colors",
                                                        settings.librarySortOrder === id ? "bg-[var(--color-accent)] text-[color:var(--color-accent-contrast)] border-[var(--color-accent)]" : "text-[color:var(--color-text-secondary)] border-transparent hover:border-[var(--color-border)]"
                                                    )}
                                                >
                                                    {id === "asc" ? "ASC" : "DESC"}
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                    <div className="p-4">
                                        <h3 className="text-[10px] font-black uppercase tracking-[0.2em] text-[color:var(--color-text-muted)] mb-3">Quick</h3>
                                        <div className="flex flex-col gap-1">
                                            <button
                                                onClick={() => {
                                                    setShowFavoritesOnly(!showFavoritesOnly);
                                                    if (!showFavoritesOnly) setShowUnshelvedOnly(false);
                                                }}
                                                className={cn(
                                                    "px-3 py-2 text-[10px] font-bold border transition-colors",
                                                    showFavoritesOnly ? "bg-[var(--color-accent)] text-[color:var(--color-accent-contrast)] border-[var(--color-accent)]" : "text-[color:var(--color-text-secondary)] border-transparent hover:border-[var(--color-border)]"
                                                )}
                                            >
                                                Favorites
                                            </button>
                                            <button
                                                onClick={() => {
                                                    setShowUnshelvedOnly(!showUnshelvedOnly);
                                                    if (!showUnshelvedOnly) setShowFavoritesOnly(false);
                                                }}
                                                className={cn(
                                                    "px-3 py-2 text-[10px] font-bold border transition-colors",
                                                    showUnshelvedOnly ? "bg-[var(--color-accent)] text-[color:var(--color-accent-contrast)] border-[var(--color-accent)]" : "text-[color:var(--color-text-secondary)] border-transparent hover:border-[var(--color-border)]"
                                                )}
                                            >
                                                Unshelved
                                            </button>
                                            <button
                                                onClick={() => updateSettings({ librarySortBy: "lastRead", librarySortOrder: "desc" })}
                                                className="px-3 py-2 text-[10px] font-bold border transition-colors text-[color:var(--color-text-secondary)] border-transparent hover:border-[var(--color-border)]"
                                            >
                                                Recent
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>

                    <section ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto overscroll-contain scroll-smooth">
                        {(() => {
                            if (dismissedHighlight || !settings.showDailyHighlight) return null;
                            const nonBookmarks = annotations.filter((a) => a.type !== "bookmark" && a.selectedText);
                            if (nonBookmarks.length === 0 || selectedShelf || showFavoritesOnly || isSelecting) return null;
                            const daySeed = new Date().toISOString().split("T")[0].split("-").reduce((a, b) => a + parseInt(b), 0);
                            const hl = nonBookmarks[daySeed % nonBookmarks.length];
                            const hlBook = books.find((b) => b.id === hl.bookId);
                            if (!hl) return null;
                            return (
                                <div className="mb-3 border-l-[3px] border-[var(--color-accent)] bg-[var(--color-surface)] pl-4 pr-4 py-3 flex items-start gap-3">
                                    <div className="flex-1 min-w-0">
                                        <div className="text-[10px] font-medium text-[color:var(--color-text-muted)] uppercase tracking-wider mb-1.5">
                                            From your highlights
                                        </div>
                                        <p className="font-serif text-[14px] leading-relaxed text-[color:var(--color-text-primary)] mb-1.5">
                                            &ldquo;{hl.selectedText}&rdquo;
                                        </p>
                                        <div className="text-[11px] text-[color:var(--color-text-secondary)]">
                                            — {hlBook?.title || "Unknown source"}
                                        </div>
                                    </div>
                                    <button
                                        onClick={() => {
                                            sessionStorage.setItem("theorem-dismiss-highlight", new Date().toISOString().split("T")[0]);
                                            setDismissedHighlight(true);
                                        }}
                                        className="shrink-0 mt-0.5 p-1 text-[color:var(--color-text-muted)] hover:text-[color:var(--color-text-primary)] transition-colors"
                                        aria-label="Dismiss highlight"
                                    >
                                        ✕
                                    </button>
                                </div>
                            );
                        })()}
                        {sortedBooks.length === 0 ? (
                            <div className="text-center py-16 border-2 border-dashed border-[var(--color-border)]">
                                <p className="text-[color:var(--color-text-muted)] font-bold uppercase text-xs tracking-widest">No documents match criteria</p>
                                {searchQuery && (
                                    <button onClick={() => useUIStore.getState().setSearchQuery("")} className="mt-4 text-[10px] font-black uppercase text-[color:var(--color-accent)] hover:underline tracking-tighter">
                                        [ RESET SEARCH ]
                                    </button>
                                )}
                            </div>
                        ) : (
                            <div style={{ height: `${rowVirtualizer.getTotalSize()}px`, position: "relative" }}>
                                <div style={{ paddingTop: `${rowVirtualizer.getVirtualItems()[0]?.start ?? 0}px` }}>
                                    {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                                        const rowStart = virtualRow.index * (isListView ? 1 : effectiveCols);
                                        const itemsInRow = isListView
                                            ? 1
                                            : Math.min(effectiveCols, sortedBooks.length - rowStart);
                                        const rowItems = isListView
                                            ? [sortedBooks[virtualRow.index]]
                                            : sortedBooks.slice(rowStart, rowStart + itemsInRow);

                                        return (
                                            <div key={virtualRow.key} data-index={virtualRow.index} ref={rowVirtualizer.measureElement}>
                                                {isListView ? (
                                                    <div className="pb-1">
                                                        <MemoizedBookCard
                                                            key={rowItems[0].id}
                                                            book={rowItems[0]}
                                                            viewMode={settings.libraryViewMode}
                                                            isSelected={selectedBooks.includes(rowItems[0].id)}
                                                            {...cardProps}
                                                        />
                                                    </div>
                                                ) : (
                                                    <div
                                                        style={{
                                                            display: "grid",
                                                            gridTemplateColumns: `repeat(${effectiveCols}, minmax(0, 1fr))`,
                                                            gap: isCompactView ? "8px" : "20px",
                                                            paddingBottom: isCompactView ? "8px" : "20px",
                                                        }}
                                                    >
                                                        {rowItems.map((book) => (
                                                            <MemoizedBookCard
                                                                key={book.id}
                                                                book={book}
                                                                viewMode={settings.libraryViewMode}
                                                                isSelected={selectedBooks.includes(book.id)}
                                                                {...cardProps}
                                                            />
                                                        ))}
                                                    </div>
                                                )}
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        )}
                    </section>
                </div>

                {showFilterDropdown && (
                    <>
                        <div className="hidden md:block fixed inset-0 z-30" onClick={() => setShowFilterDropdown(false)} />
                        <aside className="hidden md:block w-72 absolute right-0 top-0 z-40 border-2 border-[var(--color-border)] bg-[var(--color-surface)] shadow-xl animate-in slide-in-from-right-4 duration-200 max-h-[80vh] overflow-y-auto [content-visibility:auto] overscroll-contain">
                            <div className="divide-y-2 divide-[var(--color-border)]">
                                <div className="p-4">
                                    <h3 className="text-[10px] font-black uppercase tracking-[0.3em] text-[color:var(--color-text-muted)] mb-3">Sort</h3>
                                    <div className="grid grid-cols-2 gap-1">
                                        {[
                                            { id: "title", label: "Title" },
                                            { id: "author", label: "Author" },
                                            { id: "dateAdded", label: "Added" },
                                            { id: "lastRead", label: "Read" },
                                        ].map((option) => (
                                            <button
                                                key={option.id}
                                                onClick={() => updateSettings({ librarySortBy: option.id as LibrarySortBy })}
                                                className={cn(
                                                    "px-2.5 py-1.5 text-[10px] font-bold border transition-colors",
                                                    settings.librarySortBy === option.id
                                                        ? "bg-[var(--color-accent)] text-[color:var(--color-accent-contrast)] border-[var(--color-accent)]"
                                                        : "bg-[var(--color-surface)] text-[color:var(--color-text-secondary)] border-transparent hover:border-[var(--color-border)]"
                                                )}
                                            >
                                                {option.label}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                                <div className="p-4">
                                    <h3 className="text-[10px] font-black uppercase tracking-[0.3em] text-[color:var(--color-text-muted)] mb-3">Status</h3>
                                    <div className="grid grid-cols-4 gap-1">
                                        {([
                                            { id: "all", label: "All" },
                                            { id: "unread", label: "New" },
                                            { id: "reading", label: "Read" },
                                            { id: "completed", label: "Done" },
                                        ] as const).map((option) => (
                                            <button
                                                key={option.id}
                                                onClick={() => setStatusFilter(option.id as LibraryStatusFilter)}
                                                className={cn(
                                                    "px-2 py-1.5 text-[10px] font-bold border transition-colors",
                                                    statusFilter === option.id
                                                        ? "bg-[var(--color-accent)] text-[color:var(--color-accent-contrast)] border-[var(--color-accent)]"
                                                        : "bg-[var(--color-surface)] text-[color:var(--color-text-secondary)] border-transparent hover:border-[var(--color-border)]"
                                                )}
                                            >
                                                {option.label}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                                <div className="grid grid-cols-2 divide-x divide-[var(--color-border)]">
                                    <div className="p-4">
                                        <h3 className="text-[10px] font-black uppercase tracking-[0.3em] text-[color:var(--color-text-muted)] mb-3">Order</h3>
                                        <div className="flex flex-col gap-1">
                                            {["asc", "desc"].map((id) => (
                                                <button
                                                    key={id}
                                                    onClick={() => updateSettings({ librarySortOrder: id as LibrarySortOrder })}
                                                    className={cn(
                                                        "px-2.5 py-1.5 text-[10px] font-bold border transition-colors",
                                                        settings.librarySortOrder === id
                                                            ? "bg-[var(--color-accent)] text-[color:var(--color-accent-contrast)] border-[var(--color-accent)]"
                                                            : "bg-[var(--color-surface)] text-[color:var(--color-text-secondary)] border-transparent hover:border-[var(--color-border)]"
                                                    )}
                                                >
                                                    {id === "asc" ? "ASC" : "DESC"}
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                    <div className="p-4">
                                        <h3 className="text-[10px] font-black uppercase tracking-[0.3em] text-[color:var(--color-text-muted)] mb-3">Quick</h3>
                                        <div className="flex flex-col gap-1">
                                            <button
                                                onClick={() => {
                                                    setShowFavoritesOnly((prev) => !prev);
                                                    if (!showFavoritesOnly) setShowUnshelvedOnly(false);
                                                }}
                                                className={cn(
                                                    "w-full px-2.5 py-1.5 text-[10px] font-bold border transition-colors",
                                                    showFavoritesOnly
                                                        ? "bg-[var(--color-accent)] text-[color:var(--color-accent-contrast)] border-[var(--color-accent)]"
                                                        : "bg-[var(--color-surface)] text-[color:var(--color-text-secondary)] border-transparent hover:border-[var(--color-border)]"
                                                )}
                                            >
                                                Favorites
                                            </button>
                                            <button
                                                onClick={() => {
                                                    setShowUnshelvedOnly((prev) => !prev);
                                                    if (!showUnshelvedOnly) setShowFavoritesOnly(false);
                                                }}
                                                className={cn(
                                                    "w-full px-2.5 py-1.5 text-[10px] font-bold border transition-colors",
                                                    showUnshelvedOnly
                                                        ? "bg-[var(--color-accent)] text-[color:var(--color-accent-contrast)] border-[var(--color-accent)]"
                                                        : "bg-[var(--color-surface)] text-[color:var(--color-text-secondary)] border-transparent hover:border-[var(--color-border)]"
                                                )}
                                            >
                                                Unshelved
                                            </button>
                                            <button
                                                onClick={() => updateSettings({ librarySortBy: "lastRead", librarySortOrder: "desc" })}
                                                className="w-full px-2.5 py-1.5 text-[10px] font-bold border transition-colors bg-[var(--color-surface)] text-[color:var(--color-text-secondary)] border-transparent hover:border-[var(--color-border)]"
                                            >
                                                Recent
                                            </button>
                                        </div>
                                    </div>
                                </div>
                        </div>
                    </aside>
                    </>
                )}
            </div>

            {isSelecting && selectedBooks.length > 0 && (
                <div className="fixed bottom-0 left-0 right-0 z-50 bg-[var(--color-surface)] border-t-2 border-[var(--color-accent)] shadow-[0_-8px_32px_rgba(0,0,0,0.15)] px-4 py-3 flex items-center gap-3 justify-center flex-wrap">
                    <span className="text-sm font-bold text-[color:var(--color-text-primary)] mr-2">
                        {selectedBooks.length} selected
                    </span>
                    <button
                        onClick={handleBatchMarkRead}
                        className="ui-btn px-3 py-1.5 text-xs font-bold border-2 uppercase"
                    >
                        <CheckCheck className="w-3.5 h-3.5" />
                        <span className="hidden sm:inline">Mark Read</span>
                    </button>
                    <button
                        onClick={handleBatchMarkUnread}
                        className="ui-btn px-3 py-1.5 text-xs font-bold border-2 uppercase"
                    >
                        <RotateCcw className="w-3.5 h-3.5" />
                        <span className="hidden sm:inline">Mark Unread</span>
                    </button>
                    <button
                        onClick={handleBatchAddToShelf}
                        className="ui-btn px-3 py-1.5 text-xs font-bold border-2 uppercase"
                    >
                        <BookMarked className="w-3.5 h-3.5" />
                        <span className="hidden sm:inline">Add to Shelf</span>
                    </button>
                    <button
                        onClick={handleBatchExport}
                        className="ui-btn px-3 py-1.5 text-xs font-bold border-2 uppercase"
                    >
                        <Download className="w-3.5 h-3.5" />
                        <span className="hidden sm:inline">Export</span>
                    </button>
                    <div className="h-5 w-px bg-[var(--color-border)]" />
                    <button
                        onClick={handleBatchDelete}
                        className="ui-btn px-3 py-1.5 text-xs font-bold border-2 uppercase bg-[var(--color-error)]/10 text-[var(--color-error)] border-[var(--color-error)]/30 hover:bg-[var(--color-error)]/20"
                    >
                        <Trash2 className="w-3.5 h-3.5" />
                        <span className="hidden sm:inline">Delete</span>
                    </button>
                </div>
            )}

            <BookInfoModal
                book={infoModalBook}
                isOpen={isInfoModalOpen}
                onClose={() => {
                    setIsInfoModalOpen(false);
                    setInfoModalBook(null);
                }}
                onEdit={handleRename}
            />

            <AddToShelfModal
                isOpen={isAddToShelfModalOpen}
                onClose={() => {
                    setIsAddToShelfModalOpen(false);
                    setAddToShelfBookId(null);
                }}
                bookId={addToShelfBookId}
                collections={collections}
                onAddToShelf={handleAddBookToShelf}
                onCreateShelf={handleCreateShelf}
            />

            <EditBookModal
                isOpen={isEditModalOpen}
                book={editBook}
                onClose={() => {
                    setIsEditModalOpen(false);
                    setEditBook(null);
                }}
            />

            {alertInfo && (
                <AlertDialog
                    isOpen={!!alertInfo}
                    title={alertInfo.title}
                    message={alertInfo.message}
                    okLabel="OK"
                    onClose={() => setAlertInfo(null)}
                />
            )}

            <ConfirmDialog
                isOpen={!!deleteConfirm}
                title={deleteConfirm?.batch ? "Delete Books" : "Delete Book"}
                message={deleteConfirm ? `Are you sure you want to delete "${deleteConfirm.title}"? This action cannot be undone.` : ""}
                confirmLabel="Delete"
                cancelLabel="Cancel"
                variant="danger"
                onConfirm={() => {
                    if (deleteConfirm?.batch) {
                        for (const id of selectedBooks) {
                            removeBook(id);
                        }
                        clearSelection();
                        setIsSelecting(false);
                    } else if (deleteConfirm?.bookId) {
                        removeBook(deleteConfirm.bookId);
                    }
                    setDeleteConfirm(null);
                }}
                onCancel={() => setDeleteConfirm(null)}
            />
        </div>
    );
}
