// @vitest-environment node
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
    extractPdfLinks,
    parseExplicitDestAnchor,
    resolvePdfDestTarget,
} from "../src/features/reader/engines/pdf-links";
import {
    buildPdfLensPreview,
    computeLensRegion,
    detectColumnRange,
    groupLensLines,
    selectLensRegion,
    toLensTextItems,
    type LensLine,
    type LensTextItem,
} from "../src/features/reader/engines/pdf-lens";

const item = (x: number, y: number, str: string, width = str.length * 5, height = 10): LensTextItem =>
    ({ x, y, width, height, str });
const line = (y: number, text: string, height = 10): LensLine => ({ y, x0: 50, x1: 300, height, text });

describe("extractPdfLinks", () => {
    it("classifies internal, external and named links and normalizes rects", () => {
        const links = extractPdfLinks([
            { annotationType: 2, rect: [10, 20, 30, 40], dest: "cite.a" },
            { annotationType: 2, rect: [30, 40, 10, 20], url: "https://example.org" },
            { annotationType: 2, rect: [0, 0, 5, 5], action: "NextPage" },
        ]);
        expect(links).toEqual([
            { kind: "internal", rect: [10, 20, 30, 40], dest: "cite.a" },
            { kind: "external", rect: [10, 20, 30, 40], url: "https://example.org" },
            { kind: "named", rect: [0, 0, 5, 5], action: "NextPage" },
        ]);
    });

    it("drops unsafe URLs, zero-area rects, non-links, unknown actions and malformed rects", () => {
        expect(extractPdfLinks([
            { annotationType: 2, rect: [0, 0, 10, 10], unsafeUrl: "javascript:alert(1)" },
            { annotationType: 2, rect: [5, 5, 5, 20], dest: "x" },
            { annotationType: 1, rect: [0, 0, 10, 10], dest: "x" },
            { annotationType: 2, rect: [0, 0, 10, 10], action: "Print" },
            { annotationType: 2, rect: [0, Number.NaN, 10, 10], dest: "x" },
            { annotationType: 2, rect: [0, 0, 10], dest: "x" },
            { annotationType: 2, rect: [0, 0, 10, 10], dest: "" },
        ])).toEqual([]);
    });

    it("handles an empty annotation list", () => {
        expect(extractPdfLinks([])).toEqual([]);
    });
});

describe("parseExplicitDestAnchor", () => {
    const ref = { num: 1, gen: 0 };
    it.each([
        [[ref, { name: "XYZ" }, 56, 700, null], { left: 56, top: 700 }],
        [[ref, { name: "XYZ" }, null, null, 0], { left: null, top: null }],
        [[ref, { name: "FitH" }, 500], { left: null, top: 500 }],
        [[ref, { name: "FitBH" }, 480], { left: null, top: 480 }],
        [[ref, { name: "FitV" }, 72], { left: 72, top: null }],
        [[ref, { name: "FitR" }, 10, 100, 200, 300], { left: 10, top: 300 }],
        [[ref, { name: "Fit" }], { left: null, top: null }],
        [[ref], { left: null, top: null }],
        [[ref, "garbage", "1", {}], { left: null, top: null }],
    ])("%j", (dest, expected) => {
        expect(parseExplicitDestAnchor(dest as unknown[])).toEqual(expected);
    });
});

describe("resolvePdfDestTarget", () => {
    const doc = {
        numPages: 3,
        getDestination: async (name: string) => (name === "known" ? [{ num: 7, gen: 0 }, { name: "XYZ" }, 40, 500, null] : null),
        getPageIndex: async (ref: { num: number }) => (ref.num === 7 ? 1 : 99),
    };

    it("resolves named destinations through getDestination", async () => {
        expect(await resolvePdfDestTarget(doc as never, "known")).toEqual({ pageNumber: 2, left: 40, top: 500 });
    });

    it("accepts a numeric page index", async () => {
        expect(await resolvePdfDestTarget(doc as never, [0, { name: "Fit" }])).toEqual({ pageNumber: 1, left: null, top: null });
    });

    it("returns null for missing names, out-of-range pages and garbage", async () => {
        expect(await resolvePdfDestTarget(doc as never, "missing")).toBeNull();
        expect(await resolvePdfDestTarget(doc as never, [5, { name: "Fit" }])).toBeNull();
        expect(await resolvePdfDestTarget(doc as never, [-1, { name: "Fit" }])).toBeNull();
        expect(await resolvePdfDestTarget(doc as never, [{ num: 1, gen: 0 }, { name: "Fit" }])).toBeNull();
        expect(await resolvePdfDestTarget(doc as never, [])).toBeNull();
        expect(await resolvePdfDestTarget(doc as never, 42)).toBeNull();
        const throwing = { ...doc, getPageIndex: async () => { throw new Error("bad xref"); } };
        expect(await resolvePdfDestTarget(throwing as never, [{ num: 7, gen: 0 }, { name: "Fit" }])).toBeNull();
    });
});

