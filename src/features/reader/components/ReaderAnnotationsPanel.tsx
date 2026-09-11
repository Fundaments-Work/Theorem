
import { useMemo, useState } from 'react';
import { Bookmark, X, Trash2, ExternalLink, Highlighter, MoreVertical, Pencil, Share2 } from 'lucide-react';
import { HIGHLIGHT_PICKER_COLORS } from "../../../core/lib/design-tokens";
import { cn } from "../../../core/lib/utils";
import { useLibraryStore, useUIStore } from "../../../core/store";
import { format } from 'date-fns';
import { useShallow } from 'zustand/react/shallow';
import { Backdrop, FloatingPanel } from "../../../ui";
import { ShareMenu } from "../../library/components/ShareMenu";
import type { Annotation, HighlightColor } from "../../../core/types";

interface ReaderAnnotationsPanelProps {
    bookId: string;
    visible: boolean;
    onClose: () => void;
    onNavigate: (location: string, annotation?: Annotation) => void;
    onDelete?: (id: string) => void;
    className?: string;
}

type TabType = 'bookmarks' | 'highlights';

const TAB_BUTTON_CLASS =
    "border border-[var(--color-border)] bg-[var(--color-surface)] text-[color:var(--color-text-secondary)] transition-[background-color,border-color,color] duration-200 ease-out hover:bg-[var(--color-surface-muted)] hover:text-[color:var(--color-text-primary)] data-[active=true]:border-[var(--color-accent)] data-[active=true]:bg-[var(--color-accent)] data-[active=true]:text-[color:var(--color-accent-contrast)] cursor-pointer focus-visible:outline-2 focus-visible:outline-[color:var(--color-focus-ring)] focus-visible:outline-offset-2 flex w-full min-h-10 items-center justify-between px-3 py-2 text-xs font-medium transition-colors";

