import { Readability } from "@mozilla/readability";
import DOMPurify from "dompurify";
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "../lib/env";

export interface ExtractedArticle {
    title: string;
    byline?: string;
    content: string;
    textContent?: string;
    excerpt?: string;
    siteName?: string;
    leadImageUrl?: string;
    publishedTime?: string;
}

function resolveAbsoluteUrls(doc: Document, baseUrl: string): void {
    const images = Array.from(doc.querySelectorAll<HTMLImageElement>("img[src]"));
    for (const img of images) {
        const rawSrc = img.getAttribute("src");
        if (rawSrc && !rawSrc.startsWith("data:") && !rawSrc.startsWith("blob:")) {
            try {
                img.setAttribute("src", new URL(rawSrc, baseUrl).href);
            } catch {
                // Keep original src if invalid
            }
        }
    }

    const links = Array.from(doc.querySelectorAll<HTMLAnchorElement>("a[href]"));
    for (const a of links) {
        const rawHref = a.getAttribute("href");
        if (rawHref && !rawHref.startsWith("#") && !rawHref.startsWith("javascript:") && !rawHref.startsWith("mailto:")) {
            try {
                a.setAttribute("href", new URL(rawHref, baseUrl).href);
            } catch {
                // Keep original href
            }
        }
    }
}

export class ArticleExtractorService {
    /**
     * Fetches the raw HTML content of a URL.
     * Uses Tauri native Rust command on desktop/mobile to bypass CORS and rotate user-agents,
     * and falls back to standard browser fetch on web.
     */
    static async fetchHtml(url: string, timeoutMs: number = 6000): Promise<string> {
        if (isTauri()) {
            const invokePromise = invoke<string>("fetch_url_content", { url });
            const timeoutPromise = new Promise<string>((_, reject) => {
                setTimeout(() => reject(new Error(`Timeout after ${timeoutMs}ms`)), timeoutMs);
            });
            return await Promise.race([invokePromise, timeoutPromise]);
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetch(url, {
                signal: controller.signal,
                headers: {
                    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                },
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            return await response.text();
        } finally {
            clearTimeout(timeoutId);
        }
    }

    /**
     * Extracts readable full article content from raw HTML.
     */
    static extractFromHtml(html: string, url?: string): ExtractedArticle | null {
        if (typeof DOMParser === "undefined") {
            return null;
        }

        try {
            const parser = new DOMParser();
            const doc = parser.parseFromString(html, "text/html");

            if (url) {
                resolveAbsoluteUrls(doc, url);
            }

            // Remove clutter, scripts, widgets before Readability
            doc.querySelectorAll("script, style, noscript, iframe, svg, form").forEach(el => el.remove());

            // Clone document before Readability mutation
            const docClone = doc.cloneNode(true) as Document;
            const reader = new Readability(docClone, {
                keepClasses: false,
                charThreshold: 60,
            });

            const parsed = reader.parse();
            if (!parsed || !parsed.content) {
                return null;
            }

            const sanitizedContent = DOMPurify.sanitize(parsed.content, {
                ALLOWED_TAGS: [
                    "h1", "h2", "h3", "h4", "h5", "h6",
                    "p", "a", "img", "blockquote", "ul", "ol", "li",
                    "code", "pre", "em", "strong", "b", "i", "u", "s",
                    "hr", "br", "table", "thead", "tbody", "tr", "th", "td",
                    "figure", "figcaption", "sup", "sub", "mark", "span", "div"
                ],
                ALLOWED_ATTR: ["href", "src", "alt", "title", "class", "id", "target", "rel", "width", "height"],
            });

            // Find lead image if present
            let leadImageUrl: string | undefined;
            const firstImg = doc.querySelector<HTMLImageElement>("meta[property='og:image'], img");
            if (firstImg) {
                if (firstImg.tagName.toLowerCase() === "meta") {
                    leadImageUrl = firstImg.getAttribute("content") || undefined;
                } else {
                    leadImageUrl = firstImg.getAttribute("src") || undefined;
                }
            }

            return {
                title: parsed.title || "",
                byline: parsed.byline || undefined,
                content: sanitizedContent,
                textContent: parsed.textContent || "",
                excerpt: parsed.excerpt || undefined,
                siteName: parsed.siteName || undefined,
                leadImageUrl,
                publishedTime: parsed.publishedTime || undefined,
            };
        } catch (error) {
            console.error("[ArticleExtractor] Error parsing article HTML:", error);
            return null;
        }
    }

    /**
     * Fetches and extracts full readable article from a URL.
     */
    static async extractFromUrl(url: string): Promise<ExtractedArticle | null> {
        if (!url || !url.startsWith("http")) {
            return null;
        }

        if (isTauri()) {
            try {
                const nativeResult = await invoke<ExtractedArticle>("fetch_and_extract_article_native", { url });
                if (nativeResult && nativeResult.title) {
                    return nativeResult;
                }
            } catch (error) {
                console.warn("[ArticleExtractor] Native extraction failed, falling back to browser:", error);
            }
        }

        try {
            const html = await this.fetchHtml(url);
            return this.extractFromHtml(html, url);
        } catch (error) {
            console.error(`[ArticleExtractor] Failed to extract article from ${url}:`, error);
            return null;
        }
    }
}
