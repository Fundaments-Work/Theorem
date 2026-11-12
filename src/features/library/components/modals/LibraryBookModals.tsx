import { useState, useEffect, useId, useMemo } from "react";
import { cn, normalizeAuthor, formatProgress, formatFileSize, formatRelativeDate } from "../../../../core/lib/utils";
import { sanitizeHtml } from "../../../../core/lib/sanitize";
import type { Book, Collection } from "../../../../core/types";
import { FORMAT_DISPLAY_NAMES } from "../../../../core/types";
import { FolderOpen, Star, Check, Pencil } from "lucide-react";
import { Button, TheoremBookCover } from "../../../../ui";
import { Modal, ModalHeader, ModalBody, ModalFooter } from "../../../../ui";

export function BookInfoModal({
    book,
    isOpen,
    onClose,
    onEdit,
}: {
    book: Book | null;
    isOpen: boolean;
    onClose: () => void;
    onEdit?: (book: Book) => void;
}) {
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
                <Button variant="ghost" onClick={onClose}>
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

    useEffect(() => {
        if (!isOpen) {
            setShelfSearch("");
            setNewShelfName("");
        }
    }, [isOpen, bookId]);

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
                            <Button
                                variant="primary"
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
                <Button variant="ghost" onClick={onClose}>
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
                        <label htmlFor="rename-title" className="block text-sm text-[color:var(--color-text-primary)] mb-1.5">
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
                    <Button variant="ghost" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button
                        variant="primary"
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
