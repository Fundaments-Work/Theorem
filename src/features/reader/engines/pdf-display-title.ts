import { hasBookExtension, isPlaceholderMetadataTitle } from "../../../core/lib/cover-extractor";

export interface PdfDisplayTitleInput {
    /** `Title` from the PDF's own metadata, if any. */
    pdfTitle?: string;
    /** `info.filename` — carries the library *title*, not a file name. */
    filename?: string;
    /** Real on-disk file-name stem, e.g. `0132180146` for `0132180146.pdf`. */
    sourceFilename?: string;
    /** Title of the book row in the library. */
    libraryTitle?: string;
}

/** Strips a trailing book extension: `0132180146.pdf` -> `0132180146`. */
export function pdfFileNameStem(fileName: string | undefined | null): string {
    return (fileName ?? "")
        .split(/[/\\]/)
        .pop()!
        .replace(/\.[^/.]+$/, "")
        .trim();
}

/**
 * Decides which title the reader header (and Book Info) shows for a PDF.
 *
 * Priority: real PDF metadata, then the library book name, then whatever the
 * loader came up with, then `Untitled`.
 *
 * Three things must not be mistaken for genuine PDF metadata:
 *
 *  1. `info.filename` is the library **title**, not a file name, so it can never
 *     answer "is this Title just a file name again?".
 *  2. `Title: 0132180146.pdf` — a real file name, extension and all. Exports
 *     from document-management systems (`Adobe InDesign CS3` + `PDFKit.NET`)
 *     routinely carry one.
 *  3. A bare record number such as `0132180146` — an inventory id, not a name.
 */
export function resolvePdfDisplayTitle({
    pdfTitle,
    filename,
    sourceFilename,
    libraryTitle,
}: PdfDisplayTitleInput): string {
    const title = (pdfTitle ?? '').trim();
    const stem = pdfFileNameStem(sourceFilename);

    // A title that keeps its extension is a file name; drop it before comparing
    // so `0132180146.pdf` also matches a file called `0132180146.pdf`.
    const bareTitle = title && hasBookExtension(title) ? pdfFileNameStem(title) : title;

    const titleEchoesFileName = !!bareTitle
        && !!stem
        && bareTitle.toLowerCase() === stem.toLowerCase();
    const matchesLibraryTitle = !!title
        && !!filename
        && title === filename;

    const isRealPdfMetadata = !!title
        && !matchesLibraryTitle
        && !hasBookExtension(title)
        && !titleEchoesFileName
        && !isPlaceholderMetadataTitle(title);

    if (isRealPdfMetadata) {
        return title;
    }
    return libraryTitle || bareTitle || title || 'Untitled';
}