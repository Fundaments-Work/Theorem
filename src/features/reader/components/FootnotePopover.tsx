import { useEffect, useMemo, useRef } from "react";
import { Copy, ExternalLink, X, Compass } from "lucide-react";
import { toast } from "sonner";
import { cn } from "../../../core/lib/utils";
import { isMobile } from "../../../core/lib/env";
import type { FootnoteData } from "../engines/foliate-engine";

export interface FootnotePopoverProps {
    footnote: FootnoteData | null;
    onClose: () => void;
    onJump?: (href: string) => void;
    /** Hover previews: keep open while the pointer is over the popover. */
    onPointerEnter?: () => void;
    onPointerLeave?: () => void;
}

export function FootnotePopover({ footnote, onClose, onJump, onPointerEnter, onPointerLeave }: FootnotePopoverProps) {
    const popoverRef = useRef<HTMLDivElement>(null);
    const isMobileDevice = isMobile();

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                onClose();
            }
        };

        const handleClickOutside = (e: MouseEvent | TouchEvent) => {
            if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
                onClose();
            }
        };

        window.addEventListener("keydown", handleKeyDown);
        window.addEventListener("mousedown", handleClickOutside);
        window.addEventListener("touchstart", handleClickOutside, { passive: true });

        return () => {
            window.removeEventListener("keydown", handleKeyDown);
            window.removeEventListener("mousedown", handleClickOutside);
            window.removeEventListener("touchstart", handleClickOutside);
        };
    }, [onClose]);

    const anchorStyle = useMemo(() => {
        if (isMobileDevice || !footnote?.rect) {
            return undefined;
        }

        const rect = footnote.rect;
        const popoverWidth = Math.min(420, window.innerWidth - 32);
        const margin = 16;
        const gap = 10;

        const targetCenterX = rect.left + rect.width / 2;
        let left = targetCenterX - popoverWidth / 2;
        left = Math.max(margin, Math.min(window.innerWidth - popoverWidth - margin, left));

        const estimatedHeight = 240;
        const placeAbove = rect.top > estimatedHeight + gap + 40;

        let top: number;
        if (placeAbove) {
            top = Math.max(margin, rect.top - gap);
        } else {
            top = rect.bottom + gap;
        }

        return {
            position: "fixed" as const,
            left: `${left}px`,
            top: placeAbove ? "auto" : `${top}px`,
            bottom: placeAbove ? `${window.innerHeight - rect.top + gap}px` : "auto",
            width: `${popoverWidth}px`,
            placeAbove,
        };
    }, [footnote?.rect, isMobileDevice]);

    if (!footnote) return null;

    const handleCopy = async () => {
        try {
            await navigator.clipboard.writeText(footnote.text);
            toast.success("Copied to clipboard");
        } catch {
            toast.error("Failed to copy");
        }
    };

    return (
        <div
            className={cn(
                "fixed z-[150] transition-[opacity,transform] duration-200 ease-out animate-fade-in",
                isMobileDevice && "inset-x-0 bottom-0 p-4 pb-[calc(env(safe-area-inset-bottom)+1rem)]"
            )}
            style={isMobileDevice ? undefined : (anchorStyle ? {
                position: anchorStyle.position,
                left: anchorStyle.left,
                top: anchorStyle.top,
                bottom: anchorStyle.bottom,
                width: anchorStyle.width,
            } : { top: "4rem", right: "2rem", width: "420px" })}
        >
            {isMobileDevice && (
                <div
                    onClick={onClose}
                    className="fixed inset-0 -z-10 bg-black/40 transition-opacity"
                />
            )}

            <div
                ref={popoverRef}
                onPointerEnter={onPointerEnter}
                onPointerLeave={onPointerLeave}
                className={cn(
                    "relative flex flex-col bg-[var(--color-surface)] border border-[var(--color-border)] shadow-2xl overflow-hidden",
                    isMobileDevice ? "rounded-t-2xl max-h-[60vh]" : "rounded-xl max-h-[420px]"
                )}
            >
                {/* Header */}
                <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-[var(--color-border)] bg-[var(--color-surface-muted)] select-none">
                    <div className="flex items-center gap-2 min-w-0">
                        <div className="flex h-5 w-5 items-center justify-center rounded-full bg-[var(--color-surface)] border border-[var(--color-border)] text-[color:var(--color-accent)] shrink-0">
                            <Compass className="h-3 w-3" />
                        </div>
                        <span className="text-[11px] font-bold uppercase tracking-wider text-[color:var(--color-text-primary)] truncate">
                            {footnote.title || "Theorem Lens"}
                        </span>
                    </div>

                    <div className="flex items-center gap-1">
                        <button
                            onClick={handleCopy}
                            className="ui-icon-btn p-1.5"
                            title="Copy text"
                            aria-label="Copy text"
                        >
                            <Copy className="h-3.5 w-3.5" />
                        </button>

                        {footnote.href && onJump && (
                            <button
                                onClick={() => {
                                    if (footnote.href) onJump(footnote.href);
                                    onClose();
                                }}
                                className="ui-icon-btn p-1.5 text-[color:var(--color-accent)]"
                                title="Go to target"
                                aria-label="Go to target"
                            >
                                <ExternalLink className="h-3.5 w-3.5" />
                            </button>
                        )}

                        <button
                            onClick={onClose}
                            className="ui-icon-btn p-1.5 ml-1"
                            title="Close"
                            aria-label="Close"
                        >
                            <X className="h-3.5 w-3.5" />
                        </button>
                    </div>
                </div>

                {/* Content */}
                <div className="p-3.5 sm:p-4 overflow-y-auto overscroll-contain text-xs leading-relaxed text-[color:var(--color-text-primary)] select-text [content-visibility:auto]">
                    {footnote.imageUrl ? (
                        <img
                            src={footnote.imageUrl}
                            alt={footnote.text}
                            draggable={false}
                            className="block w-full h-auto rounded border border-[var(--color-border)] bg-white"
                        />
                    ) : footnote.html ? (
                        <div
                            dangerouslySetInnerHTML={{ __html: footnote.html }}
                            className="[&_a]:text-[color:var(--color-accent)] [&_a]:underline space-y-1.5 [&_img]:max-h-48 [&_img]:rounded [&_img]:mx-auto"
                        />
                    ) : (
                        <p className="whitespace-pre-line">{footnote.text}</p>
                    )}
                </div>
            </div>
        </div>
    );
}

export { FootnotePopover as TheoremLens };

