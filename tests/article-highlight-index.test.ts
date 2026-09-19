import { describe, expect, it } from "vitest";
import {
    applyHighlightToIndexedNodes,
    buildArticleTextIndex,
    buildIndexedRange,
} from "../src/features/reader/article-reader/ArticleViewer";
import { setElementHtml } from "../src/core/lib/sanitize";

function makeRoot(html: string): HTMLDivElement {
    const root = document.createElement("div");
    setElementHtml(root, html);
    document.body.appendChild(root);
    return root;
}

describe("buildArticleTextIndex", () => {
    it("indexes offsets and full text in one pass", () => {
        const root = makeRoot("<p>Hello</p><p> brave new <b>world</b></p>");
        try {
            const index = buildArticleTextIndex(root);
            expect(index.fullText).toBe("Hello brave new world");
            expect(index.totalLength).toBe("Hello brave new world".length);
            // "Hello" | " brave new " | "world"
            expect(index.nodes.length).toBe(3);
            expect(index.starts).toEqual([0, 5, 16]);
        } finally {
            root.remove();
        }
    });

    it("skips empty text nodes like the legacy walker", () => {
        const root = makeRoot("<p>A</p>   <p>B</p>");
        try {
            const index = buildArticleTextIndex(root);
            // Whitespace-only run between paragraphs is one text node.
            expect(index.fullText).toBe("A   B");
            expect(index.totalLength).toBe(5);
        } finally {
            root.remove();
        }
    });
});

describe("buildIndexedRange", () => {
    it("resolves snapshots to the exact text", () => {
        const root = makeRoot("<p>Hello</p><p> brave new <b>world</b></p>");
        try {
            const index = buildArticleTextIndex(root);
            const start = index.fullText.indexOf("brave");
            const found = buildIndexedRange(
                { start, end: start + "brave new world".length, text: "" },
                index,
            );
            expect(found).not.toBeNull();
            expect(found!.range.toString()).toBe("brave new world");
        } finally {
            root.remove();
        }
    });

    it("returns null for empty and out-of-range snapshots", () => {
        const root = makeRoot("<p>Hi</p>");
        try {
            const index = buildArticleTextIndex(root);
            expect(buildIndexedRange({ start: 1, end: 1, text: "" }, index)).toBeNull();
            expect(
                buildIndexedRange({ start: 1000, end: 2000, text: "" }, index),
            ).toBeNull();
        } finally {
            root.remove();
        }
    });

    it("clamps end overflow to the last node", () => {
        const root = makeRoot("<p>Hi</p>");
        try {
            const index = buildArticleTextIndex(root);
            const found = buildIndexedRange({ start: 0, end: 9999, text: "" }, index);
            expect(found).not.toBeNull();
            expect(found!.range.toString()).toBe("Hi");
        } finally {
            root.remove();
        }
    });
});

describe("applyHighlightToIndexedNodes", () => {
    it("marks the snapshot text and skips already-marked regions", () => {
        const root = makeRoot("<p>Hello brave new world</p>");
        try {
            const index = buildArticleTextIndex(root);
            const found = buildIndexedRange({ start: 6, end: 11, text: "" }, index);
            expect(found).not.toBeNull();
            const applied = applyHighlightToIndexedNodes(found!, index, "h1", "yellow");
            expect(applied).toBe(true);
            const mark = root.querySelector('mark.article-highlight[data-highlight-id="h1"]');
            expect(mark?.textContent).toBe("brave");
            // Second application over the same snapshot is a no-op.
            const again = applyHighlightToIndexedNodes(found!, index, "h2", "yellow");
            expect(again).toBe(false);
        } finally {
            root.remove();
        }
    });
});
