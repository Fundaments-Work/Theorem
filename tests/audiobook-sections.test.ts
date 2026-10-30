// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
    collectAudioSections,
    extractSpeechText,
    sectionTitlesFromToc,
    type AudioSectionSource,
} from "../src/features/reader/engines/audio-sections";

// Save as Audiobook: chapter names come from the table of contents, and the
// cover, the contents page and non-linear items are not narrated.

const parser = new DOMParser();
const doc = (body: string) =>
    parser.parseFromString(`<html><head><title>t</title></head><body>${body}</body></html>`, "text/html");

function source(id: string, body: string, extra: Partial<AudioSectionSource> = {}): AudioSectionSource {
    return { id, createDocument: async () => doc(body), ...extra };
}

describe("sectionTitlesFromToc", () => {
    it("names each section after the TOC entry that points into it", () => {
        const titles = sectionTitlesFromToc(
            ["cover.xhtml", "ch1.xhtml", "ch2.xhtml", "ch3.xhtml"],
            [
                { label: "Chapter One", href: "ch1.xhtml" },
                {
                    label: "Chapter Two", href: "ch2.xhtml#start",
                    subitems: [{ label: "A Scene", href: "ch2.xhtml#s1" }],
                },
            ],
        );
        expect(titles.get(1)).toBe("Chapter One");
        expect(titles.get(2)).toBe("Chapter Two");
        expect(titles.has(0)).toBe(false);
        expect(titles.has(3)).toBe(false);
    });

    it("prefers the deepest entry that opens the section, and nested parts keep their own file", () => {
        const titles = sectionTitlesFromToc(
            ["part1.xhtml", "ch1.xhtml", "ch2.xhtml"],
            [{
                label: "Part One", href: "part1.xhtml",
                subitems: [
                    { label: "Chapter 1", href: "ch1.xhtml" },
                    { label: "Book II", href: "ch2.xhtml", subitems: [{ label: "Chapter 2", href: "ch2.xhtml" }] },
                ],
            }],
        );
        expect([...titles.entries()]).toEqual([[0, "Part One"], [1, "Chapter 1"], [2, "Chapter 2"]]);
    });

    it("matches encoded, relative-looking and differently-cased-fragment hrefs; ignores broken ones", () => {
        const titles = sectionTitlesFromToc(
            ["Text/ch 1.xhtml", "Text/ch2.xhtml"],
            [
                { label: "  Spaced   Title ", href: "Text/ch%201.xhtml" },
                { label: "Broken", href: "Text/missing.xhtml" },
                { label: "", href: "Text/ch2.xhtml" },
                { label: "No href" },
                { label: "Bad %E0%A4%A", href: "%E0%A4%A" },
            ],
        );
        expect(titles.get(0)).toBe("Spaced Title");
        // An empty label is no name.
        expect(titles.has(1)).toBe(false);
    });

    it("uses the book's own resolver for formats whose TOC is not file paths", () => {
        const titles = sectionTitlesFromToc(
            ["0", "1"],
            [{ label: "Opening", href: "filepos:0042" }],
            (href) => (href === "filepos:0042" ? 1 : null),
        );
        expect(titles.get(1)).toBe("Opening");
    });

    it("copes with no TOC", () => {
        expect(sectionTitlesFromToc(["a"], undefined).size).toBe(0);
        expect(sectionTitlesFromToc([], [{ label: "x", href: "a" }]).size).toBe(0);
    });
});

describe("extractSpeechText", () => {
    it("keeps paragraph breaks between blocks and drops scripts, styles and SVG text", () => {
        const d = doc(`<h1>Title</h1>\n  <p>One\n   two.</p><p>Three<br/>four.</p>
            <script>var x = 1</script><style>p{}</style><svg><title>Cover art</title></svg><div><p>Five.</p></div>`);
        expect(extractSpeechText(d.body)).toBe("Title\n\nOne two.\n\nThree\nfour.\n\nFive.");
    });

    it("is empty for an empty body", () => {
        expect(extractSpeechText(doc("").body)).toBe("");
    });
});

describe("collectAudioSections", () => {
    it("narrates the chapters only, named from the TOC", async () => {
        const sections = [
            source("cover.xhtml", `<div><img src="cover.jpg" alt="Cover"/></div>`),
            source("nav.xhtml", `<nav><ol><li><a href="ch1.xhtml">Chapter One</a></li></ol></nav>`),
            source("ch1.xhtml", `<h2>I</h2><p>It was a dark night.</p>`),
            source("ch1_split.xhtml", `<p>The night went on.</p>`),
            source("ch2.xhtml", `<p id="start">Morning came.</p>`),
            source("notes.xhtml", `<p>1. A footnote.</p>`, { linear: "no" }),
        ];
        const out = await collectAudioSections({
            sections,
            toc: [
                { label: "Chapter One", href: "ch1.xhtml" },
                { label: "Chapter Two", href: "ch2.xhtml#start" },
            ],
            navPath: "nav.xhtml",
        });
        expect(out.map((s) => s.title)).toEqual(["Chapter One", "Chapter Two"]);
        // A split continuation of a chapter is narrated as part of it, not as "Section 4".
        expect(out[0].text).toBe("I\n\nIt was a dark night.\n\nThe night went on.");
        expect(out[1]).toEqual({ id: "section-4", title: "Chapter Two", text: "Morning came." });
    });

    it("skips the contents page found through landmarks and the cover named by the package", async () => {
        const out = await collectAudioSections({
            sections: [
                source("titlepage.xhtml", `<svg><image href="c.jpg"/><title>Moby Dick</title></svg>`),
                source("contents.xhtml", `<h1>Contents</h1><p>Chapter 1 ..... 3</p>`),
                source("frontcover.xhtml", `<p>Cover</p><img src="c.jpg"/>`),
                source("ch1.xhtml", `<h1>Loomings</h1><p>Call me Ishmael.</p>`),
            ],
            toc: [],
            landmarks: [{ type: ["toc"], href: "contents.xhtml" }, { type: ["cover"], href: "frontcover.xhtml" }],
            coverHref: "titlepage.xhtml",
        });
        expect(out.map((s) => s.title)).toEqual(["Loomings"]);
    });

    it("falls back to the first heading, then to Section N", async () => {
        const out = await collectAudioSections({
            sections: [
                source("a.xhtml", `<p>Untitled opening text.</p>`),
                source("b.xhtml", `<header><h3>  The   Second  </h3></header><p>Body.</p>`),
            ],
            toc: undefined,
        });
        expect(out.map((s) => s.title)).toEqual(["Section 1", "The Second"]);
    });

    it("keeps an illustrated page that also has real text", async () => {
        const out = await collectAudioSections({
            sections: [source("plate.xhtml", `<img src="map.png"/><p>The map shows the island of Thule in winter.</p>`)],
            toc: [{ label: "The Map", href: "plate.xhtml" }],
        });
        expect(out).toHaveLength(1);
        expect(out[0].title).toBe("The Map");
    });

    it("skips sections that fail to load and keeps going", async () => {
        const out = await collectAudioSections({
            sections: [
                { id: "bad.xhtml", createDocument: async () => { throw new Error("corrupt"); } },
                { id: "none.xhtml" },
                source("ok.xhtml", `<p>Fine.</p>`),
            ],
            toc: [{ label: "Fine", href: "ok.xhtml" }],
        });
        expect(out).toEqual([{ id: "section-2", title: "Fine", text: "Fine." }]);
    });

    it("returns nothing for a book with no sections", async () => {
        expect(await collectAudioSections({ sections: [], toc: [] })).toEqual([]);
    });
});
