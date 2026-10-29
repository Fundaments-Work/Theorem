import type { Annotation } from "../types";

export interface DailyReviewStatus {
    date: string;
    completed: boolean;
    completedAt?: number;
    reviewedCardIds: string[];
}

export const DAILY_REVIEW_STORAGE_KEY = "theorem:daily-review-state";
export const DAILY_REVIEW_TARGET_COUNT = 5;

/** Format local date as YYYY-MM-DD */
export function getLocalDateString(d: Date = new Date()): string {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}

/** 32-bit FNV-1a hash to convert date string into numeric seed */
export function hashStringToSeed(str: string): number {
    let hash = 2166136261;
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

/** Mulberry32 PRNG initialized from seed */
export function createPrng(seed: number): () => number {
    let s = seed >>> 0;
    return function next() {
        s = (s + 0x6d2b79f5) >>> 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Fisher-Yates shuffle with seeded PRNG */
export function seededShuffle<T>(items: readonly T[], prng: () => number): T[] {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(prng() * (i + 1));
        const temp = copy[i];
        copy[i] = copy[j];
        copy[j] = temp;
    }
    return copy;
}

/** Filter valid candidate annotations for review (must have meaningful text or note) */
export function isEligibleReviewAnnotation(a: Annotation): boolean {
    if (a.type === "bookmark") return false;
    const text = (a.selectedText ?? "").trim();
    const note = (a.noteContent ?? "").trim();
    return text.length >= 5 || note.length >= 5;
}

/**
 * Select a deterministic daily batch of annotations for review.
 * Balances recent insights (< 30 days) with resurfaced gems (>= 30 days).
 */
export function selectDailyReviewCards(
    annotations: readonly Annotation[],
    dateStr: string = getLocalDateString(),
    targetCount: number = DAILY_REVIEW_TARGET_COUNT
): Annotation[] {
    const eligible = annotations.filter(isEligibleReviewAnnotation);
    if (eligible.length === 0) return [];
    if (eligible.length <= targetCount) {
        const prng = createPrng(hashStringToSeed(dateStr));
        return seededShuffle(eligible, prng);
    }

    const prng = createPrng(hashStringToSeed(dateStr));
    const now = new Date().getTime();
    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

    const recent: Annotation[] = [];
    const older: Annotation[] = [];

    for (const ann of eligible) {
        const time = ann.createdAt instanceof Date ? ann.createdAt.getTime() : new Date(ann.createdAt).getTime();
        if (Number.isFinite(time) && now - time < THIRTY_DAYS_MS) {
            recent.push(ann);
        } else {
            older.push(ann);
        }
    }

    const shuffledRecent = seededShuffle(recent, prng);
    const shuffledOlder = seededShuffle(older, prng);

    const result: Annotation[] = [];

    // Aim for 3 recent and 2 older
    const targetRecent = Math.min(3, shuffledRecent.length);
    result.push(...shuffledRecent.slice(0, targetRecent));

    const remainingNeeded = targetCount - result.length;
    const fromOlder = shuffledOlder.slice(0, remainingNeeded);
    result.push(...fromOlder);

    // If still need more, take extra from recent
    if (result.length < targetCount && shuffledRecent.length > targetRecent) {
        const moreFromRecent = shuffledRecent.slice(targetRecent, targetRecent + (targetCount - result.length));
        result.push(...moreFromRecent);
    }

    // Final shuffle to blend recent and older together
    return seededShuffle(result, prng);
}

/** Retrieve daily review status from localStorage */
export function getDailyReviewStatus(dateStr: string = getLocalDateString()): DailyReviewStatus {
    if (typeof window === "undefined" || !window.localStorage) {
        return { date: dateStr, completed: false, reviewedCardIds: [] };
    }

    try {
        const raw = window.localStorage.getItem(DAILY_REVIEW_STORAGE_KEY);
        if (!raw) {
            return { date: dateStr, completed: false, reviewedCardIds: [] };
        }
        const parsed = JSON.parse(raw) as Partial<DailyReviewStatus>;
        if (parsed.date === dateStr) {
            return {
                date: dateStr,
                completed: Boolean(parsed.completed),
                completedAt: parsed.completedAt,
                reviewedCardIds: Array.isArray(parsed.reviewedCardIds) ? parsed.reviewedCardIds : [],
            };
        }
        // Different day: reset
        return { date: dateStr, completed: false, reviewedCardIds: [] };
    } catch {
        return { date: dateStr, completed: false, reviewedCardIds: [] };
    }
}

/** Mark today's daily review as completed */
export function markDailyReviewCompleted(
    dateStr: string = getLocalDateString(),
    reviewedCardIds: string[] = []
): void {
    if (typeof window === "undefined" || !window.localStorage) return;

    try {
        const status: DailyReviewStatus = {
            date: dateStr,
            completed: true,
            completedAt: Date.now(),
            reviewedCardIds,
        };
        window.localStorage.setItem(DAILY_REVIEW_STORAGE_KEY, JSON.stringify(status));
    } catch {
        // Storage unavailable or quota exceeded
    }
}

/** Reset daily review state (for testing or "review again") */
export function resetDailyReview(dateStr: string = getLocalDateString()): void {
    if (typeof window === "undefined" || !window.localStorage) return;
    try {
        const status: DailyReviewStatus = {
            date: dateStr,
            completed: false,
            reviewedCardIds: [],
        };
        window.localStorage.setItem(DAILY_REVIEW_STORAGE_KEY, JSON.stringify(status));
    } catch {
        // Storage unavailable
    }
}
