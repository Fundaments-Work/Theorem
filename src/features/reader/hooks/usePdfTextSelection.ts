import { useEffect, useState } from "react";

export interface PdfTextSelection {
    text: string;
    /** Picker anchor: centre x and top y of the last selected line (viewport px). */
    position: { x: number; y: number; height: number };
}

/** Longest selection offered for lookup/copy from the bubble. */
const MAX_SELECTION_CHARS = 2000;

/**
 * The finished selection if it lies in a PDF text layer, else `null`.
 * Text-layer spans carry their own spacing, so whitespace is collapsed.
 */
export function readPdfTextSelection(selection: Selection | null): PdfTextSelection | null {
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
    const range = selection.getRangeAt(0);
    const container = range.commonAncestorContainer;
    const element = container instanceof Element ? container : container.parentElement;
    if (!element?.closest(".textLayer")) return null;
    const text = selection.toString().replace(/\s+/g, " ").trim();
    if (!text || text.length > MAX_SELECTION_CHARS) return null;
    const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
    const rect = rects.length > 0 ? rects[rects.length - 1] : range.getBoundingClientRect();
    return { text, position: { x: rect.left + rect.width / 2, y: rect.top, height: Math.max(rect.height, 24) } };
}

/**
 * Tracks text selected in the PDF text layer. Updates once the selection is
 * finished (pointer/key release, or a pause for touch handles), not per
 * character while dragging.
 */
export function usePdfTextSelection(enabled: boolean): [PdfTextSelection | null, () => void] {
    const [selection, setSelection] = useState<PdfTextSelection | null>(null);

    useEffect(() => {
        if (!enabled) {
            setSelection(null);
            return;
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        let pointerDown = false;
        const update = () => setSelection(readPdfTextSelection(window.getSelection()));
        const onPointerDown = () => { pointerDown = true; };
        const onPointerUp = () => { pointerDown = false; clearTimeout(timer); timer = setTimeout(update, 0); };
        const onSelectionChange = () => {
            clearTimeout(timer);
            if (window.getSelection()?.isCollapsed) { setSelection(null); return; }
            // Touch selection handles fire no pointerup on the page: settle.
            if (!pointerDown) timer = setTimeout(update, 400);
        };
        document.addEventListener("pointerdown", onPointerDown, true);
        document.addEventListener("pointerup", onPointerUp, true);
        document.addEventListener("keyup", onPointerUp, true);
        document.addEventListener("selectionchange", onSelectionChange);
        return () => {
            clearTimeout(timer);
            document.removeEventListener("pointerdown", onPointerDown, true);
            document.removeEventListener("pointerup", onPointerUp, true);
            document.removeEventListener("keyup", onPointerUp, true);
            document.removeEventListener("selectionchange", onSelectionChange);
        };
    }, [enabled]);

    return [selection, () => setSelection(null)];
}