export function ReaderAnnotationsPanel({
    bookId,
    visible,
    onClose,
    onNavigate,
    onDelete,
    className,
}: ReaderAnnotationsPanelProps) {
    const [activeTab, setActiveTab] = useState<TabType>('bookmarks');
    const [menuId, setMenuId] = useState<string | null>(null);
    const [sharingId, setSharingId] = useState<string | null>(null);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editContent, setEditContent] = useState('');
    const annotations = useLibraryStore(useShallow(
        (state) => state.getBookAnnotations(bookId),
    ));
    const removeAnnotationAction = useLibraryStore((state) => state.removeAnnotation);
    const updateAnnotation = useLibraryStore((state) => state.updateAnnotation);
    const vaultSyncStatus = useUIStore((state) => state.vaultSyncStatus);

    const bookmarks = useMemo(
        () => annotations.filter((annotation) => annotation.type === 'bookmark'),
        [annotations],
    );
    const highlights = useMemo(
        () => annotations.filter((annotation) => annotation.type === 'highlight' || annotation.type === 'note'),
        [annotations],
    );
    const vaultStatusText = {
        synced: "Synced to export folder",
        syncing: "Syncing markdown pages",
        error: "Sync error",
        idle: "Idle",
    }[vaultSyncStatus];

    const handleNavigate = (annotation: Annotation) => {
        onNavigate(annotation.location, annotation);
        onClose();
    };

    const handleEdit = (id: string) => {
        const annotation = annotations.find((a) => a.id === id);
        if (annotation) {
            setEditingId(id);
            setEditContent(annotation.noteContent || '');
        }
    };

    const saveEdit = () => {
        if (editingId) {
            updateAnnotation(editingId, { noteContent: editContent });
            setEditingId(null);
            setEditContent('');
        }
    };

    const handleShare = (id: string) => {
        setSharingId(id);
        setMenuId(null);
    };

    const closeMenu = () => setMenuId(null);

    const getBook = (bookId: string) => useLibraryStore.getState().getBook(bookId);

    const renderContextMenu = (annotation: Annotation) => (
        <div className="absolute right-0 top-full z-20 mt-1 w-40 border border-[var(--color-border)] bg-[var(--color-surface)] py-1 shadow-lg">
            <button
                onClick={(e) => { e.stopPropagation(); handleEdit(annotation.id); closeMenu(); }}
                className="flex w-full items-center gap-2 whitespace-nowrap px-3 py-2 text-left font-sans text-[11px] font-medium text-[color:var(--color-text-primary)] hover:bg-[var(--color-surface-muted)] touch-manipulation"
            >
                <Pencil className="w-3.5 h-3.5" /> Edit note
            </button>
            <button
                onClick={(e) => { e.stopPropagation(); handleShare(annotation.id); }}
                className="flex w-full items-center gap-2 whitespace-nowrap px-3 py-2 text-left font-sans text-[11px] font-medium text-[color:var(--color-text-primary)] hover:bg-[var(--color-surface-muted)] touch-manipulation"
            >
                <Share2 className="w-3.5 h-3.5" /> Share
            </button>
            <button
                onClick={(e) => {
                    e.stopPropagation();
                    removeAnnotationAction(annotation.id);
                    onDelete?.(annotation.id);
                    closeMenu();
                }}
                className="flex w-full items-center gap-2 whitespace-nowrap px-3 py-2 text-left font-sans text-[11px] font-medium text-[color:var(--color-error)] hover:bg-[var(--color-surface-muted)] touch-manipulation"
            >
                <Trash2 className="w-3.5 h-3.5" /> Delete
            </button>
        </div>
    );

    const renderBookmarkItem = (bookmark: Annotation) => (
        <div
            key={bookmark.id}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleNavigate(bookmark); } }}
            className="group cursor-pointer border border-[var(--color-border)] bg-[var(--color-surface)] p-3 transition-colors hover:border-[var(--color-accent)]"
            onClick={() => handleNavigate(bookmark)}
        >
            <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-2 flex-1 min-w-0">
                    <Bookmark className="w-4 h-4 text-[color:var(--color-accent)] flex-shrink-0" />
                    <span className="text-[var(--font-size-caption)] font-medium text-[color:var(--color-text-primary)] truncate">
                        {bookmark.selectedText || 'Bookmark'}
                    </span>
                </div>
                <div className="relative flex-shrink-0">
                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            setMenuId(menuId === bookmark.id ? null : bookmark.id);
                        }}
                        className="border border-[var(--color-border)] p-1.5 text-[color:var(--color-text-muted)] transition-opacity touch-manipulation"
                    >
                        <MoreVertical className="w-4 h-4" />
                    </button>
                    {menuId === bookmark.id && (
                        <>
                            <div className="fixed inset-0 z-10" role="button" tabIndex={-1} aria-label="Close menu" onClick={(e) => { e.stopPropagation(); closeMenu(); }} />
                            {renderContextMenu(bookmark)}
                        </>
                    )}
                    {sharingId === bookmark.id && (
                        <>
                            <div className="fixed inset-0 z-10" role="button" tabIndex={-1} aria-label="Close menu" onClick={(e) => { e.stopPropagation(); setSharingId(null); }} />
                            <ShareMenu annotation={bookmark} book={getBook(bookmark.bookId)} onClose={() => setSharingId(null)} />
                        </>
                    )}
                </div>
            </div>
            <div className="flex items-center justify-between pl-6 font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-[color:var(--color-text-secondary)]">
                <span>{format(new Date(bookmark.createdAt), 'MMM d, yyyy')}</span>
                <div className="flex items-center gap-1 text-[color:var(--color-accent)] transition-opacity">
                    <span>Jump to</span>
                    <ExternalLink className="w-2.5 h-2.5" />
                </div>
            </div>
        </div>
    );

    const renderHighlightItem = (highlight: Annotation) => (
        <div
            key={highlight.id}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleNavigate(highlight); } }}
            className="group cursor-pointer border border-[var(--color-border)] bg-[var(--color-surface)] p-3 transition-colors hover:border-[var(--color-accent)]"
            onClick={() => handleNavigate(highlight)}
        >
            <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-2 flex-1 min-w-0">
                    
                    <div 
                        className="mt-0.5 h-3 w-3 flex-shrink-0 border border-[var(--color-border)]"
                        style={{ 
                            backgroundColor: getHighlightColor(highlight.color),
                            opacity: 0.6 
                        }}
                    />
                    <div className="flex-1 min-w-0">
                        <p className="font-serif text-sm leading-relaxed text-[color:var(--color-text-primary)] line-clamp-3">
                            {highlight.selectedText || 'Highlight'}
                        </p>
                        {highlight.noteContent && editingId !== highlight.id && (
                            <div className="mt-1 border-l border-[var(--color-border)] pl-2 font-serif text-[13px] text-[color:var(--color-text-secondary)]">
                                <span className="line-clamp-2">{highlight.noteContent}</span>
                            </div>
                        )}
                        {editingId === highlight.id && (
                            <div className="mt-2" onClick={(e) => e.stopPropagation()}>
                                <textarea
                                    value={editContent}
                                    onChange={(e) => setEditContent(e.target.value)}
                                    className="w-full min-h-[60px] p-2 text-[13px] border border-[var(--color-border)] bg-[var(--color-surface)] text-[color:var(--color-text-primary)] resize-y font-serif"
                                    placeholder="Add a note..."
                                    autoFocus
                                />
                                <div className="flex gap-2 mt-1">
                                    <button onClick={saveEdit} className="text-[11px] px-2 py-1 bg-[var(--color-accent)] text-[color:var(--color-accent-contrast)] touch-manipulation">Save</button>
                                    <button onClick={() => { setEditingId(null); setEditContent(''); }} className="text-[11px] px-2 py-1 border border-[var(--color-border)] text-[color:var(--color-text-muted)] touch-manipulation">Cancel</button>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
                <div className="relative flex-shrink-0">
                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            setMenuId(menuId === highlight.id ? null : highlight.id);
                        }}
                        className="border border-[var(--color-border)] p-1.5 text-[color:var(--color-text-muted)] transition-opacity touch-manipulation"
                    >
                        <MoreVertical className="w-4 h-4" />
                    </button>
                    {menuId === highlight.id && (
                        <>
                            <div className="fixed inset-0 z-10" role="button" tabIndex={-1} aria-label="Close menu" onClick={(e) => { e.stopPropagation(); closeMenu(); }} />
                            {renderContextMenu(highlight)}
                        </>
                    )}
                    {sharingId === highlight.id && (
                        <>
                            <div className="fixed inset-0 z-10" role="button" tabIndex={-1} aria-label="Close menu" onClick={(e) => { e.stopPropagation(); setSharingId(null); }} />
                            <ShareMenu annotation={highlight} book={getBook(highlight.bookId)} onClose={() => setSharingId(null)} />
                        </>
                    )}
                </div>
            </div>
            <div className="flex items-center justify-between pl-6 font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-[color:var(--color-text-secondary)]">
                <span>{format(new Date(highlight.createdAt), 'MMM d, yyyy')}</span>
                <div className="flex items-center gap-1 text-[color:var(--color-accent)] transition-opacity">
                    <span>Jump to</span>
                    <ExternalLink className="w-2.5 h-2.5" />
                </div>
            </div>
        </div>
    );

    const getHighlightColor = (color?: HighlightColor): string => {
        return color ? HIGHLIGHT_PICKER_COLORS[color] : HIGHLIGHT_PICKER_COLORS.yellow;
    };

    const currentItems = activeTab === 'bookmarks' ? bookmarks : highlights;
    const emptyState = activeTab === 'bookmarks' ? (
        <div className="w-full flex flex-col items-center justify-center py-12 px-6 text-center">
            <div className="w-12 h-12 bg-[var(--color-background)] flex items-center justify-center mb-4 text-[color:var(--color-text-muted)]">
                <Bookmark className="w-6 h-6" />
            </div>
            <h3 className="text-sm font-semibold text-[color:var(--color-text-primary)] mb-1">No bookmarks yet</h3>
            <p className="w-full max-w-[17rem] text-xs text-[color:var(--color-text-muted)] leading-relaxed">
                Click the bookmark button in the toolbar to save your current page.
            </p>
        </div>
    ) : (
        <div className="w-full flex flex-col items-center justify-center py-12 px-6 text-center">
            <div className="w-12 h-12 bg-[var(--color-background)] flex items-center justify-center mb-4 text-[color:var(--color-text-muted)]">
                <Highlighter className="w-6 h-6" />
            </div>
            <h3 className="text-sm font-semibold text-[color:var(--color-text-primary)] mb-1">No highlights yet</h3>
            <p className="w-full max-w-[17rem] text-xs text-[color:var(--color-text-muted)] leading-relaxed">
                Select text and choose a color to highlight important passages.
            </p>
        </div>
    );

    return (
        <>
            <Backdrop visible={visible} onClick={onClose} />

            <FloatingPanel visible={visible} className={cn("overflow-hidden", className)}>
                
                <div className="reader-panel-header flex flex-col">
                    <div className="flex items-center justify-between p-4">
                        <h2 className="text-sm font-semibold text-[color:var(--color-text-primary)]">Annotations</h2>
                        <button
                            onClick={onClose}
                            className="inline-flex h-9 w-9 items-center justify-center border border-[color:var(--color-border-subtle)] bg-transparent text-[color:var(--color-text-secondary)] transition-[background-color,border-color,color,opacity] duration-200 ease-out hover:bg-[var(--color-surface-muted)] hover:text-[color:var(--color-text-primary)] data-[active=true]:border-[var(--color-accent)] data-[active=true]:bg-[var(--color-accent)] data-[active=true]:text-[color:var(--color-accent-contrast)] focus-visible:outline-2 focus-visible:outline-[color:var(--color-focus-ring)] focus-visible:outline-offset-2 w-8 h-8"
                            aria-label="Close annotations"
                        >
                            <X className="w-4 h-4" />
                        </button>
                    </div>
                    <div className="border border-[var(--color-border-subtle)] bg-[var(--color-surface-muted)] mx-4 mb-3 border px-3 py-1.5 text-xs text-[color:var(--color-text-secondary)]">
                        {vaultStatusText}
                    </div>

                    <div className="grid grid-cols-2 gap-2 px-4 pb-3">
                        <button
                            onClick={() => setActiveTab('bookmarks')}
                            className={TAB_BUTTON_CLASS}
                            data-active={activeTab === "bookmarks"}
                            aria-pressed={activeTab === "bookmarks"}
                        >
                            <span className="inline-flex items-center gap-1.5">
                                <Bookmark className="w-3.5 h-3.5" />
                                <span>Bookmarks</span>
                            </span>
                            <span className="[font-variant-numeric:tabular-nums] text-[10px]">{bookmarks.length}</span>
                        </button>
                        <button
                            onClick={() => setActiveTab('highlights')}
                            className={TAB_BUTTON_CLASS}
                            data-active={activeTab === "highlights"}
                            aria-pressed={activeTab === "highlights"}
                        >
                            <span className="inline-flex items-center gap-1.5">
                                <Highlighter className="w-3.5 h-3.5" />
                                <span>Highlights</span>
                            </span>
                            <span className="[font-variant-numeric:tabular-nums] text-[10px]">{highlights.length}</span>
                        </button>
                    </div>
                </div>

                <div className="flex-1 min-h-0 overflow-y-auto p-4 custom-scrollbar [content-visibility:auto] overscroll-contain">
                    {currentItems.length === 0 ? (
                        emptyState
                    ) : (
                        <div className="space-y-2">
                            {activeTab === 'bookmarks' 
                                ? bookmarks.map(renderBookmarkItem)
                                : highlights.map(renderHighlightItem)
                            }
                        </div>
                    )}
                </div>
            </FloatingPanel>
        </>
    );
}

export default ReaderAnnotationsPanel;
