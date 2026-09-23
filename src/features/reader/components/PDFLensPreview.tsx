import { useEffect, useMemo, useRef } from "react";
import { isMobile } from "../../../core/lib/env";

export interface PDFLensPreviewProps {
    imageUrl: string | null;
    /** Extracted text: accessible label, and the fallback when rendering failed. */
    text: string;
    pageNumber: number;
    /** Viewport rect of the link the preview belongs to. */
    anchorRect: { top: number; left: number; bottom: number; width: number };
    onJump: () => void;
    onClose: () => void;
    onPointerEnter?: () => void;
    onPointerLeave?: () => void;
}

const MAX_WIDTH = 420;
const MARGIN = 12;
const GAP = 8;

/**
 * Theorem Lens for PDF: just the destination, rendered as it appears on the
 * page. No chrome: click/tap it to jump there, move away / Esc / click
 * outside to dismiss.
 */
export function PDFLensPreview({
    imageUrl, text, pageNumber, anchorRect, onJump, onClose, onPointerEnter, onPointerLeave,
}: PDFLensPreviewProps) {
    const ref = useRef<HTMLButtonElement>(null);
    const mobile = isMobile();

    useEffect(() => {
        const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
        const onDown = (event: PointerEvent) => {
            if (ref.current && !ref.current.contains(event.target as Node)) onClose();
        };
        window.addEventListener("keydown", onKey);
        window.addEventListener("pointerdown", onDown, true);
        return () => {
            window.removeEventListener("keydown", onKey);
            window.removeEventListener("pointerdown", onDown, true);
        };
    }, [onClose]);

    const style = useMemo(() => {
        const width = Math.min(MAX_WIDTH, window.innerWidth - MARGIN * 2);
        if (mobile) {
            return { left: MARGIN, right: MARGIN, bottom: `calc(env(safe-area-inset-bottom) + ${MARGIN}px)` };
        }
        const centre = anchorRect.left + anchorRect.width / 2;
        const left = Math.max(MARGIN, Math.min(window.innerWidth - width - MARGIN, centre - width / 2));
        const spaceBelow = window.innerHeight - anchorRect.bottom;
        return spaceBelow > 180 || spaceBelow > anchorRect.top
            ? { left, width, top: anchorRect.bottom + GAP }
            : { left, width, bottom: window.innerHeight - anchorRect.top + GAP };
    }, [anchorRect, mobile]);

    return (
        <button
            ref={ref}
            type="button"
            data-theorem-lens
            onClick={onJump}
            onPointerEnter={onPointerEnter}
            onPointerLeave={onPointerLeave}
            title={`Page ${pageNumber} — click to go there`}
            aria-label={`Go to page ${pageNumber}: ${text}`}
            className="fixed z-[150] block overflow-hidden rounded-lg bg-white p-0 text-left cursor-pointer border-0"
            style={{
                ...style,
                maxHeight: mobile ? "45vh" : 360,
                // Lift off the page without a frame: soft shadow + hairline ring.
                boxShadow: "0 0 0 1px rgba(0,0,0,0.06), 0 10px 32px rgba(0,0,0,0.22), 0 2px 6px rgba(0,0,0,0.12)",
            }}
        >
            {imageUrl ? (
                <img src={imageUrl} alt="" draggable={false} className="block w-full h-auto select-none" />
            ) : (
                <p className="m-0 p-3 text-xs leading-relaxed text-black whitespace-pre-line">{text}</p>
            )}
        </button>
    );
}
