import { SELECT_ALL_EVENT } from "../../core/lib/keyboard-shortcuts";
import { useSmartShelves } from "../../core/lib/useSmartShelves";

import { useState, useCallback, useEffect, useId, useLayoutEffect, useRef, useMemo } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn, normalizeFilePath, normalizeAuthor, formatProgress, formatFileSize, formatRelativeDate } from "../../core/lib/utils";
import { FILTER_CHIP_SELECTED } from "../../ui/filter-chips";
import { saveCoverImage, getBookData } from "../../core/lib/storage";
import { sanitizeHtml } from "../../core/lib/sanitize";
import { buildFallbackCoverSvg, shouldUseExtractedTitle, shouldUseExtractedAuthor } from "../../core/lib/cover-extractor";
import { ensureFilenameForFormat, extractFilenameFromPath, pickAndImportBooksIncremental, scanBookFolder } from "../../core/lib/import";
import { pickLibraryFolderMobile, scanLibraryFolderMobileDetailed } from "../../core/lib/mobile-folder-scan";
import { describeFolderImport, importFolder, type FolderImportDeps, type FolderImportProgress } from "../../core/lib/folder-import";
import { FolderImportStatus } from "./components/FolderImportStatus";
import { isMobile, isTauri } from "../../core/lib/env";
import { showOpenDirectoryDialog } from "../../core/lib/dialogs";
import { useLibraryStore, useUIStore, useSettingsStore } from "../../core/store";
import { LibraryFilterPanel } from "./LibraryFilterPanel";
import { LibraryDailyReviewDeck } from "./components/LibraryDailyReviewDeck";
import type { Book, Collection, LibraryViewMode, LibrarySortBy, LibrarySortOrder, LibraryStatusFilter } from "../../core/types";
import { FORMAT_DISPLAY_NAMES } from "../../core/types";
import {
    Plus, BookOpen, Loader2, FolderOpen, RefreshCw, Trash2, BookMarked, LayoutGrid, List, Grid3X3, CheckCheck, RotateCcw, Star, Check, Compass, Pencil, Download, ListOrdered, X, CheckSquare, Folder, SlidersHorizontal
} from "lucide-react";
import { Button, PageHeader, TheoremBookCover } from "../../ui";
import { TOOLBAR_ICON_BUTTON } from "../../ui/toolbar-styles";
import { Modal, ModalHeader, ModalBody, ModalFooter, ConfirmDialog, AlertDialog } from "../../ui";
import { getFilteredAndSortedBooks } from "./filtering";
import { useDebounce } from "../../core/lib/useDebounce";
import { twoTierSearchBooks } from "../../core/lib/sqlite-storage";
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
    grid: <LayoutGrid className="w-4 h-4" />,
    list: <List className="w-4 h-4" />,
    compact: <Grid3X3 className="w-4 h-4" />,
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

import { normalizeMetadataText, isBookMarkedRead } from "./components/BookCard";


export { BookCard, MemoizedBookCard } from "./components/BookCard";
import { MemoizedBookCard } from "./components/BookCard";

export function EmptyLibrary({
    onAddBooks,
    onScanFolder,
    onBrowseDiscover,
    isImporting,
    isScanning,
}: {
    onAddBooks: () => void;
    onScanFolder?: () => void;
    onBrowseDiscover: () => void;
    isImporting: boolean;
    isScanning: boolean;
}) {
    return (
        <div className="mx-auto w-full max-w-[26rem] min-w-0 px-4 sm:px-6 flex flex-col items-center justify-center py-24 text-center animate-fade-in">
            <div className="w-16 h-16 bg-[var(--color-surface-muted)] flex items-center justify-center mb-6">
                <BookOpen className="w-6 h-6 text-[color:var(--color-text-secondary)]" />
            </div>
            <h2 className="w-full break-words text-balance text-lg text-[color:var(--color-text-primary)] mb-2">
                No Books Yet
            </h2>
            <p className="mx-auto w-full max-w-[24rem] break-words text-[color:var(--color-text-muted)] mb-8 text-sm leading-relaxed">
                Add EPUB, PDF, MOBI, FB2 or comic files from this device, or find free books in Discover.
            </p>
            <div className="flex flex-wrap items-center justify-center gap-3">
                <Button variant="primary"
                    onClick={onAddBooks}
                    disabled={isImporting}
                     className={cn("min-w-[10.5rem] whitespace-nowrap px-6 py-2.5")}
                >
                    {isImporting ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                        <Plus className="w-4 h-4" />
                    )}
                    <span>{isImporting ? "Importing..." : "Import Books"}</span>
                </Button>

                {onScanFolder && (
                    <Button
                        onClick={onScanFolder}
                        disabled={isScanning}
                         className={cn("min-w-[10.5rem] whitespace-nowrap px-6 py-2.5")}
                    >
                        {isScanning ? (
                            <RefreshCw className="w-4 h-4 animate-spin" />
                        ) : (
                            <FolderOpen className="w-4 h-4" />
                        )}
                        <span>{isScanning ? "Scanning..." : "Scan Folder"}</span>
                    </Button>
                )}
            </div>
            <button
                type="button"
                onClick={onBrowseDiscover}
                className="mt-6 inline-flex items-center gap-2 text-sm text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-accent)] transition-colors"
            >
                <Compass className="w-4 h-4" />
                Browse free books in Discover
            </button>
        </div>
    );
}

