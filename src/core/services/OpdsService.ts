import { isTauri } from "../lib/env";
import { saveBookData, saveCoverImage } from "../lib/storage";
import { useLibraryStore } from "../store";
import type { Book, BookFormat, OpdsCatalog, OpdsEntry, OpdsFeed, OpdsLink } from "../types";
import { XMLParser } from "fast-xml-parser";

export const DEFAULT_OPDS_PRESETS: OpdsCatalog[] = [
    {
        id: "project-gutenberg",
        title: "Project Gutenberg",
        url: "https://www.gutenberg.org/ebooks.opds/",
        isPreset: true,
        description: "Over 60,000 free classics and public domain literature.",
    },
    {
        id: "standard-ebooks",
        title: "Standard Ebooks",
        url: "https://standardebooks.org/feeds/atom/new-releases",
        isPreset: true,
        description: "Carefully produced, beautifully formatted public domain ebooks.",
    },
];

function resolveUrl(relativeOrAbsolute: string, baseUrl: string): string {
    try {
        return new URL(relativeOrAbsolute, baseUrl).href;
    } catch {
        return relativeOrAbsolute;
    }
}

async function fetchFeedXml(url: string): Promise<string> {
    let rawText = "";
    if (isTauri()) {
        const { invoke } = await import("@tauri-apps/api/core");
        rawText = await invoke<string>("fetch_rss_feed", { url });
    } else {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Could not load catalog (${response.status})`);
        }
        rawText = await response.text();
    }

    // Auto-discover Atom/OPDS alternate link if an HTML page was returned
    if (rawText.trim().startsWith("<!DOCTYPE html") || rawText.trim().startsWith("<html")) {
        const match = rawText.match(/<link[^>]+rel=["']alternate["'][^>]+type=["'](application\/atom\+xml[^"']*)["'][^>]+href=["']([^"']+)["']/i)
            || rawText.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["']alternate["'][^>]+type=["'](application\/atom\+xml[^"']*)["']/i);
        if (match) {
            const feedHref = match[1].includes("http") ? match[1] : match[2];
            if (feedHref && !feedHref.includes("atom+xml")) {
                const resolvedFeedUrl = resolveUrl(feedHref, url);
                return fetchFeedXml(resolvedFeedUrl);
            }
        }
    }

    return rawText;
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
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to download book: ${response.status}`);
    }
    return await response.arrayBuffer();
}

function createOpdsParser(): XMLParser {
    return new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: "@_",
        removeNSPrefix: false,
        textNodeName: "#text",
        parseTagValue: false,
        parseAttributeValue: false,
        isArray: (name: string) => name === "entry" || name === "link" || name === "author" || name === "item",
        trimValues: true,
    });
}

function getTextContent(node: any): string {
    if (!node) return "";
    if (typeof node === "string") return node;
    if (typeof node === "object" && "#text" in node) return String(node["#text"]);
    return "";
}

function extractFormatFromMime(mime?: string, href?: string): "epub" | "pdf" | "cbz" | "mobi" | undefined {
    const type = (mime || "").toLowerCase();
    const path = (href || "").toLowerCase();

    if (type.includes("epub") || path.endsWith(".epub")) return "epub";
    if (type.includes("pdf") || path.endsWith(".pdf")) return "pdf";
    if (type.includes("comic") || type.includes("cbz") || path.endsWith(".cbz")) return "cbz";
    if (type.includes("mobi") || type.includes("prc") || path.endsWith(".mobi") || type.includes("kindle")) return "mobi";
    return undefined;
}

