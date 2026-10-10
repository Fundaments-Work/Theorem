import { memo } from "react";
import { BookOpen, Download, RefreshCw } from "lucide-react";
import type { OpdsEntry } from "../../../core/types";

export interface OpdsBookCardProps {
    entry: OpdsEntry;
    isDownloading: boolean;
    onSelect: () => void;
    onDownload: () => void;
}

/**
 * One OPDS result tile: cover plus title/author, with a download overlay.
 *
 * Extracted from `OPDSBrowser` so the virtualized grid can mount and discard
 * thousands of these without re-creating the JSX inline. `memo` matters here —
 * a scroll re-renders a handful of rows at a time, and without it every card
 * in the window would re-render whenever a sibling's download state flipped.
 */
export const OpdsBookCard = memo(function OpdsBookCard({
    entry,
    isDownloading,
    onSelect,
    onDownload,
}: OpdsBookCardProps) {
    const coverSrc = entry.thumbnailUrl || entry.coverUrl;

    return (
        <div data-opds-card="" onClick={onSelect} className="group flex flex-col cursor-pointer">
            {/* Cover Container */}
            <div className="relative aspect-[2/3] w-full rounded-md overflow-hidden bg-[var(--color-surface-muted)] border border-[var(--color-border)] shadow-sm group-hover:shadow-md transition-shadow">
                {coverSrc ? (
                    <img
                        src={coverSrc}
                        alt={entry.title}
                        loading="lazy"
                        decoding="async"
                        className="h-full w-full object-cover group-hover:scale-105 transition-transform duration-200"
                    />
                ) : (
                    <div className="flex flex-col items-center justify-center h-full w-full p-3 text-center bg-[var(--color-surface-muted)]">
                        <BookOpen className="h-6 w-6 text-[color:var(--color-text-muted)] mb-1.5" />
                        <span className="text-[10px] font-bold uppercase tracking-wider text-[color:var(--color-text-secondary)] line-clamp-3">
                            {entry.title}
                        </span>
                    </div>
                )}

                {/* Download Button Overlay */}
                {(entry.downloadUrl || entry.navUrl) && (
                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            onDownload();
                        }}
                        disabled={isDownloading}
                        className="absolute bottom-2 right-2 p-2 rounded-full bg-black/80 text-white hover:bg-black shadow-md transition-transform transform active:scale-95 disabled:opacity-50"
                        title="Add to Library"
                        aria-label={`Add ${entry.title} to Library`}
                    >
                        {isDownloading ? (
                            <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                            <Download className="h-3.5 w-3.5" />
                        )}
                    </button>
                )}
            </div>

            {/* Title & Author */}
            <div className="mt-2 flex flex-col min-w-0">
                <h3 className="text-xs font-semibold text-[color:var(--color-text-primary)] truncate group-hover:text-[color:var(--color-accent)] transition-colors">
                    {entry.title}
                </h3>
                <p className="text-[11px] text-[color:var(--color-text-muted)] truncate mt-0.5">
                    {entry.author || "Public Domain"}
                </p>
            </div>
        </div>
    );
});