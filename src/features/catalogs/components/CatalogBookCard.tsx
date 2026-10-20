import { memo } from "react";
import { Check, Download, ExternalLink, Loader2 } from "lucide-react";
import { cn } from "../../../core/lib/utils";
import type { OpdsEntry } from "../../../core/types";
import { TheoremBookCover } from "../../../ui";
import { entryAction, entryAuthor } from "../opds/opds-ui-utils";

export interface CatalogBookCardProps {
    entry: OpdsEntry;
    inLibrary: boolean;
    isBusy: boolean;
    onSelect: (entry: OpdsEntry) => void;
    onGet: (entry: OpdsEntry) => void;
    className?: string;
}

/**
 * One catalog book: cover plus title and author, with a "Get" overlay.
 *
 * Shared by Discover and the catalog browser so every grid of books reads as one app, and
 * `memo` because the browser's virtualized grid mounts and discards these by the thousand.
 * Going through `TheoremBookCover` means an entry with no cover, or a cover URL that 404s (common
 * on public OPDS servers), gets the drawn clothbound fallback instead of a broken image.
 *
 * The title block uses explicit leading rather than inherited: the grid computes row height from
 * it instead of measuring, so its height must not depend on the page's line-height. The
 * `data-catalog-card-*` hooks are not styling — the fallback cover renders its own title and
 * author, so tests need to target the card's own metadata.
 */
export const CatalogBookCard = memo(function CatalogBookCard({
    entry,
    inLibrary,
    isBusy,
    onSelect,
    onGet,
    className,
}: CatalogBookCardProps) {
    const action = entryAction(entry);
    const author = entryAuthor(entry);
    // Catalogs commonly serve a full-size image several times larger than the thumbnail.
    const coverSrc = entry.thumbnail || entry.cover;
    const canGet = action.kind === "download" || action.kind === "partial";

    return (
        <div
            data-catalog-card=""
            onClick={() => onSelect(entry)}
            className={cn("group flex w-full cursor-pointer select-none flex-col text-left", className)}
        >
            <div className="relative aspect-[2/3] w-full overflow-hidden border border-[var(--color-border)] transition-[transform,box-shadow] duration-300 ease-out group-hover:-translate-y-1">
                <TheoremBookCover title={entry.title} author={author || undefined} coverUrl={coverSrc} />

                {(inLibrary || canGet || action.kind === "website") && (
                    <button
                        type="button"
                        onClick={(e) => {
                            e.stopPropagation();
                            if (inLibrary || action.kind === "website") onSelect(entry);
                            else onGet(entry);
                        }}
                        disabled={isBusy}
                        className={cn(
                            "absolute bottom-2 right-2 z-20 flex h-6 items-center justify-center border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-[9px] text-[color:var(--color-text-primary)]",
                            "transition-[color,background-color,border-color,transform] duration-200 ease-out hover:bg-[var(--color-surface-muted)] active:scale-95",
                            isBusy && "opacity-60",
                        )}
                        title={inLibrary ? "In Library" : action.kind === "website" ? "View details" : "Add to Library"}
                        aria-label={
                            inLibrary
                                ? `${entry.title} is in your Library`
                                : action.kind === "website"
                                  ? `View ${entry.title}`
                                  : `Add ${entry.title} to Library`
                        }
                    >
                        {isBusy ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                        ) : inLibrary ? (
                            <span className="flex items-center gap-1">
                                <Check className="h-3 w-3" />
                                <span>In Library</span>
                            </span>
                        ) : action.kind === "website" ? (
                            <span className="flex items-center gap-1">
                                <ExternalLink className="h-3 w-3" />
                                <span>View</span>
                            </span>
                        ) : (
                            <span className="flex items-center gap-1">
                                <Download className="h-3 w-3" />
                                <span>Get</span>
                            </span>
                        )}
                    </button>
                )}
            </div>

            <div className="mt-2.5 min-w-0 px-0.5">
                <h3
                    data-catalog-card-title=""
                    className="mb-0.5 line-clamp-2 break-words text-[11px] leading-[14px] text-[color:var(--color-text-primary)] transition-colors group-hover:text-[color:var(--color-accent)]"
                >
                    {entry.title}
                </h3>
                <p
                    data-catalog-card-author=""
                    className="line-clamp-1 text-[10px] leading-[13px] text-[color:var(--color-text-secondary)] opacity-60"
                >
                    {author || "Unknown author"}
                </p>
            </div>
        </div>
    );
});
