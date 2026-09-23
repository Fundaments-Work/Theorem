// @vitest-environment node
// PDFs generated at test time (tests/helpers/make-pdf.ts): a JBIG2 scan,
// rotated pages and a 1,000-page document.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PDFJS_ASSET_OPTIONS } from "../src/core/lib/pdfjs-runtime";
import { buildPdfSearchPattern, findPdfTextMatches, normalizeSearchText } from "../src/features/reader/engines/pdf-search";
import { normalizePageLabels } from "../src/features/reader/engines/pdf-page-labels";
import { viewRotation } from "../src/features/reader/engines/pdf-rotation";
import { jbig2FromG4, makePdf } from "./helpers/make-pdf";

const PDFJS_DIST = fileURLToPath(new URL("../node_modules/pdfjs-dist/", import.meta.url));
const toLocal = (appPath: string) => appPath.replace(/^\/pdfjs\//, PDFJS_DIST);
const shippedOptions = {
    ...PDFJS_ASSET_OPTIONS,
    cMapUrl: toLocal(PDFJS_ASSET_OPTIONS.cMapUrl),
    standardFontDataUrl: toLocal(PDFJS_ASSET_OPTIONS.standardFontDataUrl),
    wasmUrl: toLocal(PDFJS_ASSET_OPTIONS.wasmUrl),
    iccUrl: toLocal(PDFJS_ASSET_OPTIONS.iccUrl),
};

async function openPdf(data: Uint8Array, options: Record<string, unknown> = shippedOptions) {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    // pdf.js transfers (detaches) the buffer it is given: pass a copy.
    const task = pdfjs.getDocument({ ...options, data: data.slice(), verbosity: 0 });
    return { pdfjs, task, doc: await task.promise };
}

async function pageText(doc: Awaited<ReturnType<typeof openPdf>>["doc"], n: number): Promise<string> {
    const content = await (await doc.getPage(n)).getTextContent();
    return normalizeSearchText(content.items.map((i) => ("str" in i ? i.str : "")).join(" "));
}

/** The G4 image data of tests/fixtures/pdf/ccitt-g4-scan.pdf (240×120, BlackIs1). */
function ccittFixtureG4(): Uint8Array {
    const file = readFileSync(new URL("./fixtures/pdf/ccitt-g4-scan.pdf", import.meta.url));
    const dict = file.indexOf("/CCITTFaxDecode");
    const start = file.indexOf("stream\n", dict) + "stream\n".length;
    return new Uint8Array(file.subarray(start, file.indexOf("\nendstream", start)));
}

describe("JBIG2 scan", () => {
    const g4 = ccittFixtureG4();
    const pageWith = (dict: string, data: Uint8Array) => makePdf([{
        width: 240, height: 120,
        image: { dict: `/Type /XObject /Subtype /Image /Width 240 /Height 120 /BitsPerComponent 1 ${dict}`, data, width: 240, height: 120 },
    }]);
    const jbig2 = pageWith("/Filter /JBIG2Decode", jbig2FromG4(g4, 240, 120));
    // The same G4 data as CCITT with BlackIs1: coded black runs become 1 bits,
    // which DeviceGray draws white. JBIG2 always draws 1 bits black, so the
    // two renders are exact complements.
    const ccitt = pageWith("/ColorSpace /DeviceGray /Filter /CCITTFaxDecode /DecodeParms << /K -1 /Columns 240 /Rows 120 /BlackIs1 true >>", g4);

    async function ink(data: Uint8Array, options: Record<string, unknown>): Promise<number> {
        const { task, doc } = await openPdf(data, options);
        try {
            const page = await doc.getPage(1);
            const viewport = page.getViewport({ scale: 1 });
            const { canvas, context } = doc.canvasFactory.create(viewport.width, viewport.height);
            await page.render({ canvas, canvasContext: context, viewport }).promise;
            const px = context.getImageData(0, 0, canvas.width, canvas.height).data;
            let n = 0;
            for (let i = 0; i < px.length; i += 4) if (px[i] + px[i + 1] + px[i + 2] < 384) n++;
            return n;
        } finally {
            await task.destroy();
        }
    }

    it("decodes through the bundled jbig2 wasm (blank without wasmUrl)", async () => {
        expect(g4.length).toBe(61);
        const { wasmUrl: _omit, ...withoutWasm } = shippedOptions;
        expect(await ink(jbig2, withoutWasm)).toBe(0);
        const jbig2Ink = await ink(jbig2, shippedOptions);
        const ccittInk = await ink(ccitt, shippedOptions);
        expect(jbig2Ink).toBeGreaterThan(0);
        expect(ccittInk).toBeGreaterThan(0);
        expect(jbig2Ink + ccittInk).toBe(240 * 120);
    });
});

describe("rotated pages", () => {
    const rotations = [0, 90, 180, 270] as const;
    const data = makePdf(rotations.map((rotate, i) => ({
        rotate, width: i === 3 ? 400 : 200, height: i === 3 ? 250 : 300, text: `Page ${i + 1}`,
    })));

    it("reports /Rotate, swaps viewport sides for 90/270 and moves text with the page", async () => {
        const { task, doc } = await openPdf(data);
        try {
            expect(doc.numPages).toBe(4);
            for (const [i, rotate] of rotations.entries()) {
                const page = await doc.getPage(i + 1);
                expect(page.rotate).toBe(rotate);
                const [w, h] = i === 3 ? [400, 250] : [200, 300];
                const viewport = page.getViewport({ scale: 1 });
                expect([viewport.width, viewport.height]).toEqual(rotate % 180 ? [h, w] : [w, h]);

                const item = (await page.getTextContent()).items.find((it) => "str" in it && it.str)!;
                expect("str" in item && item.str).toBe(`Page ${i + 1}`);
                // Text origin (10, h-20) in PDF space is near the unrotated
                // top-left; each 90° clockwise turn moves it to the next corner.
                const [a, b, c, d, e, f] = viewport.transform;
                const [x, y] = [a * 10 + c * (h - 20) + e, b * 10 + d * (h - 20) + f];
                const left = x < viewport.width / 2;
                const top = y < viewport.height / 2;
                const corner = { 0: [true, true], 90: [false, true], 180: [false, false], 270: [true, false] }[rotate];
                expect([left, top], `rotate ${rotate}`).toEqual(corner);
            }
        } finally {
            await task.destroy();
        }
    });

    it("the viewer's rotation adds to /Rotate instead of replacing it", async () => {
        const { task, doc } = await openPdf(data);
        try {
            for (const [i, rotate] of rotations.entries()) {
                const page = await doc.getPage(i + 1);
                const own = page.getViewport({ scale: 1 });
                const view = page.getViewport({ scale: 1, rotation: viewRotation(page, 0) });
                expect([view.width, view.height]).toEqual([own.width, own.height]);
                expect(viewRotation(page, 90)).toBe((rotate + 90) % 360);
                expect(viewRotation(page, -90)).toBe((rotate + 270) % 360);
                if (rotate % 180) {
                    // Passing only the viewer's rotation (the old code) drew
                    // these pages sideways.
                    const wrong = page.getViewport({ scale: 1, rotation: 0 });
                    expect([wrong.width, wrong.height]).toEqual([own.height, own.width]);
                }
            }
        } finally {
            await task.destroy();
        }
    });
});

describe("1,000-page document", () => {
    const data = makePdf(Array.from({ length: 1000 }, (_, i) => ({ text: `Page ${i + 1} of the stress file` })));

    it("opens, reads the last page and searches every page literally", async () => {
        const { task, doc } = await openPdf(data);
        try {
            expect(doc.numPages).toBe(1000);
            expect(await pageText(doc, 1000)).toBe("Page 1000 of the stress file");
            expect(normalizePageLabels(await doc.getPageLabels(), doc.numPages)).toBeNull();

            const whole = buildPdfSearchPattern("page 10", { wholeWord: true });
            const partial = buildPdfSearchPattern("page 10");
            const wholeHits: number[] = [];
            let partialHits = 0;
            for (let n = 1; n <= doc.numPages; n++) {
                const text = await pageText(doc, n);
                if (findPdfTextMatches(text, whole).length) wholeHits.push(n);
                partialHits += findPdfTextMatches(text, partial).length;
            }
            expect(wholeHits).toEqual([10]);
            expect(partialHits).toBe(12); // 10, 100-109, 1000
        } finally {
            await task.destroy();
        }
    }, 60_000);
});
