// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
    decodeDoubleEscapedHtml,
    looksLikeDoubleEscapedHtml,
    sanitizeArticleHtml,
    selectArticleBody,
} from "../src/features/reader/article-reader/utils";

// RSS article body selection and double-escaped HTML recovery (#107)

describe("selectArticleBody prefers extracted full content", () => {
    it("prefers fullContent over content and summary", () => {
        expect(
            selectArticleBody({ fullContent: "full", content: "c", summary: "s" }),
        ).toBe("full");
    });

    it("falls back to content, then summary, then empty", () => {
        expect(selectArticleBody({ content: "c", summary: "s" })).toBe("c");
        expect(selectArticleBody({ summary: "s" })).toBe("s");
        expect(selectArticleBody({})).toBe("");
        expect(selectArticleBody(null)).toBe("");
        expect(selectArticleBody(undefined)).toBe("");
    });

    it("treats empty fullContent as missing", () => {
        expect(selectArticleBody({ fullContent: "", content: "c" })).toBe("c");
    });
});

describe("double-escaped HTML detection and recovery", () => {
    it("detects escaped markup without real tags", () => {
        expect(
            looksLikeDoubleEscapedHtml("&lt;p&gt;Hello&lt;/p&gt;"),
        ).toBe(true);
    });

    it("does not flag genuine markup", () => {
        expect(looksLikeDoubleEscapedHtml("<p>Hello</p>")).toBe(false);
    });

    it("does not flag plain entities in text", () => {
        expect(looksLikeDoubleEscapedHtml("Fish &amp; chips")).toBe(false);
    });

    it("decodes escaped markup back to tags", () => {
        expect(decodeDoubleEscapedHtml("&lt;p&gt;Hi&lt;/p&gt;")).toBe(
            "<p>Hi</p>",
        );
    });

    it("decodes prose entities to their rendered form", () => {
        // Single-level entities decode (renders identically in the DOM).
        expect(decodeDoubleEscapedHtml("Fish &amp; chips")).toBe(
            "Fish & chips",
        );
    });

    it("decodes numeric and double-encoded tag entities", () => {
        expect(decodeDoubleEscapedHtml("&#60;p&#62;Hi&#60;/p&#62;")).toBe(
            "<p>Hi</p>",
        );
        expect(decodeDoubleEscapedHtml("&amp;lt;p&amp;gt;Hi&amp;lt;/p&amp;gt;")).toBe(
            "<p>Hi</p>",
        );
    });

    it("decodes escaped tags inside mixed markup, preserving prose entities", () => {
        expect(
            decodeDoubleEscapedHtml("<div>Real</div>&lt;p&gt;Escaped&lt;/p&gt;"),
        ).toBe("<div>Real</div><p>Escaped</p>");
        expect(decodeDoubleEscapedHtml("<p>Fish &amp; chips</p>")).toBe(
            "<p>Fish &amp; chips</p>",
        );
    });
});

describe("sanitizeArticleHtml renders escaped feeds as markup", () => {
    it("double-escaped paragraph becomes a real element, not literal text", () => {
        const out = sanitizeArticleHtml("&lt;p&gt;Hello world&lt;/p&gt;");
        expect(out).toContain("<p>");
        expect(out).toContain("Hello world");
        expect(out).not.toContain("&lt;p&gt;");
    });

    it("still strips scripts from recovered markup", () => {
        const out = sanitizeArticleHtml(
            "&lt;p&gt;Safe&lt;/p&gt;&lt;script&gt;alert(1)&lt;/script&gt;",
        );
        expect(out).toContain("Safe");
        expect(out).not.toContain("script");
    });

    it("renders normal markup unchanged", () => {
        const out = sanitizeArticleHtml('<p>Plain <a href="https://example.com">link</a></p>');
        expect(out).toContain("<p>");
        expect(out).toContain("link");
    });

    it("escaped markup with markdown-like signals renders as markup, not literal tags", () => {
        // Transport-escaped HTML wins over markdown: asterisks stay literal.
        const out = sanitizeArticleHtml("&lt;p&gt;Hello **bold** text&lt;/p&gt;");
        expect(out).toContain("Hello");
        expect(out).not.toContain("&lt;p&gt;");
    });

    it("mixed genuine and escaped markup renders both as elements", () => {
        const out = sanitizeArticleHtml("<div>Real</div>&lt;p&gt;Escaped&lt;/p&gt;");
        expect(out).toContain("<div>Real</div>");
        expect(out).toContain("<p>Escaped</p>");
        expect(out).not.toContain("&lt;");
    });

    it("numeric and double-encoded entities render as elements", () => {
        expect(sanitizeArticleHtml("&#60;p&#62;Hi&#60;/p&#62;")).toContain("<p>Hi</p>");
        expect(sanitizeArticleHtml("&amp;lt;p&amp;gt;Hi&amp;lt;/p&amp;gt;")).toContain("<p>Hi</p>");
    });
});
