/**
 * Pure functions for adaptive reading time and reading speed calculations.
 */

export const AVERAGE_WPM = 200;
export const WORDS_PER_PAGE = 250;
export const MIN_WPM = 80;
export const MAX_WPM = 800;
export const MIN_DWELL_SECONDS = 5;
export const MAX_DWELL_SECONDS = 180;
export const EMA_ALPHA = 0.15;

/**
 * Calculate instantaneous words per minute given words read and dwell duration in seconds.
 * Returns null if the dwell time is outside reasonable reading boundaries (<5s or >180s).
 */
export function calculateWpm(words: number, dwellSeconds: number): number | null {
    if (!Number.isFinite(dwellSeconds) || dwellSeconds < MIN_DWELL_SECONDS || dwellSeconds > MAX_DWELL_SECONDS) {
        return null;
    }
    const safeWords = Math.max(1, words);
    const instantWpm = Math.round((safeWords / dwellSeconds) * 60);
    return Math.max(MIN_WPM, Math.min(MAX_WPM, instantWpm));
}

/**
 * Exponential moving average smoothing for reading speed.
 */
export function computeExponentialMovingAverage(
    currentAvg: number,
    instantWpm: number,
    alpha: number = EMA_ALPHA
): number {
    if (!Number.isFinite(currentAvg) || currentAvg <= 0) {
        return instantWpm;
    }
    return Math.round((1 - alpha) * currentAvg + alpha * instantWpm);
}

/**
 * Format minutes remaining into human-readable text.
 * e.g. "< 1 min left", "14 min left", "1 hr left", "2 hr 15 min left"
 */
export function formatTimeRemaining(minutes: number, suffix: string = "left"): string {
    if (!Number.isFinite(minutes) || minutes < 1) {
        return `< 1 min ${suffix}`;
    }
    const totalRoundedMins = Math.round(minutes);
    if (totalRoundedMins < 60) {
        return `${totalRoundedMins} min ${suffix}`;
    }
    const hours = Math.floor(totalRoundedMins / 60);
    const remainingMins = totalRoundedMins % 60;
    if (remainingMins === 0) {
        return `${hours} hr ${suffix}`;
    }
    return `${hours} hr ${remainingMins} min ${suffix}`;
}

/**
 * Estimate total reading time remaining for the entire book in minutes.
 */
export function calculateTimeRemaining(
    currentProgress: number,
    totalPages: number,
    wpm: number = AVERAGE_WPM
): number {
    if (totalPages <= 0 || !Number.isFinite(currentProgress) || currentProgress >= 1) {
        return 0;
    }

    const clampedProgress = Math.max(0, Math.min(1, currentProgress));
    const pagesRemaining = Math.ceil(totalPages * (1 - clampedProgress));
    const wordsRemaining = pagesRemaining * WORDS_PER_PAGE;
    const safeWpm = Math.max(MIN_WPM, wpm);

    return wordsRemaining / safeWpm;
}

/**
 * Estimate reading time remaining in the current chapter/section in minutes.
 * Returns null if chapter information is unavailable or if current chapter is the final section.
 */
export function calculateChapterTimeRemaining(
    currentProgress: number,
    normalizedSectionFractions: number[],
    totalPages: number,
    wpm: number = AVERAGE_WPM
): number | null {
    if (totalPages <= 0 || normalizedSectionFractions.length <= 1 || !Number.isFinite(currentProgress) || currentProgress >= 1) {
        return null;
    }

    const clampedProgress = Math.max(0, Math.min(1, currentProgress));

    // Find the active section index
    let currentIdx = -1;
    for (let i = normalizedSectionFractions.length - 1; i >= 0; i--) {
        if (normalizedSectionFractions[i] <= clampedProgress + 1e-4) {
            currentIdx = i;
            break;
        }
    }

    if (currentIdx === -1) {
        currentIdx = 0;
    }

    // Next section start or 1.0 (book end)
    const nextSectionStart = currentIdx + 1 < normalizedSectionFractions.length
        ? normalizedSectionFractions[currentIdx + 1]
        : 1.0;

    // If this is the final chapter, chapter remaining time is redundant with whole-book remaining time
    if (nextSectionStart >= 1.0 - 1e-4) {
        return null;
    }

    const fractionRemainingInChapter = Math.max(0, nextSectionStart - clampedProgress);
    if (fractionRemainingInChapter <= 0) {
        return 0;
    }

    const chapterPagesRemaining = fractionRemainingInChapter * totalPages;
    const wordsRemaining = chapterPagesRemaining * WORDS_PER_PAGE;
    const safeWpm = Math.max(MIN_WPM, wpm);

    return wordsRemaining / safeWpm;
}

/**
 * Formats adaptive reading time strings for chapter and total book.
 */
export function formatAdaptiveReadingTime(options: {
    chapterMinutes: number | null;
    bookMinutes: number | null;
}): {
    chapterText: string | null;
    bookText: string | null;
    combined: string | null;
} {
    const { chapterMinutes, bookMinutes } = options;
    const chapterText = chapterMinutes !== null ? formatTimeRemaining(chapterMinutes, "in chapter") : null;
    const bookText = bookMinutes !== null ? formatTimeRemaining(bookMinutes, "left") : null;

    let combined: string | null = null;
    if (chapterText && bookText) {
        combined = `${chapterText} · ${bookText}`;
    } else if (bookText) {
        combined = bookText;
    } else if (chapterText) {
        combined = chapterText;
    }

    return { chapterText, bookText, combined };
}
