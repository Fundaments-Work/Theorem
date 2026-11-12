// @vitest-environment node
// End-to-end check against a minimal synthetic PDF carrying an archival record id
// as `/Title` ("0132180146.pdf") alongside `/Creator` ("Adobe InDesign CS3 (5.0.4)").
import { describe, expect, it } from "vitest";
import { resolvePdfDisplayTitle } from "../src/features/reader/engines/pdf-display-title";
import { shouldUseExtractedTitle } from "../src/core/lib/cover-extractor";

const LIBRARY_TITLE =
    "CUDA by Example An Introduction to General-Purpose GPU Programming (Jason Sanders,Edward Kandrot)";
const SOURCE_FILENAME = `${LIBRARY_TITLE} (Z-Library).pdf`;
const FILE_PATH = `/books/CUDA/${SOURCE_FILENAME}`;

function buildSyntheticPdfWithArchivalTitle(): Uint8Array {
    const objects = [
        "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
        "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
        "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>\nendobj\n",
        "4 0 obj\n<< /Title (0132180146.pdf) /Creator (Adobe InDesign CS3 (5.0.4)) >>\nendobj\n",
    ];
    let body = "%PDF-1.4\n";
    const offsets = [0];
    for (const obj of objects) {
        offsets.push(body.length);
        body += obj;
    }
    const xrefOffset = body.length;
    body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (let i = 1; i <= objects.length; i++) {
        body += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
    }
    body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 4 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
    return new TextEncoder().encode(body);
}

describe("PDF with archival record-id metadata", () => {
    it("shows the library name, not the archival record id", async () => {
        const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
        const task = pdfjs.getDocument({
            data: buildSyntheticPdfWithArchivalTitle(),
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