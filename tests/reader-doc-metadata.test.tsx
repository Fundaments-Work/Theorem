// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { toDocMetadata, metadataText } from "../src/features/reader/engines/doc-metadata";
import { BookInfoPopover } from "../src/features/reader/components/BookInfoPopover";
import type { DocMetadata } from "../src/core/types";

// Shapes produced by foliate-js-runtime/epub.js for an EPUB 3 package.
const contributor = (name: unknown) => ({ name, sortAs: "Sort", role: ["pbl"], code: undefined, scheme: undefined });

describe("metadataText", () => {
    it("returns plain strings trimmed", () => {
        expect(metadataText("  Standard Ebooks \n")).toBe("Standard Ebooks");
    });

    it("returns undefined for empty, null and whitespace", () => {
        expect(metadataText(undefined)).toBeUndefined();
        expect(metadataText(null)).toBeUndefined();
        expect(metadataText("   ")).toBeUndefined();
        expect(metadataText([])).toBeUndefined();
        expect(metadataText({})).toBeUndefined();
    });

    it("reads a contributor object by its name", () => {
        expect(metadataText(contributor("Standard Ebooks"))).toBe("Standard Ebooks");
    });

    it("joins a list of contributors", () => {
        expect(metadataText([contributor("A Press"), contributor("B Press")])).toBe("A Press, B Press");
    });

    it("reads a language map (alternate scripts)", () => {
        expect(metadataText(contributor({ ne: "साझा प्रकाशन", en: "Sajha Prakashan" }))).toBe("साझा प्रकाशन");
    });

    it("joins language code arrays and drops empty entries", () => {
        expect(metadataText(["en", "", "ne"])).toBe("en, ne");
    });

    it("formats numbers", () => {
        expect(metadataText(1901)).toBe("1901");
    });

    it("does not loop on self-referencing objects", () => {
        const loop: Record<string, unknown> = {};
        loop.name = loop;
        expect(metadataText(loop)).toBeUndefined();
    });
});

describe("toDocMetadata", () => {
    it("turns raw foliate EPUB metadata into strings only", () => {
        const doc = toDocMetadata({
            title: { en: "Pride and Prejudice" },
            author: [contributor("Jane Austen")],
            publisher: [contributor("Standard Ebooks")],
            language: ["en"],
            published: "1813-01-28",
            identifier: "url:https://standardebooks.org/ebooks/jane-austen/pride-and-prejudice",
            description: "A novel.",
        });

        expect(doc).toEqual({
            title: "Pride and Prejudice",
            author: "Jane Austen",
            publisher: "Standard Ebooks",
            language: "en",
            pubdate: "1813-01-28",
            identifier: "url:https://standardebooks.org/ebooks/jane-austen/pride-and-prejudice",
            description: "A novel.",
        });
        for (const value of Object.values(doc)) {
            expect(["string", "undefined"]).toContain(typeof value);
        }
    });

    it("falls back when metadata is missing or corrupted", () => {
        expect(toDocMetadata(undefined)).toEqual({ title: "Unknown Title", author: "Unknown Author" });
        expect(toDocMetadata({ title: 42 as unknown, author: { foo: {} }, publisher: [{}] })).toEqual({
            title: "42",
            author: "Unknown Author",
        });
    });
});

describe("BookInfoPopover", () => {
    it("renders without crashing when a field is not text", () => {
        const metadata = {
            title: "Book",
            author: "Author",
            publisher: [contributor("Standard Ebooks")],
            language: ["en"],
        } as unknown as DocMetadata;

        // renderToString throws synchronously on an invalid child, as the reader did.
        let html = "";
        expect(() => {
            html = renderToString(<BookInfoPopover metadata={metadata} visible={false} onClose={() => {}} />);
        }).not.toThrow();
        expect(html).toContain("Standard Ebooks");
    });
});
