/**
 * Back/forward stack for PDF navigation (links, TOC, page jumps), like a
 * browser's history. Positions are stored as page + fraction within the page
 * so they survive zoom and rotation changes.
 */
export interface PdfHistoryEntry {
    page: number;
    /** Scroll offset within the page as a fraction of its height, 0..1. */
    ratio: number;
}

export interface PdfHistoryState {
    back: PdfHistoryEntry[];
    forward: PdfHistoryEntry[];
}

export const PDF_HISTORY_LIMIT = 50;

function isSameLocation(a: PdfHistoryEntry | undefined, b: PdfHistoryEntry): boolean {
    return !!a && a.page === b.page && Math.abs(a.ratio - b.ratio) < 0.02;
}

/** Record `current` before a jump. A new jump clears the forward stack. */
export function pushPdfHistory(state: PdfHistoryState, current: PdfHistoryEntry): PdfHistoryState {
    const back = isSameLocation(state.back[state.back.length - 1], current)
        ? state.back
        : [...state.back, current].slice(-PDF_HISTORY_LIMIT);
    return { back, forward: [] };
}

/**
 * Move one step back or forward. `current` is saved on the opposite stack so
 * the move can be undone. Returns null when there is nowhere to go.
 */
export function stepPdfHistory(
    state: PdfHistoryState,
    current: PdfHistoryEntry,
    direction: "back" | "forward",
): { history: PdfHistoryState; target: PdfHistoryEntry } | null {
    const from = direction === "back" ? state.back : state.forward;
    const to = direction === "back" ? state.forward : state.back;
    const target = from[from.length - 1];
    if (!target) return null;
    const remaining = from.slice(0, -1);
    const saved = isSameLocation(to[to.length - 1], current) ? to : [...to, current].slice(-PDF_HISTORY_LIMIT);
    return {
        history: direction === "back"
            ? { back: remaining, forward: saved }
            : { back: saved, forward: remaining },
        target,
    };
}
