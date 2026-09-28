// Library list cards (Workbench, Bookmarks) fit their content, but their
// height is computed from the text (font metrics + list width), never measured
// per row: per-row measurement is banned for library virtualizers. Each card
// renders at exactly the computed height (text is line-clamped to the computed
// line count), so even if a line count is off by one the gaps stay uniform.

const CARD_CHROME_PX = 2 + 40 + 44 + 16; // border + p-5 + header + header margin
export const CARD_HORIZONTAL_CHROME_PX = 3 + 1 + 40; // left accent + right border + p-5
export const QUOTE_INDENT_PX = 12; // blockquote pl-3
export const QUOTE_LINE_PX = 28;
export const NOTE_LINE_PX = 26;
export const META_BLOCK_PX = 20;
export const TOGGLE_BLOCK_PX = 20;
export const BLOCK_GAP_PX = 12; // space-y-3
export const ANNOTATION_ROW_GAP_PX = 16;

/** Collapsed caps; longer text gets a "Show more" toggle. */
export const QUOTE_MAX_LINES = 8;
export const NOTE_MAX_LINES = 6;

export interface AnnotationCardBlocks {
    quote?: string;
    note?: string;
    meta?: string;
}

export interface CardLayout {
    quoteLines: number;
    noteLines: number;
    hasMeta: boolean;
    expandable: boolean;
    expanded: boolean;
}

export interface CardTextMeasurer {
    /** Width available to text inside the list (the list container width). */
    listWidth: number;
    measureQuote: (text: string) => number;
    measureNote: (text: string) => number;
}

/**
 * Greedy word wrap, matching CSS `overflow-wrap: break-word`: words wrap at
 * spaces; a word wider than the line breaks between characters.
 * `preserveNewlines` follows `white-space: pre-wrap`, otherwise whitespace
 * collapses like normal flow.
 */
export function countWrappedLines(
    text: string | undefined,
    maxWidth: number,
    measure: (text: string) => number,
    preserveNewlines: boolean,
): number {
    if (!text) return 0;
    if (!(maxWidth > 0)) return 1;
    const paragraphs = preserveNewlines
        ? text.replace(/\r\n?/g, "\n").split("\n")
        : [text.replace(/\s+/g, " ").trim()];
    const space = measure(" ");
    let lines = 0;
    for (const paragraph of paragraphs) {
        lines++;
        let lineWidth = 0;
        for (const word of paragraph.split(/[ \t]+/)) {
            if (!word) continue;
            const wordWidth = measure(word);
            if (wordWidth > maxWidth) {
                if (lineWidth > 0) {
                    lines++;
                    lineWidth = 0;
                }
                for (const ch of word) {
                    const charWidth = measure(ch);
                    if (lineWidth > 0 && lineWidth + charWidth > maxWidth) {
                        lines++;
                        lineWidth = 0;
                    }
                    lineWidth += charWidth;
                }
                continue;
            }
            const needed = lineWidth === 0 ? wordWidth : lineWidth + space + wordWidth;
            if (needed > maxWidth) {
                lines++;
                lineWidth = wordWidth;
            } else {
                lineWidth = needed;
            }
        }
    }
    return Math.max(1, lines);
}

export function computeCardLayout(
    { quote, note, meta }: AnnotationCardBlocks,
    measurer: CardTextMeasurer,
    expanded: boolean,
): CardLayout {
    const textWidth = measurer.listWidth - CARD_HORIZONTAL_CHROME_PX;
    // Canvas and DOM widths differ by sub-pixels; err towards one more line
    // (a little air) rather than one fewer (a clipped last line).
    const slack = 0.98;
    const quoteTotal = countWrappedLines(quote, (textWidth - QUOTE_INDENT_PX) * slack, measurer.measureQuote, false);
    const noteTotal = countWrappedLines(note, textWidth * slack, measurer.measureNote, true);
    const expandable = quoteTotal > QUOTE_MAX_LINES || noteTotal > NOTE_MAX_LINES;
    const open = expandable && expanded;
    return {
        quoteLines: open ? quoteTotal : Math.min(quoteTotal, QUOTE_MAX_LINES),
        noteLines: open ? noteTotal : Math.min(noteTotal, NOTE_MAX_LINES),
        hasMeta: Boolean(meta),
        expandable,
        expanded: open,
    };
}

export function annotationCardHeight(layout: CardLayout): number {
    const blocks: number[] = [];
    if (layout.quoteLines > 0) blocks.push(layout.quoteLines * QUOTE_LINE_PX);
    if (layout.noteLines > 0) blocks.push(layout.noteLines * NOTE_LINE_PX);
    if (layout.hasMeta) blocks.push(META_BLOCK_PX);
    const body = blocks.reduce((sum, h) => sum + h, 0) + Math.max(0, blocks.length - 1) * BLOCK_GAP_PX;
    const toggle = layout.expandable ? BLOCK_GAP_PX + TOGGLE_BLOCK_PX : 0;
    return CARD_CHROME_PX + body + toggle;
}

const EMPTY_LAYOUT: CardLayout = { quoteLines: 0, noteLines: 0, hasMeta: false, expandable: false, expanded: false };

/** Virtual row size: the card plus the gap below it. */
export function annotationRowSize(layout: CardLayout | undefined): number {
    return annotationCardHeight(layout ?? EMPTY_LAYOUT) + ANNOTATION_ROW_GAP_PX;
}
