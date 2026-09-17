import { useState } from "react";
import { Check, Download, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { cn, normalizeAuthor } from "../../../core/lib/utils";
import { useLibraryStore, useUIStore } from "../../../core/store";
import { DiscoverService } from "../../../core/services/DiscoverService";
import type { OpdsEntry } from "../../../core/types";
import { TheoremBookCover } from "../../../ui";

export interface DiscoverBookCardProps {
    entry: OpdsEntry;
    onSelect?: (entry: OpdsEntry) => void;
    className?: string;
}

export function DiscoverBookCard({
    entry,
    onSelect,
    className,
}: DiscoverBookCardProps) {
    const isBookInLibrary = useLibraryStore((state) =>
        state.books.some(
            (b) => b.title.toLowerCase().trim() === entry.title.toLowerCase().trim()
        )
    );
    const setRoute = useUIStore((state) => state.setRoute);
    const [isDownloading, setIsDownloading] = useState(false);

    const handleGet = async (e: React.MouseEvent) => {
        e.stopPropagation();
        if (isBookInLibrary) {
            setRoute("library");
            return;
        }

        setIsDownloading(true);
        const toastId = toast.loading(`Adding "${entry.title}"…`);
        try {
            await DiscoverService.downloadBook(entry, (msg) => {
                toast.loading(msg, { id: toastId });
            });
            toast.success(`"${entry.title}" is in your Library`, {
                id: toastId,
                action: {
                    label: "Open Library",
                    onClick: () => setRoute("library"),
                },
            });
        } catch (err: any) {
            toast.error(err.message || "Failed to download book", { id: toastId });
        } finally {
            setIsDownloading(false);
        }
    };

    return (
        <div
            onClick={() => onSelect?.(entry)}
            className={cn(
                "group flex flex-col text-left w-full select-none cursor-pointer",
                className
            )}
        >
            {/* Book Cover Container */}
            <div className="relative aspect-[2/3] bg-[var(--color-surface-muted)] mb-2.5 overflow-hidden border border-[var(--color-border)] transition-[transform,box-shadow] duration-300 ease-out group-hover:shadow-lg group-hover:-translate-y-1">
                <TheoremBookCover
                    title={entry.title}
                    author={entry.author}
                    coverUrl={entry.coverUrl || entry.thumbnailUrl}
                />

                {/* Micro Action Button on Cover */}
                <button
                    onClick={handleGet}
                    disabled={isDownloading}
                    className={cn(
                        "absolute bottom-2 right-2 z-20 flex items-center justify-center rounded-sm transition-[color,background-color,border-color,transform,box-shadow] duration-200 ease-out shadow-md",
                        isBookInLibrary
                            ? "h-6 px-2 bg-[var(--color-surface)] text-[color:var(--color-text-primary)] text-[9px] font-bold border border-[var(--color-border)] hover:bg-[var(--color-surface-muted)]"
                            : "h-6 px-2 bg-[var(--color-surface)] text-[color:var(--color-text-primary)] text-[9px] font-bold border border-[var(--color-border)] hover:bg-[var(--color-surface-muted)] active:scale-95"
                    )}
                    title={isBookInLibrary ? "In Library" : "Add to Library"}
                >
                    {isDownloading ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                    ) : isBookInLibrary ? (
                        <span className="flex items-center gap-1">
                            <Check className="h-3 w-3" />
                            <span>In Library</span>
                        </span>
                    ) : (
                        <span className="flex items-center gap-1">
                            <Download className="h-3 w-3" />
                            <span>Get</span>
                        </span>
                    )}
                </button>
            </div>

            {/* Title & Author */}
            <div className="px-0.5 min-w-0">
                <h3 className="font-bold text-[11px] uppercase tracking-wide text-[color:var(--color-text-primary)] line-clamp-2 mb-0.5 transition-colors group-hover:text-[color:var(--color-accent)] break-words">
                    {entry.title}
                </h3>
                <p className="text-[10px] font-medium text-[color:var(--color-text-secondary)] line-clamp-1 opacity-60 uppercase tracking-tight">
                    {normalizeAuthor(entry.author) || "Public Domain"}
                </p>
            </div>
        </div>
    );
}
