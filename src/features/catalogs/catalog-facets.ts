import type { OpdsEntry } from "../../core/types";

export const CATALOG_SORT_ORDERS = [
    // The server's own order (popularity, newest first, relevance) is often the point of a list.
    { id: "catalog", label: "Catalog order" },
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
    azw3: "AZW3",
    fb2: "FB2",
};

/**
 * Format for an entry: the best download's declared format, else any acquisition's, else the
 * file extension of its address (plenty of OPDS servers omit the media type), else "other".
 */
export function entryFormat(entry: OpdsEntry): string {
    const best = entry.primary !== undefined ? entry.acquisitions[entry.primary] : entry.acquisitions[0];
    if (!best) return "other";
    if (best.format) return best.format;
    const url = best.href;
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
        const language = entryLanguage(entry);
        if (language) languageCounts.set(language, (languageCounts.get(language) ?? 0) + 1);
        // A partial entry (its downloads are one click deeper) has no format to filter on yet.
        if (entry.acquisitions.length === 0) continue;
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
    if (sortOrder === "catalog") return [...entries];
    const sorted = [...entries];
    switch (sortOrder) {
        case "author":
            sorted.sort(
                (a, b) =>
                    (a.authors[0] ?? "").localeCompare(b.authors[0] ?? "", undefined, { sensitivity: "base" }) ||
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