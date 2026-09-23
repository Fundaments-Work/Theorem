import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn } from "../../../core/lib/utils";
import { createThumbnailStore, type ThumbnailStore } from "../engines/pdf-thumbnails";

const COLUMNS = 2;
const THUMB_CSS_WIDTH = 140;
const ROW_HEIGHT = 228;

interface PdfPageGridProps {
    totalPages: number;
    currentPage: number;
    /** Only request thumbnails while the grid is on screen. */
    active: boolean;
    renderThumbnail: (pageNumber: number, cssWidth: number, signal: AbortSignal) => Promise<Blob | null>;
    getPageLabel?: (pageNumber: number) => string | undefined;
    onNavigate: (pageNumber: number) => void;
}

const Thumbnail = memo(function Thumbnail({ store, pageNumber, label, isCurrent, onNavigate }: {
    store: ThumbnailStore;
    pageNumber: number;
    label: string;
    isCurrent: boolean;
    onNavigate: (pageNumber: number) => void;
}) {
    const [url, setUrl] = useState(() => store.get(pageNumber) ?? null);
    useEffect(() => {
        let live = true;
        if (!url) void store.request(pageNumber).then((next) => { if (live && next) setUrl(next); });
        return () => {
            live = false;
            store.cancel(pageNumber);
        };
    }, [store, pageNumber, url]);

    return (
        <button
            type="button"
            onClick={() => onNavigate(pageNumber)}
            aria-label={`Page ${label}`}
            aria-current={isCurrent ? "page" : undefined}
            className="flex flex-col items-center gap-1.5 p-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
        >
            <div
                className={cn(
                    "flex h-[190px] w-full items-center justify-center border bg-[var(--color-surface-muted)]",
                    isCurrent ? "border-[var(--color-accent)] border-2" : "border-[var(--color-border)]",
                )}
            >
                {url && <img src={url} alt="" draggable={false} className="max-h-full max-w-full object-contain" />}
            </div>
            <span className={cn("text-xs tabular-nums", isCurrent ? "font-semibold text-[var(--color-accent)]" : "text-[var(--color-text-muted)]")}>
                {label}
            </span>
        </button>
    );
});

/** Virtualized page thumbnails; renders only visible tiles, after page renders. */
export function PdfPageGrid({ totalPages, currentPage, active, renderThumbnail, getPageLabel, onNavigate }: PdfPageGridProps) {
    const scrollRef = useRef<HTMLDivElement>(null);
    const renderRef = useRef(renderThumbnail);
    renderRef.current = renderThumbnail;
    const store = useMemo(
        () => createThumbnailStore((page, signal) => renderRef.current(page, THUMB_CSS_WIDTH, signal)),
        // A new document (page count) starts a fresh cache.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [totalPages],
    );
    useEffect(() => () => store.dispose(), [store]);

    const rows = Math.ceil(totalPages / COLUMNS);
    const virtualizer = useVirtualizer({
        count: active ? rows : 0,
        getScrollElement: () => scrollRef.current,
        estimateSize: () => ROW_HEIGHT,
        overscan: 2,
    });

    // Show the current page when the grid opens.
    useEffect(() => {
        if (active && currentPage > 0) virtualizer.scrollToIndex(Math.floor((currentPage - 1) / COLUMNS), { align: "center" });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [active]);

    return (
        <div ref={scrollRef} className="h-full overflow-y-auto overscroll-contain">
            <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
                {virtualizer.getVirtualItems().map((row) => (
                    <div
                        key={row.key}
                        className="absolute left-0 right-0 grid grid-cols-2 px-2"
                        style={{ top: row.start, height: row.size }}
                    >
                        {Array.from({ length: COLUMNS }, (_, col) => {
                            const pageNumber = row.index * COLUMNS + col + 1;
                            if (pageNumber > totalPages) return <div key={col} />;
                            return (
                                <Thumbnail
                                    key={pageNumber}
                                    store={store}
                                    pageNumber={pageNumber}
                                    label={getPageLabel?.(pageNumber) ?? String(pageNumber)}
                                    isCurrent={pageNumber === currentPage}
                                    onNavigate={onNavigate}
                                />
                            );
                        })}
                    </div>
                ))}
            </div>
        </div>
    );
}
