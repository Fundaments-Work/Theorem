import { memo } from "react";
import { ChevronRight, Folder } from "lucide-react";
import type { OpdsNavItem } from "../../../core/types";
import { isSafeImageUrl } from "../../../core/lib/url-safety";

/** A tiny inline placeholder icon (Gutenberg ships a 16px PNG for every row) is not worth showing. */
function usableThumbnail(src?: string): string | undefined {
    if (!src || !isSafeImageUrl(src)) return undefined;
    if (src.startsWith("data:image/png;base64") && src.length < 5000) return undefined;
    return src;
}

const NavRow = memo(function NavRow({ item, onOpen }: { item: OpdsNavItem; onOpen: (item: OpdsNavItem) => void }) {
    const thumb = usableThumbnail(item.thumbnail);
    return (
        <button
            type="button"
            onClick={() => onOpen(item)}
            className="group flex w-full items-center gap-3 border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5 text-left transition-colors hover:border-[var(--color-accent)]"
        >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden border border-[var(--color-border)] bg-[var(--color-surface-muted)] text-[color:var(--color-text-muted)]">
                {thumb ? <img src={thumb} alt="" loading="lazy" className="h-full w-full object-cover" /> : <Folder className="h-4 w-4" />}
            </span>
            <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-[color:var(--color-text-primary)] transition-colors group-hover:text-[color:var(--color-accent)]">
                    {item.title}
                </span>
                {item.summary && <span className="block truncate text-xs text-[color:var(--color-text-muted)]">{item.summary}</span>}
            </span>
            {item.count !== undefined && (
                <span className="shrink-0 font-mono text-[10px] text-[color:var(--color-text-muted)]">{item.count}</span>
            )}
            <ChevronRight className="h-4 w-4 shrink-0 text-[color:var(--color-text-muted)] transition-colors group-hover:text-[color:var(--color-accent)]" />
        </button>
    );
});

/** Links to other lists in a catalog: categories, authors, shelves, "new" and "popular". */
export function OpdsNavList({ items, onOpen }: { items: OpdsNavItem[]; onOpen: (item: OpdsNavItem) => void }) {
    if (items.length === 0) return null;
    return (
        <ul className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3" aria-label="Browse">
            {items.map((item) => (
                <li key={`${item.href}|${item.title}`}>
                    <NavRow item={item} onOpen={onOpen} />
                </li>
            ))}
        </ul>
    );
}
