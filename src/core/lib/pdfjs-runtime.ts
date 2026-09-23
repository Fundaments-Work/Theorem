import pdfjsWorkerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";

type PdfJsModule = typeof import("pdfjs-dist");
type PdfJsWorkerConfigurableModule = Pick<PdfJsModule, "GlobalWorkerOptions">;

const PDFJS_WORKER_URL = pdfjsWorkerUrl;

/**
 * Same-origin asset locations copied into the build by vite.config.ts. All
 * local — the reader must work offline. `wasmUrl` is required by pdf.js 6 to
 * decode JPEG 2000 (openjpeg), JBIG2 and CCITT fax images (jbig2); without it
 * those images render blank, which covers most scanned books and many papers.
 * `iccUrl` enables the CMYK ICC profile where pdf.js can use its qcms decoder.
 */
export const PDFJS_ASSET_OPTIONS = {
    cMapUrl: "/pdfjs/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/pdfjs/standard_fonts/",
    wasmUrl: "/pdfjs/wasm/",
    iccUrl: "/pdfjs/iccs/",
    isEvalSupported: false,
} as const;

let workerConfigured = false;
let configuredPdfJsModulePromise: Promise<PdfJsModule> | null = null;
let prewarmPromise: Promise<void> | null = null;

export function configurePdfJsWorker(module: PdfJsWorkerConfigurableModule): void {
    if (workerConfigured && module.GlobalWorkerOptions.workerSrc === PDFJS_WORKER_URL) {
        return;
    }

    module.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
    workerConfigured = true;
}

export async function getConfiguredPdfJs(): Promise<PdfJsModule> {
    if (!configuredPdfJsModulePromise) {
        configuredPdfJsModulePromise = import("pdfjs-dist").then((module) => {
            configurePdfJsWorker(module);
            return module;
        });
    }

    return configuredPdfJsModulePromise;
}

export function prewarmPdfJsRuntime(): Promise<void> {
    if (!prewarmPromise) {
        prewarmPromise = getConfiguredPdfJs()
            .then(() => undefined)
            .catch(() => {
                
                prewarmPromise = null;
            });
    }
    return prewarmPromise;
}
