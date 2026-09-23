import { BookOpen, Copy } from "lucide-react";
import type { PdfTextSelection } from "../hooks/usePdfTextSelection";

interface PdfSelectionBubbleProps {
    selection: PdfTextSelection;
    onDefine: () => void;
    onCopy: () => void;
}

const BUTTON = "inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-[color:var(--color-text-primary)] transition-colors duration-150 hover:bg-[var(--color-surface-muted)]";

/** Actions for text selected in a PDF (PDF highlights use the annotation tools). */
export function PdfSelectionBubble({ selection, onDefine, onCopy }: PdfSelectionBubbleProps) {
    const { x, y } = selection.position;
    const above = y > 56;
    return (
        <div
            role="toolbar"
            aria-label="Selection actions"
            // Keep the selection: a mousedown here would collapse it.
            onPointerDown={(e) => e.preventDefault()}
            className="fixed z-[170] flex border border-[var(--color-border)] bg-[var(--color-surface)] shadow-lg"
            style={{
                left: Math.min(Math.max(x, 90), window.innerWidth - 90),
                top: above ? y - 8 : y + selection.position.height + 8,
                transform: above ? "translate(-50%, -100%)" : "translateX(-50%)",
            }}
        >
            <button type="button" className={BUTTON} onClick={onDefine}>
                <BookOpen className="w-4 h-4" /> Define
            </button>
            <button type="button" className={BUTTON} onClick={onCopy}>
                <Copy className="w-4 h-4" /> Copy
            </button>
        </div>
    );
}
