import { memo, useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { MoreVertical } from "lucide-react";
import { cn } from "../../../core/lib/utils";
import { HighlightMatch } from "../../../ui";
import { annotationCardHeight, type AnnotationCardBlocks } from "./annotation-card-layout";

export interface AnnotationListCardMenuItem {
    label: string;
    onSelect: () => void;
    danger?: boolean;
}

interface AnnotationListCardProps extends AnnotationCardBlocks {
    id: string;
    typeLabel: string;
    dateLabel: string;
    sourceTitle: string;
    sourceAuthor: string;
    accentColor?: string;
    searchQuery?: string;
    menuItems: AnnotationListCardMenuItem[];
    menuOpen: boolean;
    onMenuOpenChange: (id: string | null) => void;
    /** Extra popover anchored under the menu button (e.g. the share menu). */
    popover?: ReactNode;
    onPopoverClose?: () => void;
    onOpen: () => void;
    openTitle: string;
}

/**
 * The card shared by the Workbench and Bookmarks lists. Renders at exactly
 * `annotationCardHeight()`; long quotes and notes are clamped (full text in the
 * tooltip). The row hosting it must raise its z-index while `menuOpen` or the
 * popover is shown: virtual rows are transformed, so each is its own stacking
 * context and later rows would otherwise paint over the menu.
 */
export const AnnotationListCard = memo(function AnnotationListCard({
    id,
    typeLabel,
    dateLabel,
    sourceTitle,
    sourceAuthor,
    accentColor,
    quote,
    note,
    meta,
    searchQuery,
    menuItems,
    menuOpen,
    onMenuOpenChange,
    popover,
    onPopoverClose,
    onOpen,
    openTitle,
}: AnnotationListCardProps) {
    const pointerInsideRef = useRef(false);
    const popoverOpen = popover != null;
    const anyOpen = menuOpen || popoverOpen;

    // Outside-click / Escape close. A `fixed inset-0` backdrop cannot be used:
    // inside a transformed row `fixed` becomes row-relative and would only
    // cover this card. Inside-clicks are flagged by a React capture handler
    // rather than DOM `contains()`, so clicks inside portalled content (the
    // share studio modal) still count as inside.
    useEffect(() => {
        if (!anyOpen) return;
        const close = () => {
            if (menuOpen) onMenuOpenChange(null);
            if (popoverOpen) onPopoverClose?.();
        };
        const handlePointerDown = () => {
            const inside = pointerInsideRef.current;
            pointerInsideRef.current = false;
            if (!inside) close();
        };
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") close();
        };
        document.addEventListener("pointerdown", handlePointerDown);
        document.addEventListener("keydown", handleKeyDown);
        return () => {
            document.removeEventListener("pointerdown", handlePointerDown);
            document.removeEventListener("keydown", handleKeyDown);
        };
    }, [anyOpen, menuOpen, popoverOpen, onMenuOpenChange, onPopoverClose]);

    return (
        <div
            className="group border border-[var(--color-border)] bg-[var(--color-surface)] p-5 transition-colors hover:border-[var(--color-accent)]"
            style={{
                borderLeft: `3px solid ${accentColor ?? "var(--color-border)"}`,
                height: annotationCardHeight({ quote, note, meta }),
            }}
        >
            <div className="flex h-[44px] items-start justify-between mb-4">
                <div className="min-w-0">
                    <div className="flex items-center gap-2">
                        <span className="font-sans text-[11px] font-semibold text-[color:var(--color-text-secondary)]">
                            {typeLabel}
                        </span>
                        <span className="font-sans text-[11px] text-[color:var(--color-text-secondary)]">
                            {dateLabel}
                        </span>
                    </div>
                    <div
                        onClick={onOpen}
                        className="mt-2 font-sans text-[11px] text-[color:var(--color-text-secondary)] truncate cursor-pointer hover:underline"
                        title={openTitle}
                    >
                        <HighlightMatch text={sourceTitle} query={searchQuery} /> <span className="text-[color:var(--color-text-muted)]">|</span> <HighlightMatch text={sourceAuthor} query={searchQuery} />
                    </div>
                </div>
                <div
                    className="relative"
                    onPointerDownCapture={() => {
                        pointerInsideRef.current = true;
                    }}
                >
                    <button
                        onClick={() => onMenuOpenChange(menuOpen ? null : id)}
                        aria-label="Actions"
                        aria-haspopup="menu"
                        aria-expanded={menuOpen}
                        className="border border-[var(--color-border)] p-1.5 text-[color:var(--color-text-muted)] transition-opacity hover:text-[color:var(--color-text-primary)]"
                    >
                        <MoreVertical className="w-4 h-4" />
                    </button>
                    {menuOpen && (
                        <div role="menu" className="absolute right-0 top-full z-20 mt-1 w-40 border border-[var(--color-border)] bg-[var(--color-surface)] py-1">
                            {menuItems.map((item) => (
                                <button
                                    key={item.label}
                                    role="menuitem"
                                    onClick={() => {
                                        onMenuOpenChange(null);
                                        item.onSelect();
                                    }}
                                    className={cn(
                                        "w-full whitespace-nowrap px-3 py-2 text-left font-sans text-[11px] font-medium hover:bg-[var(--color-surface-muted)]",
                                        item.danger
                                            ? "text-[color:var(--color-error)]"
                                            : "text-[color:var(--color-text-primary)]",
                                    )}
                                >
                                    {item.label}
                                </button>
                            ))}
                        </div>
                    )}
                    {popover}
                </div>
            </div>

            <div
                className="space-y-3 cursor-pointer"
                onClick={onOpen}
                title={openTitle}
            >
                {quote && (
                    <blockquote
                        className="h-[84px] overflow-hidden line-clamp-3 pl-3 font-serif text-[17px] leading-[28px] text-[color:var(--color-text-primary)] hover:opacity-85 transition-opacity"
                        title={quote}
                    >
                        <HighlightMatch text={quote} query={searchQuery} />
                    </blockquote>
                )}
                {note && (
                    <p
                        className="h-[52px] overflow-hidden line-clamp-2 font-serif text-[16px] leading-[26px] text-[color:var(--color-text-primary)] whitespace-pre-wrap hover:opacity-85 transition-opacity"
                        title={note}
                    >
                        <HighlightMatch text={note} query={searchQuery} />
                    </p>
                )}
                {meta && (
                    <p className="h-[20px] truncate font-sans text-[11px] leading-[20px] text-[color:var(--color-text-muted)]">
                        {meta}
                    </p>
                )}
            </div>
        </div>
    );
});
