import { NAV_CONTROL_ICON } from "../../ui/toolbar-styles";
import { SELECT_ALL_EVENT } from "../../core/lib/keyboard-shortcuts";
import { useSmartShelves } from "../../core/lib/useSmartShelves";

import { useState, useCallback, useEffect, useLayoutEffect, useRef, useMemo } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn } from "../../core/lib/utils";
import { FILTER_CHIP_SELECTED } from "../../ui/filter-chips";
import { FolderImportStatus } from "./components/FolderImportStatus";
import { isTauri } from "../../core/lib/env";
import { useLibraryStore, useUIStore, useSettingsStore } from "../../core/store";
import { LibraryFilterPanel } from "./LibraryFilterPanel";
import { LibraryDailyReviewDeck } from "./components/LibraryDailyReviewDeck";
import { EmptyLibrary, ImportButton } from "./components/LibraryEmptyState";
import { RemoveFolderModal, type RemoveFolderTarget } from "./components/modals/RemoveFolderModal";
import { useLibraryImportAndMetadata } from "./hooks/useLibraryImportAndMetadata";
import type { Book, Collection, LibraryViewMode, LibrarySortBy, LibrarySortOrder, LibraryStatusFilter } from "../../core/types";
import {
    Trash2, BookMarked, LayoutGrid, Rows3, Grid3X3, CheckCheck, RotateCcw, Download, ListOrdered, X, CheckSquare, Folder, Funnel
} from "lucide-react";
import { IconButton } from "../../ui/IconButton";
import { Button, PageHeader, ConfirmDialog, AlertDialog } from "../../ui";
import { getFilteredAndSortedBooks } from "./filtering";
import { useDebounce } from "../../core/lib/useDebounce";
import { twoTierSearchBooks, sqliteQueryBooksWindow } from "../../core/lib/sqlite-storage";
import { initTheoremCoreWasm, isWasmCoreReady } from "../../core/lib/theorem-core";
import { exportBook, exportBooks } from "../../core/lib/book-export";
import { EditBookModal } from "./components/modals/EditBookModal";
import { AssignSeriesModal } from "./components/modals/AssignSeriesModal";
import { toast } from "sonner";
import { useFilteredSelection } from "./useFilteredSelection";
import { FolderImportModal } from "./components/modals/FolderImportModal";
import { buildSourceFolderIndex } from "../../core/lib/source-folders";
import type { SourceFolderSelection } from "../../core/lib/source-folders";

const viewModeIcons: Record<LibraryViewMode, React.ReactNode> = {
    grid: <LayoutGrid className={NAV_CONTROL_ICON} />,
    list: <Rows3 className={NAV_CONTROL_ICON} />,
    compact: <Grid3X3 className={NAV_CONTROL_ICON} />,
};

/**
 * Fixed height of a list-view book row, in CSS pixels.
 *
 * The row virtualizer positions rows absolutely from its estimate, so the
 * rendered row must be exactly this tall or it overlaps its neighbour. It is
 * shared with the estimate so the two can never drift apart (see
 * `getEstimateSize` in Library.tsx and Shelves.tsx).
 *
 * 24px of `p-3` padding + a 64px `h-16` cover = 88px, rounded up to leave room
 * for a two-line title plus the author and metadata lines.
 */
export { LIBRARY_LIST_ROW_HEIGHT } from "./row-height";
import { LIBRARY_LIST_ROW_HEIGHT } from "./row-height";

/**
 * Filter-panel chip styles live in `src/ui/filter-chips.ts` so the OPDS catalog
 * browser shares the exact same treatment without importing the Library route.
 */

import { isBookMarkedRead } from "./components/BookCard";
import { BookInfoModal, AddToShelfModal } from "./components/modals/LibraryBookModals";

export { EmptyLibrary };
export { BookCard, MemoizedBookCard } from "./components/BookCard";
export { BookInfoModal, AddToShelfModal, RenameBookModal } from "./components/modals/LibraryBookModals";
import { MemoizedBookCard } from "./components/BookCard";

