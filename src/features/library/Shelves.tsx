
import { useState, useMemo, useCallback, useEffect, useRef, memo } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn } from "../../core/lib/utils";
import { getShelfColor, getShelfInitials } from "../../core/lib/design-tokens";
import { rankByFuzzyQuery } from "../../core/lib/search/fuzzy";
import { useLibraryStore, useUIStore, useSettingsStore } from "../../core/store";
import { ShelfModal } from "./components/modals/ShelfModal";
import { ConfirmDialog } from "../../ui";
import { MemoizedBookCard, BookInfoModal, AddToShelfModal, RenameBookModal } from "./Library";
import { getFilteredAndSortedBooks } from "./filtering";
import { useDebounce } from "../../core/lib/useDebounce";
import { sqliteSearchBooks } from "../../core/lib/sqlite-storage";
import { isTauri } from "../../core/lib/env";
import { exportBook } from "../../core/lib/book-export";
import { toast } from "sonner";
import {
    FolderOpen,
    Plus,
    MoreVertical,
    Edit3,
    Trash2,
    BookOpen,
    Grid3X3,
    List,
    ArrowLeft,
    LayoutGrid,
} from "lucide-react";
import type { Book, Collection, LibraryViewMode } from "../../core/types";

const viewModeIcons: Record<LibraryViewMode, React.ReactNode> = {
    grid: <LayoutGrid className="w-4 h-4" />,
    list: <List className="w-4 h-4" />,
    compact: <Grid3X3 className="w-4 h-4" />,
};

function EmptyShelves({ onCreate }: { onCreate: () => void }) {
    return (
        <div className="mx-auto w-full max-w-[26rem] min-w-0 px-4 sm:px-6 flex flex-col items-center justify-center py-20 text-center animate-fade-in">
            <div className="w-16 h-16 bg-[var(--color-surface-muted)] flex items-center justify-center mb-6">
                <FolderOpen className="w-6 h-6 text-[color:var(--color-text-secondary)]" />
            </div>
            <h2 className="w-full break-words text-balance text-lg font-medium text-[color:var(--color-text-primary)] mb-2">
                No Shelves Yet
            </h2>
            <p className="mx-auto w-full max-w-[24rem] break-words text-[color:var(--color-text-muted)] mb-8 text-sm leading-relaxed">
                Create shelves to organize your books your way.
            </p>
            <button
                onClick={onCreate}
                className={cn(
                    "min-w-[10.5rem] whitespace-nowrap flex items-center gap-2 px-6 py-2.5",
                    "bg-[var(--color-accent)] text-[color:var(--color-accent-contrast)] text-sm font-medium",
                    "hover:opacity-90 transition-opacity"
                )}
            >
                <Plus className="w-4 h-4" />
                <span>Create Shelf</span>
            </button>
        </div>
    );
}

