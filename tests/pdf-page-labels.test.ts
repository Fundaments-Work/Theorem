// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
    formatPageIndicator,
    normalizePageLabels,
    pageLabelAt,
    pageNumberForLabel,
    parsePdfDate,
} from "../src/features/reader/engines/pdf-page-labels";

describe("page labels on a real PDF (tests/fixtures/pdf/page-labels.pdf)", () => {
    it("reads roman, arabic and prefixed labels and the PDF creation date", async () => {
        const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
        const data = new Uint8Array(readFileSync(join(process.cwd(), "tests/fixtures/pdf/page-labels.pdf")));
        const task = pdfjs.getDocument({ data, verbosity: 0 });
        try {
            const doc = await task.promise;
            const labels = normalizePageLabels(await doc.getPageLabels(), doc.numPages);
            expect(labels).toEqual(["i", "ii", "1", "2", "3", "A-1", "A-2"]);

            expect(formatPageIndicator(labels, 1)).toBe("i (1)");
            expect(formatPageIndicator(labels, 6)).toBe("A-1 (6)");
            expect(pageNumberForLabel(labels, " II ")).toBe(2);
            expect(pageNumberForLabel(labels, "a-2")).toBe(7);

            const { info } = await doc.getMetadata() as { info: Record<string, unknown> };
            expect(parsePdfDate(info.CreationDate)?.toISOString()).toBe("2026-01-02T02:04:05.000Z");
        } finally {
            await task.destroy();
        }
    });
});

describe("normalizePageLabels", () => {
    it("drops missing, empty, mismatched and identity label sets", () => {
        expect(normalizePageLabels(null, 3)).toBeNull();
        expect(normalizePageLabels([], 0)).toBeNull();
        expect(normalizePageLabels(["i", "ii"], 3)).toBeNull();
        expect(normalizePageLabels(["1", "2", "3"], 3)).toBeNull();
        expect(normalizePageLabels(["1", "", "3"], 3)).toBeNull();
        expect(normalizePageLabels([" i ", 7, "3"], 3)).toEqual(["i", "", "3"]);
    });
});

describe("label lookups", () => {
    const labels = ["i", "ii", "1", "2", "1", "A-1"];

    it("returns no label for identity, unlabelled or out-of-range pages", () => {
        expect(pageLabelAt(labels, 1)).toBe("i");
        expect(pageLabelAt(labels, 3)).toBe("1");
        expect(pageLabelAt(["i", "2"], 2)).toBeNull();
        expect(pageLabelAt(["", "x"], 1)).toBeNull();
        expect(pageLabelAt(labels, 0)).toBeNull();
        expect(pageLabelAt(labels, 7)).toBeNull();
        expect(pageLabelAt(labels, 1.5)).toBeNull();
        expect(pageLabelAt(null, 1)).toBeNull();
        expect(formatPageIndicator(null, 4)).toBe("4");
    });

    it("resolves the first match, case-insensitively, and rejects blanks", () => {
        expect(pageNumberForLabel(labels, "1")).toBe(3);
        expect(pageNumberForLabel(labels, "A-1")).toBe(6);
        expect(pageNumberForLabel(labels, "iii")).toBeNull();
        expect(pageNumberForLabel(labels, "   ")).toBeNull();
        expect(pageNumberForLabel(null, "i")).toBeNull();
    });
});

describe("parsePdfDate", () => {
    it("parses PDF date strings and rejects everything else", () => {
        expect(parsePdfDate("D:20260923101500Z")?.toISOString()).toBe("2026-09-23T10:15:00.000Z");
        expect(parsePdfDate("D:2026")?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
        expect(parsePdfDate("not a date")).toBeUndefined();
        expect(parsePdfDate("")).toBeUndefined();
        expect(parsePdfDate(undefined)).toBeUndefined();
        expect(parsePdfDate(20260101)).toBeUndefined();
    });
});
