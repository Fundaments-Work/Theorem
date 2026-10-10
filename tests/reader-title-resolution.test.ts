import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
    hasBookExtension,
    isPlaceholderMetadataTitle,
    shouldUseExtractedAuthor,
    shouldUseExtractedTitle,
} from "../src/core/lib/cover-extractor";
import {
    pdfFileNameStem,
    resolvePdfDisplayTitle,
} from "../src/features/reader/engines/pdf-display-title";

// ─── The reported book, reproduced from its real PDF metadata ───
//
// `book-cache/02009b16-….book`, read with pdf.js:
//     Title   : "0132180146.pdf"
//     Creator : "Adobe InDesign CS3 (5.0.4)"
//     Producer: "PDFKit.NET 2.0.28.0"
// while the file on disk is the long CUDA title. `0132180146` is the document
// management system's record id, not a title — it must never reach the header
// or the library row.

const REAL_PDF_TITLE = "0132180146.pdf";
const REAL_SOURCE_FILENAME =
    "CUDA by Example An Introduction to General-Purpose GPU Programming (Jason Sanders,Edward Kandrot) (Z-Library).pdf";
const REAL_LIBRARY_TITLE =
    "CUDA by Example An Introduction to General-Purpose GPU Programming (Jason Sanders,Edward Kandrot)";
const REAL_FILE_PATH = `/run/media/sapiens/BackUP/Books/SoftwareDevelopment/CUDA/${REAL_SOURCE_FILENAME}`;

describe("reported book: an archival record id in the PDF Title", () => {
    it("shows the library name in the reader", () => {
        expect(resolvePdfDisplayTitle({
            pdfTitle: REAL_PDF_TITLE,
            filename: REAL_LIBRARY_TITLE,
            sourceFilename: REAL_SOURCE_FILENAME,
            libraryTitle: REAL_LIBRARY_TITLE,
        })).toBe(REAL_LIBRARY_TITLE);
    });

    it("shows the library name even after the extension is stripped", () => {
        // `extractMetadata` strips `.pdf` before the value is compared, so the
        // bare record number has to be rejected on its own merits too.
        expect(resolvePdfDisplayTitle({
            pdfTitle: "0132180146",
            filename: REAL_LIBRARY_TITLE,
            sourceFilename: REAL_SOURCE_FILENAME,
            libraryTitle: REAL_LIBRARY_TITLE,
        })).toBe(REAL_LIBRARY_TITLE);
    });

    it("never renames the library row to the record id", () => {
        expect(shouldUseExtractedTitle(
            REAL_LIBRARY_TITLE,
            REAL_PDF_TITLE,
            REAL_FILE_PATH,
        )).toBe(false);
        expect(shouldUseExtractedTitle(
            REAL_LIBRARY_TITLE,
            "0132180146",
            REAL_FILE_PATH,
        )).toBe(false);
    });

    it("flags the record id as a placeholder and a file name as a file name", () => {
        expect(isPlaceholderMetadataTitle("0132180146")).toBe(true);
        expect(isPlaceholderMetadataTitle(REAL_PDF_TITLE)).toBe(true);
        expect(hasBookExtension(REAL_PDF_TITLE)).toBe(true);
        expect(hasBookExtension(REAL_LIBRARY_TITLE)).toBe(false);
    });
});

describe("hasBookExtension", () => {
    it("detects book extensions case-insensitively", () => {
        expect(hasBookExtension("0132180146.pdf")).toBe(true);
        expect(hasBookExtension("0132180146.PDF")).toBe(true);
        expect(hasBookExtension("scan.epub")).toBe(true);
        expect(hasBookExtension("vol1.cbz")).toBe(true);
        expect(hasBookExtension("handbook.mobi")).toBe(true);
    });

    it("does not fire on ordinary titles", () => {
        expect(hasBookExtension("Dune")).toBe(false);
        expect(hasBookExtension("The Documentary")).toBe(false);
        // A dotted title that is not a book extension stays a title.
        expect(hasBookExtension("Dr. Strangelove")).toBe(false);
        expect(hasBookExtension("")).toBe(false);
        expect(hasBookExtension(undefined)).toBe(false);
    });
});

