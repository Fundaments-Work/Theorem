import { describe, expect, it, vi } from "vitest";
import { looksLikeMarkdown, needsMarkdownRender, plainTextToHtml } from "../src/core/lib/article-markdown";
import { convertStoredMarkdownArticles } from "../src/core/store/rssStore";
import type { RssArticle } from "../src/core/types";

describe("article markdown (rendering lives in Rust)", () => {
    it("detects markdown that still needs rendering", () => {
        expect(looksLikeMarkdown("## Heading")).toBe(true);
        expect(looksLikeMarkdown("Just a sentence.")).toBe(false);
        expect(needsMarkdownRender("## Heading")).toBe(true);
        expect(needsMarkdownRender("<h2>Heading</h2>\n- x")).toBe(false);
        expect(needsMarkdownRender(undefined)).toBe(false);
        expect(needsMarkdownRender("")).toBe(false);
    });

    it("plain-text fallback escapes everything and keeps paragraphs", () => {
        expect(plainTextToHtml("# <script>x</script>\r\n\r\nline 1\nline 2\n\n\n  "))
            .toBe("<p># &lt;script&gt;x&lt;/script&gt;</p>\n<p>line 1<br>line 2</p>");
        expect(plainTextToHtml("")).toBe("");
    });
});

describe("convertStoredMarkdownArticles", () => {
    const article = (id: string, content: string, summary?: string) =>
        ({ id, feedId: "f", title: id, url: `https://x/${id}`, content, summary, fetchedAt: new Date(), isRead: false, isFavorite: false }) as unknown as RssArticle;

    it("renders only markdown fields, in one batch", async () => {
        const render = vi.fn(async (items: string[]) => items.map((item) => `<r>${item}</r>`));
        const patches = await convertStoredMarkdownArticles([
            article("a", "## md", "**sum**"),
            article("b", "<p>html</p>", "plain"),
            article("c", "plain text", "- list"),
        ], render);
        expect(render).toHaveBeenCalledTimes(1);
        expect(render.mock.calls[0][0]).toEqual(["## md", "**sum**", "- list"]);
        expect(patches).toEqual(new Map([
            ["a", { content: "<r>## md</r>", summary: "<r>**sum**</r>" }],
            ["c", { summary: "<r>- list</r>" }],
        ]));
    });

    it("returns null when nothing needs converting or the renderer misbehaves", async () => {
        const render = vi.fn(async () => [] as string[]);
        expect(await convertStoredMarkdownArticles([article("b", "<p>x</p>")], render)).toBeNull();
        expect(render).not.toHaveBeenCalled();
        expect(await convertStoredMarkdownArticles([article("a", "## md")], render)).toBeNull();
    });
});