function EmptyShelfDetail({ shelfName, onAddBooks }: { shelfName: string; onAddBooks: () => void }) {
    return (
        <div className="mx-auto w-full max-w-[26rem] min-w-0 px-4 sm:px-6 flex flex-col items-center justify-center py-20 text-center animate-fade-in">
            <div className="w-16 h-16 bg-[var(--color-surface-muted)] flex items-center justify-center mb-6">
                <BookOpen className="w-6 h-6 text-[color:var(--color-text-secondary)]" />
            </div>
            <h2 className="w-full break-words text-balance text-lg font-medium text-[color:var(--color-text-primary)] mb-2">
                "{shelfName}" is Empty
            </h2>
            <p className="mx-auto w-full max-w-[24rem] break-words text-[color:var(--color-text-muted)] mb-8 text-sm leading-relaxed">
                Add books from your library to this shelf.
            </p>
            <button
                onClick={onAddBooks}
                className={cn(
                    "min-w-[10.5rem] whitespace-nowrap flex items-center gap-2 px-6 py-2.5",
                    "bg-[var(--color-accent)] text-[color:var(--color-accent-contrast)] text-sm font-medium",
                    "hover:opacity-90 transition-opacity"
                )}
            >
                <BookOpen className="w-4 h-4" />
                <span>Go to Library</span>
            </button>
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
                                    className="relative overflow-hidden shadow-sm bg-[var(--color-surface)] h-full w-full"
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
                                        <div className="w-full h-full bg-[#0e0e11] border border-[#27272a] flex flex-col items-center justify-center p-1.5 text-center">
                                            <BookOpen className="w-4 h-4 text-zinc-500 mb-0.5 shrink-0" />
                                            <span className="text-[8px] font-serif font-bold text-zinc-300 line-clamp-2 leading-tight">
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
                            <FolderOpen className="w-12 h-12 text-[color:var(--color-text-muted)] mb-2" />
                            <span className="text-sm text-[color:var(--color-text-secondary)]">Empty Shelf</span>
                        </div>
                    )}
                </div>
            </button>

            <div className="p-4">
                <div className="flex items-center gap-3">
                    
                    <div
                        className="w-10 h-10 flex items-center justify-center text-sm font-semibold flex-shrink-0 shadow-sm"
                        style={{
                            backgroundColor: getShelfColor(shelf.id, shelf.name).bg,
                            color: getShelfColor(shelf.id, shelf.name).text,
                        }}
                    >
                        {getShelfInitials(shelf.name)}
                    </div>

                    <div className="flex-1 min-w-0 overflow-hidden">
                        <button onClick={onClick} className="text-left w-full">
                            <h3 className="font-semibold text-[color:var(--color-text-primary)] truncate group-hover:text-[color:var(--color-accent)] transition-colors">
                                {shelf.name}
                            </h3>
                        </button>
                        <p className="text-xs text-[color:var(--color-text-muted)] mt-0.5">
                            {actualBookCount} {actualBookCount === 1 ? "book" : "books"}
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
                            className="p-1.5 text-[color:var(--color-text-muted)] hover:bg-[var(--color-surface-muted)] sm:opacity-0 sm:group-hover:opacity-100 transition-opacity"
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
                                        "absolute right-0 w-36 border border-[var(--color-border)] bg-[var(--color-surface)] shadow-lg z-20 py-1",
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
}