describe("identifier-like titles", () => {
    it("flags long bare numbers", () => {
        expect(isPlaceholderMetadataTitle("0132180146")).toBe(true);
        expect(isPlaceholderMetadataTitle("00012345")).toBe(true);
        expect(isPlaceholderMetadataTitle("2024-001234")).toBe(true);
    });

    it("keeps real numeric titles that are short", () => {
        // Orwell, Kubrick, Le Guin — these are books, not record ids.
        expect(isPlaceholderMetadataTitle("1984")).toBe(false);
        expect(isPlaceholderMetadataTitle("2001")).toBe(false);
        expect(isPlaceholderMetadataTitle("451")).toBe(false);
    });

    it("keeps titles that merely start with digits", () => {
        expect(isPlaceholderMetadataTitle("1984 and the novella")).toBe(false);
        expect(isPlaceholderMetadataTitle("2001: A Space Odyssey")).toBe(false);
    });
});

describe("isPlaceholderMetadataTitle", () => {
    it("flags a bare book id (UUID) leaking in from a materialized cache path", () => {
        expect(isPlaceholderMetadataTitle("3f1c9a52-6b1e-4a77-9d0b-8e2c5a1f4b30")).toBe(true);
        expect(isPlaceholderMetadataTitle("3F1C9A52-6B1E-4A77-9D0B-8E2C5A1F4B30")).toBe(true);
        expect(isPlaceholderMetadataTitle("  3f1c9a52-6b1e-4a77-9d0b-8e2c5a1f4b30  ")).toBe(true);
    });

    it("flags the synthetic document.<ext> name given to blob-loaded books", () => {
        expect(isPlaceholderMetadataTitle("document.cbz")).toBe(true);
        expect(isPlaceholderMetadataTitle("document.epub")).toBe(true);
        expect(isPlaceholderMetadataTitle("DOCUMENT.CBZ")).toBe(true);
    });

    it("flags the PDF engine's bare fallback name but not a real 'Document' title", () => {
        expect(isPlaceholderMetadataTitle("document")).toBe(true);
        expect(isPlaceholderMetadataTitle("Document")).toBe(false);
    });

    it("flags the generic unknown/untitled family", () => {
        expect(isPlaceholderMetadataTitle("Unknown Title")).toBe(true);
        expect(isPlaceholderMetadataTitle("untitled")).toBe(true);
        expect(isPlaceholderMetadataTitle("Untitled Book")).toBe(true);
    });

    it("flags empty, whitespace-only and missing titles", () => {
        expect(isPlaceholderMetadataTitle("")).toBe(true);
        expect(isPlaceholderMetadataTitle("   ")).toBe(true);
        expect(isPlaceholderMetadataTitle(null)).toBe(true);
        expect(isPlaceholderMetadataTitle(undefined)).toBe(true);
    });

    it("keeps real titles, including ones that merely look id-ish", () => {
        expect(isPlaceholderMetadataTitle("Dune")).toBe(false);
        expect(isPlaceholderMetadataTitle("Neuromancer")).toBe(false);
        // A real title that happens to contain a UUID must survive.
        expect(isPlaceholderMetadataTitle("Notes on 3f1c9a52-6b1e-4a77-9d0b-8e2c5a1f4b30")).toBe(false);
        // Not a well-formed UUID — a legitimate (if odd) title.
        expect(isPlaceholderMetadataTitle("3f1c9a52-6b1e-4a77")).toBe(false);
        // A title carrying a book extension is a file name — comic archives
        // take their title straight off the archive name ("Sandman Vol 1.cbz").
        expect(isPlaceholderMetadataTitle("Sandman Vol 1.cbz")).toBe(true);
        // `.md` is not a book extension, so this stays a title.
        expect(isPlaceholderMetadataTitle("Document.md")).toBe(false);
        expect(isPlaceholderMetadataTitle("The Documentary")).toBe(false);
    });

    it("lets the library title win for a comic archive title read off the file name", () => {
        expect(resolvePdfDisplayTitle({
            pdfTitle: "Sandman Vol 1.cbz",
            filename: "Sandman Volume One",
            sourceFilename: "Sandman Vol 1.cbz",
            libraryTitle: "Sandman Volume One",
        })).toBe("Sandman Volume One");
    });
});

