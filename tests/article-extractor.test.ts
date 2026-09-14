import { describe, it, expect } from "vitest";
import { ArticleExtractorService } from "../src/core/services/ArticleExtractorService";

describe("ArticleExtractorService", () => {
    it("extracts clean readable article content from HTML", async () => {
        const sampleHtml = `
            <!DOCTYPE html>
            <html>
            <head>
                <title>Revolutionary E-Reader Architecture</title>
                <meta property="og:image" content="https://example.com/cover.jpg">
            </head>
            <body>
                <header>
                    <nav><a href="/">Home</a><a href="/news">News</a></nav>
                </header>
                <div class="ad-banner">Buy our widget!</div>
                <article>
                    <h1>Revolutionary E-Reader Architecture</h1>
                    <p class="byline">By Ada Lovelace</p>
                    <p>Theorem ebook reader combines local-first SQLite persistence with peer-to-peer synchronization and native rendering engines.</p>
                    <p>This is a second paragraph demonstrating multi-paragraph full article extraction without ads or navigation menus.</p>
                    <img src="/images/diagram.png" alt="Architecture Diagram">
                </article>
                <footer>
                    <p>Copyright 2026</p>
                    <div class="cookie-notice">We use cookies</div>
                </footer>
            </body>
            </html>
        `;

        const extracted = await ArticleExtractorService.extractFromHtml(sampleHtml, "https://example.com/posts/ereader");
        expect(extracted).not.toBeNull();
        expect(extracted?.title).toBe("Revolutionary E-Reader Architecture");
        expect(extracted?.content).toContain("Theorem ebook reader combines local-first SQLite persistence");
        expect(extracted?.content).toContain("This is a second paragraph");
        expect(extracted?.content).not.toContain("Buy our widget!");
        expect(extracted?.content).not.toContain("cookie-notice");
        // Relative image src should be resolved to absolute URL
        expect(extracted?.content).toContain('src="https://example.com/images/diagram.png"');
        expect(extracted?.leadImageUrl).toBe("https://example.com/cover.jpg");
    });

    it("returns null on empty or unparseable input", async () => {
        const extracted = await ArticleExtractorService.extractFromHtml("");
        expect(extracted).toBeNull();
    });

    it("sanitizes dangerous script tags from extracted content", async () => {
        const maliciousHtml = `
            <html>
            <body>
                <article>
                    <h1>Security Test</h1>
                    <p>This is safe content.</p>
                    <script>alert('xss');</script>
                    <img src="x" onerror="alert(1)">
                </article>
            </body>
            </html>
        `;

        const extracted = await ArticleExtractorService.extractFromHtml(maliciousHtml);
        expect(extracted).not.toBeNull();
        expect(extracted?.content).not.toContain("<script>");
        expect(extracted?.content).not.toContain("onerror");
    });
});
