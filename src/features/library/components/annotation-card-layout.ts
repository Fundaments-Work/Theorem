// Library list cards (Workbench, Bookmarks) render at a fixed height derived
// from which blocks they show, so the virtualizer knows every row's exact size
// without measuring it (per-row measurement is banned for library
// virtualizers) and the gaps between cards stay uniform.

const CARD_CHROME_PX = 2 + 40 + 44 + 16; // border + p-5 + header + header margin
export const QUOTE_BLOCK_PX = 84; // 3 lines × 28px
export const NOTE_BLOCK_PX = 52; // 2 lines × 26px
export const META_BLOCK_PX = 20; // 1 line × 20px
const BLOCK_GAP_PX = 12; // space-y-3
export const ANNOTATION_ROW_GAP_PX = 16;

export interface AnnotationCardBlocks {
    quote?: string;
    note?: string;
    meta?: string;
}

export function annotationCardHeight({ quote, note, meta }: AnnotationCardBlocks): number {
    const blocks: number[] = [];
    if (quote) blocks.push(QUOTE_BLOCK_PX);
    if (note) blocks.push(NOTE_BLOCK_PX);
    if (meta) blocks.push(META_BLOCK_PX);
    const body = blocks.reduce((sum, h) => sum + h, 0) + Math.max(0, blocks.length - 1) * BLOCK_GAP_PX;
    return CARD_CHROME_PX + body;
}

/** Virtual row size: the card plus the gap below it. */
export function annotationRowSize(blocks: AnnotationCardBlocks | undefined): number {
    return annotationCardHeight(blocks ?? {}) + ANNOTATION_ROW_GAP_PX;
}