describe("resolvePdfDisplayTitle", () => {
    const LIBRARY_TITLE = "Annual Report 2019";

    it("prefers the library title when the PDF Title is just the file name", () => {
        expect(resolvePdfDisplayTitle({
            pdfTitle: "0132180146",
            filename: LIBRARY_TITLE,
            sourceFilename: "0132180146",
            libraryTitle: LIBRARY_TITLE,
        })).toBe(LIBRARY_TITLE);
    });

    it("matches the echoed file name case-insensitively and with the extension", () => {
        expect(resolvePdfDisplayTitle({
            pdfTitle: "SCAN_2019.PDF",
            filename: LIBRARY_TITLE,
            sourceFilename: "scan_2019.pdf",
            libraryTitle: LIBRARY_TITLE,
        })).toBe(LIBRARY_TITLE);
    });

    it("still honours genuine PDF metadata over the library title", () => {
        expect(resolvePdfDisplayTitle({
            pdfTitle: "Dune",
            filename: LIBRARY_TITLE,
            sourceFilename: "0132180146",
            libraryTitle: LIBRARY_TITLE,
        })).toBe("Dune");
    });

    it("keeps the library title when the PDF has no Title at all", () => {
        expect(resolvePdfDisplayTitle({
            filename: LIBRARY_TITLE,
            sourceFilename: "0132180146",
            libraryTitle: LIBRARY_TITLE,
        })).toBe(LIBRARY_TITLE);
    });

    it("does not treat a placeholder as metadata", () => {
        expect(resolvePdfDisplayTitle({
            pdfTitle: "document",
            filename: LIBRARY_TITLE,
            sourceFilename: "whatever",
            libraryTitle: LIBRARY_TITLE,
        })).toBe(LIBRARY_TITLE);

        expect(resolvePdfDisplayTitle({
            pdfTitle: "3f1c9a52-6b1e-4a77-9d0b-8e2c5a1f4b30",
            filename: LIBRARY_TITLE,
            sourceFilename: "whatever",
            libraryTitle: LIBRARY_TITLE,
        })).toBe(LIBRARY_TITLE);
    });

    it("falls back through to the PDF title, then Untitled", () => {
        // No library row: the file-name echo is better than nothing.
        expect(resolvePdfDisplayTitle({
            pdfTitle: "0132180146",
            filename: "0132180146",
            sourceFilename: "0132180146",
        })).toBe("0132180146");

        // Still better than leaking a file extension into the header.
        expect(resolvePdfDisplayTitle({ pdfTitle: "0132180146.pdf" })).toBe("0132180146");

        expect(resolvePdfDisplayTitle({})).toBe("Untitled");
        expect(resolvePdfDisplayTitle({ pdfTitle: "   " })).toBe("Untitled");
    });

    it("does not treat a title that merely contains the stem as an echo", () => {
        expect(resolvePdfDisplayTitle({
            pdfTitle: "0132180146 Annual Report",
            filename: LIBRARY_TITLE,
            sourceFilename: "0132180146",
            libraryTitle: LIBRARY_TITLE,
        })).toBe("0132180146 Annual Report");
    });
});

// ─── Header flickers: real name, then the file-name id ───
//
// Background cover extraction ran `shouldUseExtractedTitle` against the PDF
// `Title`, adopted it, and permanently renamed the library row. The
// `storeTitle` subscription then pushed that value straight back into the
// reader header, so the correct name was only visible for a moment.

