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
    static async extractFromHtml(html: string, url?: string): Promise<ExtractedArticle | null> {
        if (!html || !html.trim()) {
            return null;
        }

        if (isTauri()) {
            try {
                const nativeResult = await invoke<ExtractedArticle>("extract_article_from_html_native", {
                    html,
                    url: url || null,
                });
                if (nativeResult && nativeResult.title) {
                    return nativeResult;
                }
            } catch (error) {
                if (import.meta.env.DEV) {
                    console.warn("[ArticleExtractor] Native extract_article_from_html_native failed, falling back:", error);
                }
            }
        }

        if (typeof DOMParser === "undefined") {
            return null;
        }

        try {
            const dompurifyModule = await import("dompurify");
            const DOMPurify = (dompurifyModule && (dompurifyModule.default || dompurifyModule)) as typeof import("dompurify").default;

            const parser = new DOMParser();
            const doc = parser.parseFromString(html, "text/html");

            if (url) {
                resolveAbsoluteUrls(doc, url);
            }

            // Remove clutter, scripts, widgets, nav, header, footer, ads before extraction
            doc.querySelectorAll("script, style, noscript, iframe, svg, form, nav, header, footer, .ad-banner, .cookie-notice").forEach(el => el.remove());

            // Extract title: og:title -> <title> -> <h1>
            const ogTitle = doc.querySelector("meta[property='og:title']")?.getAttribute("content");
            const docTitle = doc.querySelector("title")?.textContent;
            const h1Title = doc.querySelector("h1")?.textContent;
            const title = (ogTitle || docTitle || h1Title || "").trim();

            // Extract byline
            const byline = (
                doc.querySelector("meta[name='author']")?.getAttribute("content") ||
                doc.querySelector(".byline")?.textContent ||
                ""
            ).trim() || undefined;

            // Target main content element: <article> -> <main> -> [role="main"] -> <body>
            const articleEl = doc.querySelector("article") || doc.querySelector("main") || doc.querySelector('[role="main"]') || doc.body;
            if (!articleEl) {
                return null;
            }

            const rawContent = articleEl.innerHTML.trim();
            if (!rawContent) {
                return null;
            }

            const sanitizedContent = DOMPurify.sanitize(rawContent, {
                ALLOWED_TAGS: [
                    "h1", "h2", "h3", "h4", "h5", "h6",
                    "p", "a", "img", "blockquote", "ul", "ol", "li",
                    "code", "pre", "em", "strong", "b", "i", "u", "s",
                    "hr", "br", "table", "thead", "tbody", "tr", "th", "td",
                    "figure", "figcaption", "sup", "sub", "mark", "span", "div"
                ],
                ALLOWED_ATTR: ["href", "src", "alt", "title", "class", "id", "target", "rel", "width", "height"],
            });

            // Find lead image: og:image -> first <img>
            let leadImageUrl: string | undefined;
            const metaImg = doc.querySelector<HTMLMetaElement>("meta[property='og:image'], meta[name='twitter:image']");
            if (metaImg) {
                leadImageUrl = metaImg.getAttribute("content") || undefined;
            } else {
                const firstImg = articleEl.querySelector<HTMLImageElement>("img[src]");
                if (firstImg) {
                    leadImageUrl = firstImg.getAttribute("src") || undefined;
                }
            }

            const textContent = articleEl.textContent?.trim() || "";
            const excerpt = doc.querySelector("meta[name='description'], meta[property='og:description']")?.getAttribute("content") || undefined;
            const siteName = doc.querySelector("meta[property='og:site_name']")?.getAttribute("content") || undefined;
            const publishedTime = doc.querySelector("meta[property='article:published_time']")?.getAttribute("content") || undefined;

            return {
                title,
                byline,
                content: sanitizedContent,
                textContent,
                excerpt,
                siteName,
                leadImageUrl,
                publishedTime,
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
            return await this.extractFromHtml(html, url);
        } catch (error) {
            console.error(`[ArticleExtractor] Failed to extract article from ${url}:`, error);
            return null;
        }
    }
}
