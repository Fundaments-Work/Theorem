
import {
    ArrowLeft,
    List,
    Bookmark as BookmarkIcon,
    Search,
    MoreVertical,
    Maximize2,
    Minimize2,
} from 'lucide-react';
import { cn, normalizeAuthor } from '../../../core/lib/utils';
import { isMobile } from '../../../core/lib/env';
import type { DocMetadata, DocLocation } from '../../../core/types';

interface ReaderToolbarProps {
    metadata: DocMetadata | null;
    location?: DocLocation | null;
    onBack: () => void;
    onToggleToc: () => void;
    onToggleSettings: () => void;
    onToggleBookmarks: () => void;
    onToggleSearch: () => void;
    onToggleInfo: () => void;
    onAddBookmark?: () => void;
    activePanel: string | null;
    fullscreen?: boolean;
    onToggleFullscreen?: () => void;
    className?: string;
}

const READER_BUTTON_CLASS =
    "inline-flex h-10 w-10 items-center justify-center text-[color:var(--color-text-secondary)] transition-colors duration-200 ease-out hover:text-[color:var(--color-accent)] data-[active=true]:text-[color:var(--color-accent)]";

export function ReaderToolbar({
    metadata,
    location,
    onBack,
    onToggleToc,
    onToggleSettings,
    onToggleBookmarks,
    onToggleSearch,
    onToggleInfo,
    onAddBookmark,
    activePanel,
    fullscreen,
    onToggleFullscreen,
    className,
}: ReaderToolbarProps) {
    
    const currentChapter = location?.tocItem?.label || location?.pageItem?.label;
    
    const formatLocation = () => {
        if (!location) return null;
        
        if (location.pageInfo) {
            return `Page ${location.pageInfo.currentPage}${location.pageInfo.totalPages ? ` / ${location.pageInfo.totalPages}` : ''}`;
        }
        
        if (location.pageItem?.label) {
            return location.pageItem.label;
        }
        
        const percentage = Math.round((location.percentage || 0) * 100);
        return `${percentage}%`;
    };

    return (
        <div
            className={cn(
                'flex h-[var(--layout-reader-toolbar-height)] items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-surface)] px-2 sm:px-4',
                className
            )}
        >
            
            <div className="flex items-center gap-1">
                <button
                    onClick={onBack}
                    className={READER_BUTTON_CLASS}
                    title="Back to Library"
                    aria-label="Back to Library"
                >
                    <ArrowLeft className="w-5 h-5" />
                </button>
            </div>

            <div className="flex-1 mx-4 text-center overflow-hidden">
                <h1 className="truncate text-sm text-[color:var(--color-text-primary)]">
                    {metadata?.title || 'Loading...'}
                </h1>
                <div className="flex items-center justify-center gap-2">
                    {currentChapter ? (
                        <span className="text-[color:var(--color-accent)] text-xs truncate">
                            {currentChapter}
                        </span>
                    ) : metadata?.author ? (
                        <span className="text-xs text-[color:var(--color-text-secondary)] truncate">
                            {normalizeAuthor(metadata.author)}
                        </span>
                    ) : null}
                    {formatLocation() && (
                        <span className="text-xs text-[color:var(--color-text-secondary)]">
                            • {formatLocation()}
                        </span>
                    )}
                </div>
            </div>

            <div className="flex items-center gap-1">
                
                <button
                    onClick={onToggleToc}
                    className={READER_BUTTON_CLASS}
                    data-active={activePanel === 'toc'}
                    title="Table of Contents"
                    aria-label="Table of Contents"
                >
                    <List className="w-5 h-5" />
                </button>

                <button
                    onClick={onToggleSearch}
                    className={READER_BUTTON_CLASS}
                    data-active={activePanel === 'search'}
                    title="Search"
                    aria-label="Search"
                >
                    <Search className="w-5 h-5" />
                </button>

                {onAddBookmark && (
                    <button
                        onClick={onAddBookmark}
                        className={READER_BUTTON_CLASS}
                        title="Bookmark current page (Ctrl+D)"
                        aria-label="Bookmark current page"
                    >
                        <BookmarkIcon className="w-5 h-5" />
                    </button>
                )}

                <button
                    onClick={onToggleBookmarks}
                    className={READER_BUTTON_CLASS}
                    data-active={activePanel === 'bookmarks'}
                    title="View Bookmarks & Highlights"
                    aria-label="View Bookmarks and Highlights"
                >
                    <BookmarkIcon className="w-5 h-5 fill-current" />
                </button>

                <button
                    onClick={onToggleSettings}
                    className={cn(READER_BUTTON_CLASS, "min-w-[var(--control-icon-button-size)]")}
                    data-active={activePanel === 'settings'}
                    title="Reading Settings"
                    aria-label="Reading Settings"
                >
                    <span className="text-base font-serif">Aa</span>
                </button>

                {!isMobile() && onToggleFullscreen && (
                    <button
                        onClick={onToggleFullscreen}
                        className={READER_BUTTON_CLASS}
                        data-active={fullscreen}
                        title={fullscreen ? "Exit Fullscreen" : "Enter Fullscreen"}
                        aria-label={fullscreen ? "Exit Fullscreen" : "Enter Fullscreen"}
                    >
                        {fullscreen ? <Minimize2 className="w-5 h-5" /> : <Maximize2 className="w-5 h-5" />}
                    </button>
                )}

                <div className="w-px h-6 bg-[var(--color-border)] mx-1" />

                <button
                    onClick={onToggleInfo}
                    className={READER_BUTTON_CLASS}
                    data-active={activePanel === 'info'}
                    title="Book Information"
                    aria-label="Book Information"
                >
                    <MoreVertical className="w-5 h-5" />
                </button>
            </div>
        </div>
    );
}

export default ReaderToolbar;
