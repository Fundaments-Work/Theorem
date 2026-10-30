import { SELECT_ALL_EVENT } from "../../core/lib/keyboard-shortcuts";
import { useSmartShelves } from "../../core/lib/useSmartShelves";

import { useState, useMemo, useCallback, useEffect, useLayoutEffect, useRef, memo } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn } from "../../core/lib/utils";
import { getShelfColor, getShelfInitials } from "../../core/lib/design-tokens";
import { useFuzzyRank } from "../../core/lib/search/useFuzzyRank";
import { useLibraryStore, useUIStore, useSettingsStore } from "../../core/store";
import { ShelfModal } from "./components/modals/ShelfModal";
import { AssignSeriesModal } from "./components/modals/AssignSeriesModal";
import { SeriesGroupHeader } from "./components/SeriesGroupHeader";
import { SeriesGroupContinue } from "./components/SeriesGroupContinue";
import { TOOLBAR_ICON_BUTTON } from "../../ui/toolbar-styles";
import { Button, ConfirmDialog, PageHeader } from "../../ui";
import { MemoizedBookCard, BookInfoModal, AddToShelfModal, RenameBookModal } from "./Library";
import { LIBRARY_LIST_ROW_HEIGHT } from "./row-height";
import { getFilteredAndSortedBooks } from "./filtering";
import { useDebounce } from "../../core/lib/useDebounce";
import { twoTierSearchBooks } from "../../core/lib/sqlite-storage";
import { isTauri } from "../../core/lib/env";
import { exportBook } from "../../core/lib/book-export";
import { toast } from "sonner";
import {
    Layers,
    Plus,
    MoreVertical,
    Edit3,
    Trash2,
    BookOpen,
    Grid3X3,
    List,
    ArrowLeft,
    LayoutGrid,
    CheckCheck,
    BookMarked,
    RotateCcw,
    ListOrdered,
    MoreHorizontal,
    Check,
} from "lucide-react";
import type { Book, Collection, LibraryViewMode, SmartShelfDefinition } from "../../core/types";

const viewModeIcons: Record<LibraryViewMode, React.ReactNode> = {
    grid: <LayoutGrid className="w-4 h-4" />,
    list: <List className="w-4 h-4" />,
    compact: <Grid3X3 className="w-4 h-4" />,
};


function EmptyShelves({ onCreate }: { onCreate: () => void }) {
    return (
        <div className="mx-auto w-full max-w-[26rem] min-w-0 px-4 sm:px-6 flex flex-col items-center justify-center py-20 text-center animate-fade-in">
            <div className="w-16 h-16 bg-[var(--color-surface-muted)] flex items-center justify-center mb-6">
                <Layers className="w-6 h-6 text-[color:var(--color-text-secondary)]" />
            </div>
            <h2 className="w-full break-words text-balance text-lg text-[color:var(--color-text-primary)] mb-2">
                No Shelves Yet
            </h2>
            <p className="mx-auto w-full max-w-[24rem] break-words text-[color:var(--color-text-muted)] mb-8 text-sm leading-relaxed">
                Create shelves to organize your books your way.
            </p>
            <Button variant="primary"
                onClick={onCreate}
                 className={cn(
                    "min-w-[10.5rem] whitespace-nowrap px-6 py-2.5"
                )}
            >
                <Plus className="w-4 h-4" />
                <span>Create Shelf</span>
            </Button>
        </div>
    );
}

function EmptyShelfDetail({ shelfName, onAddBooks }: { shelfName: string; onAddBooks: () => void }) {
    return (
        <div className="mx-auto w-full max-w-[26rem] min-w-0 px-4 sm:px-6 flex flex-col items-center justify-center py-20 text-center animate-fade-in">
            <div className="w-16 h-16 bg-[var(--color-surface-muted)] flex items-center justify-center mb-6">
                <BookOpen className="w-6 h-6 text-[color:var(--color-text-secondary)]" />
            </div>
            <h2 className="w-full break-words text-balance text-lg text-[color:var(--color-text-primary)] mb-2">
                "{shelfName}" is Empty
            </h2>
            <p className="mx-auto w-full max-w-[24rem] break-words text-[color:var(--color-text-muted)] mb-8 text-sm leading-relaxed">
                Add books from your library to this shelf.
            </p>
            <Button variant="primary"
                onClick={onAddBooks}
                 className={cn(
                    "min-w-[10.5rem] whitespace-nowrap px-6 py-2.5"
                )}
            >
                <BookOpen className="w-4 h-4" />
                <span>Go to Library</span>
            </Button>
        </div>
    );
}

interface ShelfCardProps {
    shelf: Collection;
    books: Book[];
    actualBookCount: number;
    onClick: () => void;
    onEdit: () => void;
    onDelete: () => void;
}

