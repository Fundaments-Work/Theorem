/**
 * Selection highlight rects for reflowable (EPUB) text.
 *
 * `Range.getClientRects()` also returns the border boxes of elements fully
 * inside the range, and browsers paint "selection gaps" between blocks, so a
 * native selection across paragraphs floods margins and blank space. Taking
 * rects from text nodes only gives per-line glyph boxes, which is how PDF
 * selection looks. Rects on the same line are merged so adjacent inline runs
 * (<em>, links, spans) do not show seams.
 */

export interface SelectionRect {
    left: number;
    top: number;
    width: number;
    height: number;
}

const SHOW_TEXT = 4; // NodeFilter.SHOW_TEXT (avoid depending on the global in tests)

/** Glyph-box rects for the text covered by `range`, one or more per line. */
export function computeTextSelectionRects(range: Range): SelectionRect[] {
    if (range.collapsed) return [];
    const doc = range.startContainer.ownerDocument ?? (range.startContainer as Document);
    const raw: SelectionRect[] = [];

    const pushTextNode = (node: Text) => {
        if (!node.data || !/\S/.test(node.data)) return;
        const sub = doc.createRange();
        sub.selectNodeContents(node);
        if (node === range.startContainer) sub.setStart(node, range.startOffset);
        if (node === range.endContainer) sub.setEnd(node, range.endOffset);
        if (sub.collapsed) return;
        for (const rect of Array.from(sub.getClientRects())) {
            if (rect.width > 0 && rect.height > 0) {
                raw.push({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
            }
        }
    };

    const root = range.commonAncestorContainer;
    if (root.nodeType === 3) {
        pushTextNode(root as Text);
    } else {
        const walker = doc.createTreeWalker(root, SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            if (range.intersectsNode(node)) pushTextNode(node as Text);
        }
    }
    return mergeLineRects(raw);
}

/** Merge rects that sit on the same line and touch/overlap horizontally. */
export function mergeLineRects(rects: ReadonlyArray<SelectionRect>): SelectionRect[] {
    const sorted = [...rects].sort((a, b) => a.top - b.top || a.left - b.left);
    const out: SelectionRect[] = [];
    for (const rect of sorted) {
        const last = out[out.length - 1];
        if (last) {
            const sameLine = Math.abs(last.top - rect.top) <= Math.max(1.5, Math.min(last.height, rect.height) * 0.25)
                && Math.abs(last.top + last.height - (rect.top + rect.height)) <= Math.max(1.5, Math.min(last.height, rect.height) * 0.25);
            const gap = rect.left - (last.left + last.width);
            if (sameLine && gap <= Math.min(last.height, rect.height) * 0.6) {
                const right = Math.max(last.left + last.width, rect.left + rect.width);
                const top = Math.min(last.top, rect.top);
                const bottom = Math.max(last.top + last.height, rect.top + rect.height);
                last.left = Math.min(last.left, rect.left);
                last.width = right - last.left;
                last.top = top;
                last.height = bottom - top;
                continue;
            }
        }
        out.push({ ...rect });
    }
    return out;
}
