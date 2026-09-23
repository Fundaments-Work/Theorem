import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { PRINT_ROOT_ID, clearPrintJob, printPdfDocument, printScale } from "../src/features/reader/engines/pdf-print";

function fakePdf(numPages: number, opts: { failOn?: number; sizes?: [number, number][] } = {}) {
    const renders: { page: number; intent: string; width: number }[] = [];
    const cleaned: number[] = [];
    const pdf = {
        numPages,
        getPage: async (n: number) => {
            const [w, h] = opts.sizes?.[n - 1] ?? [612, 792];
            return {
                getViewport: ({ scale }: { scale: number }) => ({ width: w * scale, height: h * scale }),
                render: ({ intent, viewport }: { intent: string; viewport: { width: number } }) => {
                    renders.push({ page: n, intent, width: viewport.width });
                    return { promise: n === opts.failOn ? Promise.reject(new Error("bad page")) : Promise.resolve() };
                },
                cleanup: () => { cleaned.push(n); },
            };
        },
    } as unknown as PDFDocumentProxy;
    return { pdf, renders, cleaned };
}

const root = () => document.getElementById(PRINT_ROOT_ID);
let revoked: string[];

beforeEach(() => {
    revoked = [];
    let next = 0;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ fillRect() {}, fillStyle: "" } as never);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (cb: BlobCallback) { cb(new Blob(["x"])); });
    Object.assign(URL, {
        createObjectURL: () => `blob:${++next}`,
        revokeObjectURL: (u: string) => { revoked.push(u); },
    });
    Object.defineProperty(HTMLImageElement.prototype, "decode", { configurable: true, value: () => Promise.resolve() });
});

afterEach(() => {
    clearPrintJob();
    vi.restoreAllMocks();
});

describe("printPdfDocument", () => {
    it("renders every page with the print intent, then opens the dialog once", async () => {
        const { pdf, renders, cleaned } = fakePdf(3);
        const progress: string[] = [];
        const openDialog = vi.fn(() => {
            // Dialog opens only when every page is in the container.
            expect(root()?.querySelectorAll("img").length).toBe(3);
            expect(document.documentElement.classList.contains("theorem-printing")).toBe(true);
        });
        await printPdfDocument(pdf, { openDialog, onProgress: (d, t) => progress.push(`${d}/${t}`) });
        expect(openDialog).toHaveBeenCalledTimes(1);
        expect(renders.map((r) => r.intent)).toEqual(["print", "print", "print"]);
        expect(cleaned).toEqual([1, 2, 3]);
        expect(progress).toEqual(["1/3", "2/3", "3/3"]);

        window.dispatchEvent(new Event("afterprint"));
        expect(root()).toBeNull();
        expect(document.documentElement.classList.contains("theorem-printing")).toBe(false);
        expect(revoked).toEqual(["blob:1", "blob:2", "blob:3"]);
    });

    it("a second print replaces the first job", async () => {
        await printPdfDocument(fakePdf(2).pdf, { openDialog: () => {} });
        await printPdfDocument(fakePdf(1).pdf, { openDialog: () => {} });
        expect(document.querySelectorAll(`#${PRINT_ROOT_ID}`).length).toBe(1);
        expect(root()?.querySelectorAll("img").length).toBe(1);
        expect(revoked).toEqual(["blob:1", "blob:2"]);
    });

    it("cleans up on a render error and on abort, never opening the dialog", async () => {
        const openDialog = vi.fn();
        await expect(printPdfDocument(fakePdf(3, { failOn: 2 }).pdf, { openDialog })).rejects.toThrow("bad page");
        expect(root()).toBeNull();
        expect(revoked).toEqual(["blob:1"]);

        const controller = new AbortController();
        const run = printPdfDocument(fakePdf(5).pdf, {
            openDialog,
            signal: controller.signal,
            onProgress: (done) => { if (done === 2) controller.abort(); },
        });
        await expect(run).rejects.toThrow("Print cancelled");
        expect(openDialog).not.toHaveBeenCalled();
        expect(root()).toBeNull();
        expect(document.documentElement.classList.contains("theorem-printing")).toBe(false);
    });

    it("an empty document still opens the dialog with no pages", async () => {
        const openDialog = vi.fn();
        await printPdfDocument(fakePdf(0).pdf, { openDialog });
        expect(openDialog).toHaveBeenCalledTimes(1);
        expect(root()?.querySelectorAll("img").length).toBe(0);
    });
});

describe("printScale", () => {
    it("uses the DPI, capping huge pages at 4096 px on the long side", () => {
        expect(printScale(612, 792, 150)).toBeCloseTo(150 / 72);
        const poster = printScale(2384, 3370, 150); // A0
        expect(3370 * poster).toBeCloseTo(4096);
        expect(printScale(4096, 10, 72)).toBe(1); // exactly at the limit
    });
});
