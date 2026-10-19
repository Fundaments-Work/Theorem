import { describe, it, expect } from "vitest";
import { sanitizeArticleHtml } from "../src/features/reader/article-reader/utils";

describe("sanitizeArticleHtml URL policy", () => {
    it("strips script and non-image data schemes from links", () => {
        const out = sanitizeArticleHtml(
            "<p>"
            + '<a href="javascript:alert(1)">ja</a>'
            + '<a href="vbscript:msgbox(1)">vb</a>'
            + '<a href="data:text/html,<script>alert(1)</script>">da</a>'
            + "</p>",
        );
        expect(out).not.toMatch(/javascript:/i);
        expect(out).not.toMatch(/vbscript:/i);
        expect(out).not.toMatch(/data:text\/html/i);
        expect(out).toContain("ja");
        expect(out).toContain("vb");
        expect(out).toContain("da");
    });

    it("keeps https, mailto and relative links, opening them outside the app", () => {
        const out = sanitizeArticleHtml(
            '<p><a href="https://example.com">https</a>'
            + '<a href="mailto:ada@example.com">mail</a>'
            + '<a href="/local">rel</a></p>',
        );
        expect(out).toContain('href="https://example.com"');
        expect(out).toContain('href="mailto:ada@example.com"');
        expect(out).toContain('href="/local"');
        expect(out).toContain('target="_blank"');
        expect(out).toContain('rel="noopener noreferrer"');
    });

    it("strips link schemes outside the app allowlist", () => {
        const out = sanitizeArticleHtml('<p><a href="ftp://example.com/file">ftp</a></p>');
        expect(out).not.toContain("ftp:");
        expect(out).toContain("ftp");
    });

    it("keeps image data URIs but strips non-image data URIs and script sources", () => {
        const out = sanitizeArticleHtml(
            "<p>"
            + '<img src="data:image/png;base64,AAAA" alt="ok">'
            + '<img src="data:text/html,<script>alert(1)</script>" alt="bad">'
            + '<img src="javascript:alert(1)" alt="js">'
            + "</p>",
        );
        expect(out).toContain('src="data:image/png;base64,AAAA"');
        expect(out).not.toMatch(/data:text\/html/i);
        expect(out).not.toMatch(/javascript:/i);
    });

    it("strips schemes obfuscated with control characters", () => {
        const out = sanitizeArticleHtml('<p><a href="java\tscript:alert(1)">x</a></p>');
        expect(out).not.toMatch(/javascript:/i);
    });
});
