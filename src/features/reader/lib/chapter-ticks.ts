/**
 * Which chapter ticks the reader's progress bar draws (issue #160).
 *
 * A tick for every chapter turned books with many short chapters into a dense
 * row of marks. A chapter's tick is now drawn only when it stands at least
 * `minGapPx` from the chapter starts on either side of it (the ends of the bar
 * count as such). A book with a handful of chapters shows them all; a book
 * whose chapters are each a few pixels wide shows a plain bar; in between,
 * only the boundaries with room around them get a tick.
 *
 * (Thinning to "every third chapter" was tried and rejected: on a 1,000px bar
 * a 300-chapter book still looked like a ruler, and the ticks no longer said
 * where chapters start.)
 */

/** Smallest distance from a tick to the chapter start (or bar end) on either side. */
export const MIN_TICK_GAP_PX = 8;

export interface ChapterTick {
    /** Position along the bar, 0..1. */
    fraction: number;
    /** Index into the list the fraction came from (to look up the chapter's name). */
    index: number;
}

/**
 * Picks the ticks to draw on a bar `trackWidthPx` wide from chapter start
 * positions `fractions` (0..1, in reading order). Unusable or out-of-order
 * values are skipped. Returns nothing while the width is unknown.
 */
export function thinChapterTicks(
    fractions: readonly number[],
    trackWidthPx: number,
    minGapPx: number = MIN_TICK_GAP_PX,
): ChapterTick[] {
    if (!Number.isFinite(trackWidthPx) || trackWidthPx <= 0 || fractions.length === 0) return [];
    // A hair of tolerance so chapters exactly `minGapPx` wide are not lost to rounding.
    const gap = Math.max(0, minGapPx) - 1e-6;

    const starts: ChapterTick[] = [];
    let last = -Infinity;
    for (let index = 0; index < fractions.length; index++) {
        const fraction = fractions[index];
        if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1 || fraction < last) continue;
        starts.push({ fraction, index });
        last = fraction;
    }

    const ticks: ChapterTick[] = [];
    for (let i = 0; i < starts.length; i++) {
        const x = starts[i].fraction * trackWidthPx;
        const prevX = i > 0 ? starts[i - 1].fraction * trackWidthPx : 0;
        const nextX = i < starts.length - 1 ? starts[i + 1].fraction * trackWidthPx : trackWidthPx;
        // The bar's own ends bound the first and last chapter.
        const roomBefore = Math.min(x - prevX, x);
        const roomAfter = Math.min(nextX - x, trackWidthPx - x);
        if (roomBefore >= gap && roomAfter >= gap) ticks.push(starts[i]);
    }
    return ticks;
}
