import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
    decodeDoubleEscapedHtml,
    looksLikeDoubleEscapedHtml,
    sanitizeArticleHtml,
    selectArticleBody,
} from "../src/features/reader/article-reader/utils";

// ─── #107: RSS article body selection ───

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

// ─── #107: double-escaped HTML from native parser ───

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

// ─── Library selection wiring (static guards) ───

describe("library multi-select wiring", () => {
    const libraryTsx = readFileSync(
        resolve("src/features/library/Library.tsx"),
        "utf-8",
    );

    it("toolbar select button exposes data-action for Ctrl+A shortcut", () => {
        expect(libraryTsx).toContain('data-action="toggle-select-mode"');
    });

    it("selection checkbox exists in grid, list, and compact views", () => {
        const checkboxBlocks = libraryTsx.match(/\{isSelecting && \(/g) || [];
        expect(checkboxBlocks.length).toBeGreaterThanOrEqual(3);
    });

    it("selection lookups use a Set, not O(n) includes per card", () => {
        expect(libraryTsx).toContain("selectedBookIds");
        expect(libraryTsx).not.toContain("selectedBooks.includes");
    });

    it("memo comparison covers audioTrack and rating", () => {
        expect(libraryTsx).toContain("prev.book.audioTrack === next.book.audioTrack");
        expect(libraryTsx).toContain("prev.book.rating === next.book.rating");
    });
});

// ─── #102: memory-trim IPC path ───

describe("sqliteShrinkMemory IPC path", () => {
    const storage = readFileSync(
        resolve("src/core/lib/sqlite-storage.ts"),
        "utf-8",
    );

    it("prefers trim_memory entry point over direct sqlite_shrink_memory", () => {
        expect(storage).toContain("invoke('trim_memory')");
    });

    it("throttles hot-path invocations", () => {
        expect(storage).toContain("SHRINK_MEMORY_THROTTLE_MS");
    });
});
