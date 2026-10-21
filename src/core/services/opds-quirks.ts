import type { OpdsAcquisition, OpdsEntry, OpdsFeed } from "../types";

/**
 * Per-catalog adapters. The Rust parser is deliberately strict about OPDS; the few public
 * catalogs that bend the spec are corrected here, in one place, instead of leaking special cases
 * into the parser or the UI.
 */

const GUTENBERG_BOOK = /^https?:\/\/(?:www\.|m\.)?gutenberg\.org\/ebooks\/(\d+)\.opds\/?$/i;

function isGutenberg(url: string): boolean {
    try {
        const host = new URL(url).hostname;
        return host === "gutenberg.org" || host.endsWith(".gutenberg.org");
    } catch {
        return false;
    }
}

/**
 * Project Gutenberg lists each book in search results as a "subsection" link to the book's own
 * feed, indistinguishable from a category link except by its address. Treat those as partial
 * books: real covers come from a stable address, and the full entry (with downloads) is loaded
 * when the book is opened.
 */
function gutenbergBook(item: OpdsFeed["navigation"][number], id: string): OpdsEntry {
    // "Dracula by Bram Stoker" is also used as a title in some listings.
    const byMatch = item.title.match(/^(.*?)\s+by\s+(.+)$/i);
    const title = (byMatch ? byMatch[1] : item.title).trim();
    const author = (item.summary ?? byMatch?.[2] ?? "").trim();
    return {
        id: `urn:gutenberg:${id}`,
        title,
        authors: author ? [author] : [],
        cover: `https://www.gutenberg.org/cache/epub/${id}/pg${id}.cover.medium.jpg`,
        thumbnail: `https://www.gutenberg.org/cache/epub/${id}/pg${id}.cover.small.jpg`,
        acquisitions: [],
        detailHref: item.href,
        webUrl: `https://www.gutenberg.org/ebooks/${id}`,
    };
}

export function applyCatalogQuirks(feed: OpdsFeed, feedUrl: string): OpdsFeed {
    if (!isGutenberg(feedUrl) && !isGutenberg(feed.selfUrl ?? "")) return feed;

    const books: OpdsEntry[] = [];
    const navigation = feed.navigation.filter((item) => {
        const m = GUTENBERG_BOOK.exec(item.href);
        if (!m) return true;
        books.push(gutenbergBook(item, m[1]));
        return false;
    });
    if (books.length === 0) return feed;

    const entries = [...books, ...feed.entries];
    const kind = navigation.length > 0 ? "mixed" : "acquisition";
    return { ...feed, navigation, entries, kind };
}

const FORMAT_RANK: Record<string, number> = { epub: 60, pdf: 50, cbz: 45, cbr: 44, mobi: 40, fb2: 35 };

/**
 * Best direct download among `acquisitions` (index), mirroring the parser's ranking: importable
 * and DRM-free only, never a sample, EPUB first, the illustrated edition over "no images", and a
 * plain EPUB over Kobo/"advanced" variants.
 */
export function pickPrimaryAcquisition(acquisitions: OpdsAcquisition[]): number | undefined {
    let best: { index: number; score: number } | undefined;
    acquisitions.forEach((a, index) => {
        if (!a.downloadable || a.kind === "sample") return;
        let score = (a.format ? FORMAT_RANK[a.format] ?? 0 : 0) + (a.kind === "openAccess" ? 8 : 6);
        const hay = `${a.title ?? ""} ${a.href}`.toLowerCase();
        if (hay.includes("noimages") || hay.includes("no images")) score -= 5;
        if (hay.includes("kepub")) score -= 20;
        if (hay.includes("advanced")) score -= 3;
        if (hay.includes("recommended") || hay.includes("compatible")) score += 3;
        if (hay.includes("epub3")) score += 2;
        if (!best || score > best.score) best = { index, score };
    });
    return best?.index;
}

/**
 * A book's own feed can hold several editions as separate entries (Gutenberg: with and without
 * images). Present them as one book: the first entry's metadata with every edition's downloads.
 */
export function mergeEditions(entries: OpdsEntry[]): OpdsEntry | undefined {
    if (entries.length === 0) return undefined;
    const [first, ...rest] = entries;
    if (rest.length === 0) return first;
    const seen = new Set(first.acquisitions.map((a) => a.href));
    const acquisitions = [...first.acquisitions];
    for (const e of rest) {
        for (const a of e.acquisitions) {
            if (!seen.has(a.href)) {
                seen.add(a.href);
                acquisitions.push(a);
            }
        }
    }
    const merged: OpdsEntry = { ...first, acquisitions, primary: pickPrimaryAcquisition(acquisitions) };
    merged.summary = first.summary ?? rest.find((e) => e.summary)?.summary;
    merged.cover = first.cover ?? rest.find((e) => e.cover)?.cover;
    merged.thumbnail = first.thumbnail ?? rest.find((e) => e.thumbnail)?.thumbnail;
    merged.related = first.related ?? rest.find((e) => e.related)?.related;
    return merged;
}