function ImportButton({
    onImport,
    isLoading,
}: {
    onImport: () => void;
    isLoading: boolean;
}) {
    return (
        <Button variant="primary"
            onClick={onImport}
            disabled={isLoading}
             className={cn("h-11 px-3.5 sm:h-10 sm:px-4")}
        >
            {isLoading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
                <Plus className="w-4 h-4" />
            )}
            <span className="hidden sm:inline">Add Books</span>
            <span className="sm:hidden">Add</span>
        </Button>
    );
}

export function BookInfoModal({ book, isOpen, onClose, onEdit }: { book: Book | null; isOpen: boolean; onClose: () => void; onEdit?: (book: Book) => void }) {
    if (!book) return null;

    return (
        <Modal isOpen={isOpen} onClose={onClose} size="md" showCloseButton={true}>
            <ModalBody className="p-0">
                <div className="p-6">
                    <div className="flex items-start gap-4">
                        <div className="w-24 h-36 shrink-0 overflow-hidden">
                            <TheoremBookCover
                                title={book.title}
                                author={book.author}
                                coverUrl={book.coverPath}
                            />
                        </div>
                        <div className="flex-1 min-w-0">
                            <h2 className="text-lg text-[color:var(--color-text-primary)] line-clamp-2">
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
                        {book.series && (
                            <div className="p-3 bg-[var(--color-surface-muted)] border border-[var(--color-border)]">
                                <p className="text-xs text-[color:var(--color-text-muted)]">Series</p>
                                <p className="text-sm text-[color:var(--color-text-primary)] mt-0.5">
                                    {book.series}
                                    {book.seriesIndex !== undefined ? ` • Volume ${book.seriesIndex}` : ""}
                                </p>
                            </div>
                        )}
                        {book.description && (
                            <div>
                                <p className="text-xs text-[color:var(--color-text-muted)]">Description</p>
                                <div
                                    className="text-sm text-[color:var(--color-text-secondary)] mt-1 [&_a]:text-[var(--color-accent)] [&_a]:underline prose prose-sm max-w-none"
                                    dangerouslySetInnerHTML={{ __html: sanitizeHtml(book.description) }}
                                />
                            </div>
                        )}
                        <div className="grid grid-cols-2 gap-3">
                            {book.publisher && (
                                <div>
                                    <p className="text-xs text-[color:var(--color-text-muted)]">Publisher</p>
                                    <p className="text-sm text-[color:var(--color-text-secondary)]">{book.publisher}</p>
                                </div>
                            )}
                            {book.publishedDate && (
                                <div>
                                    <p className="text-xs text-[color:var(--color-text-muted)]">Published</p>
                                    <p className="text-sm text-[color:var(--color-text-secondary)]">{book.publishedDate}</p>
                                </div>
                            )}
                            {book.language && (
                                <div>
                                    <p className="text-xs text-[color:var(--color-text-muted)]">Language</p>
                                    <p className="text-sm text-[color:var(--color-text-secondary)]">{book.language}</p>
                                </div>
                            )}
                            {book.isbn && (
                                <div>
                                    <p className="text-xs text-[color:var(--color-text-muted)]">ISBN</p>
                                    <p className="text-sm text-[color:var(--color-text-secondary)]">{book.isbn}</p>
                                </div>
                            )}
                            <div>
                                <p className="text-xs text-[color:var(--color-text-muted)]">Format</p>
                                <p className="text-sm text-[color:var(--color-text-secondary)]">{FORMAT_DISPLAY_NAMES[book.format] || book.format}</p>
                            </div>
                            <div>
                                <p className="text-xs text-[color:var(--color-text-muted)]">Size</p>
                                <p className="text-sm text-[color:var(--color-text-secondary)]">{formatFileSize(book.fileSize)}</p>
                            </div>
                            <div>
                                <p className="text-xs text-[color:var(--color-text-muted)]">Added</p>
                                <p className="text-sm text-[color:var(--color-text-secondary)]">{formatRelativeDate(book.addedAt instanceof Date ? book.addedAt : new Date(book.addedAt))}</p>
                            </div>
                            {book.lastReadAt && (
                                <div>
                                    <p className="text-xs text-[color:var(--color-text-muted)]">Last Read</p>
                                    <p className="text-sm text-[color:var(--color-text-secondary)]">{book.lastReadAt ? formatRelativeDate(book.lastReadAt instanceof Date ? book.lastReadAt : new Date(book.lastReadAt)) : "Never"}</p>
                                </div>
                            )}
                        </div>
                        {book.progress > 0 && (
                            <div>
                                <p className="text-xs text-[color:var(--color-text-muted)]">Progress</p>
                                <p className="text-sm text-[color:var(--color-text-secondary)]">{formatProgress(book.progress)}</p>
                            </div>
                        )}
                        {book.tags.length > 0 && (
                            <div>
                                <p className="text-xs text-[color:var(--color-text-muted)] mb-1">Tags</p>
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
                    <Button
                        onClick={() => {
                            onClose();
                            onEdit(book);
                        }}
                         className="px-3 py-1.5 text-xs"
                    >
                        <Pencil className="w-3.5 h-3.5" />
                        Edit
                    </Button>
                )}
                <Button variant="ghost"
                    onClick={onClose}
                    
                >
                    Close
                </Button>
            </ModalFooter>
        </Modal>
    );
}