export async function parseOpdsFeed(xmlText: string, feedUrl: string): Promise<OpdsFeed> {
    const parser = createOpdsParser();
    const result = parser.parse(xmlText);

    // Support standard Atom, RSS 2.0, or RDF feeds
    const feedNode = result.feed || result["atom:feed"] || result.rss?.channel || result;
    const title = getTextContent(feedNode.title || feedNode["atom:title"]) || "Library Catalog";
    const subtitle = getTextContent(feedNode.subtitle || feedNode["atom:subtitle"] || feedNode.description) || undefined;
    const icon = getTextContent(feedNode.icon || feedNode["atom:icon"] || feedNode.image?.url) || undefined;
    const updated = getTextContent(feedNode.updated || feedNode["atom:updated"] || feedNode.lastBuildDate) || undefined;
    const feedId = getTextContent(feedNode.id || feedNode["atom:id"]) || feedUrl;

    const rawLinks: any[] = Array.isArray(feedNode.link) ? feedNode.link : feedNode.link ? [feedNode.link] : [];
    let selfUrl: string | undefined;
    let nextUrl: string | undefined;
    let prevUrl: string | undefined;
    let upUrl: string | undefined;
    let startUrl: string | undefined;
    let searchUrlTemplate: string | undefined;

    for (const link of rawLinks) {
        if (typeof link === "string") continue;
        const rel = link["@_rel"] || "";
        const href = link["@_href"];
        const type = link["@_type"] || "";
        if (!href) continue;

        const resolved = resolveUrl(href, feedUrl);
        if (rel === "self") selfUrl = resolved;
        else if (rel === "next") nextUrl = resolved;
        else if (rel === "previous" || rel === "prev") prevUrl = resolved;
        else if (rel === "up") upUrl = resolved;
        else if (rel === "start") startUrl = resolved;
        else if (rel === "search" || type.includes("opensearch")) {
            if (href.includes("{searchTerms}")) {
                searchUrlTemplate = href;
            } else {
                searchUrlTemplate = resolved;
            }
        }
    }

    const rawEntries: any[] = Array.isArray(feedNode.entry)
        ? feedNode.entry
        : feedNode.entry
          ? [feedNode.entry]
          : Array.isArray(feedNode.item)
            ? feedNode.item
            : feedNode.item
              ? [feedNode.item]
              : [];

    const entries: OpdsEntry[] = [];

    for (const entryNode of rawEntries) {
        const id = getTextContent(entryNode.id || entryNode["atom:id"] || entryNode.guid) || `book-${Math.random().toString(36).slice(2)}`;
        const entryTitle = getTextContent(entryNode.title || entryNode["atom:title"]) || "Untitled";
        
        let author: string | undefined;
        const authors = entryNode.author || entryNode["atom:author"] || entryNode["dc:creator"];
        if (Array.isArray(authors) && authors.length > 0) {
            author = getTextContent(authors[0].name || authors[0]["atom:name"] || authors[0]);
        } else if (authors) {
            author = getTextContent(authors.name || authors["atom:name"] || authors);
        }

        const summary = getTextContent(entryNode.summary || entryNode["atom:summary"] || entryNode.description) || undefined;
        const content = getTextContent(entryNode.content || entryNode["atom:content"]) || undefined;
        const entryUpdated = getTextContent(entryNode.updated || entryNode["atom:updated"] || entryNode.pubDate) || undefined;
        const published = getTextContent(entryNode.published || entryNode["atom:published"] || entryNode["dc:issued"]) || undefined;
        const language = getTextContent(entryNode["dc:language"]) || undefined;
        const publisher = getTextContent(entryNode["dc:publisher"]) || undefined;

        const entryLinksRaw: any[] = Array.isArray(entryNode.link)
            ? entryNode.link
            : entryNode.link
              ? [entryNode.link]
              : [];

        // RSS enclosure support
        if (entryNode.enclosure) {
            const enc = entryNode.enclosure;
            entryLinksRaw.push({
                "@_rel": "http://opds-spec.org/acquisition",
                "@_href": enc["@_url"] || enc.url,
                "@_type": enc["@_type"] || enc.type,
            });
        }

        const links: OpdsLink[] = [];
        let coverUrl: string | undefined;
        let thumbnailUrl: string | undefined;
        let downloadUrl: string | undefined;
        let downloadFormat: "epub" | "pdf" | "cbz" | "mobi" | undefined;
        let navUrl: string | undefined;

        for (const l of entryLinksRaw) {
            if (typeof l === "string") {
                const resolvedHref = resolveUrl(l, feedUrl);
                const detectedFmt = extractFormatFromMime(undefined, l);
                if (detectedFmt) {
                    downloadUrl = resolvedHref;
                    downloadFormat = detectedFmt;
                }
                continue;
            }

            const rel = (l["@_rel"] || "").toLowerCase();
            const href = l["@_href"];
            const type = (l["@_type"] || "").toLowerCase();
            const linkTitle = l["@_title"] || undefined;
            if (!href) continue;

            const resolvedHref = resolveUrl(href, feedUrl);
            links.push({ rel, href: resolvedHref, type, title: linkTitle });

            // Image / Thumbnail
            if (rel.includes("thumbnail") || rel.includes("image/thumbnail")) {
                thumbnailUrl = resolvedHref;
            } else if (rel.includes("image") || rel.includes("cover")) {
                coverUrl = resolvedHref;
            } else if (type.includes("image/")) {
                if (!coverUrl) coverUrl = resolvedHref;
            }

            // Acquisition (Direct Download)
            if (
                rel.includes("acquisition") ||
                type.includes("application/epub+zip") ||
                type.includes("application/pdf") ||
                href.endsWith(".epub") ||
                href.endsWith(".pdf")
            ) {
                const detectedFmt = extractFormatFromMime(type, href);
                if (detectedFmt && (!downloadUrl || detectedFmt === "epub")) {
                    downloadUrl = resolvedHref;
                    downloadFormat = detectedFmt;
                }
            }

            // Navigation (drilldown subfeed)
            if (rel === "subsection" || rel.includes("subsection") || type.includes("profile=opds-catalog") || type.includes("application/atom+xml")) {
                if (!navUrl) {
                    navUrl = resolvedHref;
                }
            }
        }

        if (!thumbnailUrl && coverUrl) thumbnailUrl = coverUrl;
        if (!coverUrl && thumbnailUrl) coverUrl = thumbnailUrl;

        // If it has no download URL yet but links to a specific book OPDS feed (like Gutenberg single book),
        // keep it as navigable so tapping it loads the book acquisition feed
        const isNavigation = !downloadUrl && Boolean(navUrl);

        entries.push({
            id,
            title: entryTitle,
            author,
            summary: summary || content,
            content,
            updated: entryUpdated,
            published,
            language,
            publisher,
            coverUrl,
            thumbnailUrl,
            downloadUrl,
            downloadFormat,
            navUrl,
            isNavigation,
            links,
        });
    }

    return {
        id: feedId,
        title,
        subtitle,
        icon,
        updated,
        selfUrl,
        nextUrl,
        prevUrl,
        upUrl,
        startUrl,
        searchUrlTemplate,
        entries,
    };
}

