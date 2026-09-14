import pdfjsWorkerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";

type PdfJsModule = typeof import("pdfjs-dist");
type PdfJsWorkerConfigurableModule = Pick<PdfJsModule, "GlobalWorkerOptions">;

const PDFJS_WORKER_URL = pdfjsWorkerUrl;

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
