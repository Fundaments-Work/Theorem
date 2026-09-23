/**
 * Logical page labels (`/PageLabels`: "i", "xii", "A-3") for the PDF view.
 *
 * Numbers typed into "go to page" and stored locations stay physical page
 * numbers (TOC entries, bookmarks and progress use them); labels are shown
 * next to the physical number and accepted when the input is not a plain
 * number, like Firefox's viewer does for non-numeric labels.
 */

import { PDFDateString } from "pdfjs-dist";

/** PDF date (`D:YYYYMMDDHHmmSS+hh'mm'`) → Date; `undefined` when absent/invalid. */
export function parsePdfDate(value: unknown): Date | undefined {
    if (typeof value !== "string" || !value.trim()) return undefined;
    const date = PDFDateString.toDateObject(value);
    return date && Number.isFinite(date.getTime()) ? date : undefined;
}

/**
 * Normalise `getPageLabels()` output: `null` when there are no labels, the
 * count does not match the document, or every label is just its page number.
 */
export function normalizePageLabels(raw: unknown, totalPages: number): string[] | null {
    if (!Array.isArray(raw) || raw.length === 0 || raw.length !== totalPages) return null;
    const labels = raw.map((label) => (typeof label === "string" ? label.trim() : ""));
    return labels.every((label, index) => label === "" || label === String(index + 1)) ? null : labels;
}

/** Label for a 1-based page, or `null` when it adds nothing to the number. */
export function pageLabelAt(labels: ReadonlyArray<string> | null, pageNumber: number): string | null {
    if (!labels || !Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > labels.length) return null;
    const label = labels[pageNumber - 1];
    return label && label !== String(pageNumber) ? label : null;
}

/** 1-based page for a typed label (case-insensitive, first match), else `null`. */
export function pageNumberForLabel(labels: ReadonlyArray<string> | null, input: string): number | null {
    const wanted = input.trim().toLowerCase();
    if (!labels || !wanted) return null;
    const index = labels.findIndex((label) => label.toLowerCase() === wanted);
    return index >= 0 ? index + 1 : null;
}

/** Page indicator text: `xii (12)` when labelled, else the number. */
export function formatPageIndicator(labels: ReadonlyArray<string> | null, pageNumber: number): string {
    const label = pageLabelAt(labels, pageNumber);
    return label ? `${label} (${pageNumber})` : String(pageNumber);
}