export function AddToShelfModal({
    isOpen,
    onClose,
    bookId,
    collections,
    currentShelfIds,
    onAddToShelf,
    onRemoveFromShelf,
    onCreateShelf,
}: {
    isOpen: boolean;
    onClose: () => void;
    bookId: string | null;
    collections: Collection[];
    /** Shelves `bookId` already belongs to, so the dialog can toggle membership. */
    currentShelfIds?: ReadonlySet<string>;
    onAddToShelf: (bookId: string | null, shelfId: string) => void;
    onRemoveFromShelf?: (shelfId: string) => void;
    onCreateShelf: (name: string) => void;
}) {
    const [newShelfName, setNewShelfName] = useState("");
    const titleId = useId();

    const handleCreateShelf = () => {
        if (newShelfName.trim()) {
            onCreateShelf(newShelfName.trim());
            setNewShelfName("");
        }
    };

    const [shelfSearch, setShelfSearch] = useState("");

    const filteredShelves = useMemo(
        () => shelfSearch.trim()
            ? collections.filter((s) => !s.smartRules && s.name.toLowerCase().includes(shelfSearch.toLowerCase()))
            : collections.filter((s) => !s.smartRules),
        [collections, shelfSearch],
    );

    const renderShelfItem = (shelf: Collection) => {
        const isMember = !!currentShelfIds?.has(shelf.id);
        return (
            <button
                key={shelf.id}
                role="checkbox"
                aria-checked={isMember}
                onClick={() => {
                    // Toggle rather than add-only, so a book can also be removed
                    // from a shelf on a phone. The dialog stays open so several
                    // shelves can be fixed in one go.
                    if (isMember) {
                        onRemoveFromShelf?.(shelf.id);
                    } else {
                        onAddToShelf(bookId, shelf.id);
                    }
                }}
                className="w-full flex items-center gap-2 p-2 hover:bg-[var(--color-surface-muted)] transition-colors text-left"
            >
                <FolderOpen className="w-4 h-4 shrink-0 text-[color:var(--color-text-muted)]" />
                <div className="flex-1 min-w-0">
                    <p className={cn(
                        "text-sm truncate",
                        isMember
                            ? "text-[color:var(--color-accent)]"
                            : "text-[color:var(--color-text-primary)]"
                    )}>
                        {shelf.name}
                    </p>
                    <p className="text-[11px] text-[color:var(--color-text-muted)]">
                        {shelf.bookIds.length} {shelf.bookIds.length === 1 ? "book" : "books"}
                    </p>
                </div>
                {isMember && (
                    <Check className="w-4 h-4 shrink-0 text-[color:var(--color-accent)]" />
                )}
            </button>
        );
    };

    return (
        <Modal isOpen={isOpen} onClose={onClose} size="sm" showCloseButton={true} ariaLabelledby={titleId}>
            <ModalBody className="p-0">
                <div className="p-4 sm:p-6">
                    <h2 id={titleId} className="text-base sm:text-lg text-[color:var(--color-text-primary)] mb-3">
                        {currentShelfIds && currentShelfIds.size > 0 ? "Shelves" : "Add to Shelf"}
                    </h2>

                    {collections.length > 0 && (
                        <input
                            type="text"
                            value={shelfSearch}
                            onChange={(e) => setShelfSearch(e.target.value)}
                            aria-label="Search shelves"
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
                        <p className="text-[11px] text-[color:var(--color-text-muted)] mb-2">Create New Shelf</p>
                        <div className="flex gap-2">
                            <input
                                type="text"
                                value={newShelfName}
                                onChange={(e) => setNewShelfName(e.target.value)}
                                aria-label="New shelf name"
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
                            <Button variant="primary"
                                onClick={handleCreateShelf}
                                disabled={!newShelfName.trim()}
                                 className="text-xs px-3"
                            >
                                Create
                            </Button>
                        </div>
                    </div>
                </div>
            </ModalBody>
            <ModalFooter>
                <Button variant="ghost"
                    onClick={onClose}
                    
                >
                    Cancel
                </Button>
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
                        <label htmlFor="rename-title"className="block text-sm text-[color:var(--color-text-primary)] mb-1.5">
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
                    <Button variant="ghost"
                        
                        onClick={onClose}
                        
                    >
                        Cancel
                    </Button>
                    <Button variant="primary"
                        type="submit"
                        disabled={!title.trim() || title.trim() === book.title}
                         className="disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        Save
                    </Button>
                </ModalFooter>
            </form>
        </Modal>
    );
}

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

    const [isImporting, setIsImporting] = useState(false);
    const [isScanning, setIsScanning] = useState(false);
    const scanInProgress = useRef(false);
    const [folderImportProgress, setFolderImportProgress] = useState<FolderImportProgress | null>(null);
    const folderImportAbort = useRef<AbortController | null>(null);
    const [stoppingFolderImport, setStoppingFolderImport] = useState(false);
    const [showFolderImport, setShowFolderImport] = useState(false);
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
    const [isExtractingCovers, setIsExtractingCovers] = useState(false);
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

    const extractedBookIdsRef = useRef<Set<string>>(new Set());
    const pendingImportMetadataQueueRef = useRef<Book[]>([]);
    const queuedImportMetadataIdsRef = useRef<Set<string>>(new Set());
    const activeImportMetadataTasksRef = useRef(0);

    const performImportedBookMetadataExtraction = useCallback(async (book: Book) => {
        const latestBook = useLibraryStore
            .getState()
            .getBook(book.id) ?? book;

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
            if (metadata.series && !latestBook.series) {
                updates.series = metadata.series;
            }
            if (metadata.seriesIndex !== undefined && latestBook.seriesIndex === undefined) {
                updates.seriesIndex = metadata.seriesIndex;
            }

            const hasUsefulMetadataUpdate = (
                Boolean(metadata.coverDataUrl)
                || shouldUpdateTitle
                || shouldUpdateAuthor
                || Boolean(metadata.description && !latestBook.description)
                || Boolean(metadata.publisher && !latestBook.publisher)
                || Boolean(metadata.language && !latestBook.language)
                || Boolean(metadata.publishedDate && !latestBook.publishedDate)
                || Boolean(metadata.series && !latestBook.series)
                || Boolean(metadata.seriesIndex !== undefined && latestBook.seriesIndex === undefined)
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

    const sortedBooks = useMemo(() => {
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

    const scrollRef = useRef<HTMLDivElement>(null);
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
            setObservedCols(compute());
            if (lastWidth === 0 && currentWidth > 0) {
                rowVirtualizer.measure();
            }
            lastWidth = currentWidth;
        });
        observer.observe(el);
        return () => observer.disconnect();
    }, [isListView, isCompactView]);

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

    useLayoutEffect(() => {
        if (currentRoute === "library") {
            rowVirtualizer.measure();
        }
    }, [currentRoute, rowVirtualizer, settings.libraryViewMode, effectiveCols, isCompactView, isListView]);

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
        if (scanInProgress.current) return;
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

    const runFolderImport = useCallback(async (root: string, preserve: boolean, scan: FolderImportDeps["scan"]) => {
        const controller = new AbortController();
        folderImportAbort.current = controller;
        setStoppingFolderImport(false);
        try {
            const result = await importFolder(root, preserve, {
                scan,
                getBooks: () => useLibraryStore.getState().books,
                addBooks: (batch) => useLibraryStore.getState().addBooks(batch),
                updateBooks: (updates) => useLibraryStore.getState().updateBooks(updates),
                onBooksAdded: (batch) => {
                    for (const book of batch) void extractImportedBookMetadata(book);
                },
                onProgress: setFolderImportProgress,
            }, controller.signal);
            if (!result.cancelled) setLastScannedAt(new Date());
            if (preserve && result.imported + result.alreadyInLibrary > 0) {
                setSelectedSourceFolder({ root, path: "" });
                setSelectedShelfId(null);
                sessionStorage.removeItem("theorem-selected-shelf");
                setShowFavoritesOnly(false);
                setShowUnshelvedOnly(false);
            }
            const summary = describeFolderImport(result);
            if (summary) setAlertInfo(summary);
        } finally {
            folderImportAbort.current = null;
            setFolderImportProgress(null);
            setStoppingFolderImport(false);
        }
    }, [extractImportedBookMetadata, setLastScannedAt]);

    const stopFolderImport = useCallback(() => {
        setStoppingFolderImport(true);
        folderImportAbort.current?.abort();
    }, []);

    const handleScanFolder = useCallback(async (preserve: boolean) => {
        if (scanInProgress.current || isImporting) return;
        if (!isTauri()) {
            setAlertInfo({ title: "Not Available", message: "Folder scanning requires the desktop app." });
            return;
        }

        scanInProgress.current = true;
        setIsScanning(true);
        try {
            if (isMobile()) {

                const pickedFolder = await pickLibraryFolderMobile();
                if (!pickedFolder) {
                    setIsScanning(false);
                    return;
                }

                updateSettings({ scanFolders: [pickedFolder] });

                try {
                    await runFolderImport(pickedFolder, preserve, (root) => scanLibraryFolderMobileDetailed(root));
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
            await runFolderImport(normalizedFolderPath, preserve, (root, signal) => scanBookFolder(root, signal));
        } catch (err) {
            setAlertInfo({ title: "Scan Error", message: err instanceof Error ? err.message : 'Failed to scan selected folder.' });
        } finally {
            scanInProgress.current = false;
            setIsScanning(false);
        }
    }, [
        isImporting,
        runFolderImport,
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

    const [folderToRemove, setFolderToRemove] = useState<{ root: string; name: string; count: number } | null>(null);
    const [removeFolderDeleteBooks, setRemoveFolderDeleteBooks] = useState(false);

    const handleInitiateRemoveFolder = useCallback((root: string) => {
        const entry = sourceFolderIndex.get(root);
        const displayName = entry?.name && entry.name !== root
            ? entry.name
            : root.replace(/\\/g, "/").split("/").filter(Boolean).pop() || root;
        const count = entry?.folders.get("")?.size ?? 0;
        setRemoveFolderDeleteBooks(false);
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
                actionsClassName="w-full sm:w-auto"
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

                <div className="flex items-center gap-2 sm:gap-4 ml-auto">
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

                    <Button
                        onClick={toggleViewMode}
                         className={cn(TOOLBAR_ICON_BUTTON, "border-2")}
                        title={`View: ${settings.libraryViewMode}`}
                        aria-label={`Change view (now ${settings.libraryViewMode})`}
                    >
                        {viewModeIcons[settings.libraryViewMode]}
                    </Button>

                    <Button
                        onClick={() => setShowFilterDropdown(!showFilterDropdown)}
                        aria-label="Filter and sort"
                        aria-expanded={showFilterDropdown}
                         className={cn(
                            TOOLBAR_ICON_BUTTON,
                            "relative border-2 transition-colors",
                            showFilterDropdown
                                ? FILTER_CHIP_SELECTED
                                : hasActiveFilters
                                ? "bg-[var(--color-surface)] text-[color:var(--color-accent)] border-[var(--color-accent)]"
                                : "bg-[var(--color-surface)] text-[color:var(--color-text-secondary)] border-[var(--color-border)] hover:border-[var(--color-text-primary)]"
                        )}
                        title={hasActiveFilters ? "Filter and sort (active filters applied)" : "Filter and sort"}
                    >
                        <SlidersHorizontal className="w-4 h-4" />
                        {hasActiveFilters && (
                            <span className="absolute top-2 right-2 w-2 h-2 rounded-full bg-[color:var(--color-accent)] ring-2 ring-[var(--color-surface)]" />
                        )}
                    </Button>
                </div>
            </PageHeader>
            {selectedSourceFolder && (
                <div className="flex items-center gap-2 my-3 animate-fade-in">
                    <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs bg-[var(--color-surface)] border border-[var(--color-border)] text-[color:var(--color-text-primary)] max-w-full">
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
                    
                    <div className={cn(
                        "md:hidden shrink-0 overflow-hidden transition-colors duration-300",
                        showFilterDropdown ? "max-h-[800px] mb-8 opacity-100" : "max-h-0 opacity-0 mb-0"
                    )}>
                        <div className="w-full border-t-2 border-b-2 border-[var(--color-border)] bg-[var(--color-surface-muted)]">
                            <LibraryFilterPanel
                                variant="sheet"
                                {...filterPanelProps}
                            />
                        </div>
                    </div>

                    <section aria-label="Library books" ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto overscroll-contain scrollbar-solid [content-visibility:auto] pb-[calc(var(--layout-bottom-nav-height)+var(--safe-area-bottom)+var(--spacing-lg))] md:pb-0">
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

            {folderToRemove && (
                <Modal isOpen={!!folderToRemove} onClose={() => setFolderToRemove(null)} size="sm" showCloseButton={true}>
                    <ModalHeader title="Remove Folder" onClose={() => setFolderToRemove(null)} showCloseButton={true} />
                    <ModalBody>
                        <p className="text-sm leading-relaxed text-[color:var(--color-text-primary)] font-medium">
                            Remove &ldquo;{folderToRemove.name}&rdquo; from your library?
                        </p>
                        <p className="text-xs text-[color:var(--color-text-muted)] mt-1 truncate" title={folderToRemove.root}>
                            {folderToRemove.root}
                        </p>
                        <p className="text-xs text-[color:var(--color-text-muted)] mt-3">
                            Your original book files on your device will never be deleted.
                        </p>
                        {folderToRemove.count > 0 && (
                            <label className="flex items-center gap-2 mt-4 text-xs text-[color:var(--color-text-primary)] cursor-pointer select-none">
                                <input
                                    type="checkbox"
                                    checked={removeFolderDeleteBooks}
                                    onChange={(e) => setRemoveFolderDeleteBooks(e.target.checked)}
                                    className="rounded border-[var(--color-border)] text-[color:var(--color-accent)]"
                                />
                                <span>Also remove {folderToRemove.count} {folderToRemove.count === 1 ? "book" : "books"} from Theorem library</span>
                            </label>
                        )}
                    </ModalBody>
                    <ModalFooter>
                        <Button variant="ghost"
                            
                            onClick={() => setFolderToRemove(null)}
                            
                        >
                            Cancel
                        </Button>
                        <Button variant="danger"
                            
                            onClick={() => {
                                handleConfirmRemoveFolder(folderToRemove.root, removeFolderDeleteBooks);
                            }}
                            
                        >
                            Remove Folder
                        </Button>
                    </ModalFooter>
                </Modal>
            )}
        </div>
    );
}
