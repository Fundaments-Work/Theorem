// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PDFJS_ASSET_OPTIONS } from "../src/core/lib/pdfjs-runtime";

// In the app these paths are served same-origin from dist/pdfjs/ (copied from
// node_modules by vite.config.ts). Here they map back to that source.
const PDFJS_DIST = fileURLToPath(new URL("../node_modules/pdfjs-dist/", import.meta.url));
const toLocal = (appPath: string) => appPath.replace(/^\/pdfjs\//, PDFJS_DIST);

async function countInkPixels(fixture: string, options: Record<string, unknown>): Promise<number> {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const data = new Uint8Array(readFileSync(new URL(`./fixtures/pdf/${fixture}`, import.meta.url)));
    const task = pdfjs.getDocument({ ...options, data, verbosity: 0 });
    const doc = await task.promise;
    try {
        const page = await doc.getPage(1);
        const viewport = page.getViewport({ scale: 1 });
        const { canvas, context } = doc.canvasFactory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
        await page.render({ canvas, canvasContext: context, viewport }).promise;
        const px = context.getImageData(0, 0, canvas.width, canvas.height).data;
        let ink = 0;
        for (let i = 0; i < px.length; i += 4) if (px[i] + px[i + 1] + px[i + 2] < 600) ink++;
        return ink;
    } finally {
        await task.destroy();
    }
}

const shippedOptions = {
    ...PDFJS_ASSET_OPTIONS,
    cMapUrl: toLocal(PDFJS_ASSET_OPTIONS.cMapUrl),
    standardFontDataUrl: toLocal(PDFJS_ASSET_OPTIONS.standardFontDataUrl),
    wasmUrl: toLocal(PDFJS_ASSET_OPTIONS.wasmUrl),
    iccUrl: toLocal(PDFJS_ASSET_OPTIONS.iccUrl),
};

describe("pdf.js image decoders", () => {
    it("asset options are same-origin paths only (offline, no CDN)", () => {
        for (const [key, value] of Object.entries(PDFJS_ASSET_OPTIONS)) {
            if (typeof value !== "string") continue;
            expect(value, key).toMatch(/^\/pdfjs\/[a-z_]+\/$/);
        }
    });

    // The fixture is a 1-bit CCITT Group 4 scan (the usual scanned-book
    // encoding), decoded by the jbig2 wasm module in pdf.js 6. The black box
    // covers ~28% of the page.
    it("renders CCITT G4 scans (blank without wasmUrl)", async () => {
        const { wasmUrl: _omit, ...withoutWasm } = shippedOptions;
        expect(await countInkPixels("ccitt-g4-scan.pdf", withoutWasm)).toBe(0);
        const ink = await countInkPixels("ccitt-g4-scan.pdf", shippedOptions);
        expect(ink).toBeGreaterThan(400);
    });

    it("renders JPEG 2000 images (blank without wasmUrl)", async () => {
        const { wasmUrl: _omit, ...withoutWasm } = shippedOptions;
        expect(await countInkPixels("jpx-image.pdf", withoutWasm)).toBe(0);
        expect(await countInkPixels("jpx-image.pdf", shippedOptions)).toBeGreaterThan(7000);
    });
});
