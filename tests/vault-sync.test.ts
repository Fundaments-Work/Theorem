import { describe, it, expect } from "vitest";
import {
    buildVocabularyMarkdown,
    buildBookPageMarkdown,
    buildBookPages,
} from "../src/core/lib/vault-sync";
import type { Annotation, Book, VocabularyTerm } from "../src/core/types";

describe("Vault Sync — Lemma FSRS Vocabulary Deck", () => {
    const mockTerms: VocabularyTerm[] = [
        {
            id: "vocab-1",
            term: "ephemeral",
            normalizedTerm: "ephemeral",
            language: "en",
            phonetic: "ɪˈfɛm(ə)rəl",
            meanings: [
                {
                    partOfSpeech: "adjective",
                    definitions: ["Lasting for a very short time."],
                    provider: "mdict",
                },
                {
                    partOfSpeech: "noun",
                    definitions: ["An ephemeral plant or insect."],
                    provider: "mdict",
                },
            ],
            providerHistory: ["mdict"],
            contexts: ["The beauty of the cherry blossoms was ephemeral."],
            createdAt: new Date("2026-09-01T10:00:00Z"),
        },
        {
            id: "vocab-2",
            term: "solitude",
            normalizedTerm: "solitude",
            language: "en",
            phonetic: "ˈsɒlɪtjuːd",
            meanings: [
                {
                    partOfSpeech: "noun",
                    definitions: ["The state or situation of being alone."],
                    provider: "free-dictionary",
                },
            ],
            providerHistory: ["free-dictionary"],
            contexts: [],
            createdAt: new Date("2026-09-02T10:00:00Z"),
        },
    ];

    it("generates frontmatter containing flashcards tag for Lemma auto-discovery", () => {
        const md = buildVocabularyMarkdown(mockTerms, "2026-09-11T12:00:00.000Z");
        expect(md).toContain("tags:\n  - flashcards\n  - theorem\n  - vocabulary");
        expect(md).toContain('title: "Theorem Vocabulary"');
        expect(md).toContain('type: "theorem-vocabulary"');
        expect(md).toContain("terms_total: 2");
    });

    it("formats cards with ---card--- separator and Lemma-compatible front/back", () => {
        const md = buildVocabularyMarkdown(mockTerms, "2026-09-11T12:00:00.000Z");

        // Verify card delimiter
        expect(md).toContain("---card---");
        // Verify block ID format ^fsrs-vocab-<id>
        expect(md).toContain("### ephemeral *[/ɪˈfɛm(ə)rəl/]* ^fsrs-vocab-vocab-1");
        // Verify in-book context quote
        expect(md).toContain('> "The beauty of the cherry blossoms was ephemeral."');
        // Verify separator between front and back
        expect(md).toContain("\n---\n");
        // Verify definitions formatting
        expect(md).toContain("1. **adjective**: Lasting for a very short time.");
        expect(md).toContain("2. **noun**: An ephemeral plant or insect.");
    });

    it("is strictly parseable by Lemma's parseBasicCards engine", () => {
        const md = buildVocabularyMarkdown(mockTerms, "2026-09-11T12:00:00.000Z");

        // Mirror Lemma DataManager.ts parseBasicCards algorithm
        const basicCardsRaw = md.split(/---\s*card\s*---/i).slice(1);
        expect(basicCardsRaw.length).toBe(2);

        // Card 1: ephemeral
        const parts0 = basicCardsRaw[0].split(/\n---\n/);
        expect(parts0.length).toBeGreaterThanOrEqual(2);
        const frontPart0 = parts0[0];
        const backPart0 = parts0.slice(1).join("\n---\n");

        const cleanFront0 = frontPart0.replace(/\?type\b\s*/g, "").trim();
        const blockIdMatch0 = cleanFront0.match(/\^([a-zA-Z0-9-]+)\s*$/m);
        expect(blockIdMatch0).not.toBeNull();
        expect(blockIdMatch0?.[1]).toBe("fsrs-vocab-vocab-1");

        const strippedFront0 = cleanFront0.replace(/\^([a-zA-Z0-9-]+)\s*$/m, "").trim();
        expect(strippedFront0).toContain("### ephemeral *[/ɪˈfɛm(ə)rəl/]*");
        expect(strippedFront0).toContain('> "The beauty of the cherry blossoms was ephemeral."');

        expect(backPart0).toContain("1. **adjective**: Lasting for a very short time.");
        expect(backPart0).toContain("2. **noun**: An ephemeral plant or insect.");

        // Card 2: solitude
        const parts1 = basicCardsRaw[1].split(/\n---\n/);
        expect(parts1.length).toBeGreaterThanOrEqual(2);
        const frontPart1 = parts1[0];
        const cleanFront1 = frontPart1.replace(/\?type\b\s*/g, "").trim();
        const blockIdMatch1 = cleanFront1.match(/\^([a-zA-Z0-9-]+)\s*$/m);
        expect(blockIdMatch1).not.toBeNull();
        expect(blockIdMatch1?.[1]).toBe("fsrs-vocab-vocab-2");
    });

    it("handles empty terms gracefully", () => {
        const md = buildVocabularyMarkdown([], "2026-09-11T12:00:00.000Z");
        expect(md).toContain("_No vocabulary terms available._");
        expect(md).toContain("terms_total: 0");
    });
});

