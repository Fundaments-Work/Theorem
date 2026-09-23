// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
    buildPdfSearchPattern,
    findPdfTextMatches,
    normalizeSearchText,
    pdfSearchExcerpt,
    pdfSearchLocation,
} from "../src/features/reader/engines/pdf-search";

const find = (text: string, query: string, options = {}) =>
    findPdfTextMatches(normalizeSearchText(text), buildPdfSearchPattern(query, options)).map((m) => m.index);

describe("findPdfTextMatches", () => {
    it("reports every occurrence, not just the first", () => {
        expect(find("the cat and the hat and the bat", "the")).toEqual([0, 12, 24]);
    });

    it("matches literally, never as a scattered subsequence", () => {
        // "tea" is a subsequence of "the cat" but not a substring.
        expect(find("the cat sat", "tea")).toEqual([]);
        expect(find("character", "crt")).toEqual([]);
    });

    it("is case-insensitive by default and exact with matchCase", () => {
        expect(find("Word word WORD", "word")).toEqual([0, 5, 10]);
        expect(find("Word word WORD", "word", { matchCase: true })).toEqual([5]);
    });

    it("keeps offsets right for characters whose lowercase is longer", () => {
        // "İ".toLowerCase() is two code units; lowercasing the page would shift
        // every later offset by one. The regex path must not.
        const text = "İİİ then istanbul";
        const matches = findPdfTextMatches(text, buildPdfSearchPattern("istanbul"));
        expect(matches).toEqual([{ index: 9, length: 8 }]);
        expect(text.slice(9, 17)).toBe("istanbul");
    });

    it("whole-word respects Unicode letters", () => {
        expect(find("cat category concat cat.", "cat", { wholeWord: true })).toEqual([0, 20]);
        expect(find("café cafés", "café", { wholeWord: true })).toEqual([0]);
        expect(find("naïve", "na", { wholeWord: true })).toEqual([]);
    });

    it("treats regex characters literally and spans line breaks", () => {
        expect(find("cost is $5 (approx.) or $5.00", "$5 (approx.)")).toEqual([8]);
        expect(find("a.b axb", "a.b")).toEqual([0]);
        expect(find("end of\n   line", "of line")).toEqual([4]);
    });

    it("handles empty input and limits", () => {
        expect(find("", "x")).toEqual([]);
        expect(find("text", "   ")).toEqual([]);
        expect(findPdfTextMatches("aaaa", buildPdfSearchPattern("a"), 2)).toHaveLength(2);
        expect(buildPdfSearchPattern("")).toBeNull();
    });

    it("builds excerpts around the actual match and distinct locations", () => {
        const text = normalizeSearchText("x ".repeat(100) + "needle" + " y".repeat(100));
        const [match] = findPdfTextMatches(text, buildPdfSearchPattern("needle"));
        const excerpt = pdfSearchExcerpt(text, match, 10);
        expect(excerpt).toMatch(/^….{10}needle.{10}…$/);
        expect(pdfSearchExcerpt("needle", { index: 0, length: 6 })).toBe("needle");
        expect(pdfSearchLocation(3, 0)).toBe("pdf:page:3");
        expect(pdfSearchLocation(3, 2)).toBe("pdf:page:3#m2");
        expect(pdfSearchLocation(3, 2).match(/pdf:page:(\d+)/)?.[1]).toBe("3");
    });
});

describe("search on a real PDF's pdf.js text", () => {
    it("finds each occurrence on the right page", async () => {
        const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
        const data = new Uint8Array(readFileSync(join(process.cwd(), "tests/fixtures/pdf/page-labels.pdf")));
        const task = pdfjs.getDocument({ data, verbosity: 0 });
        try {
            const doc = await task.promise;
            const pattern = buildPdfSearchPattern("one");
            const hits: string[] = [];
            for (let page = 1; page <= doc.numPages; page++) {
                const content = await (await doc.getPage(page)).getTextContent();
                const text = normalizeSearchText(content.items.map((item) => ("str" in item ? item.str : "")).join(" "));
                findPdfTextMatches(text, pattern).forEach((_, ordinal) => hits.push(pdfSearchLocation(page, ordinal)));
            }
            // "Front matter one." (p1), "Body one." (p3), "Appendix one." (p6).
            expect(hits).toEqual(["pdf:page:1", "pdf:page:3", "pdf:page:6"]);
        } finally {
            await task.destroy();
        }
    });
});
