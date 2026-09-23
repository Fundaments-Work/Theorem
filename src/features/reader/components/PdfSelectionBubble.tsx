import { BookOpen, Copy } from "lucide-react";
import { cn } from "../../../core/lib/utils";
import type { PdfTextSelection } from "../hooks/usePdfTextSelection";
import { PICKER_ACTION_BUTTON_CLASS, PICKER_PANEL_CLASS } from "./highlights/HighlightColorPicker";

interface PdfSelectionBubbleProps {
    selection: PdfTextSelection;
    onDefine: () => void;
    onCopy: () => void;
}

/**
 * Actions for text selected in a PDF, drawn like the EPUB selection popup
 * (same panel and buttons). PDF highlights use the annotation tools.
 */
export function PdfSelectionBubble({ selection, onDefine, onCopy }: PdfSelectionBubbleProps) {
    const { x, y, height } = selection.position;
    const above = y > 140;
    return (
        <div
            role="toolbar"
            aria-label="Selection actions"
            // Keep the selection: a mousedown here would collapse it.
            onPointerDown={(e) => e.preventDefault()}
            className={cn("fixed z-[170] grid gap-1.5", PICKER_PANEL_CLASS)}
            style={{
                left: Math.min(Math.max(x, 140), window.innerWidth - 140),
                top: above ? y - 8 : y + height + 8,
                transform: above ? "translate(-50%, -100%)" : "translateX(-50%)",
            }}
        >
            <button type="button" className={PICKER_ACTION_BUTTON_CLASS} onClick={onCopy}>
                <Copy className="w-4 h-4 mr-2" /> Copy
            </button>
            <button type="button" className={PICKER_ACTION_BUTTON_CLASS} onClick={onDefine}>
                <BookOpen className="w-4 h-4 mr-2" /> Define
            </button>
        </div>
    );
}
