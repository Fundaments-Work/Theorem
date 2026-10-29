// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import {
    selectDailyReviewCards,
    isEligibleReviewAnnotation,
    getDailyReviewStatus,
    markDailyReviewCompleted,
    resetDailyReview,
    hashStringToSeed,
    createPrng,
    DAILY_REVIEW_STORAGE_KEY,
} from "../src/core/lib/daily-review";
import type { Annotation } from "../src/core/types";

function createMockAnnotation(id: string, text: string, daysAgo: number = 5, type: "highlight" | "note" | "bookmark" = "highlight"): Annotation {
    const createdAt = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
    return {
        id,
        bookId: "book-1",
        type,
        location: `loc-${id}`,
        selectedText: text,
        createdAt,
    };
}

describe("daily-review selection and state", () => {
    beforeEach(() => {
        window.localStorage.clear();
    });

    it("filters out bookmarks and empty highlights", () => {
        const bookmark = createMockAnnotation("b1", "", 1, "bookmark");
        const emptyHighlight = createMockAnnotation("h1", "   ", 1, "highlight");
        const shortHighlight = createMockAnnotation("h2", "abc", 1, "highlight");
        const validHighlight = createMockAnnotation("h3", "In the beginning was the Word", 1, "highlight");

        expect(isEligibleReviewAnnotation(bookmark)).toBe(false);
        expect(isEligibleReviewAnnotation(emptyHighlight)).toBe(false);
        expect(isEligibleReviewAnnotation(shortHighlight)).toBe(false);
        expect(isEligibleReviewAnnotation(validHighlight)).toBe(true);
    });

    it("returns empty array when no annotations exist", () => {
        const selected = selectDailyReviewCards([], "2026-10-29");
        expect(selected).toEqual([]);
    });

    it("returns all annotations when total count is less than target", () => {
        const annos = [
            createMockAnnotation("1", "First memorable quote", 2),
            createMockAnnotation("2", "Second insightful observation", 4),
        ];

        const selected = selectDailyReviewCards(annos, "2026-10-29", 5);
        expect(selected.length).toBe(2);
        const ids = selected.map(a => a.id);
        expect(ids).toContain("1");
        expect(ids).toContain("2");
    });

    it("is strictly deterministic for the same date", () => {
        const annos: Annotation[] = [];
        for (let i = 1; i <= 20; i++) {
            annos.push(createMockAnnotation(`ann-${i}`, `Insightful paragraph number ${i} with deep meaning`, i * 3));
        }

        const run1 = selectDailyReviewCards(annos, "2026-10-29", 5);
        const run2 = selectDailyReviewCards(annos, "2026-10-29", 5);

        expect(run1.length).toBe(5);
        expect(run2.length).toBe(5);
        expect(run1.map(a => a.id)).toEqual(run2.map(a => a.id));

        // Different date produces a different valid selection
        const differentDay = selectDailyReviewCards(annos, "2026-10-30", 5);
        expect(differentDay.length).toBe(5);
    });

    it("balances recent and older annotations when both are available", () => {
        const annos: Annotation[] = [
            // 4 recent (< 30 days)
            createMockAnnotation("r1", "Recent note one from book", 2),
            createMockAnnotation("r2", "Recent note two from book", 5),
            createMockAnnotation("r3", "Recent note three from book", 10),
            createMockAnnotation("r4", "Recent note four from book", 15),
            // 4 older (>= 30 days)
            createMockAnnotation("o1", "Older note one from archive", 40),
            createMockAnnotation("o2", "Older note two from archive", 60),
            createMockAnnotation("o3", "Older note three from archive", 90),
            createMockAnnotation("o4", "Older note four from archive", 120),
        ];

        const selected = selectDailyReviewCards(annos, "2026-10-29", 5);
        expect(selected.length).toBe(5);

        const hasRecent = selected.some(a => a.id.startsWith("r"));
        const hasOlder = selected.some(a => a.id.startsWith("o"));

        expect(hasRecent).toBe(true);
        expect(hasOlder).toBe(true);
    });

    it("tracks completion state in localStorage and resets on next day", () => {
        const statusToday = getDailyReviewStatus("2026-10-29");
        expect(statusToday.completed).toBe(false);

        markDailyReviewCompleted("2026-10-29", ["1", "2", "3"]);

        const updatedToday = getDailyReviewStatus("2026-10-29");
        expect(updatedToday.completed).toBe(true);
        expect(updatedToday.reviewedCardIds).toEqual(["1", "2", "3"]);

        // Tomorrow's date query sees uncompleted
        const tomorrow = getDailyReviewStatus("2026-10-30");
        expect(tomorrow.completed).toBe(false);

        // Reset works
        resetDailyReview("2026-10-29");
        const afterReset = getDailyReviewStatus("2026-10-29");
        expect(afterReset.completed).toBe(false);
    });
});
