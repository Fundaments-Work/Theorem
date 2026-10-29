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
/** Sits on the page background: styled with a visible border and surface so it feels like a real button. */
export const FILTER_CHIP_UNSELECTED =
    "bg-[var(--color-surface)] text-[color:var(--color-text-secondary)] border-[var(--color-border)] hover:border-[var(--color-border)] hover:bg-[var(--color-surface)] hover:text-[color:var(--color-text-primary)]";
/** Sits on a panel surface already, with a defined border and surface fill. */
export const FILTER_CHIP_UNSELECTED_ON_SURFACE =
    "bg-[var(--color-surface)] text-[color:var(--color-text-secondary)] border-[var(--color-border)] hover:border-[var(--color-border)] hover:text-[color:var(--color-text-primary)]";