describe("shouldUseExtractedTitle rejects a file-name echo", () => {
    it("does not rename the book to the file name", () => {
        expect(shouldUseExtractedTitle(
            "Annual Report 2019",
            "0132180146",
            "/home/user/books/0132180146.pdf",
        )).toBe(false);
    });

    it("matches the echo case-insensitively and via Windows paths", () => {
        expect(shouldUseExtractedTitle(
            "Annual Report 2019",
            "0132180146",
            "C:\\books\\0132180146.pdf",
        )).toBe(false);
        expect(shouldUseExtractedTitle(
            "Annual Report 2019",
            "annual report 2019",
            "/books/Annual Report 2019.pdf",
        )).toBe(false);
    });

    it("still upgrades a library title that was only a file name", () => {
        // Library holds the file name, PDF carries a real title: adopt it.
        expect(shouldUseExtractedTitle(
            "0132180146",
            "Annual Report 2019",
            "/books/0132180146.pdf",
        )).toBe(true);
    });

    it("still upgrades other placeholder-ish library titles", () => {
        expect(shouldUseExtractedTitle("Unknown", "Dune", "/books/scan.pdf")).toBe(true);
        expect(shouldUseExtractedTitle("scan.v2.pdf", "Dune", "/books/scan.v2.pdf")).toBe(true);
    });

    it("still upgrades from an empty library title", () => {
        expect(shouldUseExtractedTitle("", "Dune", "/books/scan.pdf")).toBe(true);
    });

    it("leaves the author alone for a file-name echo", () => {
        expect(shouldUseExtractedAuthor("Jane Roe", "jroe")).toBe(true);
        expect(shouldUseExtractedAuthor("Jane Roe", "")).toBe(false);
    });
});

describe("pdfFileNameStem", () => {
    it("strips directories and the extension", () => {
        expect(pdfFileNameStem("0132180146.pdf")).toBe("0132180146");
        expect(pdfFileNameStem("/home/user/books/0132180146.pdf")).toBe("0132180146");
        expect(pdfFileNameStem("C:\\books\\0132180146.pdf")).toBe("0132180146");
        expect(pdfFileNameStem("0132180146.PDF")).toBe("0132180146");
    });

    it("handles a name with no extension and empty input", () => {
        expect(pdfFileNameStem("0132180146")).toBe("0132180146");
        expect(pdfFileNameStem("")).toBe("");
        expect(pdfFileNameStem(undefined)).toBe("");
        expect(pdfFileNameStem(null)).toBe("");
    });

    it("does not mangle dotfiles or multi-dot names", () => {
        expect(pdfFileNameStem(".gitignore")).toBe("");
        expect(pdfFileNameStem("report.v2.final.pdf")).toBe("report.v2.final");
    });
});

describe("reader title resolution wiring", () => {
    const readerSource = readFileSync(resolve("src/features/reader/Reader.tsx"), "utf-8");

    it("falls back to the library title for placeholder document titles", () => {
        expect(readerSource).toContain("isPlaceholderMetadataTitle(meta.title)");
    });

    it("passes a real archive filename hint to the viewport", () => {
        expect(readerSource).toContain("filenameHint={currentBookSourceFilename}");
    });

    it("routes PDF titles through the shared resolver", () => {
        expect(readerSource).toContain("resolvePdfDisplayTitle(");
    });
});

