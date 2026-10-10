// @vitest-environment node
// End-to-end check against the real book from the bug report:
// book-cache/02009b16-5826-4f98-a414-a483c27045df.book
//   Title: "0132180146.pdf"  Creator: "Adobe InDesign CS3 (5.0.4)"
// The library title is the long CUDA title; the file on disk is that title too.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolvePdfDisplayTitle } from "../src/features/reader/engines/pdf-display-title";
import { shouldUseExtractedTitle } from "../src/core/lib/cover-extractor";

const BOOK_CACHE = join(
    process.env.HOME ?? "",
    ".local/share/work.fundamentals.theorem/book-cache",
);
const BOOK_FILE = join(BOOK_CACHE, "02009b16-5826-4f98-a414-a483c27045df.book");

const LIBRARY_TITLE =
    "CUDA by Example An Introduction to General-Purpose GPU Programming (Jason Sanders,Edward Kandrot)";
const SOURCE_FILENAME = `${LIBRARY_TITLE} (Z-Library).pdf`;
const FILE_PATH = `/run/media/sapiens/BackUP/Books/SoftwareDevelopment/CUDA/${SOURCE_FILENAME}`;

// Not every machine has the book; the pure-logic suite covers the same cases.
describe.skipIf(!existsSync(BOOK_FILE))("real PDF from the bug report", () => {
    it("shows the library name, not the archival record id", async () => {
        const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
        const task = pdfjs.getDocument({
            data: new Uint8Array(readFileSync(BOOK_FILE)),
            verbosity: 0,
        });
        try {
            const doc = await task.promise;
            const { info } = await doc.getMetadata() as { info: Record<string, unknown> };
            const pdfTitle = String(info.Title ?? "");

            // Sanity: this is the shape that produced the report.
            expect(pdfTitle).toBe("0132180146.pdf");

            expect(resolvePdfDisplayTitle({
                pdfTitle,
                filename: LIBRARY_TITLE,
                sourceFilename: SOURCE_FILENAME,
                libraryTitle: LIBRARY_TITLE,
            })).toBe(LIBRARY_TITLE);

            // And it must not rename the library row, with or without the
            // extension that `extractMetadata` strips.
            expect(shouldUseExtractedTitle(LIBRARY_TITLE, pdfTitle, FILE_PATH)).toBe(false);
            expect(shouldUseExtractedTitle(LIBRARY_TITLE, "0132180146", FILE_PATH)).toBe(false);
        } finally {
            await task.destroy();
        }
    });
});