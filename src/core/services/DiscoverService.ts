import type { Book, OpdsEntry, OpdsFeed } from "../types";
import { OpdsService } from "./OpdsService";

export interface DiscoverSection {
    id: string;
    title: string;
    subtitle?: string;
    books: OpdsEntry[];
}

// High-trust stable curated feeds for instant discovery
const CURATED_FEEDS = [
    {
        id: "essentials",
        title: "Timeless Essentials",
        subtitle: "The most celebrated literature of all time.",
        url: "https://www.gutenberg.org/ebooks/search.opds/?sort_order=downloads",
    },
    {
        id: "new-releases",
        title: "New & Restored Editions",
        subtitle: "Carefully produced, beautifully formatted public domain releases.",
        url: "https://standardebooks.org/feeds/atom/new-releases",
    },
    {
        id: "philosophy",
        title: "Philosophy & Essays",
        subtitle: "Stoic meditations, classical thought, and philosophical treatises.",
        url: "https://www.gutenberg.org/ebooks/search.opds/?query=philosophy&sort_order=downloads",
    },
    {
        id: "classics-fiction",
        title: "Classic Fiction",
        subtitle: "Enduring novels and foundational stories.",
        url: "https://www.gutenberg.org/ebooks/search.opds/?query=fiction&sort_order=downloads",
    },
];

// In-memory and persistent cache for instant 0ms section switching.
// The key is versioned with the *shape* of an entry: v2 held the pre-OPDS-rewrite entries
// (`author`, `downloadUrl`...), which the current UI cannot render and used to crash it.
const DISCOVER_CACHE_KEY = "theorem_discover_cache_v3";
const LEGACY_DISCOVER_CACHE_KEYS = ["theorem_discover_cache_v2", "theorem_discover_cache"];
const sectionCache = new Map<string, { data: DiscoverSection; timestamp: number }>();
const CACHE_TTL_MS = 1000 * 60 * 60 * 24; // 24 hours

/** Is this really a book in today's shape? Anything else in storage is ignored, never rendered. */
function isUsableEntry(book: unknown): book is OpdsEntry {
    const b = book as Partial<OpdsEntry> | null;
    return Boolean(b) && typeof b!.id === "string" && typeof b!.title === "string" && Array.isArray(b!.authors) && Array.isArray(b!.acquisitions);
}

function isUsableSection(section: unknown): section is DiscoverSection {
    const s = section as Partial<DiscoverSection> | null;
    return Boolean(s) && typeof s!.id === "string" && typeof s!.title === "string" && Array.isArray(s!.books) && s!.books.every(isUsableEntry);
}

function loadPersistedCache(): DiscoverSection[] {
    try {
        if (typeof window === "undefined" || !window.localStorage) return [];
        // Free the space the old caches held; their entries are in a shape we no longer read.
        for (const key of LEGACY_DISCOVER_CACHE_KEYS) localStorage.removeItem(key);
        const raw = localStorage.getItem(DISCOVER_CACHE_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
            const usable = parsed.filter(isUsableSection);
            if (usable.length === parsed.length && usable.length > 0) return usable;
            // Partly or wholly unusable (a corrupt or hand-edited cache): start clean.
            localStorage.removeItem(DISCOVER_CACHE_KEY);
        }
    } catch {
        // Ignore parse errors
    }
    return [];
}

function savePersistedCache(sections: DiscoverSection[]) {
    try {
        if (typeof window !== "undefined" && window.localStorage && sections.length > 0) {
            localStorage.setItem(DISCOVER_CACHE_KEY, JSON.stringify(sections));
        }
    } catch {
        // Storage quota exceeded or unavailable
    }
}

async function fetchFeedSafe(url: string, timeoutMs = 8000): Promise<OpdsFeed | null> {
    try {
        const load = OpdsService.load(url).then((r) => r.feed);
        const timeout = new Promise<OpdsFeed>((_, reject) => setTimeout(() => reject(new Error("Timeout")), timeoutMs));
        return await Promise.race([load, timeout]);
    } catch (e) {
        console.warn(`Failed to fetch feed from ${url}:`, e);
        return null;
    }
}

