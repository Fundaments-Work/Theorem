/**
 * While a book reopens, the reader holds back progress saves so the transient
 * locations of the jump (the section start, the start of the visible page)
 * never overwrite the saved position. This decides what one location change
 * means for that hold. Framework-free so the Svelte reader can reuse it.
 */

/** Relocation reasons the paginator reports for a page turn the reader made (button, key, swipe, scroll). */
const USER_REASONS = new Set(["page", "snap", "scroll"]);

export function isUserRelocation(reason: unknown): boolean {
    return typeof reason === "string" && USER_REASONS.has(reason);
}

export type ResumeDecision =
    /** The reader reached the saved position: stop holding back, nothing new to save. */
    | "arrived"
    /** The reader turned the page: the resume is over and this location is the new position. */
    | "user"
    /** Still settling: keep holding back. */
    | "wait";

export function resumeDecision({ target, cfi, byUser }: { target: string | null; cfi: string | undefined; byUser?: boolean }): ResumeDecision {
    if (target && cfi && cfi.startsWith(target)) return "arrived";
    // A page turn is the reader's own choice. Holding it back lost the position
    // when someone opened a new book and turned pages within the first second
    // (the hold had no target and its timer was the only way out), so the
    // book reopened on page 1 or one page early.
    if (byUser) return "user";
    return "wait";
}
