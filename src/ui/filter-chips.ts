/**
 * Filter/sort chip styles, shared by the Library filter panel and the OPDS
 * catalog browser.
 *
 * These were previously copy-pasted per button, which let the hover treatment
 * drift: the Library's mobile panel gave Sort and Status a `hover:bg`, while
 * Order and all three Quick buttons only changed their border. Every section now
 * uses the same selected/unselected pair so hovering any chip looks identical.
 *
 * They live here rather than in `Library.tsx` so the catalogs feature can use
 * them without importing the whole Library route chunk.
 */
export const FILTER_CHIP_SELECTED =
    "bg-[var(--color-accent)] text-[color:var(--color-accent-contrast)] border-[var(--color-accent)]";
/** Sits on the page background: transparent at rest, surfacing on hover. */
export const FILTER_CHIP_UNSELECTED =
    "text-[color:var(--color-text-secondary)] border-transparent hover:border-[var(--color-border)] hover:bg-[var(--color-surface)]";
/** Sits on a panel surface already, so it only outlines on hover. */
export const FILTER_CHIP_UNSELECTED_ON_SURFACE =
    "bg-[var(--color-surface)] text-[color:var(--color-text-secondary)] border-transparent hover:border-[var(--color-border)]";