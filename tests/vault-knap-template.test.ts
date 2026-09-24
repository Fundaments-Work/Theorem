import { describe, it, expect } from "vitest";
import {
    DEFAULT_KNAP_TEMPLATE,
    validateKnapTemplate,
    renderKnapBookPage,
    type KnapBookData,
} from "../src/core/lib/knap-templates";

describe("Knap AST Template Engine", () => {
    const sampleBook: KnapBookData = {
        id: "book-123",
        title: "Frankenstein; or, The Modern Prometheus",
        author: "Mary Wollstonecraft Shelley",
        format: "epub",
        filePath: "/library/frankenstein.epub",
        highlights: [
            {
                id: "h-1",
                text: "Beware; for I am fearless, and therefore powerful.",
                note: "Monologue to Victor.",
                color: "yellow",
                createdAt: "2026-09-24T12:00:00Z",
                chapterTitle: "Chapter 20",
            },
            {
                id: "h-2",
                text: "Nothing is so painful to the human mind as a great and sudden change.",
                note: null,
                color: "green",
                createdAt: "2026-09-24T12:30:00Z",
                chapterTitle: "Chapter 23",
            },
        ],
        totalHighlights: 2,
        syncDate: "2026-09-24",
        tags: ["reading/highlights", "classics"],
    };

    it("validates the default Knap template without errors", () => {
        const result = validateKnapTemplate(DEFAULT_KNAP_TEMPLATE);
        expect(result.valid).toBe(true);
        expect(result.errors).toEqual([]);
    });

    it("catches empty template inputs", () => {
        const emptyResult = validateKnapTemplate("   ");
        expect(emptyResult.valid).toBe(false);
        expect(emptyResult.errors.length).toBeGreaterThan(0);
        expect(emptyResult.errors[0]).toContain("empty");
    });

    it("catches malformed tags and unclosed blocks", () => {
        const malformed = "{% for item in highlights %}{{ item.text }";
        const result = validateKnapTemplate(malformed);
        expect(result.valid).toBe(false);
        expect(result.errors.length).toBeGreaterThan(0);
    });

    it("catches unknown filter names", () => {
        const unknownFilter = "{{ title | non_existent_filter_xyz }}";
        const result = validateKnapTemplate(unknownFilter);
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes("non_existent_filter_xyz"))).toBe(true);
    });

    it("renders default template with frontmatter, wikilinks, and highlights", async () => {
        const res = await renderKnapBookPage(DEFAULT_KNAP_TEMPLATE, sampleBook);
        expect(res.errors).toEqual([]);
        expect(res.output).toContain('title: "Frankenstein; or, The Modern Prometheus"');
        expect(res.output).toContain('author: "Mary Wollstonecraft Shelley"');
        expect(res.output).toContain("*By [[Mary Wollstonecraft Shelley]]*");
        expect(res.output).toContain("> ==Beware; for I am fearless, and therefore powerful.==");
        expect(res.output).toContain("**Note**: Monologue to Victor.");
        expect(res.output).toContain("> ==Nothing is so painful to the human mind as a great and sudden change.==");
    });

    it("supports custom callouts and filter expressions", async () => {
        const customTemplate = `
# {{ title }}
{% for item in highlights %}
> [!quote] {{ item.chapterTitle | default: "General" }}
> {{ item.text }}
{% if item.note %}
> [!note] Personal Reflection
> {{ item.note }}
{% endif %}
{% endfor %}
        `.trim();

        const res = await renderKnapBookPage(customTemplate, sampleBook);
        expect(res.errors).toEqual([]);
        expect(res.output).toContain("# Frankenstein; or, The Modern Prometheus");
        expect(res.output).toContain("> [!quote] Chapter 20");
        expect(res.output).toContain("> Beware; for I am fearless, and therefore powerful.");
        expect(res.output).toContain("> [!note] Personal Reflection");
        expect(res.output).toContain("> Monologue to Victor.");
        expect(res.output).toContain("> [!quote] Chapter 23");
    });

    it("handles books with zero highlights gracefully", async () => {
        const emptyBook: KnapBookData = {
            ...sampleBook,
            highlights: [],
            totalHighlights: 0,
        };

        const res = await renderKnapBookPage(DEFAULT_KNAP_TEMPLATE, emptyBook);
        expect(res.errors).toEqual([]);
        expect(res.output).toContain("total_highlights: 0");
        expect(res.output).toContain("# Frankenstein; or, The Modern Prometheus");
    });
});