/** Entries that are real, openable books — not notices, empty-result placeholders or shelves. */
function filterActualBooks(entries: OpdsEntry[]): OpdsEntry[] {
    return entries
        .filter((entry) => {
            const title = (entry.title || "").trim();
            const lower = title.toLowerCase();
            if (title.length < 2) return false;
            // Placeholder rows some catalogs emit for an empty search.
            if (
                lower.includes("no results") ||
                lower.includes("returned no") ||
                lower.includes("no books found") ||
                lower.includes("matching your search") ||
                lower.startsWith("search results for")
            ) {
                return false;
            }
            // Something the reader can actually get: a download now, or a detail page that has one.
            return entry.primary !== undefined || Boolean(entry.detailHref);
        })
        .map((entry) => ({ ...entry, title: entry.title.replace(/\s+by\s+.*$/i, "").trim() || entry.title }));
}

export const DiscoverService = {
    getCachedSections(): DiscoverSection[] {
        if (sectionCache.size > 0) {
            return Array.from(sectionCache.values()).map((v) => v.data);
        }
        const persisted = loadPersistedCache();
        if (persisted.length > 0) {
            persisted.forEach((section) => {
                sectionCache.set(section.id, { data: section, timestamp: Date.now() });
            });
            return persisted;
        }
        return [];
    },

    async loadCuratedSections(forceRefresh = false): Promise<DiscoverSection[]> {
        const results: DiscoverSection[] = [];

        await Promise.allSettled(
            CURATED_FEEDS.map(async (feedConfig) => {
                const cacheKey = feedConfig.id;
                const cached = sectionCache.get(cacheKey);
                if (!forceRefresh && cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
                    results.push(cached.data);
                    return;
                }

                try {
                    const feed = await fetchFeedSafe(feedConfig.url, 6000);
                    if (feed && feed.entries.length > 0) {
                        const validBooks = filterActualBooks(feed.entries);
                        if (validBooks.length > 0) {
                            const section: DiscoverSection = {
                                id: feedConfig.id,
                                title: feedConfig.title,
                                subtitle: feedConfig.subtitle,
                                books: validBooks.slice(0, 20),
                            };
                            sectionCache.set(cacheKey, { data: section, timestamp: Date.now() });
                            results.push(section);
                        }
                    }
                } catch (err) {
                    console.warn(`Error loading section ${feedConfig.id}:`, err);
                }
            })
        );

        // Maintain display order based on CURATED_FEEDS
        const ordered = CURATED_FEEDS.map((f) => results.find((r) => r.id === f.id)).filter(Boolean) as DiscoverSection[];
        const finalSections = ordered.length > 0 ? ordered : results;
        if (finalSections.length > 0) {
            savePersistedCache(finalSections);
        }
        return finalSections;
    },

    async search(query: string): Promise<OpdsEntry[]> {
        const clean = query.trim();
        if (!clean) return [];

        const gutenbergSearchUrl = `https://www.gutenberg.org/ebooks/search.opds/?query=${encodeURIComponent(clean)}`;
        const feed = await fetchFeedSafe(gutenbergSearchUrl);
        return feed ? filterActualBooks(feed.entries) : [];
    },

    /** Add a Discover book to the Library (resolving its detail page first when it has one). */
    async downloadBook(entry: OpdsEntry, onProgress?: (message: string) => void): Promise<Book> {
        let full = entry;
        if (entry.primary === undefined && entry.detailHref) {
            onProgress?.("Resolving download options…");
            full = await OpdsService.loadDetail(entry);
        }
        const acquisition = full.primary !== undefined ? full.acquisitions[full.primary] : undefined;
        if (!acquisition) throw new Error("No download link available for this book.");
        onProgress?.("Downloading book…");
        return OpdsService.download(acquisition);
    },
};
