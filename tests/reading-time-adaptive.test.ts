import { describe, it, expect } from "vitest";
import {
    calculateWpm,
    computeExponentialMovingAverage,
    formatTimeRemaining,
    calculateTimeRemaining,
    calculateChapterTimeRemaining,
    formatAdaptiveReadingTime,
    MIN_WPM,
    MAX_WPM,
} from "../src/features/reader/lib/reading-time";

describe("calculateWpm", () => {
    it("returns null for dwell times less than 5 seconds (rapid flipping)", () => {
        expect(calculateWpm(250, 4.9)).toBeNull();
        expect(calculateWpm(250, 1.0)).toBeNull();
        expect(calculateWpm(250, 0)).toBeNull();
    });

    it("returns null for dwell times greater than 180 seconds (idle/abandoned)", () => {
        expect(calculateWpm(250, 181)).toBeNull();
        expect(calculateWpm(250, 600)).toBeNull();
    });

    it("calculates exact instant WPM for normal reading dwell", () => {
        // 250 words in 60 seconds = 250 WPM
        expect(calculateWpm(250, 60)).toBe(250);
        // 125 words in 30 seconds = 250 WPM
        expect(calculateWpm(125, 30)).toBe(250);
        // 300 words in 60 seconds = 300 WPM
        expect(calculateWpm(300, 60)).toBe(300);
    });

    it("clamps instant WPM to MIN_WPM (80) and MAX_WPM (800)", () => {
        // Very slow: 50 words in 120s = 25 WPM -> clamped to 80
        expect(calculateWpm(50, 120)).toBe(MIN_WPM);
        // Extremely fast: 500 words in 10s = 3000 WPM -> clamped to 800
        expect(calculateWpm(500, 10)).toBe(MAX_WPM);
    });
});

describe("computeExponentialMovingAverage", () => {
    it("returns instant WPM when current average is invalid or zero", () => {
        expect(computeExponentialMovingAverage(0, 250)).toBe(250);
        expect(computeExponentialMovingAverage(-10, 220)).toBe(220);
    });

    it("smooths reading speed using alpha = 0.15", () => {
        // current = 200, instant = 300 -> 0.85 * 200 + 0.15 * 300 = 170 + 45 = 215
        expect(computeExponentialMovingAverage(200, 300, 0.15)).toBe(215);
        // current = 250, instant = 200 -> 0.85 * 250 + 0.15 * 200 = 212.5 + 30 = 242.5 -> 243
        expect(computeExponentialMovingAverage(250, 200, 0.15)).toBe(243);
    });
});

describe("formatTimeRemaining", () => {
    it("formats sub-minute times as < 1 min", () => {
        expect(formatTimeRemaining(0)).toBe("< 1 min left");
        expect(formatTimeRemaining(0.4)).toBe("< 1 min left");
        expect(formatTimeRemaining(0.9)).toBe("< 1 min left");
    });

    it("formats minutes under an hour", () => {
        expect(formatTimeRemaining(1)).toBe("1 min left");
        expect(formatTimeRemaining(24.4)).toBe("24 min left");
        expect(formatTimeRemaining(59)).toBe("59 min left");
    });

    it("formats exact hours", () => {
        expect(formatTimeRemaining(60)).toBe("1 hr left");
        expect(formatTimeRemaining(120)).toBe("2 hr left");
    });

    it("formats hours and minutes without exceeding 59 min", () => {
        expect(formatTimeRemaining(65)).toBe("1 hr 5 min left");
        expect(formatTimeRemaining(150)).toBe("2 hr 30 min left");
        // Boundary case: 59.8 min rounds to 60 -> should be 1 hr left, not 1 hr 60 min left
        expect(formatTimeRemaining(59.8)).toBe("1 hr left");
        expect(formatTimeRemaining(119.8)).toBe("2 hr left");
    });

    it("supports custom suffixes", () => {
        expect(formatTimeRemaining(15, "in chapter")).toBe("15 min in chapter");
        expect(formatTimeRemaining(0.2, "in chapter")).toBe("< 1 min in chapter");
        expect(formatTimeRemaining(90, "in chapter")).toBe("1 hr 30 min in chapter");
    });
});

describe("calculateTimeRemaining", () => {
    it("returns 0 when totalPages <= 0 or progress >= 1", () => {
        expect(calculateTimeRemaining(0.5, 0)).toBe(0);
        expect(calculateTimeRemaining(1.0, 100)).toBe(0);
        expect(calculateTimeRemaining(1.2, 100)).toBe(0);
    });

    it("computes remaining minutes based on pages and WPM", () => {
        // 100 pages, progress = 0.5 -> 50 pages remaining
        // 50 pages * 250 words/page = 12500 words
        // 12500 / 250 WPM = 50 minutes
        expect(calculateTimeRemaining(0.5, 100, 250)).toBe(50);
        // 12500 / 200 WPM = 62.5 minutes
        expect(calculateTimeRemaining(0.5, 100, 200)).toBe(62.5);
    });

    it("respects faster TTS speed (e.g. 300 WPM)", () => {
        expect(calculateTimeRemaining(0.5, 100, 300)).toBeCloseTo(41.67, 1);
    });
});

describe("calculateChapterTimeRemaining", () => {
    const fractions = [0, 0.25, 0.5, 0.75, 1.0];

    it("returns null if totalPages <= 0 or single section", () => {
        expect(calculateChapterTimeRemaining(0.1, [0], 100, 200)).toBeNull();
        expect(calculateChapterTimeRemaining(0.1, fractions, 0, 200)).toBeNull();
    });

    it("calculates time remaining in the current chapter", () => {
        // At progress 0.1, next section is 0.25. Remaining fraction in chapter = 0.15.
        // 0.15 * 200 pages = 30 pages = 7500 words.
        // 7500 / 250 WPM = 30 minutes.
        expect(calculateChapterTimeRemaining(0.1, fractions, 200, 250)).toBe(30);
    });

    it("returns null in the final section to avoid duplicate whole-book time", () => {
        // At progress 0.85, next section is 1.0 (final chapter).
        expect(calculateChapterTimeRemaining(0.85, fractions, 200, 250)).toBeNull();
    });
});

describe("formatAdaptiveReadingTime", () => {
    it("combines chapter and book time when both exist", () => {
        const res = formatAdaptiveReadingTime({ chapterMinutes: 14, bookMinutes: 120 });
        expect(res.chapterText).toBe("14 min in chapter");
        expect(res.bookText).toBe("2 hr left");
        expect(res.combined).toBe("14 min in chapter · 2 hr left");
    });

    it("shows only book time when chapter is null", () => {
        const res = formatAdaptiveReadingTime({ chapterMinutes: null, bookMinutes: 45 });
        expect(res.chapterText).toBeNull();
        expect(res.bookText).toBe("45 min left");
        expect(res.combined).toBe("45 min left");
    });

    it("returns null combined if both are null", () => {
        const res = formatAdaptiveReadingTime({ chapterMinutes: null, bookMinutes: null });
        expect(res.combined).toBeNull();
    });
});
