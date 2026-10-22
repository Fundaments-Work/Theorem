/** The Workbench subtitle uses the words of its tabs, not "annotations" and "terms". */
import { describe, it, expect } from "vitest";
import { workbenchSummary } from "../src/features/library/Annotations";

const marks = [
    { type: "highlight", bookId: "a" },
    { type: "highlight", bookId: "a" },
    { type: "note", bookId: "b" },
];

describe("workbenchSummary", () => {
    it("All: highlights, notes, books and words", () => {
        expect(workbenchSummary("all", marks, 6)).toBe("2 highlights, 1 note from 2 books · 6 words");
    });
    it("one tab at a time", () => {
        expect(workbenchSummary("highlights", marks, 0)).toBe("2 highlights from 2 books");
        expect(workbenchSummary("notes", marks.slice(2), 0)).toBe("1 note from 1 book");
        expect(workbenchSummary("vocabulary", [], 1)).toBe("1 word");
    });
    it("never says annotations or terms", () => {
        for (const f of ["all", "highlights", "notes", "vocabulary"]) {
            expect(workbenchSummary(f, marks, 2)).not.toMatch(/annotation|term/);
        }
    });
    it("handles nothing yet", () => {
        expect(workbenchSummary("all", [], 0)).toBe("0 highlights, 0 notes · 0 words");
    });
});