describe("toLensTextItems", () => {
    it("keeps upright text, skips empty and rotated items, derives missing height", () => {
        const items = toLensTextItems([
            { str: "a", transform: [10, 0, 0, 10, 5, 6], width: 5, height: 10 },
            { str: "   ", transform: [10, 0, 0, 10, 5, 6], width: 5, height: 10 },
            { str: "rot", transform: [0, 10, -10, 0, 5, 6], width: 5, height: 10 },
            { str: "h", transform: [12, 0, 0, 12, 1, 2], width: 3 },
            { str: "bad", transform: [1, 0] },
        ]);
        expect(items).toEqual([
            { x: 5, y: 6, width: 5, height: 10, str: "a" },
            { x: 1, y: 2, width: 3, height: 12, str: "h" },
        ]);
    });
});

describe("detectColumnRange", () => {
    const twoColumn: LensTextItem[] = [];
    for (let y = 700; y > 100; y -= 12) {
        twoColumn.push(item(56, y, "left column words here", 230));
        twoColumn.push(item(310, y, "right column words here", 230));
    }

    it("returns the left column for a left anchor and the right one for a right anchor", () => {
        expect(detectColumnRange(twoColumn, 0, 595, 60)).toEqual({ x0: 56, x1: expect.any(Number) });
        const left = detectColumnRange(twoColumn, 0, 595, 60);
        expect(left.x1).toBeGreaterThanOrEqual(286);
        expect(left.x1).toBeLessThanOrEqual(310);
        const right = detectColumnRange(twoColumn, 0, 595, 400);
        expect(right.x0).toBeGreaterThanOrEqual(286);
        expect(right.x0).toBeLessThanOrEqual(310);
        expect(right.x1).toBe(540);
    });

    it("survives a few full-width items (title) spanning the gutter", () => {
        const withTitle = [...twoColumn, item(56, 780, "A Very Long Title Across Both Columns", 480, 18)];
        const right = detectColumnRange(withTitle, 0, 595, 400);
        expect(right.x0).toBeGreaterThan(280);
    });

    it("treats single-column text as one column", () => {
        const single: LensTextItem[] = [];
        for (let y = 700; y > 100; y -= 12) single.push(item(56, y, "full width line of body text", 480));
        expect(detectColumnRange(single, 0, 595, 400)).toEqual({ x0: 56, x1: 536 });
    });

    it("uses the full extent without an anchor, and the page for no text", () => {
        expect(detectColumnRange(twoColumn, 0, 595, null)).toEqual({ x0: 56, x1: 540 });
        expect(detectColumnRange([], 0, 595, 100)).toEqual({ x0: 0, x1: 595 });
    });
});

describe("groupLensLines", () => {
    it("groups items by baseline (tolerating superscripts) and orders by x", () => {
        const lines = groupLensLines([
            item(120, 700, "world"),
            item(50, 700, "hello", 60),
            item(111, 703, "1", 4, 6),
            item(50, 688, "next"),
        ]);
        expect(lines.map((l) => l.text)).toEqual(["hello 1 world", "next"]);
    });

    it("returns nothing for no items", () => {
        expect(groupLensLines([])).toEqual([]);
    });
});

describe("selectLensRegion", () => {
    const column = { x0: 50, x1: 300 };

    it("stops at the next numbered entry and joins hyphenation correctly", () => {
        const lines = [
            line(760, "References", 14),
            line(740, "[1] A. Author. The Art of Program-"),
            line(728, "ming. Addison-"),
            line(716, "Wesley, 1998."),
            line(704, "[2] B. Author. Another."),
        ];
        const region = selectLensRegion(lines, column, 752, 842, 0);
        expect(region.text).toBe("[1] A. Author. The Art of Programming. Addison-Wesley, 1998.");
        expect(region.bottom).toBeGreaterThan(704);
        expect(region.top).toBeLessThan(760);
    });

    it("stops at a paragraph gap once body text is collected", () => {
        const lines = [line(700, "First para line one"), line(688, "line two"), line(650, "Next paragraph")];
        expect(selectLensRegion(lines, column, 712, 842, 0).text).toBe("First para line one line two");
    });

    it("keeps a heading together with its first paragraph", () => {
        const lines = [line(600, "2 Method", 14), line(575, "Body of the method."), line(563, "More body.")];
        expect(selectLensRegion(lines, column, 612, 842, 0).text).toBe("2 Method\nBody of the method. More body.");
    });

    it("caps long regions", () => {
        const lines = Array.from({ length: 40 }, (_, i) => line(800 - i * 12, `line ${i}`));
        const region = selectLensRegion(lines, column, 812, 842, 0);
        expect(region.text.split("line").length - 1).toBe(12);
    });

    it("extends figure captions upward over the graphic", () => {
        const lines = [line(700, "Body above the figure."), line(500, "Figure 3: Caption.")];
        const region = selectLensRegion(lines, column, 512, 842, 0);
        expect(region.text).toBe("Figure 3: Caption.");
        expect(region.top).toBeGreaterThan(640);
        expect(region.top).toBeLessThan(700);
    });

    it("keeps table content below its caption despite gaps", () => {
        const lines = [line(700, "Table 2: Results."), line(670, "a 1 2"), line(640, "b 3 4"), line(300, "far text")];
        expect(selectLensRegion(lines, column, 712, 842, 0).text).toBe("Table 2: Results. a 1 2 b 3 4");
    });

    it("falls back to a fixed crop for text-less pages or destinations below all text", () => {
        const empty = selectLensRegion([], column, 500, 842, 0);
        expect(empty).toMatchObject({ text: "", top: 504, bottom: 280 });
        const below = selectLensRegion([line(700, "above")], column, 100, 842, 0);
        expect(below.text).toBe("");
        expect(below.bottom).toBe(0);
    });

    it("starts at the top of the page when the destination has no top", () => {
        const lines = [line(800, "Chapter 4", 18), line(760, "Opening sentence.")];
        expect(selectLensRegion(lines, column, null, 842, 0).text).toBe("Chapter 4\nOpening sentence.");
    });
});