describe("floating reader sheets are always opaque", () => {
    const indexCss = readFileSync(resolve("src/index.css"), "utf-8");

    // PDF reading deliberately renders without `data-reading-mode`, so a rule
    // scoped to `[data-reading-mode]` left the sheet fully transparent and the
    // dimmed page showed straight through it.
    function sheetRules(): Array<{ selector: string; body: string }> {
        const css = indexCss.replace(/\/\*[\s\S]*?\*\//g, "");
        const rules: Array<{ selector: string; body: string }> = [];
        let depth = 0;
        let blockStart = -1;
        for (let i = 0; i < css.length; i++) {
            const ch = css[i];
            if (ch === "{") {
                if (depth === 0) blockStart = i + 1;
                depth++;
            } else if (ch === "}") {
                depth--;
                if (depth === 0 && blockStart !== -1) {
                    const before = css.slice(0, blockStart - 1);
                    const selector = before.slice(before.lastIndexOf("}") + 1).trim();
                    if (selector.split(",").some(part => part.trim().endsWith(".reader-sheet"))) {
                        rules.push({ selector, body: css.slice(blockStart, i) });
                    }
                    blockStart = -1;
                }
            }
        }
        return rules;
    }

    it("declares a background for .reader-sheet outside the reading-mode scope", () => {
        const unscoped = sheetRules().filter(rule => !rule.selector.includes("[data-reading-mode]"));
        expect(unscoped.length).toBeGreaterThan(0);
        for (const rule of unscoped) {
            expect(rule.body).toMatch(/background-color\s*:/);
        }
    });

    it("still themes the sheet for the reading-mode token set", () => {
        const readingMode = sheetRules().filter(rule => rule.selector.includes("[data-reading-mode]"));
        expect(readingMode.length).toBeGreaterThan(0);
        expect(readingMode.some(rule => rule.body.includes("background-color:"))).toBe(true);
    });
});

describe("PDF engine never derives a display name from the internal cache path", () => {
    const engineSource = readFileSync(resolve("src/features/reader/engines/pdfjs-engine.tsx"), "utf-8");

    it("filters the path-derived fallback through isPlaceholderMetadataTitle", () => {
        expect(engineSource).toContain("isPlaceholderMetadataTitle(pathDerivedName)");
    });

    it("reports the real file-name stem on the document info", () => {
        expect(engineSource).toContain("sourceFilename: sourceFilenameStem");
    });
});

describe("PDF bottom page pill stays readable when space is tight", () => {
    const engineSource = readFileSync(resolve("src/features/reader/engines/pdfjs-engine.tsx"), "utf-8");

    // The pill is a shrink-to-fit flex row with a viewport max-width. Without
    // `shrink-0` on every sibling, flex squashed the arrows, the "/" and the
    // total page count instead of just the label, so the numbers vanished.
    it("locks the navigation arrows, separator and page count against shrinking", () => {
        // The button's own className precedes its title attribute; the icon's
        // `className` follows it, so anchor on the nearest one *before*.
        function classNameBefore(anchor: string): string | undefined {
            const at = engineSource.indexOf(anchor);
            expect(at).toBeGreaterThan(-1);
            const head = engineSource.slice(0, at);
            const matches = [...head.matchAll(/className="([^"]*)"/g)];
            return matches[matches.length - 1]?.[1];
        }

        expect(classNameBefore('title="Previous page"')).toContain("shrink-0");
        expect(classNameBefore('title="Next page"')).toContain("shrink-0");

        expect(engineSource).toContain('className="shrink-0 text-[color:var(--color-text-muted)]">/</span>');
        expect(engineSource).toContain('className="shrink-0 tabular-nums px-0.5">{totalPages}</span>');
        expect(engineSource).toContain('className="mx-0.5 w-px h-3.5 shrink-0 bg-[var(--color-border)]"');
    });

    it("lets only the label truncate, without an arbitrary width cap", () => {
        // `max-w-[45vw]` was far wider than the pill's own max-width, so the
        // label never actually truncated and the row overflowed instead.
        expect(engineSource).toContain(
            'className="min-w-0 shrink truncate font-medium text-[color:var(--color-text-primary)] tabular-nums px-0.5"',
        );
        expect(engineSource).not.toContain("max-w-[45vw]");
    });

    it("keeps the pill itself bounded to the viewport", () => {
        expect(engineSource).toContain("max-w-[calc(100vw-1.5rem)]");
    });
});

describe("source filename is plumbed from the book row to the PDF engine", () => {
    const readerSource = readFileSync(resolve("src/features/reader/Reader.tsx"), "utf-8");
    const pdfReaderSource = readFileSync(resolve("src/features/reader/components/PDFReader.tsx"), "utf-8");

    it("derives it from the book's real file path, not its title", () => {
        expect(readerSource).toContain("const currentBookSourceFilename = useMemo(");
        expect(readerSource).toContain("extractFilenameFromPath(currentBook.filePath)");
    });

    it("passes the library title and the file name as separate values", () => {
        expect(readerSource).toContain("originalFilename={currentBook?.title}");
        expect(readerSource).toContain("sourceFilename={currentBookSourceFilename}");
    });

    it("forwards it through PDFReader", () => {
        expect(pdfReaderSource).toContain("sourceFilename={sourceFilename}");
    });
});