export const OpdsService = {
    async fetchFeed(url: string): Promise<OpdsFeed> {
        if (isTauri()) {
            try {
                const { invoke } = await import("@tauri-apps/api/core");
                const nativeResult = await invoke<any>("fetch_and_parse_opds_native", { url });
                if (nativeResult && Array.isArray(nativeResult.entries)) {
                    return {
                        id: nativeResult.id,
                        title: nativeResult.title,
                        subtitle: nativeResult.subtitle,
                        icon: nativeResult.icon,
                        updated: nativeResult.updated,
                        selfUrl: nativeResult.self_url,
                        nextUrl: nativeResult.next_url,
                        prevUrl: nativeResult.prev_url,
                        upUrl: nativeResult.up_url,
                        startUrl: nativeResult.start_url,
                        searchUrlTemplate: nativeResult.search_url_template,
                        entries: nativeResult.entries.map((e: any) => ({
                            id: e.id,
                            title: e.title,
                            author: e.author,
                            summary: e.summary,
                            content: e.content,
                            updated: e.updated,
                            published: e.published,
                            language: e.language,
                            publisher: e.publisher,
                            coverUrl: e.cover_url,
                            thumbnailUrl: e.thumbnail_url,
                            downloadUrl: e.download_url,
                            downloadFormat: e.download_format,
                            navUrl: e.nav_url,
                            isNavigation: e.is_navigation,
                            links: e.links || [],
                        })),
                    };
                }
            } catch (err) {
                console.warn("[OpdsService] Native OPDS parse failed, falling back to JS:", err);
            }
        }
        const xmlText = await fetchFeedXml(url);
        return parseOpdsFeed(xmlText, url);
    },

    async search(templateUrl: string, query: string, baseUrl: string): Promise<OpdsFeed> {
        let url = templateUrl;
        if (url.includes("{searchTerms}")) {
            url = url.replace("{searchTerms}", encodeURIComponent(query));
        } else {
            const sep = url.includes("?") ? "&" : "?";
            url = `${url}${sep}q=${encodeURIComponent(query)}`;
        }
        const resolved = resolveUrl(url, baseUrl);
        return OpdsService.fetchFeed(resolved);
    },

    async downloadAndImportBook(
        entry: OpdsEntry,
        onProgress?: (msg: string) => void
    ): Promise<string> {
        let downloadUrl = entry.downloadUrl;

        // If the entry links to a sub-feed (e.g. Gutenberg book acquisition feed), resolve it
        if (!downloadUrl && entry.navUrl) {
            onProgress?.("Resolving download options…");
            const subFeed = await OpdsService.fetchFeed(entry.navUrl);
            const acqEntry = subFeed.entries.find((e) => e.downloadUrl);
            if (acqEntry?.downloadUrl) {
                downloadUrl = acqEntry.downloadUrl;
            }
        }

        if (!downloadUrl) {
            throw new Error("No download link available for this book.");
        }

        onProgress?.("Downloading book…");
        const buffer = await fetchBinary(downloadUrl);
        const bookId = `book-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const format: BookFormat = entry.downloadFormat || "epub";
        const storagePath = await saveBookData(bookId, buffer);

        let coverPath: string | undefined;
        if (entry.coverUrl) {
            try {
                onProgress?.("Downloading cover…");
                const coverBuffer = await fetchBinary(entry.coverUrl);
                const blob = new Blob([coverBuffer], { type: "image/jpeg" });
                coverPath = await saveCoverImage(bookId, blob);
            } catch {
                // Ignore cover failure
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
            tags: [],
            isFavorite: false,
            readingTime: 0,
            lastReadAt: new Date(),
        };

        useLibraryStore.getState().addBook(book);
        return bookId;
    },
};