describe("Theorem Lens on a real hyperref paper", () => {
    async function withFixture<T>(fn: (doc: import("pdfjs-dist").PDFDocumentProxy) => Promise<T>): Promise<T> {
        const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
        const data = new Uint8Array(readFileSync(new URL("./fixtures/pdf/links-paper.pdf", import.meta.url)));
        const task = pdfjs.getDocument({ data, verbosity: 0 });
        try {
            return await fn(await task.promise as never);
        } finally {
            await task.destroy();
        }
    }

    it("finds every link on the page", async () => {
        await withFixture(async (doc) => {
            const links = extractPdfLinks(await (await doc.getPage(1)).getAnnotations() as never);
            expect(links.filter((l) => l.kind === "internal")).toHaveLength(7);
            expect(links.filter((l) => l.kind === "external")).toEqual([
                expect.objectContaining({ url: "https://example.org/theorem" }),
            ]);
        });
    });

    it("previews exactly the linked target for citations, footnote, figure, equation and section", async () => {
        await withFixture(async (doc) => {
            const links = extractPdfLinks(await (await doc.getPage(1)).getAnnotations() as never);
            const texts: string[] = [];
            for (const link of links) {
                if (link.kind !== "internal") continue;
                const target = await resolvePdfDestTarget(doc, link.dest);
                expect(target).not.toBeNull();
                const page = await doc.getPage(target!.pageNumber);
                texts.push(computeLensRegion((await page.getTextContent()).items, page.view, target!).text);
            }
            expect(texts).toEqual([
                "[1] Donald E. Knuth. The Art of Computer Programming, Volume 3: Sorting and Searching. Addison-Wesley, 1998.",
                "[2] Robert Sedgewick. Algorithms in C. Addison-Wesley, 1990.",
                "[3] Thomas H. Cormen, Charles E. Leiserson, Ronald L. Rivest and Clifford Stein. Introduction to Algorithms. MIT Press, 2009.",
                "1Footnote target text about hashing.",
                "Figure 1: A black box figure.",
                "eiπ + 1 = 0 (1)",
                "2 Method\nThe method section body text sits here.",
            ]);
        });
    });

    it("renders a crop image that contains the figure graphic, and caches it", async () => {
        await withFixture(async (doc) => {
            const target = await resolvePdfDestTarget(doc, "figure.1");
            const first = buildPdfLensPreview(doc, target!, 400, 1);
            expect(buildPdfLensPreview(doc, target!, 400, 1)).toBe(first);
            const preview = await first;
            expect(preview.imageUrl).toMatch(/^data:image\/png;base64,/);

            // The node canvas pdf.js itself renders with (transitive dependency).
            const pdfjsRequire = createRequire(fileURLToPath(import.meta.resolve("pdfjs-dist/package.json")));
            const { createCanvas, loadImage } = pdfjsRequire("@napi-rs/canvas");
            const img = await loadImage(Buffer.from(preview.imageUrl!.split(",")[1], "base64"));
            const canvas = createCanvas(img.width, img.height);
            const ctx = canvas.getContext("2d");
            ctx.drawImage(img, 0, 0);
            const px = ctx.getImageData(0, 0, img.width, img.height).data;
            let black = 0;
            for (let i = 0; i < px.length; i += 4) if (px[i] < 40 && px[i + 1] < 40 && px[i + 2] < 40) black++;
            // The 3cm x 2cm black rule is a large share of the crop.
            expect(black / (img.width * img.height)).toBeGreaterThan(0.15);
        });
    });
});
