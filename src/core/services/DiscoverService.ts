import { isTauri } from "../lib/env";
import { saveBookData, saveCoverImage } from "../lib/storage";
import { useLibraryStore } from "../store";
import type { Book, BookFormat, OpdsEntry, OpdsFeed } from "../types";
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

// In-memory and persistent cache for instant 0ms section switching
const DISCOVER_CACHE_KEY = "theorem_discover_cache_v2";
const sectionCache = new Map<string, { data: DiscoverSection; timestamp: number }>();
const CACHE_TTL_MS = 1000 * 60 * 60 * 24; // 24 hours

function loadPersistedCache(): DiscoverSection[] {
    try {
        if (typeof window === "undefined" || !window.localStorage) return [];
        const raw = localStorage.getItem(DISCOVER_CACHE_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
            return parsed;
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
        const fetchPromise = OpdsService.fetchFeed(url);
        const timeoutPromise = new Promise<OpdsFeed>((_, reject) =>
            setTimeout(() => reject(new Error("Timeout")), timeoutMs)
        );
        return await Promise.race([fetchPromise, timeoutPromise]);
    } catch (e) {
        console.warn(`Failed to fetch feed from ${url}:`, e);
        return null;
    }
}

async function fetchBinary(url: string): Promise<ArrayBuffer> {
    if (isTauri()) {
        const { invoke } = await import("@tauri-apps/api/core");
        const bytes = await invoke<number[] | Uint8Array>("fetch_binary_content", { url });
        if (bytes instanceof Uint8Array) {
            const buf = new ArrayBuffer(bytes.byteLength);
            new Uint8Array(buf).set(bytes);
            return buf;
        }
        const arr = new Uint8Array(bytes);
        const buf = new ArrayBuffer(arr.byteLength);
        new Uint8Array(buf).set(arr);
        return buf;
    }
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Download failed (${res.status})`);
    return await res.arrayBuffer();
}

function filterActualBooks(entries: OpdsEntry[]): OpdsEntry[] {
    const invalidKeywords = new Set([
        "authors",
        "author",
        "bookshelves",
        "bookshelf",
        "subjects",
        "subject",
        "categories",
        "category",
        "languages",
        "language",
        "popular",
        "latest",
        "search",
        "search results",
        "no results",
        "results",
    ]);

    return entries
        .filter((entry) => {
            const rawTitle = (entry.title || "").trim();
            const lower = rawTitle.toLowerCase();
            if (invalidKeywords.has(lower)) return false;

            // Reject empty search results / notice entries
            if (
                lower.includes("no results") ||
                lower.includes("returned no") ||
                lower.includes("no books found") ||
                lower.includes("not found") ||
                lower.includes("matching your search") ||
                lower.includes("0 results") ||
                lower.startsWith("search results for") ||
                lower.startsWith("search for")
            ) {
                return false;
            }

            // Reject category / shelf navigation links
            if (entry.id.includes("/subjects/") || entry.id.includes("/bookshelves/") || entry.id.includes("/authors/")) return false;
            if (entry.navUrl && (entry.navUrl.includes("/subjects/") || entry.navUrl.includes("/bookshelves/") || entry.navUrl.includes("/authors/"))) return false;

            // Must have a valid title
            if (!rawTitle || rawTitle.length < 2) return false;

            // Must either have a direct download URL, or a valid book identifier
            const isGutenbergBook = entry.id.includes("/ebooks/") && /\/ebooks\/\d+/.test(entry.id);
            const isStandardEbooks = entry.id.includes("standardebooks.org/ebooks/");
            const hasDownload = Boolean(entry.downloadUrl);
            const hasBookNav = Boolean(entry.navUrl && (entry.navUrl.includes("/ebooks/") || entry.navUrl.includes("/entry/")));

            if (!hasDownload && !isGutenbergBook && !isStandardEbooks && !hasBookNav) {
                return false;
            }

            return true;
        })
        .map((entry) => {
            let cleanTitle = entry.title;
            cleanTitle = cleanTitle.replace(/\s+by\s+.*$/i, "").trim();
            const extractedAuthor =
                entry.author ||
                (entry.content && !entry.content.includes("<") && entry.content.length < 60 ? entry.content.trim() : undefined);
            return {
                ...entry,
                title: cleanTitle || entry.title,
                author: extractedAuthor,
            };
        });
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
                    if (feed && feed.entries && feed.entries.length > 0) {
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

    async downloadBook(
        entry: OpdsEntry,
        onProgress?: (step: string) => void
    ): Promise<string> {
        let downloadUrl = entry.downloadUrl;

        // If it's an entry linking to a book-specific acquisition feed, fetch it
        if (!downloadUrl && entry.navUrl) {
            onProgress?.("Resolving download format…");
            const subFeed = await fetchFeedSafe(entry.navUrl);
            const acq = subFeed?.entries.find((e) => e.downloadUrl);
            if (acq?.downloadUrl) {
                downloadUrl = acq.downloadUrl;
            }
        }

        if (!downloadUrl) {
            // Gutenberg direct fallback format
            const match = entry.id.match(/\/ebooks\/(\d+)/);
            if (match) {
                const id = match[1];
                downloadUrl = `https://www.gutenberg.org/ebooks/${id}.epub.images`;
            }
        }

        if (!downloadUrl) {
            throw new Error("No direct EPUB download available for this title.");
        }

        onProgress?.("Downloading book…");
        const buffer = await fetchBinary(downloadUrl);
        const bookId = `book-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const format: BookFormat = entry.downloadFormat || "epub";
        const storagePath = await saveBookData(bookId, buffer);

        let coverPath: string | undefined;
        if (entry.coverUrl || entry.thumbnailUrl) {
            const cUrl = entry.coverUrl || entry.thumbnailUrl;
            if (cUrl) {
                try {
                    onProgress?.("Downloading cover…");
                    const coverBuffer = await fetchBinary(cUrl);
                    const blob = new Blob([coverBuffer], { type: "image/jpeg" });
                    coverPath = await saveCoverImage(bookId, blob);
                } catch {
                    // Non-fatal
                }
            }
        }

        const book: Book = {
            id: bookId,
            title: entry.title,
            author: entry.author || "Unknown Author",
            format,
            filePath: storagePath,
            storagePath,
            fileSize: buffer.byteLength,
            addedAt: new Date(),
            coverPath,
            description: entry.summary,
            publisher: entry.publisher,
            language: entry.language,
            progress: 0,
            tags: ["Discover"],
            isFavorite: false,
            readingTime: 0,
            lastReadAt: new Date(),
        };

        useLibraryStore.getState().addBook(book);
        return bookId;
    },
};
