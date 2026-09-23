/**
 * In-document text search for the PDF view: literal matches only.
 *
 * The text comes from pdf.js (`getTextContent`), which decodes fonts, so it is
 * what the reader sees. There is deliberately no "fuzzy" fallback: a page of
 * prose contains almost any short letter sequence as a scattered subsequence,
 * so such results looked random. Every occurrence is reported, not just the
 * first one on each page.
 */

export interface PdfSearchOptions {
    matchCase?: boolean;
    wholeWord?: boolean;
    /** Stop after this many matches on the page. */
    limit?: number;
}

export interface PdfTextMatch {
    index: number;
    length: number;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Collapse whitespace so line breaks and double spaces match a single space. */
export function normalizeSearchText(text: string): string {
    return text.replace(/\s+/g, " ").trim();
}

/**
 * Regex for a query, or `null` for an empty one. Case-insensitive matching
 * uses the regex `i` flag (not `toLowerCase()` on both sides, whose lengths
 * differ for characters like "İ" and would shift match offsets). Whole-word
 * uses Unicode letter/number boundaries, so "café" and "naïve" work.
 */
export function buildPdfSearchPattern(query: string, options: PdfSearchOptions = {}): RegExp | null {
    const normalized = normalizeSearchText(query);
    if (!normalized) return null;
    const body = escapeRegExp(normalized).replace(/ /g, "\\s+");
    const source = options.wholeWord ? `(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])` : body;
    return new RegExp(source, options.matchCase ? "gu" : "giu");
}

/** All matches of `pattern` in `text` (already normalised), in order. */
export function findPdfTextMatches(text: string, pattern: RegExp | null, limit = Number.POSITIVE_INFINITY): PdfTextMatch[] {
    if (!pattern || !text) return [];
    const matches: PdfTextMatch[] = [];
    pattern.lastIndex = 0;
    for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
        if (match[0].length === 0) {
            pattern.lastIndex += 1;
            continue;
        }
        matches.push({ index: match.index, length: match[0].length });
        if (matches.length >= limit) break;
    }
    return matches;
}

/** `…context match context…` around one match of normalised `text`. */
export function pdfSearchExcerpt(text: string, match: PdfTextMatch, context = 80): string {
    const start = Math.max(0, match.index - context);
    const end = Math.min(text.length, match.index + match.length + context);
    return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

/** Result location: the page plus the match's ordinal on it (keeps results distinct). */
export function pdfSearchLocation(pageNumber: number, matchOrdinal: number): string {
    return matchOrdinal === 0 ? `pdf:page:${pageNumber}` : `pdf:page:${pageNumber}#m${matchOrdinal}`;
}