function ShelfDetail({ shelf, onBack }: ShelfDetailProps) {
    const books = useLibraryStore((state) => state.books);
    const collections = useLibraryStore((state) => state.collections);
    const addCollection = useLibraryStore((state) => state.addCollection);
    const addBookToCollection = useLibraryStore((state) => state.addBookToCollection);
    const removeBook = useLibraryStore((state) => state.removeBook);
    const toggleFavorite = useLibraryStore((state) => state.toggleFavorite);
    const updateBook = useLibraryStore((state) => state.updateBook);
    const getBook = useLibraryStore((state) => state.getBook);
    const markBookCompleted = useLibraryStore((state) => state.markBookCompleted);
    const markBookUnread = useLibraryStore((state) => state.markBookUnread);

    const setRoute = useUIStore((state) => state.setRoute);
    const searchQuery = useUIStore((state) => state.searchQuery);
    const settings = useSettingsStore((state) => state.settings);
    const updateSettings = useSettingsStore((state) => state.updateSettings);
    
    const viewMode = settings.libraryViewMode;

    const [infoModalBook, setInfoModalBook] = useState<Book | null>(null);
    const [isInfoModalOpen, setIsInfoModalOpen] = useState(false);
    const [addToShelfBookId, setAddToShelfBookId] = useState<string | null>(null);
    const [isAddToShelfModalOpen, setIsAddToShelfModalOpen] = useState(false);
    const [renameBook, setRenameBook] = useState<Book | null>(null);
    const [isRenameModalOpen, setIsRenameModalOpen] = useState(false);
    const [deleteBookInfo, setDeleteBookInfo] = useState<{ bookId: string; title: string } | null>(null);

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
        });
    }, [shelf.bookIds, books, debouncedSearchQuery, settings.librarySortBy, settings.librarySortOrder, ftsSearchIds]);

    const scrollRef = useRef<HTMLDivElement>(null);
    const isListView = viewMode === "list";
    const isCompactView = viewMode === "compact";

    const [cols, setCols] = useState(() => typeof window !== "undefined" && window.innerWidth >= 1280 ? 7 : 4);

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
        setCols(compute());
        const observer = new ResizeObserver(() => setCols(compute()));
        observer.observe(el);
        return () => observer.disconnect();
    }, [isListView, isCompactView]);

    const effectiveCols = isListView ? 1 : cols;

    const rowCount = isListView
        ? shelfBooks.length
        : Math.ceil(shelfBooks.length / Math.max(effectiveCols, 1));

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
    });

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

    if (shelf.bookIds.length === 0) {
        return <EmptyShelfDetail shelfName={shelf.name} onAddBooks={handleGoToLibrary} />;
    }

    return (
        <div className="flex min-h-0 flex-1 flex-col animate-fade-in">
            
            <div className="flex items-center justify-between mb-8">
                <div className="flex items-center gap-4">
                    <button
                        onClick={onBack}
                        className="p-2 text-[color:var(--color-text-secondary)] hover:bg-[var(--color-surface-muted)] transition-colors"
                    >
                        <ArrowLeft className="w-5 h-5" />
                    </button>
                    
                    <div
                        className="w-12 h-12 flex items-center justify-center text-lg font-semibold flex-shrink-0 shadow-sm"
                        style={{
                            backgroundColor: getShelfColor(shelf.id, shelf.name).bg,
                            color: getShelfColor(shelf.id, shelf.name).text,
                        }}
                    >
                        {getShelfInitials(shelf.name)}
                    </div>
                    <div>
                        <h1 className="m-0 font-sans text-[1.45rem] font-semibold uppercase tracking-[0.12em] leading-[1.1] text-[color:var(--color-text-primary)] sm:text-[1.6rem]">
                            {shelf.name}
                        </h1>
                        <p className="text-sm text-[color:var(--color-text-muted)] mt-0.5">
                            {shelfBooks.length} {shelfBooks.length === 1 ? "book" : "books"}
                        </p>
                    </div>
                </div>

                <button
                    onClick={cycleViewMode}
                    className={cn(
                        "flex items-center justify-center w-10 h-10",
                        "border border-[var(--color-border)] bg-[var(--color-surface)]",
                        "text-[color:var(--color-text-secondary)]",
                        "hover:bg-[var(--color-surface-muted)] transition-colors"
                    )}
                    title={`View: ${viewMode}`}
                >
                    {viewModeIcons[viewMode]}
                </button>
            </div>

            <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto overscroll-contain scroll-smooth">
                {shelfBooks.length === 0 ? (
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
                                                isSelecting={false} isSelected={false} onToggleSelect={() => {}}
                                                {...cardProps}
                                            />
                                        </div>
                                    ) : (
                                        <div className={isCompactView
                                            ? "grid grid-cols-3 gap-2 sm:grid-cols-4 sm:gap-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 pb-2"
                                            : "grid grid-cols-2 gap-5 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-7 2xl:grid-cols-8 pb-5"
                                        }>
                                            {rowItems.map((book) => (
                                                <MemoizedBookCard
                                                    key={book.id} book={book} viewMode={viewMode}
                                                    isSelecting={false} isSelected={false} onToggleSelect={() => {}}
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
            </div>
            <BookInfoModal
                book={infoModalBook}
                isOpen={isInfoModalOpen}
                onClose={() => setIsInfoModalOpen(false)}
            />
            <AddToShelfModal
                isOpen={isAddToShelfModalOpen}
                onClose={() => setIsAddToShelfModalOpen(false)}
                bookId={addToShelfBookId}
                collections={collections.filter(c => c.kind === "general")}
                onAddToShelf={(bookId, shelfId) => {
                    if (bookId) addBookToCollection(bookId, shelfId);
                }}
                onCreateShelf={handleCreateShelf}
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
        </div>
    );
}

export function ShelvesPage() {
    const collections = useLibraryStore((state) => state.collections);
    const books = useLibraryStore((state) => state.books);
    const addCollection = useLibraryStore((state) => state.addCollection);
    const removeCollection = useLibraryStore((state) => state.removeCollection);
    const updateCollection = useLibraryStore((state) => state.updateCollection);
    const searchQuery = useUIStore((state) => state.searchQuery);
    const [selectedShelfId, setSelectedShelfId] = useState<string | null>(null);
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [editingShelf, setEditingShelf] = useState<{ id: string; name: string; description?: string } | undefined>();
    const generalCollections = useMemo(() => collections, [collections]);

    const bookLookup = useMemo(
        () => new Map(books.map((book) => [book.id, book])),
        [books],
    );

    const debouncedSearchQuery = useDebounce(searchQuery, 250);

    const filteredShelves = useMemo(() => {
        if (!debouncedSearchQuery.trim()) {
            return generalCollections;
        }

        const rankedShelves = rankByFuzzyQuery(
            generalCollections.map((shelf) => ({
                shelf,
                name: shelf.name,
                description: shelf.description || "",
            })),
            debouncedSearchQuery,
            {
                keys: [
                    { name: "name", weight: 0.65 },
                    { name: "description", weight: 0.35 },
                ],
            },
        );
        return rankedShelves.map(({ item }) => item.shelf);
    }, [generalCollections, debouncedSearchQuery]);

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
        setIsModalOpen(true);
    };

    const handleEditShelf = (shelf: { id: string; name: string; description?: string }) => {
        setEditingShelf(shelf);
        setIsModalOpen(true);
    };

    const handleSaveShelf = (name: string, description: string) => {
        if (editingShelf) {
            updateCollection(editingShelf.id, { name, description });
        } else {
            addCollection({
                id: crypto.randomUUID(),
                name,
                description,
                bookIds: [],
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

    if (selectedShelfId) {
        const shelf = generalCollections.find((s) => s.id === selectedShelfId);
        if (shelf) {
            return (
                <div className="mx-auto flex h-full w-full max-w-[var(--layout-content-max-width)] flex-col px-4 py-6 pb-0 sm:px-6 lg:px-8 lg:py-8">
                    <ShelfDetail shelf={shelf} onBack={() => setSelectedShelfId(null)} />
                </div>
            );
        }
    }

    if (generalCollections.length === 0) {
        return (
            <div className="mx-auto w-full max-w-[var(--layout-content-max-width)] px-4 py-6 pb-0 sm:px-6 lg:px-8 lg:py-8">
                <EmptyShelves onCreate={handleCreateShelf} />
                <ShelfModal
                    isOpen={isModalOpen}
                    shelf={editingShelf}
                    onClose={() => setIsModalOpen(false)}
                    onSave={handleSaveShelf}
                />
            </div>
        );
    }

    return (
        <div className="mx-auto w-full max-w-[var(--layout-content-max-width)] px-4 py-6 pb-0 sm:px-6 lg:px-8 lg:py-8 animate-fade-in">
            
            <div className="flex items-center justify-between mb-10">
                <div>
                    <h1 className="m-0 font-sans text-[1.45rem] font-semibold uppercase tracking-[0.12em] leading-[1.1] text-[color:var(--color-text-primary)] sm:text-[1.6rem]">
                        Shelves
                    </h1>
                    <p className="mt-1 text-sm leading-relaxed text-[color:var(--color-text-secondary)]">
                        {generalCollections.length} {generalCollections.length === 1 ? "shelf" : "shelves"} •{" "}
                        {generalCollections.reduce((acc, s) => acc + getActualBookCount(s.bookIds), 0)} books
                    </p>
                </div>

                <button
                    onClick={handleCreateShelf}
                    className={cn(
                        "flex items-center gap-2 px-4 py-2.5",
                        "bg-[var(--color-accent)] text-[color:var(--color-accent-contrast)] text-sm font-medium",
                        "hover:opacity-90 transition-opacity"
                    )}
                >
                    <Plus className="w-4 h-4" />
                    <span>New Shelf</span>
                </button>
            </div>

            {filteredShelves.length === 0 ? (
                <div className="text-center py-16">
                    <p className="text-[color:var(--color-text-muted)]">
                        No shelves found matching your search.
                    </p>
                </div>
            ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-6">
                    {filteredShelves.map((shelf) => (
                        <ShelfCard
                            key={shelf.id}
                            shelf={shelf}
                            books={getShelfBooks(shelf.bookIds)}
                            actualBookCount={getActualBookCount(shelf.bookIds)}
                            onClick={() => setSelectedShelfId(shelf.id)}
                            onEdit={() =>
                                handleEditShelf({
                                    id: shelf.id,
                                    name: shelf.name,
                                    description: shelf.description,
                                })
                            }
                            onDelete={() => handleDeleteShelf(shelf.id, shelf.name)}
                        />
                    ))}
                </div>
            )}

            <ShelfModal
                isOpen={isModalOpen}
                shelf={editingShelf}
                onClose={() => setIsModalOpen(false)}
                onSave={handleSaveShelf}
            />

            <ConfirmDialog
                isOpen={!!deleteShelfInfo}
                title="Delete Shelf"
                message={deleteShelfInfo ? `Are you sure you want to delete "${deleteShelfInfo.name}"? Books in this shelf will remain in your library.` : ""}
                confirmLabel="Delete"
                cancelLabel="Cancel"
                variant="danger"
                onConfirm={handleDeleteShelfConfirm}
                onCancel={() => setDeleteShelfInfo(null)}
            />
        </div>
    );
}
