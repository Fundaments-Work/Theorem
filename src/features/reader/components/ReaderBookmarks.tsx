
import { Bookmark, X, Trash2, ExternalLink } from 'lucide-react';
import { useLibraryStore } from "../../../core/store";
import { format } from 'date-fns';
import { Backdrop, FloatingPanel } from "../../../ui";

interface ReaderBookmarksProps {
    bookId: string;
    visible: boolean;
    onClose: () => void;
    onNavigate: (location: string) => void;
    className?: string;
}

export function ReaderBookmarks({
    bookId,
    visible,
    onClose,
    onNavigate,
    className,
}: ReaderBookmarksProps) {
    const getBookAnnotations = useLibraryStore((s) => s.getBookAnnotations);
    const removeAnnotation = useLibraryStore((s) => s.removeAnnotation);
    const bookmarks = getBookAnnotations(bookId).filter(a => a.type === 'bookmark');

    return (
        <>
            <Backdrop visible={visible} onClick={onClose} />

            <FloatingPanel visible={visible} label="Bookmarks" className={className}>
                
                <div className="flex items-center justify-between p-5 border-b border-[var(--color-border)]">
                    <div className="flex items-center gap-2.5">
                        <div className="p-1.5 bg-[var(--color-background)] text-[color:var(--color-accent)]">
                            <Bookmark className="w-4 h-4 fill-current" />
                        </div>
                        <h2 className="text-sm text-[color:var(--color-text-primary)]">Bookmarks</h2>
                    </div>
                    <button
                        onClick={onClose}
                        className="p-1.5 transition-colors text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-accent)]"
                    >
                        <X className="w-4 h-4" />
                    </button>
                </div>

                <div className="flex-1 overflow-y-auto p-4 custom-scrollbar max-h-[var(--layout-reader-list-max-height)] [content-visibility:auto] overscroll-contain">
                    {bookmarks.length === 0 ? (
                        <div className="w-full flex flex-col items-center justify-center py-12 px-6 text-center">
                            <div className="w-12 h-12 bg-[var(--color-background)] flex items-center justify-center mb-4 text-[color:var(--color-text-muted)]">
                                <Bookmark className="w-6 h-6" />
                            </div>
                            <h3 className="text-sm text-[color:var(--color-text-primary)] mb-1">No bookmarks yet</h3>
                            <p className="w-full max-w-[17rem] text-xs text-[color:var(--color-text-muted)] leading-relaxed">
                                Save interesting passages or chapters to find them easily later.
                            </p>
                        </div>
                    ) : (
                        <div className="space-y-2">
                            {bookmarks.map((bookmark) => (
                                <div
                                    key={bookmark.id}
                                    className="group flex flex-col gap-2 p-3 border border-transparent hover:border-[var(--color-border)] hover:bg-[var(--color-background)] transition-colors cursor-pointer"
                                    onClick={() => {
                                        onNavigate(bookmark.location);
                                        onClose();
                                    }}
                                >
                                    <div className="flex items-start justify-between gap-3">
                                        <div className="flex-1 min-w-0">
                                            <p className="text-[var(--font-size-caption)] text-[color:var(--color-text-primary)] line-clamp-2 leading-snug">
                                                {bookmark.selectedText || 'Position ' + bookmark.location.substring(0, 8) + '...'}
                                            </p>
                                        </div>
                                        <button
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                removeAnnotation(bookmark.id);
                                            }}
                                            className="reader-danger-action p-1.5 text-[color:var(--color-text-muted)] transition-colors"
                                        >
                                            <Trash2 className="w-3.5 h-3.5" />
                                        </button>
                                    </div>
                                    <div className="flex items-center justify-between text-[var(--font-size-3xs)] text-[color:var(--color-text-muted)]">
                                        <span>{format(new Date(bookmark.createdAt), 'MMM d, yyyy')}</span>
                                        <div className="flex items-center gap-1 text-[color:var(--color-accent)] transition-opacity">
                                            <span>Jump to</span>
                                            <ExternalLink className="w-2.5 h-2.5" />
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </FloatingPanel>
        </>
    );
}

export default ReaderBookmarks;
