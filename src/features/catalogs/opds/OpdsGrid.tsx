import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { OpdsEntry } from "../../../core/types";
import { CatalogBookCard } from "../components/CatalogBookCard";

/** Gap between cover columns, px. Must match the grid's `gap`. */
const GAP = 16;
/**
 * Height of the text block under each cover: two clamped title lines at 14px leading plus 2px,
 * one clamped author line at 13px, and the 10px top margin. Fixed rather than measured so the
 * virtualizer's row height is exact and the scrollbar never drifts from the content.
 */
const TEXT_HEIGHT = 53;

export function columnsFor(width: number): number {
    if (width >= 1536) return 8;
    if (width >= 1280) return 7;
    if (width >= 1024) return 5;
    if (width >= 768) return 4;
    if (width >= 640) return 3;
    return 2;
}

/**
 * The books of a list as a virtualized grid: only the rows near the viewport are mounted, so a
 * 3,000-entry catalog costs the same as a 30-entry one. Scrolls inside `scrollRef` (the page's
 * scroll container), which may have other content above the grid.
 */
export function OpdsGrid({
    entries,
    scrollRef,
    inLibrary,
    isBusy,
    onSelect,
    onGet,
    onNearEnd,
}: {
    entries: OpdsEntry[];
    scrollRef: RefObject<HTMLElement | null>;
    inLibrary: (title: string) => boolean;
    isBusy: (id: string) => boolean;
    onSelect: (entry: OpdsEntry) => void;
    onGet: (entry: OpdsEntry) => void;
    /** Called when the user has scrolled close to the last row. */
    onNearEnd?: () => void;
}) {
    const gridRef = useRef<HTMLDivElement>(null);
    const [width, setWidth] = useState(1024);
    const [scrollMargin, setScrollMargin] = useState(0);

    useLayoutEffect(() => {
        const el = gridRef.current;
        if (!el) return;
        const measure = () => {
            setWidth(el.clientWidth || 1024);
            setScrollMargin(el.offsetTop);
        };
        measure();
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    const cols = columnsFor(width);
    const colWidth = (width - GAP * (cols - 1)) / cols;
    const rowHeight = Math.ceil(colWidth * 1.5 + TEXT_HEIGHT + GAP);
    const rowCount = Math.ceil(entries.length / cols);

    const virtualizer = useVirtualizer({
        count: rowCount,
        getScrollElement: () => scrollRef.current,
        estimateSize: () => rowHeight,
        overscan: 2,
        scrollMargin,
    });

    useLayoutEffect(() => {
        virtualizer.measure();
    }, [virtualizer, rowHeight, scrollMargin]);

    const items = virtualizer.getVirtualItems();
    const lastIndex = items.length > 0 ? items[items.length - 1].index : -1;
    // Ask for more once per length of the list: the callback's identity changes with every load,
    // and re-asking on each change would loop on a server that has nothing more to give.
    const askedAt = useRef(-1);
    const onNearEndRef = useRef(onNearEnd);
    onNearEndRef.current = onNearEnd;
    useEffect(() => {
        if (!onNearEndRef.current || rowCount === 0 || lastIndex < rowCount - 2) return;
        if (askedAt.current === entries.length) return;
        askedAt.current = entries.length;
        onNearEndRef.current();
    }, [lastIndex, rowCount, entries.length]);

    return (
        <div ref={gridRef} data-opds-grid="" data-count={entries.length} className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {items.map((row) => {
                const start = row.index * cols;
                return (
                    <div
                        key={row.key}
                        data-opds-row=""
                        className="absolute left-0 top-0 grid w-full"
                        style={{
                            height: rowHeight - GAP,
                            gap: GAP,
                            gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
                            transform: `translateY(${row.start - scrollMargin}px)`,
                        }}
                    >
                        {entries.slice(start, start + cols).map((entry) => (
                            <CatalogBookCard
                                key={entry.id}
                                entry={entry}
                                inLibrary={inLibrary(entry.title)}
                                isBusy={isBusy(entry.id)}
                                onSelect={onSelect}
                                onGet={onGet}
                            />
                        ))}
                    </div>
                );
            })}
        </div>
    );
}
