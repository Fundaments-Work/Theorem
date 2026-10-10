import { memo } from "react";
import { Download, RefreshCw } from "lucide-react";
import { cn, normalizeAuthor } from "../../../core/lib/utils";
import type { OpdsEntry } from "../../../core/types";
import { TheoremBookCover } from "../../../ui";

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
 *
 * Cover and type treatment match the Library and Discover book cards so the
 * three grids read as one app. Going through `TheoremBookCover` also means an
 * entry with no cover — or a cover URL that 404s, which is common on public
 * OPDS servers — gets the deterministic clothbound fallback instead of a broken
 * image icon.
 */
export const OpdsBookCard = memo(function OpdsBookCard({
    entry,
    isDownloading,
    onSelect,
    onDownload,
}: OpdsBookCardProps) {
    // Prefer the thumbnail when the feed offers one: catalogs commonly serve a
    // full-size image several times larger for the same book.
    const coverSrc = entry.thumbnailUrl || entry.coverUrl;

    return (
        <div
            data-opds-card=""
            onClick={onSelect}
            className="group flex flex-col text-left w-full select-none cursor-pointer"
        >
            {/* Cover Container */}
            <div className="relative aspect-[2/3] w-full overflow-hidden border border-[var(--color-border)] transition-[transform,box-shadow] duration-300 ease-out group-hover:shadow-lg group-hover:-translate-y-1">
                <TheoremBookCover
                    title={entry.title}
                    author={normalizeAuthor(entry.author)}
                    coverUrl={coverSrc}
                />

                {/* Download Button Overlay */}
                {(entry.downloadUrl || entry.navUrl) && (
                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            onDownload();
                        }}
                        disabled={isDownloading}
                        className={cn(
                            "absolute bottom-2 right-2 z-20 flex items-center justify-center rounded-sm transition-[color,background-color,border-color,transform,box-shadow] duration-200 ease-out shadow-md",
                            "h-6 px-2 bg-[var(--color-surface)] text-[color:var(--color-text-primary)] text-[9px] font-bold border border-[var(--color-border)] hover:bg-[var(--color-surface-muted)] active:scale-95",
                            isDownloading && "opacity-60",
                        )}
                        title="Add to Library"
                        aria-label={`Add ${entry.title} to Library`}
                    >
                        {isDownloading ? (
                            <RefreshCw className="h-3 w-3 animate-spin" />
                        ) : (
                            <>
                                <Download className="h-3 w-3" />
                                <span className="ml-1">Get</span>
                            </>
                        )}
                    </button>
                )}
            </div>

            {/* Title & Author
                Explicit leading, not inherited: the grid computes row height from
                this block rather than measuring it, so its height must not depend
                on whatever line-height the page happens to set.

                The `data-opds-card-*` hooks are not styling — the clothbound
                fallback cover renders its own <h3>/<p> with the same words, so
                tests need to target the card's metadata block specifically. */}
            <div className="mt-2.5 px-0.5 min-w-0">
                <h3
                    data-opds-card-title=""
                    className="font-bold text-[11px] leading-[14px] uppercase tracking-wide text-[color:var(--color-text-primary)] line-clamp-2 mb-0.5 transition-colors group-hover:text-[color:var(--color-accent)] break-words"
                >
                    {entry.title}
                </h3>
                <p
                    data-opds-card-author=""
                    className="text-[10px] leading-[13px] font-medium text-[color:var(--color-text-secondary)] line-clamp-1 opacity-60 uppercase tracking-tight"
                >
                    {normalizeAuthor(entry.author) || "Public Domain"}
                </p>
            </div>
        </div>
    );
});