const ShelfCard = memo(function ShelfCard({ shelf, books, actualBookCount, onClick, onEdit, onDelete }: ShelfCardProps) {
    const [showMenu, setShowMenu] = useState(false);
    const [menuUpward, setMenuUpward] = useState(false);
    const displayBooks = books.slice(0, 4);

    return (
        <div className="group relative border border-[var(--color-border)] bg-[var(--color-surface)] hover:border-[var(--color-text-muted)] transition-colors">
            
            <button onClick={onClick} className="block w-full">
                <div className="aspect-[16/10] bg-[var(--color-surface-muted)] p-4">
                    {displayBooks.length > 0 ? (
                        <div className="grid grid-cols-2 gap-2 h-full overflow-hidden">
                            {displayBooks.map((book, i) => (
                                <div
                                    key={book.id}
                                    className="relative overflow-hidden bg-[var(--color-surface)] h-full w-full"
                                    style={{
                                        transform: `translateY(${i % 2 === 1 ? "6px" : "0"})`,
                                    }}
                                >
                                    {book.coverPath ? (
                                        <img
                                            src={book.coverPath}
                                            alt={book.title}
                                            className="w-full h-full object-cover"
                                            loading="lazy"
                                        />
                                    ) : (
                                        <div className="w-full h-full bg-[var(--color-surface)] border border-[var(--color-border)] flex flex-col items-center justify-center p-1.5 text-center">
                                            <BookOpen className="w-4 h-4 text-[color:var(--color-text-muted)] mb-0.5 shrink-0" />
                                            <span className="text-[8px] font-serif text-[color:var(--color-text-secondary)] line-clamp-2 leading-tight">
                                                {book.title}
                                            </span>
                                        </div>
                                    )}
                                </div>
                            ))}
                            
                            {Array.from({ length: Math.max(0, 4 - displayBooks.length) }).map((_, i) => (
                                <div
                                    key={`empty-${i}`}
                                    className="bg-[var(--color-surface)]/50 border border-dashed border-[var(--color-border)]"
                                />
                            ))}
                        </div>
                    ) : (
                        <div className="flex flex-col items-center justify-center h-full">
                            <Layers className="w-12 h-12 text-[color:var(--color-text-muted)] mb-2" />
                            <span className="text-sm text-[color:var(--color-text-secondary)]">Empty Shelf</span>
                        </div>
                    )}
                </div>
            </button>

            <div className="p-4">
                <div className="flex items-center gap-3">
                    
                    <div
                        className="w-10 h-10 flex items-center justify-center text-sm flex-shrink-0"
                        style={{
                            backgroundColor: getShelfColor(shelf.id, shelf.name).bg,
                            color: getShelfColor(shelf.id, shelf.name).text,
                        }}
                    >
                        {getShelfInitials(shelf.name)}
                    </div>

                    <div className="flex-1 min-w-0 overflow-hidden">
                        <button onClick={onClick} className="text-left w-full">
                            <h3 className="text-[color:var(--color-text-primary)] truncate group-hover:text-[color:var(--color-accent)] transition-colors">
                                {shelf.name}
                            </h3>
                        </button>
                        <p className="text-xs text-[color:var(--color-text-muted)] mt-0.5">
                            {shelf.smartRules ? "Smart shelf · " : ""}{actualBookCount} {actualBookCount === 1 ? "book" : "books"}
                        </p>
                    </div>

                    <div className="relative flex-shrink-0">
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                const btnRect = e.currentTarget.getBoundingClientRect();
                                const spaceBelow = window.innerHeight - btnRect.bottom;
                                setMenuUpward(spaceBelow < 130);
                                setShowMenu(!showMenu);
                            }}
                            className="p-1.5 text-[color:var(--color-text-muted)] sm:opacity-0 sm:group-hover:opacity-100 transition-opacity hover:text-[color:var(--color-accent)]"
                            aria-label={`Actions for ${shelf.name}`}
                        >
                            <MoreVertical className="w-4 h-4" />
                        </button>
                        {showMenu && (
                            <>
                                <div
                                    className="fixed inset-0 z-10"
                                    onClick={() => { setShowMenu(false); setMenuUpward(false); }}
                                />
                                <div
                                    className={cn(
                                        "absolute right-0 w-36 border border-[var(--color-border)] bg-[var(--color-surface)] z-20 py-1",
                                        menuUpward ? "bottom-full mb-1" : "top-full mt-1",
                                    )}
                                >
                                    <button
                                        onClick={() => {
                                            onEdit();
                                            setShowMenu(false);
                                        }}
                                        className="w-full flex items-center gap-2 px-3 py-2 text-sm text-[color:var(--color-text-primary)] hover:bg-[var(--color-surface-muted)]"
                                    >
                                        <Edit3 className="w-4 h-4" />
                                        Edit
                                    </button>
                                    <button
                                        onClick={() => {
                                            onDelete();
                                            setShowMenu(false);
                                        }}
                                        className="w-full flex items-center gap-2 px-3 py-2 text-sm text-[color:var(--color-error)] hover:bg-[var(--color-surface-muted)]"
                                    >
                                        <Trash2 className="w-4 h-4" />
                                        Delete
                                    </button>
                                </div>
                            </>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
});

interface ShelfDetailProps {
    shelf: Collection;
    onBack: () => void;
    onNavigate: (id: string) => void;
    onCreateChild: () => void;
}

function ShelfDetail({ shelf, onBack, onNavigate, onCreateChild }: ShelfDetailProps) {
    const books = useLibraryStore((state) => state.books);
    const collections = useLibraryStore((state) => state.collections);
    const addCollection = useLibraryStore((state) => state.addCollection);
    const addBookToCollection = useLibraryStore((state) => state.addBookToCollection);
    const addBooksToCollection = useLibraryStore((state) => state.addBooksToCollection);
    const removeBookFromCollection = useLibraryStore((state) => state.removeBookFromCollection);
    const removeBooksFromCollection = useLibraryStore((state) => state.removeBooksFromCollection);
    const removeBook = useLibraryStore((state) => state.removeBook);
    const removeBooks = useLibraryStore((state) => state.removeBooks);
    const toggleFavorite = useLibraryStore((state) => state.toggleFavorite);
    const updateBook = useLibraryStore((state) => state.updateBook);
    const updateCollection = useLibraryStore((state) => state.updateCollection);
    const getBook = useLibraryStore((state) => state.getBook);
    const markBookCompleted = useLibraryStore((state) => state.markBookCompleted);
    const markBookUnread = useLibraryStore((state) => state.markBookUnread);
    const markBooksCompleted = useLibraryStore((state) => state.markBooksCompleted);
    const markBooksUnread = useLibraryStore((state) => state.markBooksUnread);

    const setRoute = useUIStore((state) => state.setRoute);
    const searchQuery = useUIStore((state) => state.searchQuery);
    const selectedBooks = useUIStore((state) => state.selectedBooks);
    const setSelectedBooks = useUIStore((state) => state.setSelectedBooks);
    const toggleBookSelection = useUIStore((state) => state.toggleBookSelection);
    const clearSelection = useUIStore((state) => state.clearSelection);
    const [isSelecting, setIsSelecting] = useState(false);
    const lastSelectedIndexRef = useRef<number | null>(null);
    const settings = useSettingsStore((state) => state.settings);
    const updateSettings = useSettingsStore((state) => state.updateSettings);

    const allSelectedCompleted = useMemo(() => {
        if (selectedBooks.length === 0) return false;
        const selectedSet = new Set(selectedBooks);
        const targetBooks = books.filter((b) => selectedSet.has(b.id));
        return targetBooks.length > 0 && targetBooks.every((b) => !!b.completedAt);
    }, [selectedBooks, books]);
    
    const viewMode = settings.libraryViewMode;

    const [infoModalBook, setInfoModalBook] = useState<Book | null>(null);
    const [isInfoModalOpen, setIsInfoModalOpen] = useState(false);
    const [addToShelfBookId, setAddToShelfBookId] = useState<string | null>(null);
    const [isAddToShelfModalOpen, setIsAddToShelfModalOpen] = useState(false);
    const [renameBook, setRenameBook] = useState<Book | null>(null);
    const [isRenameModalOpen, setIsRenameModalOpen] = useState(false);
    const [deleteBookInfo, setDeleteBookInfo] = useState<{ bookId: string; title: string } | null>(null);
    const [batchDeleteIds, setBatchDeleteIds] = useState<string[] | null>(null);

    const handleCreateShelf = (name: string) => {
        addCollection({
            id: crypto.randomUUID(),
            name,
            bookIds: [],
            kind: "general",
            createdAt: new Date(),
        });
    };

    const handleRename = useCallback((book: Book) => {
        setRenameBook(book);
        setIsRenameModalOpen(true);
    }, []);

    const handleRenameSave = useCallback((bookId: string, newTitle: string) => {
        updateBook(bookId, { title: newTitle });
        setRenameBook(null);
        setIsRenameModalOpen(false);
    }, [updateBook]);

    const handleExport = useCallback(async (book: Book) => {
        const result = await exportBook(book);
        if (result.ok) {
            toast.success(result.message || "Book exported successfully.");
        } else {
            toast.error(result.message || "Something went wrong while exporting the book.");
        }
    }, []);

    const debouncedSearchQuery = useDebounce(searchQuery, 250);

    // Same native search as the Library (FTS5 candidates, nucleo ranking).
    const [ftsSearchIds, setFtsSearchIds] = useState<string[] | undefined>(undefined);
    const [nativeSearchFailed, setNativeSearchFailed] = useState(false);
    useEffect(() => {
        if (!isTauri() || !debouncedSearchQuery.trim()) {
            setFtsSearchIds(undefined);
            return;
        }
        let cancelled = false;
        // Previous results stay until the new ones arrive.
        twoTierSearchBooks(debouncedSearchQuery.trim(), 200).then(
            (results) => {
                if (cancelled) return;
                setNativeSearchFailed(false);
                setFtsSearchIds(results.map((r) => r.bookId));
            },
            () => {
                if (cancelled) return;
                setNativeSearchFailed(true);
                setFtsSearchIds(undefined);
            },
        );
        return () => { cancelled = true; };
    }, [debouncedSearchQuery]);

    const shelfBooks = useMemo(() => {
        const shelfBookIdsSet = new Set(shelf.bookIds);
        return getFilteredAndSortedBooks({
            books,
            searchQuery: debouncedSearchQuery,
            selectedShelfBookIds: shelfBookIdsSet,
            showFavoritesOnly: false,
            statusFilter: "all",
            sortBy: settings.librarySortBy,
            sortOrder: settings.librarySortOrder,
            ftsSearchIds,
            nativeSearchPending: isTauri() && !nativeSearchFailed,
        });
    }, [shelf.bookIds, books, debouncedSearchQuery, settings.librarySortBy, settings.librarySortOrder, ftsSearchIds, nativeSearchFailed]);

    // Shelf-aware multi-selection (#109). Shares uiStore.selectedBooks with
    // the library view; range select via Shift+click over shelfBooks order.
    const selectedBookIds = useMemo(() => new Set(selectedBooks), [selectedBooks]);

    const handleToggleSelect = useCallback((bookId: string, event?: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) => {
        const index = shelfBooks.findIndex((b) => b.id === bookId);
        if (event?.shiftKey && lastSelectedIndexRef.current !== null && index >= 0) {
            const [from, to] = [
                Math.min(lastSelectedIndexRef.current, index),
                Math.max(lastSelectedIndexRef.current, index),
            ];
            const rangeIds = shelfBooks.slice(from, to + 1).map((b) => b.id);
            const merged = [...selectedBooks];
            for (const id of rangeIds) {
                if (!merged.includes(id)) merged.push(id);
            }
            setSelectedBooks(merged);
            return;
        }
        if (index >= 0) lastSelectedIndexRef.current = index;
        toggleBookSelection(bookId);
    }, [shelfBooks, selectedBooks, setSelectedBooks, toggleBookSelection]);

    const handleSelectAll = useCallback(() => {
        setSelectedBooks(shelfBooks.map((b) => b.id));
    }, [shelfBooks, setSelectedBooks]);

    // Ctrl/Cmd+A: enter selection mode and select every book on this shelf.
    useEffect(() => {
        const onSelectAll = () => {
            if (useUIStore.getState().currentRoute !== "shelves" || shelfBooks.length === 0) return;
            setIsSelecting(true);
            setSelectedBooks(shelfBooks.map((b) => b.id));
        };
        window.addEventListener(SELECT_ALL_EVENT, onSelectAll);
        return () => window.removeEventListener(SELECT_ALL_EVENT, onSelectAll);
    }, [shelfBooks, setSelectedBooks]);

    const handleToggleSelectMode = useCallback(() => {
        if (isSelecting) {
            clearSelection();
            lastSelectedIndexRef.current = null;
        }
        setIsSelecting((prev) => !prev);
    }, [isSelecting, clearSelection]);

    const handleStartSelect = useCallback((bookId: string) => {
        setIsSelecting(true);
        setSelectedBooks([bookId]);
    }, [setSelectedBooks]);

    const handleRemoveSelectedFromShelf = useCallback(() => {
        removeBooksFromCollection(selectedBooks, shelf.id);
        clearSelection();
        setIsSelecting(false);
    }, [removeBooksFromCollection, selectedBooks, shelf.id, clearSelection]);

    const handleBatchMarkRead = useCallback(() => {
        const ids = [...selectedBooks];
        markBooksCompleted(ids);
        clearSelection();
        setIsSelecting(false);
        toast.success(`Marked ${ids.length} ${ids.length === 1 ? "book" : "books"} as read`, {
            duration: 7000,
            action: {
                label: "Undo",
                onClick: () => {
                    markBooksUnread(ids);
                    toast.info(`Restored ${ids.length} ${ids.length === 1 ? "book" : "books"} to unread`);
                },
            },
        });
    }, [selectedBooks, markBooksCompleted, markBooksUnread, clearSelection]);

    const handleBatchMarkUnread = useCallback(() => {
        const ids = [...selectedBooks];
        markBooksUnread(ids);
        clearSelection();
        setIsSelecting(false);
        toast.success(`Marked ${ids.length} ${ids.length === 1 ? "book" : "books"} as unread`, {
            duration: 7000,
            action: {
                label: "Undo",
                onClick: () => {
                    markBooksCompleted(ids);
                    toast.info(`Restored ${ids.length} ${ids.length === 1 ? "book" : "books"} to read`);
                },
            },
        });
    }, [selectedBooks, markBooksUnread, markBooksCompleted, clearSelection]);

    const [isSeriesModalOpen, setIsSeriesModalOpen] = useState(false);
    const [seriesModalBookIds, setSeriesModalBookIds] = useState<string[]>([]);
    const [seriesModalInitialName, setSeriesModalInitialName] = useState<string | undefined>(undefined);

    const handleOpenSeriesModalForSelection = useCallback(() => {
        setSeriesModalBookIds([...selectedBooks]);
        const firstWithSeries = shelfBooks.find((b) => selectedBooks.includes(b.id) && b.series?.trim());
        setSeriesModalInitialName(firstWithSeries?.series?.trim() || shelf.name);
        setIsSeriesModalOpen(true);
    }, [selectedBooks, shelfBooks, shelf.name]);

    const handleOpenSeriesModalForShelf = useCallback(() => {
        setSeriesModalBookIds(shelf.bookIds);
        setSeriesModalInitialName(shelf.name);
        setIsSeriesModalOpen(true);
    }, [shelf.bookIds, shelf.name]);

    // Shelves the targeted book already belongs to, so the dialog toggles
    // membership rather than only adding.
    const addToShelfMembership = useMemo(() => {
        if (!addToShelfBookId) return undefined;
        const bookId = addToShelfBookId;
        return new Set(
            collections.filter((c) => c.kind === "general" && c.bookIds.includes(bookId)).map((c) => c.id),
        );
    }, [addToShelfBookId, collections]);

    const scrollRef = useRef<HTMLDivElement>(null);
    const currentRoute = useUIStore((state) => state.currentRoute);
    const isListView = viewMode === "list";
    const isCompactView = viewMode === "compact";

    // First paint must already match the viewport (see Library.tsx): the
    // observer only corrects after mount, flashing 4 tiny columns on phones.
    const [cols, setCols] = useState(() => {
        if (typeof window === "undefined") return 4;
        const w = window.innerWidth;
        if (viewMode === "list") return 1;
        if (viewMode === "compact") {
            if (w >= 1280) return 6;
            if (w >= 1024) return 5;
            if (w >= 640) return 4;
            return 3;
        }
        if (w >= 1440) return 6;
        if (w >= 1150) return 5;
        if (w >= 850) return 4;
        if (w >= 640) return 3;
        return 2;
    });

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
            if (w >= 1440) return 6;
            if (w >= 1150) return 5;
            if (w >= 850) return 4;
            if (w >= 640) return 3;
            return 2;
        };
        let lastWidth = el.clientWidth;
        const observer = new ResizeObserver(() => {
            const currentWidth = el.clientWidth;
            setCols(compute());
            if (lastWidth === 0 && currentWidth > 0) {
                rowVirtualizer.measure();
            }
            lastWidth = currentWidth;
        });
        observer.observe(el);
        return () => observer.disconnect();
    }, [isListView, isCompactView]);

    const effectiveCols = isListView ? 1 : cols;

    const rowCount = isListView
        ? shelfBooks.length
        : Math.ceil(shelfBooks.length / Math.max(effectiveCols, 1));

    const getEstimateSize = useCallback(() => {
        // Must equal the rendered row height or rows overlap. See
        // LIBRARY_LIST_ROW_HEIGHT in Library.tsx.
        if (isListView) return LIBRARY_LIST_ROW_HEIGHT;
        const el = scrollRef.current;
        if (!el) return 300;
        const gap = isCompactView ? 8 : 20;
        const containerWidth = el.clientWidth > 0
            ? el.clientWidth
            : (typeof window !== "undefined" && window.innerWidth > 0 ? window.innerWidth : 300);
        const cardW = Math.max(1, (containerWidth - (effectiveCols - 1) * gap) / Math.max(effectiveCols, 1));
        const textH = isCompactView ? 0 : 72;
        return Math.round(cardW * 1.5 + textH + gap);
    }, [isListView, isCompactView, effectiveCols]);

    const getItemKey = useCallback(
        (index: number) => `${viewMode}-${index}`,
        [viewMode],
    );

    const rowVirtualizer = useVirtualizer({
        count: rowCount,
        getScrollElement: useCallback(() => scrollRef.current, []),
        estimateSize: getEstimateSize,
        getItemKey,
        overscan: 3,
    });

    useLayoutEffect(() => {
        if (currentRoute === "shelves") {
            rowVirtualizer.measure();
        }
    }, [currentRoute, rowVirtualizer, viewMode, effectiveCols, isCompactView, isListView]);

    const handleOpenBook = (book: Book) => {
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
    };

    const handleGoToLibrary = () => {
        
        sessionStorage.setItem("theorem-selected-shelf", shelf.id);
        setRoute("library");
    };

    const cycleViewMode = () => {
        const modes: LibraryViewMode[] = ["grid", "list", "compact"];
        const currentIndex = modes.indexOf(viewMode);
        const nextMode = modes[(currentIndex + 1) % modes.length];
        updateSettings({ libraryViewMode: nextMode });
    };

    const childShelves = useMemo(() => collections.filter((c) => c.parentId === shelf.id), [collections, shelf.id]);

    const [showShelfMenu, setShowShelfMenu] = useState(false);
    const shelfMenuRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!showShelfMenu) return;
        const handleClickOutside = (e: MouseEvent) => {
            if (shelfMenuRef.current && !shelfMenuRef.current.contains(e.target as Node)) {
                setShowShelfMenu(false);
            }
        };
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                setShowShelfMenu(false);
            }
        };
        document.addEventListener("mousedown", handleClickOutside);
        document.addEventListener("keydown", handleKeyDown);
        return () => {
            document.removeEventListener("mousedown", handleClickOutside);
            document.removeEventListener("keydown", handleKeyDown);
        };
    }, [showShelfMenu]);

    return (
        <div className="flex min-h-0 flex-1 flex-col animate-fade-in">
            {!shelf.parentId && childShelves.length > 0 && (
                <nav aria-label="Sub-shelves" className="flex flex-wrap items-center gap-2 mb-4">
                    {childShelves.map((child) => (
                        <Button key={child.id}  className="text-xs py-1" onClick={() => onNavigate(child.id)}>{child.name}</Button>
                    ))}
                    <Button variant="ghost"  className="text-xs py-1" onClick={onCreateChild} title="New sub-shelf">
                        <Plus className="w-3.5 h-3.5" />
                        <span>New sub-shelf</span>
                    </Button>
                </nav>
            )}
            <div className="-mb-4">
                <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex items-center gap-3 sm:gap-4 min-w-0">
                        {/* Navigation, not a toolbar action: a borderless ghost
                            control so it does not compete with the shelf avatar
                            beside it, at the app's 44px phone touch minimum. */}
                        <button
                            onClick={onBack}
                            aria-label="Back to shelves"
                            title="Back to shelves"
                            className="inline-flex items-center justify-center shrink-0 h-11 w-11 sm:h-10 sm:w-10 -ml-1 text-[color:var(--color-text-primary)] transition-colors duration-200 ease-out touch-manipulation hover:text-[color:var(--color-accent)]"
                        >
                            <ArrowLeft className="w-5 h-5" />
                        </button>
                        
                        <div
                            className="w-10 h-10 sm:w-11 sm:h-11 flex items-center justify-center text-sm shrink-0"
                            style={{
                                backgroundColor: getShelfColor(shelf.id, shelf.name).bg,
                                color: getShelfColor(shelf.id, shelf.name).text,
                            }}
                        >
                            {getShelfInitials(shelf.name)}
                        </div>
                        <div className="min-w-0">
                            <h1 className="m-0 font-sans text-xl leading-[1.1] text-[color:var(--color-text-primary)] sm:text-2xl truncate">
                                {shelf.name}
                            </h1>
                            <p className="mt-1 text-sm leading-relaxed text-[color:var(--color-text-secondary)]">
                                {shelfBooks.length} {shelfBooks.length === 1 ? "book" : "books"}
                            </p>
                        </div>
                    </div>

                    <div className="flex w-full items-center gap-2 sm:ml-0 sm:w-auto sm:gap-3 flex-wrap">
                        <Button variant="primary"
                            onClick={handleGoToLibrary}
                            disabled={!!shelf.smartRules}
                             className={cn("h-11 px-3.5 py-2 sm:h-auto sm:px-4")}
                            title={shelf.smartRules ? "Membership is managed by this shelf's rules" : "Add books from library"}
                        >
                            <Plus className="w-4 h-4" />
                            <span className="hidden sm:inline">Add Books</span>
                            <span className="sm:hidden">Add</span>
                        </Button>

                        <Button
                            data-action="toggle-select-mode"
                            onClick={handleToggleSelectMode}
                            disabled={shelfBooks.length === 0}
                             className={cn(
                                TOOLBAR_ICON_BUTTON, "border-2",
                                shelfBooks.length === 0 && "opacity-50 cursor-not-allowed",
                                isSelecting ? "ui-selected" : "sr-only"
                            )}
                            title={isSelecting ? "Cancel Selection" : "Select Books"}
                        >
                            <CheckCheck className="w-4 h-4" />
                        </Button>

                        <Button
                            onClick={cycleViewMode}
                             className={cn(TOOLBAR_ICON_BUTTON, "border-2")}
                            title={`View: ${viewMode}`}
                        >
                            {viewModeIcons[viewMode]}
                        </Button>

                        <div className="relative" ref={shelfMenuRef}>
                            <Button
                                onClick={() => setShowShelfMenu((prev) => !prev)}
                                aria-label="More actions"
                                aria-expanded={showShelfMenu}
                                 className={cn(
                                    TOOLBAR_ICON_BUTTON,
                                    "border-2 transition-colors",
                                    showShelfMenu ? "ui-selected" : ""
                                )}
                                title="More actions"
                            >
                                <MoreHorizontal className="w-4 h-4" />
                            </Button>

                            <div
                                className={cn(
                                    "absolute right-0 top-full mt-2 w-56 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-lg py-1.5 z-30 transition-[opacity,transform] duration-150 origin-top-right",
                                    showShelfMenu
                                        ? "opacity-100 scale-100 pointer-events-auto"
                                        : "opacity-0 scale-95 pointer-events-none"
                                )}
                            >
                                <button
                                    onClick={() => {
                                        setShowShelfMenu(false);
                                        updateCollection(shelf.id, { groupBySeries: !shelf.groupBySeries });
                                    }}
                                    disabled={shelfBooks.length === 0}
                                    className="w-full flex items-center justify-between gap-3 px-3 py-2 text-xs text-left hover:bg-[var(--color-surface-hover,#0000000a)] cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed text-[color:var(--color-text-primary)] transition-colors"
                                    title={shelf.groupBySeries ? "Ungroup Series" : "Group by Series"}
                                >
                                    <span className="flex items-center gap-2.5">
                                        <ListOrdered className="w-4 h-4 text-[color:var(--color-text-secondary)] shrink-0" />
                                        <span>Group by Series</span>
                                    </span>
                                    {shelf.groupBySeries && (
                                        <Check className="w-3.5 h-3.5 text-[color:var(--color-accent)] shrink-0" />
                                    )}
                                </button>

                                <button
                                    onClick={() => {
                                        setShowShelfMenu(false);
                                        handleOpenSeriesModalForShelf();
                                    }}
                                    disabled={shelfBooks.length === 0}
                                    className="w-full flex items-center gap-2.5 px-3 py-2 text-xs text-left hover:bg-[var(--color-surface-hover,#0000000a)] cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed text-[color:var(--color-text-primary)] transition-colors"
                                    title="Create / Manage Series from Shelf"
                                >
                                    <BookOpen className="w-4 h-4 text-[color:var(--color-accent)] shrink-0" />
                                    <span>Manage Series…</span>
                                </button>

                                <button
                                    onClick={() => {
                                        setShowShelfMenu(false);
                                        handleToggleSelectMode();
                                    }}
                                    disabled={shelfBooks.length === 0}
                                    className="w-full flex items-center gap-2.5 px-3 py-2 text-xs text-left hover:bg-[var(--color-surface-hover,#0000000a)] cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed text-[color:var(--color-text-primary)] transition-colors"
                                    title="Select Books"
                                >
                                    <CheckCheck className="w-4 h-4 text-[color:var(--color-text-secondary)] shrink-0" />
                                    <span>Select Books</span>
                                </button>

                                {!shelf.parentId && (
                                    <>
                                        <div className="my-1 border-t border-[var(--color-border-subtle)]" />
                                        <button
                                            onClick={() => {
                                                setShowShelfMenu(false);
                                                onCreateChild();
                                            }}
                                            className="w-full flex items-center gap-2.5 px-3 py-2 text-xs text-left hover:bg-[var(--color-surface-hover,#0000000a)] cursor-pointer text-[color:var(--color-text-primary)] transition-colors"
                                            title="New sub-shelf"
                                        >
                                            <Plus className="w-4 h-4 text-[color:var(--color-text-secondary)] shrink-0" />
                                            <span>New sub-shelf…</span>
                                        </button>
                                    </>
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            {shelf.bookIds.length === 0 ? (
                <>{shelf.smartRules ? <p className="py-16 text-center text-[color:var(--color-text-muted)]">No books match this smart shelf.</p> : <EmptyShelfDetail shelfName={shelf.name} onAddBooks={handleGoToLibrary} />}</>
            ) : (
                <div className="flex min-h-0 flex-1 flex-col md:flex-row gap-6 md:gap-10 relative">
                    <div className="flex min-h-0 flex-1 flex-col w-full">
                        <section ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto overscroll-contain scrollbar-solid pb-[calc(var(--layout-bottom-nav-height)+var(--safe-area-bottom)+var(--spacing-lg))] md:pb-0">
                {shelfBooks.length === 0 ? (
                    <div className="text-center py-16 border-2 border-dashed border-[var(--color-border)]">
                        <p className="text-[color:var(--color-text-muted)] text-xs">No documents match criteria</p>
                        {searchQuery && (
                            <button onClick={() => useUIStore.getState().setSearchQuery("")} className="mt-4 text-[10px] text-[color:var(--color-accent)] hover:underline tracking-tighter">
                                [ RESET SEARCH ]
                            </button>
                        )}
                    </div>
                ) : shelf.groupBySeries ? (
                    // ── Series-grouped view ────────────────────────────────────────────
                    (() => {
                        const seriesMap = new Map<string, Book[]>();
                        const standalone: Book[] = [];
                        for (const book of shelfBooks) {
                            if (book.series) {
                                const group = seriesMap.get(book.series);
                                if (group) group.push(book);
                                else seriesMap.set(book.series, [book]);
                            } else {
                                standalone.push(book);
                            }
                        }
                        // Sort each series group by seriesIndex ascending
                        for (const group of seriesMap.values()) {
                            group.sort((a, b) => (a.seriesIndex ?? Infinity) - (b.seriesIndex ?? Infinity));
                        }
                        // Sort series names alphabetically
                        const sortedSeries = [...seriesMap.entries()].sort(([a], [b]) => a.localeCompare(b));

                        const cardProps = {
                            onOpenBook: handleOpenBook,
                            onToggleFavorite: toggleFavorite,
                            onDeleteBook: (id: string) => {
                                const book = getBook(id);
                                if (book) setDeleteBookInfo({ bookId: book.id, title: book.title });
                            },
                            onShowInfo: (b: Book) => { setInfoModalBook(b); setIsInfoModalOpen(true); },
                            onAddToShelf: (id: string) => { setAddToShelfBookId(id); setIsAddToShelfModalOpen(true); },
                            onRename: handleRename,
                            onExport: handleExport,
                            renameMenuLabel: "Rename",
                            onMarkAsRead: markBookCompleted,
                            onMarkAsUnread: markBookUnread,
                            onStartSelect: handleStartSelect,
                        };

                        return (
                            <div className="space-y-8">
                                {sortedSeries.map(([seriesName, group]) => {
                                    return (
                                        <div key={seriesName} className="space-y-4">
                                            <SeriesGroupHeader
                                                seriesName={seriesName}
                                                group={group}
                                            />
                                            {/* Own row beneath the header: the header stays
                                                purely static, so the scroll anchor cannot
                                                shift when this button appears/disappears. */}
                                            <SeriesGroupContinue
                                                group={group}
                                                onContinue={handleOpenBook}
                                            />
                                            <div
                                                style={{
                                                    display: "grid",
                                                    gridTemplateColumns: isListView ? "1fr" : `repeat(${effectiveCols}, minmax(0, 1fr))`,
                                                    gap: isCompactView ? "8px" : "20px",
                                                }}
                                            >
                                                {group.map((book) => (
                                                    <MemoizedBookCard
                                                        key={book.id} book={book} viewMode={viewMode}
                                                        isSelecting={isSelecting} isSelected={selectedBookIds.has(book.id)} onToggleSelect={handleToggleSelect}
                                                        {...cardProps}
                                                    />
                                                ))}
                                            </div>
                                        </div>
                                    );
                                })}
                                {standalone.length > 0 && (
                                    <div>
                                        <div className="flex items-center gap-3 mb-4">
                                            <h2 className="text-sm text-[color:var(--color-text-muted)]">
                                                Standalone
                                            </h2>
                                            <div className="flex-1 border-t border-[var(--color-border)]" />
                                        </div>
                                        <div
                                            style={{
                                                display: "grid",
                                                gridTemplateColumns: isListView ? "1fr" : `repeat(${effectiveCols}, minmax(0, 1fr))`,
                                                gap: isCompactView ? "8px" : "20px",
                                            }}
                                        >
                                            {standalone.map((book) => (
                                                <MemoizedBookCard
                                                    key={book.id} book={book} viewMode={viewMode}
                                                    isSelecting={isSelecting} isSelected={selectedBookIds.has(book.id)} onToggleSelect={handleToggleSelect}
                                                    {...cardProps}
                                                />
                                            ))}
                                        </div>
                                    </div>
                                )}
                            </div>
                        );
                    })()
                ) : (
                // ── Flat virtualizer view (default) ───────────────────────────────
                <div style={{ height: `${rowVirtualizer.getTotalSize()}px`, position: "relative" }}>
                        {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                            const rowStart = virtualRow.index * (isListView ? 1 : effectiveCols);
                            const itemsInRow = isListView
                                ? 1
                                : Math.min(effectiveCols, shelfBooks.length - rowStart);
                            const rowItems = isListView
                                ? [shelfBooks[virtualRow.index]]
                                : shelfBooks.slice(rowStart, rowStart + itemsInRow);

                            const cardProps = {
                                onOpenBook: handleOpenBook,
                                onToggleFavorite: toggleFavorite,
                                onDeleteBook: (id: string) => {
                                    const book = getBook(id);
                                    if (book) setDeleteBookInfo({ bookId: book.id, title: book.title });
                                },
                                onShowInfo: (b: Book) => { setInfoModalBook(b); setIsInfoModalOpen(true); },
                                onAddToShelf: (id: string) => { setAddToShelfBookId(id); setIsAddToShelfModalOpen(true); },
                                onRename: handleRename,
                                onExport: handleExport,
                                renameMenuLabel: "Rename",
                                onMarkAsRead: markBookCompleted,
                                onMarkAsUnread: markBookUnread,
                                onStartSelect: handleStartSelect,
                            };

                            return (
                                <div
                                    key={virtualRow.key}
                                    data-index={virtualRow.index}
                                    style={{
                                        position: "absolute",
                                        top: 0,
                                        left: 0,
                                        width: "100%",
                                        transform: `translateY(${virtualRow.start}px)`,
                                    }}
                                >
                                    {isListView ? (
                                        <div className="pb-1">
                                            <MemoizedBookCard
                                                key={rowItems[0].id} book={rowItems[0]} viewMode={viewMode}
                                                isSelecting={isSelecting} isSelected={selectedBookIds.has(rowItems[0].id)} onToggleSelect={handleToggleSelect}
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
                                                    key={book.id} book={book} viewMode={viewMode}
                                                    isSelecting={isSelecting} isSelected={selectedBookIds.has(book.id)} onToggleSelect={handleToggleSelect}
                                                    {...cardProps}
                                                />
                                            ))}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                </div>
                )}
                        </section>
                    </div>
                </div>
            )}
            {isSelecting && selectedBooks.length > 0 && (
                <div className="fixed bottom-[calc(var(--layout-bottom-nav-height)+var(--safe-area-bottom))] md:bottom-0 left-0 right-0 z-50 bg-[var(--color-surface)] border-t-2 border-[var(--color-accent)] shadow-[0_-8px_32px_rgba(0,0,0,0.15)] px-4 py-3 flex items-center gap-3 justify-center flex-wrap">
                    <span className="text-sm text-[color:var(--color-text-primary)] mr-2">
                        {selectedBooks.length} selected
                    </span>
                    <Button
                        onClick={handleSelectAll}
                         className="px-3 py-1.5 text-xs border-2"
                    >
                        <CheckCheck className="w-3.5 h-3.5" />
                        <span className="hidden sm:inline">Select All</span>
                    </Button>
                    <Button
                        disabled={!!shelf.smartRules}
                        title={shelf.smartRules ? "Membership is managed by this shelf's rules" : undefined}
                        onClick={handleRemoveSelectedFromShelf}
                         className="px-3 py-1.5 text-xs border-2"
                    >
                        <BookMarked className="w-3.5 h-3.5" />
                        <span className="hidden sm:inline">Remove from Shelf</span>
                    </Button>
                    <Button
                        onClick={() => { setAddToShelfBookId(null); setIsAddToShelfModalOpen(true); }}
                         className="px-3 py-1.5 text-xs border-2"
                    >
                        <Plus className="w-3.5 h-3.5" />
                        <span className="hidden sm:inline">Add to Shelf</span>
                    </Button>
                    {allSelectedCompleted ? (
                        <Button
                            onClick={handleBatchMarkUnread}
                             className="px-3 py-1.5 text-xs border-2"
                        >
                            <RotateCcw className="w-3.5 h-3.5" />
                            <span className="hidden sm:inline">Mark Unread</span>
                        </Button>
                    ) : (
                        <Button
                            onClick={handleBatchMarkRead}
                             className="px-3 py-1.5 text-xs border-2"
                        >
                            <CheckCheck className="w-3.5 h-3.5 text-[color:var(--color-accent)]" />
                            <span className="hidden sm:inline">Mark Read</span>
                        </Button>
                    )}
                    <Button
                        onClick={handleOpenSeriesModalForSelection}
                         className="px-3 py-1.5 text-xs border-2"
                    >
                        <ListOrdered className="w-3.5 h-3.5" />
                        <span className="hidden sm:inline">Set Series</span>
                    </Button>
                    <div className="h-5 w-px bg-[var(--color-border)]" />
                    <Button
                        onClick={() => setBatchDeleteIds([...selectedBooks])}
                         className="px-3 py-1.5 text-xs border-2 bg-[var(--color-error)]/10 text-[color:var(--color-error)] border-[var(--color-error)]/30 hover:bg-[var(--color-error)]/20"
                    >
                        <Trash2 className="w-3.5 h-3.5" />
                        <span className="hidden sm:inline">Delete</span>
                    </Button>
                    <Button variant="primary"
                        onClick={() => {
                            clearSelection();
                            setIsSelecting(false);
                        }}
                         className="px-3 py-1.5 text-xs border-2 ml-auto"
                        title="Done selecting"
                    >
                        <span>Done</span>
                    </Button>
                </div>
            )}
            <BookInfoModal
                book={infoModalBook}
                isOpen={isInfoModalOpen}
                onClose={() => setIsInfoModalOpen(false)}
            />
            <AddToShelfModal
                isOpen={isAddToShelfModalOpen}
                onClose={() => { setIsAddToShelfModalOpen(false); setAddToShelfBookId(null); }}
                bookId={addToShelfBookId}
                collections={collections.filter(c => c.kind === "general")}
                currentShelfIds={addToShelfMembership}
                onAddToShelf={(bookId, shelfId) => {
                    if (bookId) {
                        addBookToCollection(bookId, shelfId);
                    } else {
                        addBooksToCollection(selectedBooks, shelfId);
                        clearSelection();
                        setIsSelecting(false);
                    }
                }}
                onRemoveFromShelf={(shelfId) => {
                    if (addToShelfBookId) {
                        removeBookFromCollection(addToShelfBookId, shelfId);
                    }
                }}
                onCreateShelf={handleCreateShelf}
            />
            <AssignSeriesModal
                isOpen={isSeriesModalOpen}
                onClose={() => {
                    setIsSeriesModalOpen(false);
                    if (isSelecting) {
                        clearSelection();
                        setIsSelecting(false);
                    }
                }}
                bookIds={seriesModalBookIds}
                initialSeriesName={seriesModalInitialName}
                shelfId={shelf.id}
            />

            <RenameBookModal
                isOpen={isRenameModalOpen}
                book={renameBook}
                onClose={() => {
                    setIsRenameModalOpen(false);
                    setRenameBook(null);
                }}
                onSave={handleRenameSave}
            />

            <ConfirmDialog
                isOpen={!!deleteBookInfo}
                title="Delete Book"
                message={deleteBookInfo ? `Are you sure you want to delete "${deleteBookInfo.title}"? This action cannot be undone.` : ""}
                confirmLabel="Delete"
                cancelLabel="Cancel"
                variant="danger"
                onConfirm={() => {
                    if (deleteBookInfo) {
                        removeBook(deleteBookInfo.bookId);
                        setDeleteBookInfo(null);
                    }
                }}
                onCancel={() => setDeleteBookInfo(null)}
            />
            <ConfirmDialog
                isOpen={batchDeleteIds !== null && batchDeleteIds.length > 0}
                title="Delete Books"
                message={batchDeleteIds ? `Are you sure you want to delete ${batchDeleteIds.length} selected book(s)? This action cannot be undone.` : ""}
                confirmLabel="Delete"
                cancelLabel="Cancel"
                variant="danger"
                onConfirm={() => {
                    if (batchDeleteIds) {
                        removeBooks(batchDeleteIds);
                        setBatchDeleteIds(null);
                        clearSelection();
                        setIsSelecting(false);
                    }
                }}
                onCancel={() => setBatchDeleteIds(null)}
            />
        </div>
    );
}

export function ShelvesPage() {
    const shelfDefinitions = useLibraryStore((state) => state.collections);
    const books = useLibraryStore((state) => state.books);
    const { collections, ready: smartShelvesReady, error: smartShelvesError } = useSmartShelves(books, shelfDefinitions);
    const addCollection = useLibraryStore((state) => state.addCollection);
    const removeCollection = useLibraryStore((state) => state.removeCollection);
    const updateCollection = useLibraryStore((state) => state.updateCollection);
    const searchQuery = useUIStore((state) => state.searchQuery);
    const [selectedShelfId, setSelectedShelfId] = useState<string | null>(null);
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [editingShelf, setEditingShelf] = useState<Collection | undefined>();
    const [initialParentId, setInitialParentId] = useState<string | undefined>();
    const generalCollections = useMemo(() => collections, [collections]);

    const bookLookup = useMemo(
        () => new Map(books.map((book) => [book.id, book])),
        [books],
    );

    const debouncedSearchQuery = useDebounce(searchQuery, 250);

    // The query is already debounced above, so the matcher runs at once.
    const rankedShelves = useFuzzyRank(
        generalCollections,
        debouncedSearchQuery,
        (shelf) => ({ primary: shelf.name, secondary: shelf.description || "" }),
        { debounceMs: 0 },
    );

    const filteredShelves = useMemo(() => {
        if (!debouncedSearchQuery.trim()) {
            return generalCollections.filter(shelf => !shelf.parentId || !generalCollections.some(parent => parent.id === shelf.parentId));
        }
        // Until the first ranking arrives, show the usual top-level list rather than nothing.
        if (!rankedShelves) {
            return generalCollections.filter(shelf => !shelf.parentId || !generalCollections.some(parent => parent.id === shelf.parentId));
        }
        return rankedShelves.map(({ item }) => item);
    }, [generalCollections, debouncedSearchQuery, rankedShelves]);

    const getActualBookCount = (bookIds: string[]) => {
        return bookIds.filter((id) => bookLookup.has(id)).length;
    };

    const getShelfBooks = (bookIds: string[]): Book[] => {
        return bookIds
            .map((id) => bookLookup.get(id))
            .filter((book): book is Book => book !== undefined);
    };

    const handleCreateShelf = () => {
        setEditingShelf(undefined);
        setInitialParentId(undefined);
        setIsModalOpen(true);
    };

    const handleEditShelf = (shelf: Collection) => {
        setEditingShelf(shelf);
        setIsModalOpen(true);
    };

    const handleSaveShelf = (name: string, description: string, smartRules?: SmartShelfDefinition, parentId?: string) => {
        if (editingShelf) {
            updateCollection(editingShelf.id, { name, description, parentId, smartRules, bookIds: smartRules ? [] : editingShelf.bookIds });
        } else {
            addCollection({
                id: crypto.randomUUID(),
                name,
                description,
                parentId,
                bookIds: [],
                smartRules,
                kind: "general",
                createdAt: new Date(),
            });
        }
        setIsModalOpen(false);
    };

    const [deleteShelfInfo, setDeleteShelfInfo] = useState<{ id: string; name: string } | null>(null);

    const handleDeleteShelf = (shelfId: string, shelfName: string) => {
        setDeleteShelfInfo({ id: shelfId, name: shelfName });
    };

    const handleDeleteShelfConfirm = () => {
        if (deleteShelfInfo) {
            removeCollection(deleteShelfInfo.id);
            setDeleteShelfInfo(null);
        }
    };

    if (selectedShelfId && generalCollections.some((shelf) => shelf.id === selectedShelfId && shelf.smartRules) && !smartShelvesReady) {
        return <div role={smartShelvesError ? "alert" : "status"} className="p-6">{smartShelvesError ?? "Updating smart shelves…"}</div>;
    }
    if (selectedShelfId) {
        const shelf = generalCollections.find((s) => s.id === selectedShelfId);
        if (shelf) {
            return (
                <div className="mx-auto flex h-full w-full max-w-[var(--layout-content-max-width)] flex-col px-4 py-3 pb-0 sm:px-6 lg:px-8 lg:py-8 animate-fade-in">
                    <ShelfDetail key={shelf.id} shelf={shelf} onBack={() => setSelectedShelfId(shelf.parentId || null)}
                        onNavigate={setSelectedShelfId}
                        onCreateChild={() => { setEditingShelf(undefined); setInitialParentId(shelf.id); setIsModalOpen(true); }} />
                    <ShelfModal isOpen={isModalOpen} shelf={editingShelf} collections={collections} initialParentId={initialParentId}
                        onClose={() => setIsModalOpen(false)} onSave={handleSaveShelf} />
                </div>
            );
        }
    }

    return (
        <div className="mx-auto flex h-full w-full max-w-[var(--layout-content-max-width)] flex-col px-4 py-3 pb-0 sm:px-6 lg:px-8 lg:py-8 animate-fade-in">
            <div className="-mb-4">
                <PageHeader
                    title="Shelves"
                    description={`${generalCollections.length} ${generalCollections.length === 1 ? "shelf" : "shelves"} • ${generalCollections.reduce((acc, s) => acc + getActualBookCount(s.bookIds), 0)} books`}
                >
                    <Button variant="primary"
                        onClick={handleCreateShelf}
                         className={cn("px-3 py-2 sm:px-4")}
                    >
                        <Plus className="w-4 h-4" />
                        <span className="hidden sm:inline">New Shelf</span>
                        <span className="sm:hidden">New</span>
                    </Button>
                </PageHeader>
            </div>

            <div className="flex min-h-0 flex-1 flex-col md:flex-row gap-6 md:gap-10 relative">
                <div className="flex min-h-0 flex-1 flex-col w-full">
                    <section className="flex-1 min-h-0 overflow-y-auto overscroll-contain scrollbar-solid pb-[calc(var(--layout-bottom-nav-height)+var(--safe-area-bottom)+var(--spacing-lg))] md:pb-0 pt-4">
                        {generalCollections.length === 0 ? (
                            <EmptyShelves onCreate={handleCreateShelf} />
                        ) : filteredShelves.length === 0 ? (
                            <div className="text-center py-16 border-2 border-dashed border-[var(--color-border)]">
                                <p className="text-[color:var(--color-text-muted)] text-xs">
                                    No shelves found matching your search.
                                </p>
                            </div>
                        ) : (
                            <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,14rem),1fr))] gap-6">
                                {filteredShelves.map((shelf) => (
                                    <div key={shelf.id}>
                                    {shelf.parentId && <p className="text-sm text-[color:var(--color-text-muted)] mb-2">{collections.find(c => c.id === shelf.parentId)?.name} / {shelf.name}</p>}
                                    {!shelf.parentId && collections.some(c => c.parentId === shelf.id) && <p className="text-sm text-[color:var(--color-text-muted)] mb-2">{collections.filter(c => c.parentId === shelf.id).length} sub-shelves</p>}
                                    <ShelfCard
                                        shelf={shelf}
                                        books={getShelfBooks(shelf.bookIds)}
                                        actualBookCount={getActualBookCount(shelf.bookIds)}
                                        onClick={() => setSelectedShelfId(shelf.id)}
                                        onEdit={() =>
                                            handleEditShelf(shelf)
                                        }
                                        onDelete={() => handleDeleteShelf(shelf.id, shelf.name)}
                                    />
                                    </div>
                                ))}
                            </div>
                        )}
                    </section>
                </div>
            </div>

            {!smartShelvesReady && <p role={smartShelvesError ? "alert" : "status"}>{smartShelvesError ?? "Updating smart shelves…"}</p>}
            <ShelfModal
                isOpen={isModalOpen}
                shelf={editingShelf}
                collections={collections}
                initialParentId={initialParentId}
                onClose={() => setIsModalOpen(false)}
                onSave={handleSaveShelf}
            />

            <ConfirmDialog
                isOpen={!!deleteShelfInfo}
                title="Delete Shelf"
                message={deleteShelfInfo ? `Are you sure you want to delete "${deleteShelfInfo.name}"? Books will remain in your library. Sub-shelves will become top-level shelves.` : ""}
                confirmLabel="Delete"
                cancelLabel="Cancel"
                variant="danger"
                onConfirm={handleDeleteShelfConfirm}
                onCancel={() => setDeleteShelfInfo(null)}
            />
        </div>
    );
}
