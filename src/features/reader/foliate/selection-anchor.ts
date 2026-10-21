/**
 * Anchoring rules for the reader's selection toolbar and highlight matching.
 *
 * Two failure modes this module exists to prevent (both were seen on phones):
 * - A selection that continues onto the next page/column has client rects
 *   outside the visible page; anchoring the toolbar to the last rect puts it
 *   off screen. The anchor must be a rect the reader can actually see.
 * - Matching an existing highlight by selected text (or substring) across the
 *   whole book makes a repeated phrase edit/recolor a *different* highlight.
 *   A selection only "is" a highlight when their CFI ranges overlap.
 */

import * as CFI from "../foliate-js-runtime/epubcfi.js";

export interface AnchorRect {
    left: number;
    top: number;
    width: number;
    height: number;
}

export interface AnchorBounds {
    left: number;
    top: number;
    right: number;
    bottom: number;
}

const intersects = (r: AnchorRect, b: AnchorBounds) =>
    r.width > 0 && r.height > 0
    && r.left < b.right && r.left + r.width > b.left
    && r.top < b.bottom && r.top + r.height > b.top;

/**
 * Pick the rect the toolbar should hang from: the last visible one (where the
 * finger/handle is), falling back to the first visible one, then to the last
 * rect clamped into `bounds` so the toolbar never lands off screen.
 */
export function pickVisibleAnchorRect(
    rects: ReadonlyArray<AnchorRect>,
    bounds: AnchorBounds,
): AnchorRect | null {
    const usable = rects.filter((r) => r.width > 0 && r.height > 0);
    if (usable.length === 0) return null;
    for (let i = usable.length - 1; i >= 0; i--) {
        if (intersects(usable[i], bounds)) return clampToBounds(usable[i], bounds);
    }
    return clampToBounds(usable[usable.length - 1], bounds);
}

function clampToBounds(r: AnchorRect, b: AnchorBounds): AnchorRect {
    const left = Math.max(b.left, Math.min(r.left, b.right - 1));
    const right = Math.max(left + 1, Math.min(r.left + r.width, b.right));
    const top = Math.max(b.top, Math.min(r.top, b.bottom - 1));
    const bottom = Math.max(top + 1, Math.min(r.top + r.height, b.bottom));
    return { left, top, width: right - left, height: bottom - top };
}

interface CfiParts {
    start?: unknown;
    end?: unknown;
}

function safeParse(cfi: string): CfiParts | null {
    try {
        return CFI.parse(cfi) as CfiParts;
    } catch {
        return null;
    }
}

function bounds(cfi: string): { start: unknown; end: unknown } | null {
    const parts = safeParse(cfi);
    if (!parts) return null;
    try {
        return { start: CFI.collapse(parts), end: CFI.collapse(parts, true) };
    } catch {
        return null;
    }
}

function relate(a: string, b: string, inclusive: boolean): boolean {
    if (!a || !b) return false;
    if (a === b) return true;
    const x = bounds(a);
    const y = bounds(b);
    if (!x || !y) return false;
    try {
        const startVsEnd = CFI.compare(x.start, y.end);
        const endVsStart = CFI.compare(y.start, x.end);
        // Touching ends (a ends exactly where b starts) is adjacency, not overlap,
        // except for point CFIs which are equal at both ends.
        const aIsPoint = CFI.compare(x.start, x.end) === 0;
        const bIsPoint = CFI.compare(y.start, y.end) === 0;
        const lo = inclusive || aIsPoint || bIsPoint ? 0 : -1;
        return startVsEnd <= lo && endVsStart <= lo;
    } catch {
        return false;
    }
}

/** True when the two CFIs address overlapping (or identical) content. */
export function cfiRangesOverlap(a: string, b: string): boolean {
    return relate(a, b, false);
}

/** True when `outer` fully covers `inner` (equal ranges count). */
export function cfiContains(outer: string, inner: string): boolean {
    if (!outer || !inner) return false;
    if (outer === inner) return true;
    const x = bounds(outer);
    const y = bounds(inner);
    if (!x || !y) return false;
    try {
        return CFI.compare(x.start, y.start) <= 0 && CFI.compare(x.end, y.end) >= 0;
    } catch {
        return false;
    }
}

/** Overlap, or the ranges meet exactly end-to-start (e.g. two halves of one sentence). */
export function cfiRangesConnect(a: string, b: string): boolean {
    return relate(a, b, true);
}

const sectionOf = (cfi: string) => cfi.split("!")[0];

interface MatchableAnnotation {
    type: string;
    location?: string;
    selectedText?: string;
}

/**
 * The highlight/note a fresh selection lies inside, or undefined when it is new
 * (a selection that only partly overlaps or touches a highlight is new: it
 * extends that highlight, see `findMergeTargets`).
 * Order: same CFI, containing CFI, then — for legacy annotations whose CFI no
 * longer resolves — identical text *within the same section only*.
 */
export function findAnnotationForSelection<T extends MatchableAnnotation>(
    annotations: ReadonlyArray<T>,
    cfi: string,
    text: string,
): T | undefined {
    const candidates = annotations.filter(
        (a) => (a.type === "highlight" || a.type === "note") && a.location,
    );
    const exact = candidates.find((a) => a.location === cfi);
    if (exact) return exact;
    const containing = candidates.find((a) => cfiContains(a.location as string, cfi));
    if (containing) return containing;

    const wanted = text.trim();
    if (wanted.length <= 3) return undefined;
    const section = sectionOf(cfi);
    return candidates.find(
        (a) =>
            sectionOf(a.location as string) === section
            && a.selectedText?.trim() === wanted
            && safeParse(a.location as string) === null,
    );
}

/**
 * One range CFI covering every input: earliest start to latest end. Null when
 * the inputs are empty, unparseable, or in different spine sections (a highlight
 * cannot span chapters).
 */
export function unionCfis(cfis: ReadonlyArray<string>): string | null {
    const list = cfis.filter(Boolean);
    if (list.length === 0) return null;
    if (list.length === 1) return list[0];
    const section = sectionOf(list[0]);
    if (list.some((c) => sectionOf(c) !== section)) return null;
    try {
        let start = CFI.collapse(list[0]) as string;
        let end = CFI.collapse(list[0], true) as string;
        for (const cfi of list.slice(1)) {
            const s = CFI.collapse(cfi) as string;
            const e = CFI.collapse(cfi, true) as string;
            if (CFI.compare(s, start) < 0) start = s;
            if (CFI.compare(e, end) > 0) end = e;
        }
        return CFI.buildRange(start, end) as string;
    } catch {
        return null;
    }
}

/** Highlights/notes that a new selection overlaps or touches, i.e. must merge with. */
export function findMergeTargets<T extends MatchableAnnotation>(
    annotations: ReadonlyArray<T>,
    cfi: string,
): T[] {
    const section = sectionOf(cfi);
    return annotations.filter(
        (a) =>
            (a.type === "highlight" || a.type === "note")
            && a.location
            && sectionOf(a.location) === section
            && cfiRangesConnect(a.location, cfi),
    );
}