describe("Vault Sync — Obsidian Book Highlights & Notes", () => {
    const mockSource = {
        id: "book-1",
        title: "Dune",
        author: "Frank Herbert",
        format: "epub",
        filePath: "/books/dune.epub",
    };

    const mockAnnotations: Annotation[] = [
        {
            id: "anno-1",
            bookId: "book-1",
            type: "highlight",
            color: "yellow",
            location: "epubcfi(/6/4[chap01]!/4/2/10)",
            selectedText: "Fear is the mind-killer.",
            createdAt: new Date("2026-09-01T12:00:00Z"),
        },
        {
            id: "anno-2",
            bookId: "book-1",
            type: "note",
            color: "blue",
            location: "epubcfi(/6/4[chap01]!/4/2/18)",
            selectedText: "I must not fear.",
            noteContent: "The Litany Against Fear, repeated when facing terror.",
            createdAt: new Date("2026-09-01T12:05:00Z"),
        },
        {
            id: "anno-3",
            bookId: "book-1",
            type: "highlight",
            color: "green",
            location: "epubcfi(/6/4[chap01]!/4/2/24)",
            selectedText: "Line 1 of quote\nLine 2 of quote",
            createdAt: new Date("2026-09-01T12:10:00Z"),
        },
    ];

    it("formats quotes with native Obsidian > ==quote== syntax", () => {
        const md = buildBookPageMarkdown(mockSource, mockAnnotations, "2026-09-11T12:00:00.000Z");

        // Native highlight quote syntax
        expect(md).toContain("> ==Fear is the mind-killer.==");
        expect(md).toContain("> ==I must not fear.==");
        // Multiline highlight quote syntax
        expect(md).toContain("> ==Line 1 of quote==\n> ==Line 2 of quote==");

        // Note content cleanly positioned under quote
        expect(md).toContain("The Litany Against Fear, repeated when facing terror.");

        // Frontmatter
        expect(md).toContain('title: "Dune"');
        expect(md).toContain('author: "Frank Herbert"');
        expect(md).toContain("highlights_total: 2");
        expect(md).toContain("notes_total: 1");
        expect(md).toContain("annotations_total: 3");
    });

    it("contains no raw HTML mark tags or dead deep links", () => {
        const md = buildBookPageMarkdown(mockSource, mockAnnotations, "2026-09-11T12:00:00.000Z");
        expect(md).not.toContain("<mark");
        expect(md).not.toContain("</mark>");
        expect(md).not.toContain("theorem://");
    });

    it("buildBookPages assigns paths in the target directory", () => {
        const books: Book[] = [
            {
                id: "book-1",
                title: "Dune",
                author: "Frank Herbert",
                format: "epub",
                filePath: "/books/dune.epub",
                coverPath: "",
                addedAt: new Date(),
                progress: 0.1,
            },
        ];

        const pages = buildBookPages(
            books,
            [],
            mockAnnotations,
            "/vault/Theorem/Books",
        );

        expect(pages.length).toBe(1);
        expect(pages[0].source.title).toBe("Dune");
        expect(pages[0].annotations.length).toBe(3);
        expect(pages[0].absolutePath).toMatch(/\/vault\/Theorem\/Books\/Dune - Frank Herbert.*\.md/);
    });
});
