import type { OpdsEntry } from "../../core/types";

export const CATALOG_SORT_ORDERS = [
    { id: "title", label: "Title A–Z" },
    { id: "author", label: "Author A–Z" },
    { id: "newest", label: "Newest" },
    { id: "oldest", label: "Oldest" },
] as const;

export type CatalogSortOrder = (typeof CATALOG_SORT_ORDERS)[number]["id"];

export interface CatalogFacets {
    languages: string[];
    formats: string[];
}

export interface CatalogFacetSelection {
    sortOrder: CatalogSortOrder;
    language: string | null;
    format: string | null;
}

const FORMAT_LABELS: Record<string, string> = {
    epub: "EPUB",
    pdf: "PDF",
    cbz: "CBZ",
    cbr: "CBR",
    mobi: "MOBI",
    azw3: "AZw3",
};

/**
 * Format for an entry. `downloadFormat` is set when the feed declares it;
 * otherwise fall back to the download URL's extension, since plenty of OPDS
 * servers omit the type.
 */
export function entryFormat(entry: OpdsEntry): string {
    if (entry.downloadFormat) return entry.downloadFormat;
    const url = entry.downloadUrl;
    if (!url) return "other";
    const withoutQuery = url.split(/[?#]/)[0];
    const lastSegment = withoutQuery.slice(withoutQuery.lastIndexOf("/") + 1);
    const dot = lastSegment.lastIndexOf(".");
    // `dot <= 0` rejects both a dotless filename and a leading-dot one, and
    // reading the last *segment* keeps a dot in the host ("example.com")
    // from being mistaken for an extension.
    if (dot <= 0) return "other";
    const ext = lastSegment.slice(dot + 1).toLowerCase();
    return /^[a-z0-9]{1,5}$/.test(ext) ? ext : "other";
}

export function formatLabel(format: string): string {
    return FORMAT_LABELS[format] ?? format.toUpperCase();
}

function entryLanguage(entry: OpdsEntry): string | null {
    const raw = entry.language?.trim();
    if (!raw) return null;
    // Feeds use both "en" and "en-GB"; match on the base subtag.
    const base = raw.split(/[-_]/)[0].trim().toLowerCase();
    return base || null;
}

function entryYear(entry: OpdsEntry): number {
    const stamp = entry.published || entry.updated;
    if (!stamp) return 0;
    const parsed = Date.parse(stamp);
    return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Distinct facet values present in `entries`, most common first.
 *
 * Ordering by frequency rather than alphabetically means the chips a user is
 * likely to want are the ones they see without scrolling. Callers pass the
 * unfiltered set, so the available options do not disappear as the user
 * narrows the list.
 */
export function collectCatalogFacets(entries: OpdsEntry[]): CatalogFacets {
    const languageCounts = new Map<string, number>();
    const formatCounts = new Map<string, number>();

    for (const entry of entries) {
        if (entry.isNavigation) continue;
        const language = entryLanguage(entry);
        if (language) languageCounts.set(language, (languageCounts.get(language) ?? 0) + 1);
        const format = entryFormat(entry);
        formatCounts.set(format, (formatCounts.get(format) ?? 0) + 1);
    }

    const byFrequency = (counts: Map<string, number>) =>
        [...counts.entries()]
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .map(([value]) => value);

    return { languages: byFrequency(languageCounts), formats: byFrequency(formatCounts) };
}

/**
 * Narrow and order the loaded entries. Pure and client-side: everything it
 * operates on is already in memory.
 */
export function applyCatalogFacets(
    entries: OpdsEntry[],
    selection: CatalogFacetSelection,
): OpdsEntry[] {
    const filtered = entries.filter((entry) => {
        if (selection.language) {
            if (entryLanguage(entry) !== selection.language) return false;
        }
        if (selection.format && entryFormat(entry) !== selection.format) return false;
        return true;
    });

    return sortCatalogEntries(filtered, selection.sortOrder);
}

function sortCatalogEntries(
    entries: OpdsEntry[],
    sortOrder: CatalogSortOrder,
): OpdsEntry[] {
    const sorted = [...entries];
    switch (sortOrder) {
        case "author":
            sorted.sort(
                (a, b) =>
                    (a.author ?? "").localeCompare(b.author ?? "", undefined, { sensitivity: "base" }) ||
                    a.title.localeCompare(b.title, undefined, { sensitivity: "base" }),
            );
            break;
        case "newest":
            sorted.sort((a, b) => entryYear(b) - entryYear(a));
            break;
        case "oldest":
            sorted.sort((a, b) => entryYear(a) - entryYear(b));
            break;
        case "title":
        default:
            sorted.sort((a, b) =>
                a.title.localeCompare(b.title, undefined, { sensitivity: "base" }),
            );
            break;
    }
    return sorted;
}