export function LibraryPage() {
    const books = useLibraryStore((state) => state.books);
    const recentBooksCache = useLibraryStore(state => state.recentBooksCache);
    const resumeBookId = recentBooksCache[0]?.id;
    const shelfDefinitions = useLibraryStore((state) => state.collections);
    const { collections, ready: smartShelvesReady, error: smartShelvesError } = useSmartShelves(books, shelfDefinitions);
    const coversHydrated = useLibraryStore((state) => state.coversHydrated);
    const addBook = useLibraryStore((state) => state.addBook);
    const removeBook = useLibraryStore((state) => state.removeBook);
    const removeBooks = useLibraryStore((state) => state.removeBooks);
    const updateBook = useLibraryStore((state) => state.updateBook);
    const updateBooks = useLibraryStore((state) => state.updateBooks);
    const setLastScannedAt = useLibraryStore((state) => state.setLastScannedAt);
    const toggleFavorite = useLibraryStore((state) => state.toggleFavorite);
    const markBookCompleted = useLibraryStore((state) => state.markBookCompleted);
    const markBookUnread = useLibraryStore((state) => state.markBookUnread);
    const markBooksCompleted = useLibraryStore((state) => state.markBooksCompleted);
    const markBooksUnread = useLibraryStore((state) => state.markBooksUnread);
    const addBookToCollection = useLibraryStore((state) => state.addBookToCollection);
    const addBooksToCollection = useLibraryStore((state) => state.addBooksToCollection);
    const removeBookFromCollection = useLibraryStore((state) => state.removeBookFromCollection);
    const addCollection = useLibraryStore((state) => state.addCollection);

    const setRoute = useUIStore((state) => state.setRoute);
    const searchQuery = useUIStore((state) => state.searchQuery);
    const currentRoute = useUIStore((state) => state.currentRoute);
    const settings = useSettingsStore((state) => state.settings);
    const updateSettings = useSettingsStore((state) => state.updateSettings);

    const [selectedShelfId, setSelectedShelfId] = useState<string | null>(null);
    const [showFavoritesOnly, setShowFavoritesOnly] = useState(false);
    const [showUnshelvedOnly, setShowUnshelvedOnly] = useState(false);
    const [statusFilter, setStatusFilter] = useState<LibraryStatusFilter>("all");
    const [selectedSourceFolder, setSelectedSourceFolder] = useState<SourceFolderSelection | null>(null);
    const sourceFolderIndex = useMemo(() => buildSourceFolderIndex(books), [books]);
    const sourceFolderBookIds = useMemo(() => selectedSourceFolder
        ? sourceFolderIndex.get(selectedSourceFolder.root)?.folders.get(selectedSourceFolder.path) ?? new Set<string>()
        : undefined, [sourceFolderIndex, selectedSourceFolder]);
    useEffect(() => {
        if (selectedSourceFolder && !sourceFolderIndex.get(selectedSourceFolder.root)?.folders.has(selectedSourceFolder.path)) {
            setSelectedSourceFolder(null);
        }
    }, [sourceFolderIndex, selectedSourceFolder]);

    const [isSelecting, setIsSelecting] = useState(false);

    const [showFilterDropdown, setShowFilterDropdown] = useState(false);
    const filterDropdownRef = useRef<HTMLDivElement>(null);

    const [infoModalBook, setInfoModalBook] = useState<Book | null>(null);
    const [isInfoModalOpen, setIsInfoModalOpen] = useState(false);
    const [addToShelfBookId, setAddToShelfBookId] = useState<string | null>(null);
    const [isAddToShelfModalOpen, setIsAddToShelfModalOpen] = useState(false);
    const [editBook, setEditBook] = useState<Book | null>(null);
    const [isEditModalOpen, setIsEditModalOpen] = useState(false);
    const [isSeriesModalOpen, setIsSeriesModalOpen] = useState(false);
    const [alertInfo, setAlertInfo] = useState<{ title: string; message: string } | null>(null);
    const [deleteConfirm, setDeleteConfirm] = useState<{ bookId?: string; title: string; batch?: boolean; bookIds?: string[] } | null>(null);

    const onPreservedFolderImported = useCallback((root: string) => {
        setSelectedSourceFolder({ root, path: "" });
        setSelectedShelfId(null);
        sessionStorage.removeItem("theorem-selected-shelf");
        setShowFavoritesOnly(false);
        setShowUnshelvedOnly(false);
    }, []);

    const {
        isImporting,
        isScanning,
        folderImportProgress,
        stoppingFolderImport,
        showFolderImport,
        setShowFolderImport,
        handleAddBooks,
        handleScanFolder,
        stopFolderImport,
    } = useLibraryImportAndMetadata({
        books,
        coversHydrated,
        settings,
        addBook,
        updateBook,
        updateSettings,
        setLastScannedAt,
        setAlertInfo,
        onPreservedFolderImported,
    });

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
    const [nativeSearchFailed, setNativeSearchFailed] = useState(false);
    const [resolvedSearchQuery, setResolvedSearchQuery] = useState<string | null>(null);
    const [matchHighlights, setMatchHighlights] = useState<Map<string, { titleIndices: number[]; authorIndices: number[] }>>(() => new Map());

    useEffect(() => {
        if (!isTauri() || !debouncedSearchQuery.trim()) {
            setResolvedSearchQuery(null);
            setFtsSearchIds(undefined);
            setMatchHighlights(new Map());
            return;
        }
        let cancelled = false;
        // Previous results stay until the new ones arrive.
        setResolvedSearchQuery(null);
        twoTierSearchBooks(debouncedSearchQuery.trim(), 200).then((results) => {
            if (cancelled) return;
            setNativeSearchFailed(false);
            setFtsSearchIds(results.map((r) => r.bookId));
            const highlights = new Map<string, { titleIndices: number[]; authorIndices: number[] }>();
            for (const r of results) {
                highlights.set(r.bookId, {
                    titleIndices: r.titleIndices,
                    authorIndices: r.authorIndices,
                });
            }
            setMatchHighlights(highlights);
            setResolvedSearchQuery(debouncedSearchQuery.trim());
        }, () => {
            if (cancelled) return;
            setNativeSearchFailed(true);
            setFtsSearchIds(undefined);
            setMatchHighlights(new Map());
            setResolvedSearchQuery(debouncedSearchQuery.trim());
        });
        return () => { cancelled = true; };
    }, [debouncedSearchQuery]);

    // Browser build, or native search failed: rank with the WebAssembly build
    // of the same Rust matcher, loaded on the first search.
    const [wasmMatcherReady, setWasmMatcherReady] = useState(isWasmCoreReady);
    useEffect(() => {
        if (wasmMatcherReady || !debouncedSearchQuery.trim() || (isTauri() && !nativeSearchFailed)) return;
        let cancelled = false;
        void initTheoremCoreWasm().then((ready) => {
            if (!cancelled && ready) setWasmMatcherReady(true);
        });
        return () => { cancelled = true; };
    }, [wasmMatcherReady, debouncedSearchQuery, nativeSearchFailed]);

    const WINDOW_PAGE_SIZE = 120;
    const canUseSqliteWindow = isTauri()
        && !debouncedSearchQuery.trim()
        && !selectedShelfBookIds
        && !sourceFolderBookIds
        && !showFavoritesOnly
        && !showUnshelvedOnly
        && statusFilter === "all"
        && settings.librarySortBy === "dateAdded"
        && settings.librarySortOrder === "asc";

    const [sqliteWindowLimit, setSqliteWindowLimit] = useState(WINDOW_PAGE_SIZE);
    const [sqliteWindowIds, setSqliteWindowIds] = useState<string[] | null>(null);
    const [sqliteWindowTotal, setSqliteWindowTotal] = useState(0);

    useEffect(() => {
        if (!canUseSqliteWindow) {
            setSqliteWindowIds(null);
            setSqliteWindowTotal(0);
            setSqliteWindowLimit(WINDOW_PAGE_SIZE);
            return;
        }
        let cancelled = false;
        sqliteQueryBooksWindow(sqliteWindowLimit, 0).then((result) => {
            if (cancelled) return;
            if (result.totalCount === 0 && books.length > 0) {
                setSqliteWindowIds(null);
                setSqliteWindowTotal(0);
                return;
            }
            setSqliteWindowIds(result.bookIds);
            setSqliteWindowTotal(result.totalCount);
        }, () => {
            if (cancelled) return;
            setSqliteWindowIds(null);
            setSqliteWindowTotal(0);
        });
        return () => { cancelled = true; };
    }, [canUseSqliteWindow, sqliteWindowLimit, books]);

    const sortedBooks = useMemo(() => {
        if (canUseSqliteWindow && sqliteWindowIds && sqliteWindowIds.length > 0) {
            const getBook = useLibraryStore.getState().getBook;
            const windowed: Book[] = [];
            for (const id of sqliteWindowIds) {
                const book = getBook(id);
                if (book && !book.tags.includes("rss")) {
                    windowed.push(book);
                }
            }
            if (windowed.length > 0) {
                return windowed;
            }
        }
        return getFilteredAndSortedBooks({
            books,
            searchQuery: debouncedSearchQuery,
            selectedShelfBookIds,
            sourceFolderBookIds,
            showFavoritesOnly,
            showUnshelvedOnly,
            allShelvedBookIds,
            statusFilter,
            sortBy: settings.librarySortBy,
            sortOrder: settings.librarySortOrder,
            ftsSearchIds,
            nativeSearchPending: isTauri() && !nativeSearchFailed,
        });
    }, [
        canUseSqliteWindow,
        sqliteWindowIds,
        books,
        debouncedSearchQuery,
        selectedShelfBookIds,
        sourceFolderBookIds,
        settings.librarySortBy,
        settings.librarySortOrder,
        showFavoritesOnly,
        showUnshelvedOnly,
        allShelvedBookIds,
        statusFilter,
        ftsSearchIds,
        nativeSearchFailed,
        wasmMatcherReady,
    ]);

    const selectionReady = searchQuery.trim() === debouncedSearchQuery.trim()
        && (!isTauri() || !debouncedSearchQuery.trim() || resolvedSearchQuery === debouncedSearchQuery.trim());
    const selectionScope = JSON.stringify([searchQuery, selectedShelfId, showFavoritesOnly,
        showUnshelvedOnly, statusFilter]);
    const { selectedBooks, selectedBookIds, selectAll, clearSelection, toggleBookSelection, allSelected } =
        useFilteredSelection(sortedBooks, selectionScope, isSelecting, selectionReady);

    // Ctrl/Cmd+A: enter selection mode and select everything in the filtered view.
    // Selection only becomes available a render after the mode switches on, so the
    // request stays pending until `selectAll` reports success.
    const [selectAllPending, setSelectAllPending] = useState(false);
    useEffect(() => {
        const onSelectAll = () => {
            if (useUIStore.getState().currentRoute !== "library") return;
            setIsSelecting(true);
            setSelectAllPending(true);
        };
        window.addEventListener(SELECT_ALL_EVENT, onSelectAll);
        return () => window.removeEventListener(SELECT_ALL_EVENT, onSelectAll);
    }, []);
    useEffect(() => {
        if (selectAllPending && isSelecting && selectAll()) setSelectAllPending(false);
    }, [selectAllPending, isSelecting, selectAll]);

    const allSelectedCompleted = useMemo(() => {
        if (selectedBooks.length === 0) return false;
        const libraryBooks = useLibraryStore.getState().books;
        const targetBooks = libraryBooks.filter((b) => selectedBookIds.has(b.id));
        return targetBooks.length > 0 && targetBooks.every(isBookMarkedRead);
    }, [selectedBooks.length, selectedBookIds, books]);

    useEffect(() => {
        if (!isSelecting) return;
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                clearSelection();
                setIsSelecting(false);
            }
        };
        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [isSelecting, clearSelection]);

    useEffect(() => {
        if (currentRoute !== "library" && isSelecting) {
            clearSelection();
            setIsSelecting(false);
        }
    }, [currentRoute, isSelecting, clearSelection]);

    const scrollRef = useRef<HTMLDivElement | null>(null);
    const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
    const assignScrollRef = useCallback((node: HTMLDivElement | null) => {
        scrollRef.current = node;
        setScrollEl(node);
    }, []);
    const savedScrollOffset = useRef(0);
    const [scrollHeaderHeight, setScrollHeaderHeight] = useState(0);
    const scrollHeaderRef = useCallback((element: HTMLDivElement | null) => {
        if (!element) return;
        const update = () => setScrollHeaderHeight(element.getBoundingClientRect().height);
        update();
        const observer = new ResizeObserver(update);
        observer.observe(element);
        return () => observer.disconnect();
    }, []);

    const isListView = settings.libraryViewMode === "list";
    const isCompactView = settings.libraryViewMode === "compact";

    // First paint must already match the viewport: the ResizeObserver only
    // corrects after mount, which flashes 4 tiny columns on phones (real
    // width → 2). Same breakpoints as the observer below.
    const [observedCols, setObservedCols] = useState(() => {
        if (typeof window === "undefined") return 4;
        const w = window.innerWidth;
        if (settings.libraryViewMode === "list") return 1;
        if (settings.libraryViewMode === "compact") {
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
        const el = scrollEl;
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
        setObservedCols(compute());
        let lastWidth = el.clientWidth;
        const observer = new ResizeObserver(() => {
            const currentWidth = el.clientWidth;
            if (currentWidth === 0) { lastWidth = 0; return; }
            setObservedCols(compute());
            if (lastWidth === 0 && currentWidth > 0) {
                rowVirtualizer.measure();
            }
            lastWidth = currentWidth;
        });
        observer.observe(el);
        return () => observer.disconnect();
    }, [isListView, isCompactView, scrollEl]);

    const effectiveCols = isListView ? 1 : observedCols;

    const rowCount = isListView
        ? sortedBooks.length
        : Math.ceil(sortedBooks.length / Math.max(effectiveCols, 1));

    const getEstimateSize = useCallback(() => {
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
        (index: number) => `${settings.libraryViewMode}-${index}`,
        [settings.libraryViewMode],
    );

    const rowVirtualizer = useVirtualizer({
        count: rowCount,
        getScrollElement: useCallback(() => scrollRef.current, []),
        estimateSize: getEstimateSize,
        scrollMargin: scrollHeaderHeight,
        getItemKey,
        overscan: 3,
    });

    const virtualRows = rowVirtualizer.getVirtualItems();
    const lastVirtualRowIndex = virtualRows.length > 0 ? virtualRows[virtualRows.length - 1].index : -1;
    useEffect(() => {
        if (!canUseSqliteWindow || !sqliteWindowIds || sqliteWindowIds.length >= sqliteWindowTotal) {
            return;
        }
        const cols = isListView ? 1 : effectiveCols;
        if ((lastVirtualRowIndex + 1) * cols >= sqliteWindowIds.length - cols * 3) {
            setSqliteWindowLimit((limit) => Math.max(limit, sqliteWindowIds.length + WINDOW_PAGE_SIZE));
        }
    }, [canUseSqliteWindow, sqliteWindowIds, sqliteWindowTotal, isListView, effectiveCols, lastVirtualRowIndex]);

    useLayoutEffect(() => {
        if (currentRoute === "library") {
            rowVirtualizer.measure();
            rowVirtualizer.scrollToOffset(savedScrollOffset.current, { behavior: "auto" });
        }
    }, [currentRoute, rowVirtualizer, settings.libraryViewMode, effectiveCols, isCompactView, isListView]);

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
        setDeleteConfirm({ title: `${selectedBooks.length} selected book(s)`, batch: true, bookIds: [...selectedBooks] });
    }, [selectedBooks]);

    const handleBatchAddToShelf = useCallback(() => {
        setAddToShelfBookId(null); 
        setIsAddToShelfModalOpen(true);
    }, []);

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
            .filter((b) => selectedBookIds.has(b.id));
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
    }, [selectedBookIds, clearSelection]);

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
            // Single batched store update — N individual sets freeze the UI (#104).
            addBooksToCollection(selectedBooks, shelfId);
            clearSelection();
            setIsSelecting(false);
        }
    }, [addBookToCollection, addBooksToCollection, selectedBooks, clearSelection]);

    // Which shelves the book targeted by this dialog already belongs to, so the
    // dialog can toggle membership instead of only adding.
    const addToShelfMembership = useMemo(() => {
        if (!addToShelfBookId) return undefined;
        const bookId = addToShelfBookId;
        return new Set(
            collections.filter((c) => c.bookIds.includes(bookId)).map((c) => c.id),
        );
    }, [addToShelfBookId, collections]);

    const handleRemoveBookFromShelf = useCallback((shelfId: string) => {
        if (addToShelfBookId) {
            removeBookFromCollection(addToShelfBookId, shelfId);
        }
    }, [addToShelfBookId, removeBookFromCollection]);

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

    // Selection guards reject the old callback during the render that enters
    // the mode. Keep the requested book until the new filtered scope is ready.
    const [startSelectionPending, setStartSelectionPending] = useState<{ id: string; scope: string } | null>(null);
    useEffect(() => {
        if (!startSelectionPending) return;
        if (!isSelecting || startSelectionPending.scope !== selectionScope) {
            setStartSelectionPending(null);
            return;
        }
        if (selectedBookIds.has(startSelectionPending.id) || toggleBookSelection(startSelectionPending.id)) {
            setStartSelectionPending(null);
        }
    }, [startSelectionPending, isSelecting, selectionScope, selectedBookIds, toggleBookSelection]);
    const handleStartSelect = useCallback((bookId: string) => {
        setIsSelecting(true);
        setStartSelectionPending({ id: bookId, scope: selectionScope });
    }, [selectionScope]);

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
        onStartSelect: handleStartSelect,
    }), [handleOpenBook, handleToggleFavorite, handleDeleteBook, handleShowInfo, handleAddToShelf, handleRename, handleExport, handleMarkAsRead, handleMarkAsUnread, isSelecting, toggleBookSelection, handleStartSelect]);

    const toggleViewMode = () => {
        const modes: LibraryViewMode[] = ["grid", "list", "compact"];
        const currentIndex = modes.indexOf(settings.libraryViewMode);
        const nextMode = modes[(currentIndex + 1) % modes.length];
        updateSettings({ libraryViewMode: nextMode });
    };

    const folderImportModal = <FolderImportModal isOpen={showFolderImport}
        onClose={() => setShowFolderImport(false)}
        onContinue={(preserve) => { setShowFolderImport(false); void handleScanFolder(preserve); }} />;

    const [folderToRemove, setFolderToRemove] = useState<RemoveFolderTarget | null>(null);

    const handleInitiateRemoveFolder = useCallback((root: string) => {
        const entry = sourceFolderIndex.get(root);
        const displayName = entry?.name && entry.name !== root
            ? entry.name
            : root.replace(/\\/g, "/").split("/").filter(Boolean).pop() || root;
        const count = entry?.folders.get("")?.size ?? 0;
        setFolderToRemove({ root, name: displayName, count });
    }, [sourceFolderIndex]);

    const handleConfirmRemoveFolder = useCallback((root: string, deleteBooks: boolean) => {
        const folderName = folderToRemove?.name || root;
        if (deleteBooks) {
            const bookIdsToDelete: string[] = [];
            for (const book of books) {
                if (book.sourceFolders?.some((sf) => sf.root === root)) {
                    bookIdsToDelete.push(book.id);
                }
            }
            if (bookIdsToDelete.length > 0) {
                removeBooks(bookIdsToDelete);
            }
            toast.success(`Removed "${folderName}" and ${bookIdsToDelete.length} ${bookIdsToDelete.length === 1 ? "book" : "books"}`);
        } else {
            const updates: [string, Partial<Book>][] = [];
            for (const book of books) {
                if (book.sourceFolders?.some((sf) => sf.root === root)) {
                    const nextFolders = book.sourceFolders.filter((sf) => sf.root !== root);
                    updates.push([book.id, { sourceFolders: nextFolders }]);
                }
            }
            if (updates.length > 0) {
                updateBooks(updates);
            }
            toast.success(`Removed "${folderName}" from folders`);
        }
        if (selectedSourceFolder?.root === root) {
            setSelectedSourceFolder(null);
        }
        setFolderToRemove(null);
    }, [books, folderToRemove, removeBooks, updateBooks, selectedSourceFolder]);

    const filterPanelProps = {
        sortBy: settings.librarySortBy,
        sortOrder: settings.librarySortOrder,
        statusFilter,
        favoritesOnly: showFavoritesOnly,
        unshelvedOnly: showUnshelvedOnly,
        onSortBy: (sortBy: LibrarySortBy) => updateSettings({ librarySortBy: sortBy }),
        onSortOrder: (order: LibrarySortOrder) => updateSettings({ librarySortOrder: order }),
        onStatusFilter: setStatusFilter,
        // Favorites and "not on a shelf" are alternatives, not a combination.
        onFavoritesOnly: (on: boolean) => {
            setShowFavoritesOnly(on);
            if (on) setShowUnshelvedOnly(false);
        },
        onUnshelvedOnly: (on: boolean) => {
            setShowUnshelvedOnly(on);
            if (on) setShowFavoritesOnly(false);
        },
        sourceFolderIndex,
        selectedSourceFolder,
        onSelectSourceFolder: (folder: SourceFolderSelection | null) => {
            setSelectedSourceFolder(folder);
            clearSelection();
        },
        onRemoveSourceFolder: handleInitiateRemoveFolder,
    };

    const hasActiveFilters = Boolean(
        statusFilter !== "all" ||
        showFavoritesOnly ||
        showUnshelvedOnly ||
        selectedSourceFolder !== null
    );

    if (!smartShelvesReady && (selectedShelf?.smartRules || showUnshelvedOnly)) {
        return <div role={smartShelvesError ? "alert" : "status"} className="p-6">{smartShelvesError ?? "Updating smart shelves…"}</div>;
    }

    const folderImportStatus = folderImportProgress && (
        <div className="mt-2 mb-4">
            <FolderImportStatus progress={folderImportProgress} stopping={stoppingFolderImport} onStop={stopFolderImport} />
        </div>
    );

    if (books.length === 0) {
        return (<>
            {folderImportModal}
            {alertInfo && <AlertDialog isOpen title={alertInfo.title} message={alertInfo.message} onClose={() => setAlertInfo(null)} />}
            {folderImportStatus && <div className="mx-auto w-full max-w-[26rem] px-4 pt-6 sm:px-6">{folderImportStatus}</div>}
            <EmptyLibrary
                onAddBooks={handleAddBooks}
                onScanFolder={isTauri() ? () => setShowFolderImport(true) : undefined}
                onBrowseDiscover={() => setRoute("opds")}
                isImporting={isImporting || isScanning}
                isScanning={isScanning || isImporting}
            />
        </>);
    }

    return (
        <div className="mx-auto flex h-full w-full max-w-[var(--layout-content-max-width)] flex-col px-4 py-3 pb-0 sm:px-6 lg:px-8 lg:py-8 animate-fade-in">
            
            {folderImportModal}
            <div className="-mb-4">
            <PageHeader
                title={selectedShelf ? selectedShelf.name : showFavoritesOnly ? "Favorites" : showUnshelvedOnly ? "Unshelved" : "Library"}
                description={`${sortedBooks.length} ${sortedBooks.length === 1 ? 'book' : 'books'}${(selectedShelf || showFavoritesOnly || showUnshelvedOnly) ? '' : ''}`}
                // On a phone the actions use the whole row: Add stretches, the icon buttons sit at the end.
                actionsClassName="w-full gap-2 sm:w-auto sm:gap-2"
            >
                {(selectedShelf || showFavoritesOnly || showUnshelvedOnly) && (
                    <button
                        onClick={() => {
                            sessionStorage.removeItem("theorem-selected-shelf");
                            setSelectedShelfId(null);
                            setShowFavoritesOnly(false);
                            setShowUnshelvedOnly(false);
                        }}
                        className="text-xs text-[color:var(--color-accent)] hover:underline"
                    >
                        Clear filter
                    </button>
                )}
                <ImportButton onImport={handleAddBooks} isLoading={isImporting || isScanning} />

                <div className="ml-auto flex items-center gap-0">
                    <Button
                        data-action="toggle-select-mode"
                        onClick={() => {
                            if (isSelecting) {
                                clearSelection();
                            }
                            setIsSelecting((prev) => !prev);
                        }}
                         className={cn(
                            "h-11 w-11 px-0 sm:h-10 sm:w-auto sm:px-4 border-2 flex items-center justify-center sm:gap-2 transition-colors",
                            isSelecting ? FILTER_CHIP_SELECTED : "sr-only"
                        )}
                        title={isSelecting ? "Exit selection mode (Esc)" : "Select books"}
                        aria-label={isSelecting ? "Exit selection mode" : "Select books"}
                    >
                        {isSelecting ? <X className="w-4 h-4" /> : <CheckSquare className="w-4 h-4" />}
                        <span className="hidden sm:inline text-xs">{isSelecting ? "Done" : "Select"}</span>
                    </Button>

                    <IconButton
                        onClick={toggleViewMode}
                        className="min-h-11 min-w-11 sm:min-h-10 sm:min-w-10"
                        title={`View: ${settings.libraryViewMode}`}
                        label={`Change view (now ${settings.libraryViewMode})`}
                        icon={viewModeIcons[settings.libraryViewMode]}
                    />
                    <IconButton
                        onClick={() => setShowFilterDropdown(!showFilterDropdown)}
                        label="Filter and sort"
                        aria-expanded={showFilterDropdown}
                        data-active={showFilterDropdown || hasActiveFilters}
                        className="relative min-h-11 min-w-11 sm:min-h-10 sm:min-w-10"
                        title={hasActiveFilters ? "Filter and sort (active filters applied)" : "Filter and sort"}
                        icon={<>
                            <Funnel className={NAV_CONTROL_ICON} />
                            {hasActiveFilters && <span className="absolute top-1 right-1 h-1.5 w-1.5 bg-[color:var(--color-accent)]" />}
                        </>}
                    />
                </div>
            </PageHeader>
            {selectedSourceFolder && (
                <div className="flex items-center gap-2 my-3 animate-fade-in">
                    <span className="inline-flex items-center gap-1.5 px-3 py-1 text-xs bg-[var(--color-surface)] border border-[var(--color-border)] text-[color:var(--color-text-primary)] max-w-full">
                        <Folder className="w-3.5 h-3.5 text-[color:var(--color-text-secondary)] shrink-0" />
                        <span className="truncate max-w-[200px] sm:max-w-[320px]" title={selectedSourceFolder.root}>
                            {selectedSourceFolder.path || sourceFolderIndex.get(selectedSourceFolder.root)?.name || selectedSourceFolder.root.replace(/\\/g, "/").split("/").filter(Boolean).pop() || selectedSourceFolder.root}
                        </span>
                        <button
                            onClick={() => setSelectedSourceFolder(null)}
                            className="ml-1 text-[color:var(--color-text-muted)] hover:text-[color:var(--color-text-primary)] cursor-pointer shrink-0"
                            title="Clear folder filter"
                            aria-label="Clear folder filter"
                        >
                            <X className="w-3.5 h-3.5" />
                        </button>
                    </span>
                </div>
            )}
            {folderImportStatus}
            </div>

            {isSelecting && (
                <div
                    role="region"
                    aria-label="Bulk book actions"
                    className="w-full shrink-0 my-4 border-y-2 border-[var(--color-border)] bg-[var(--color-surface)] py-3 px-3 sm:px-4 space-y-3"
                >
                    {/* Top Row: Selection Status, Controls, and Done in the same line */}
                    <div className="flex items-center gap-2 sm:gap-2.5 flex-wrap">
                        <span className="text-sm text-[color:var(--color-text-primary)] shrink-0 mr-1">
                            {selectedBooks.length} of {sortedBooks.length} selected
                        </span>
                        <Button
                             className="px-2.5 py-1 text-xs whitespace-nowrap shrink-0"
                            onClick={selectAll}
                            disabled={!selectionReady || sortedBooks.length === 0 || allSelected}
                            title="Select all filtered books"
                        >
                            {allSelected ? "All selected" : `Select all (${sortedBooks.length})`}
                        </Button>
                        {selectedBooks.length > 0 && (
                            <Button variant="ghost"
                                 className="px-2.5 py-1 text-xs text-[color:var(--color-text-muted)] hover:text-[color:var(--color-text-primary)] whitespace-nowrap shrink-0"
                                onClick={clearSelection}
                                title="Clear selection"
                            >
                                Clear
                            </Button>
                        )}
                        {!selectionReady && (
                            <span role="status" className="text-xs text-[color:var(--color-text-muted)] animate-pulse shrink-0">
                                Updating search results…
                            </span>
                        )}
                        <Button variant="primary"
                             className="px-3 py-1 text-xs flex items-center gap-1.5 whitespace-nowrap shrink-0"
                            onClick={() => {
                                clearSelection();
                                setIsSelecting(false);
                            }}
                            title="Done (exit selection, Esc)"
                            aria-label="Done (exit selection)"
                        >
                            <X className="w-3.5 h-3.5" />
                            <span>Done</span>
                        </Button>
                    </div>

                    {/* Bottom Row: Actions with full icons + full text labels in horizontal scrollable strip */}
                    <div className="flex items-center gap-2 overflow-x-auto no-scrollbar py-0.5">
                        {allSelectedCompleted ? (
                            <Button
                                onClick={handleBatchMarkUnread}
                                aria-label="Mark selected as unread"
                                disabled={!selectionReady || selectedBooks.length === 0}
                                 className="px-3 py-1.5 text-xs border-2 flex items-center gap-1.5 whitespace-nowrap shrink-0 disabled:opacity-40"
                            >
                                <RotateCcw className="w-3.5 h-3.5" />
                                <span>Mark Unread</span>
                            </Button>
                        ) : (
                            <Button
                                onClick={handleBatchMarkRead}
                                aria-label="Mark selected as read"
                                disabled={!selectionReady || selectedBooks.length === 0}
                                 className="px-3 py-1.5 text-xs border-2 flex items-center gap-1.5 whitespace-nowrap shrink-0 disabled:opacity-40"
                            >
                                <CheckCheck className="w-3.5 h-3.5 text-[color:var(--color-accent)]" />
                                <span>Mark Read</span>
                            </Button>
                        )}
                        <Button
                            onClick={handleBatchAddToShelf}
                            aria-label="Add selected to shelf"
                            disabled={!selectionReady || selectedBooks.length === 0}
                             className="px-3 py-1.5 text-xs border-2 flex items-center gap-1.5 whitespace-nowrap shrink-0 disabled:opacity-40"
                        >
                            <BookMarked className="w-3.5 h-3.5" />
                            <span>Add to Shelf</span>
                        </Button>
                        <Button
                            onClick={() => setIsSeriesModalOpen(true)}
                            aria-label="Assign series"
                            disabled={!selectionReady || selectedBooks.length === 0}
                             className="px-3 py-1.5 text-xs border-2 flex items-center gap-1.5 whitespace-nowrap shrink-0 disabled:opacity-40"
                        >
                            <ListOrdered className="w-3.5 h-3.5" />
                            <span>Series</span>
                        </Button>
                        <Button
                            onClick={handleBatchExport}
                            aria-label="Export selected books"
                            disabled={!selectionReady || selectedBooks.length === 0}
                             className="px-3 py-1.5 text-xs border-2 flex items-center gap-1.5 whitespace-nowrap shrink-0 disabled:opacity-40"
                        >
                            <Download className="w-3.5 h-3.5" />
                            <span>Export</span>
                        </Button>

                        <div className="h-5 w-px bg-[var(--color-border)] shrink-0 mx-1" />

                        <Button variant="danger"
                            onClick={handleBatchDelete}
                            aria-label="Delete selected books"
                            disabled={!selectionReady || selectedBooks.length === 0}
                             className="px-3 py-1.5 text-xs border-2 flex items-center gap-1.5 whitespace-nowrap shrink-0 disabled:opacity-40"
                        >
                            <Trash2 className="w-3.5 h-3.5" />
                            <span>Delete</span>
                        </Button>
                    </div>
                </div>
            )}

            <div className="flex min-h-0 flex-1 flex-col md:flex-row gap-6 md:gap-10 relative">
                <div className="flex min-h-0 flex-1 flex-col w-full">
                    
                    <div
                        className={cn(
                            "md:hidden shrink-0 overflow-hidden transition-colors duration-300",
                            showFilterDropdown ? "max-h-[800px] mb-8 opacity-100" : "max-h-0 opacity-0 mb-0"
                        )}
                        inert={!showFilterDropdown}
                        aria-hidden={!showFilterDropdown}
                    >
                        <div className="w-full border-t-2 border-b-2 border-[var(--color-border)] bg-[var(--color-surface-muted)]">
                            <LibraryFilterPanel
                                variant="sheet"
                                {...filterPanelProps}
                            />
                        </div>
                    </div>

                    <section aria-label="Library books" ref={assignScrollRef} onScroll={(event) => {
                        if (currentRoute === "library") savedScrollOffset.current = event.currentTarget.scrollTop;
                    }} className="flex-1 min-h-0 overflow-y-auto overscroll-contain scrollbar-solid [content-visibility:auto] pb-[calc(var(--layout-bottom-nav-height)+var(--safe-area-bottom)+var(--spacing-lg))] md:pb-0">
                        <div ref={scrollHeaderRef} className="flow-root">
                        <LibraryDailyReviewDeck
                            showDailyHighlight={!!settings.showDailyHighlight}
                            selectedShelf={selectedShelf}
                            showFavoritesOnly={showFavoritesOnly}
                            isSelecting={isSelecting}
                        />
                        </div>
                        {sortedBooks.length === 0 ? (
                            <div className="text-center py-16 border-2 border-dashed border-[var(--color-border)]">
                                <p className="text-[color:var(--color-text-muted)] text-xs">No documents match criteria</p>
                                {searchQuery && (
                                    <button onClick={() => useUIStore.getState().setSearchQuery("")} className="mt-4 text-[10px] text-[color:var(--color-accent)] hover:underline tracking-tighter">
                                        [ RESET SEARCH ]
                                    </button>
                                )}
                            </div>
                        ) : (
                            <div style={{ height: `${rowVirtualizer.getTotalSize()}px`, position: "relative" }}>
                                    {rowVirtualizer.getVirtualItems().map((measurement) => {
                                        // Scroller measurements include the header; rows render within the grid.
                                        const virtualRow = { ...measurement, start: measurement.start - scrollHeaderHeight };
                                        const rowStart = virtualRow.index * (isListView ? 1 : effectiveCols);
                                        const itemsInRow = isListView
                                            ? 1
                                            : Math.min(effectiveCols, sortedBooks.length - rowStart);
                                        const rowItems = isListView
                                            ? [sortedBooks[virtualRow.index]]
                                            : sortedBooks.slice(rowStart, rowStart + itemsInRow);

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
                                                            key={rowItems[0].id}
                                                            book={rowItems[0]}
                                                            isResume={rowItems[0].id === resumeBookId}
                                                            viewMode={settings.libraryViewMode}
                                                            isSelected={selectedBookIds.has(rowItems[0].id)}
                                                            titleHighlightIndices={matchHighlights.get(rowItems[0].id)?.titleIndices}
                                                            authorHighlightIndices={matchHighlights.get(rowItems[0].id)?.authorIndices}
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
                                                                isResume={book.id === resumeBookId}
                                                                viewMode={settings.libraryViewMode}
                                                                isSelected={selectedBookIds.has(book.id)}
                                                                titleHighlightIndices={matchHighlights.get(book.id)?.titleIndices}
                                                                authorHighlightIndices={matchHighlights.get(book.id)?.authorIndices}
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

                {showFilterDropdown && (
                    <>
                        <div className="hidden md:block fixed inset-0 z-30" onClick={() => setShowFilterDropdown(false)} />
                        <aside className="hidden md:block w-72 absolute right-0 top-0 z-40 border-2 border-[var(--color-border)] bg-[var(--color-surface)] animate-in slide-in-from-right-4 duration-200 max-h-[80vh] overflow-y-auto [content-visibility:auto] overscroll-contain">
                            <LibraryFilterPanel
                                variant="popover"
                                {...filterPanelProps}
                            />
                    </aside>
                    </>
                )}
            </div>

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
                currentShelfIds={addToShelfMembership}
                onAddToShelf={handleAddBookToShelf}
                onRemoveFromShelf={handleRemoveBookFromShelf}
                onCreateShelf={handleCreateShelf}
            />

            <AssignSeriesModal
                isOpen={isSeriesModalOpen}
                onClose={() => {
                    setIsSeriesModalOpen(false);
                    clearSelection();
                    setIsSelecting(false);
                }}
                bookIds={selectedBooks}
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
                        removeBooks((deleteConfirm.bookIds ?? []).filter((id) => selectedBookIds.has(id)));
                        clearSelection();
                        setIsSelecting(false);
                    } else if (deleteConfirm?.bookId) {
                        removeBook(deleteConfirm.bookId);
                    }
                    setDeleteConfirm(null);
                }}
                onCancel={() => setDeleteConfirm(null)}
            />

            <RemoveFolderModal
                folderToRemove={folderToRemove}
                onClose={() => setFolderToRemove(null)}
                onConfirm={handleConfirmRemoveFolder}
            />
        </div>
    );
}
