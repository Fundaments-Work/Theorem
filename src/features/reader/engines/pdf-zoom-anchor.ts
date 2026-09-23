/**
 * Zoom anchoring for the continuous PDF view.
 *
 * Multiplying scroll offsets by the zoom ratio assumes everything scales, but
 * page gaps and padding do not: the error grows with the page number (≈300px
 * at page 300 for a 10% zoom), and a freshly opened document at scrollTop 0
 * ends up a third of a page down. Instead, remember which point of which page
 * sits under the focus (viewport centre, wheel cursor or pinch centre) and,
 * after the re-layout, scroll so that same page point is under the focus again.
 */

export interface PageBox {
    pageNumber: number;
    top: number;
    bottom: number;
    left: number;
    width: number;
}

export interface ZoomAnchor {
    pageNumber: number;
    /** Position within the page as a fraction of its height (when inside the page). */
    ratioY: number;
    /**
     * When the focus is in padding or a gap (which do not scale), the unscaled
     * pixel distance from the page's top (negative) or bottom (positive) edge.
     */
    edgeOffset: { edge: "top" | "bottom"; px: number } | null;
    /** Position within the page as a fraction of its width. */
    ratioX: number;
    /** Focus point, in px from the container's top-left. */
    focusX: number;
    focusY: number;
    /** Scale the anchor is waiting for. */
    scale: number;
}

function findPageAt(layout: ReadonlyArray<PageBox>, contentY: number): PageBox | null {
    if (layout.length === 0) return null;
    let low = 0;
    let high = layout.length - 1;
    while (low <= high) {
        const mid = (low + high) >> 1;
        const box = layout[mid];
        if (contentY < box.top) high = mid - 1;
        else if (contentY > box.bottom) low = mid + 1;
        else return box;
    }
    // In a gap: attach to the nearer neighbour.
    const below = layout[Math.min(low, layout.length - 1)];
    const above = layout[Math.max(0, low - 1)];
    return Math.abs(contentY - above.bottom) <= Math.abs(below.top - contentY) ? above : below;
}

/** `layout` must be sorted by page top (as rebuildPageLayout produces). */
export function captureZoomAnchor(
    layout: ReadonlyArray<PageBox>,
    scrollLeft: number,
    scrollTop: number,
    focusX: number,
    focusY: number,
    targetScale: number,
): ZoomAnchor | null {
    const contentY = scrollTop + focusY;
    const box = findPageAt(layout, contentY);
    if (!box || box.bottom <= box.top || box.width <= 0) return null;
    const edgeOffset = contentY < box.top
        ? { edge: "top" as const, px: contentY - box.top }
        : contentY > box.bottom
            ? { edge: "bottom" as const, px: contentY - box.bottom }
            : null;
    return {
        pageNumber: box.pageNumber,
        ratioY: edgeOffset ? 0 : (contentY - box.top) / (box.bottom - box.top),
        edgeOffset,
        ratioX: (scrollLeft + focusX - box.left) / box.width,
        focusX,
        focusY,
        scale: targetScale,
    };
}

/** Scroll position that puts the anchored page point back under the focus. */
export function resolveZoomAnchor(
    layout: ReadonlyArray<PageBox>,
    anchor: ZoomAnchor,
): { top: number; left: number } | null {
    const box = layout.find((entry) => entry.pageNumber === anchor.pageNumber);
    if (!box) return null;
    const contentY = anchor.edgeOffset
        ? (anchor.edgeOffset.edge === "top" ? box.top : box.bottom) + anchor.edgeOffset.px
        : box.top + anchor.ratioY * (box.bottom - box.top);
    return {
        top: Math.max(0, contentY - anchor.focusY),
        left: Math.max(0, box.left + anchor.ratioX * box.width - anchor.focusX),
    };
}
