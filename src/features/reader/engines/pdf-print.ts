/**
 * Print a PDF: the viewer only keeps nearby pages rendered, so printing the DOM
 * would give blank pages. Each page is rendered (pdf.js "print" intent, so form
 * fields print) into a JPEG in a print-only container, then the native dialog
 * opens. Styles live in pdfjs-engine.css (`#theorem-print-root`).
 */
import type { PDFDocumentProxy } from "pdfjs-dist";

export const PRINT_ROOT_ID = "theorem-print-root";
const PRINTING_CLASS = "theorem-printing";
/** Longest canvas side; huge pages are rendered below the target DPI. */
const MAX_CANVAS_SIDE = 4096;

export interface PrintOptions {
    dpi?: number;
    signal?: AbortSignal;
    onProgress?: (done: number, total: number) => void;
    /** Opens the print dialog; defaults to `window.print()`. */
    openDialog?: () => Promise<void> | void;
}

let activeCleanup: (() => void) | null = null;

/** Remove the print container and free its images (also run before a new print). */
export function clearPrintJob(): void {
    activeCleanup?.();
    activeCleanup = null;
}

/** Scale for a page of `width`×`height` points: `dpi`, capped so no side exceeds the limit. */
export function printScale(width: number, height: number, dpi: number): number {
    const scale = dpi / 72;
    const longest = Math.max(width, height) * scale;
    return longest > MAX_CANVAS_SIDE ? scale * (MAX_CANVAS_SIDE / longest) : scale;
}

export async function printPdfDocument(pdf: PDFDocumentProxy, options: PrintOptions = {}): Promise<void> {
    const { dpi = 150, signal, onProgress, openDialog = () => window.print() } = options;
    clearPrintJob();

    const root = document.createElement("div");
    root.id = PRINT_ROOT_ID;
    const urls: string[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
        if (timer) clearTimeout(timer);
        window.removeEventListener("afterprint", onAfterPrint);
        document.documentElement.classList.remove(PRINTING_CLASS);
        root.remove();
        for (const url of urls) URL.revokeObjectURL(url);
        urls.length = 0;
    };
    const onAfterPrint = () => { if (activeCleanup === cleanup) clearPrintJob(); };
    activeCleanup = cleanup;

    try {
        const total = pdf.numPages;
        for (let n = 1; n <= total; n++) {
            if (signal?.aborted) throw new DOMException("Print cancelled", "AbortError");
            const page = await pdf.getPage(n);
            const base = page.getViewport({ scale: 1 });
            const viewport = page.getViewport({ scale: printScale(base.width, base.height, dpi) });
            const canvas = document.createElement("canvas");
            canvas.width = Math.ceil(viewport.width);
            canvas.height = Math.ceil(viewport.height);
            const context = canvas.getContext("2d", { alpha: false });
            if (!context) throw new Error("Canvas is not available");
            context.fillStyle = "#fff";
            context.fillRect(0, 0, canvas.width, canvas.height);
            await page.render({ canvas, canvasContext: context, viewport, intent: "print" }).promise;
            const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
            canvas.width = 0;
            canvas.height = 0;
            page.cleanup();
            if (!blob) throw new Error(`Could not render page ${n}`);

            const img = document.createElement("img");
            const url = URL.createObjectURL(blob);
            urls.push(url);
            img.src = url;
            img.alt = "";
            root.appendChild(img);
            onProgress?.(n, total);
        }
        if (signal?.aborted) throw new DOMException("Print cancelled", "AbortError");

        document.body.appendChild(root);
        await Promise.all([...root.querySelectorAll("img")].map((img) => img.decode().catch(() => undefined)));
        document.documentElement.classList.add(PRINTING_CLASS);
        window.addEventListener("afterprint", onAfterPrint);
        await openDialog();
        // Native dialogs may spool after returning and do not always fire
        // `afterprint`; keep the pages a while, then free them.
        timer = setTimeout(onAfterPrint, 5 * 60_000);
    } catch (error) {
        if (activeCleanup === cleanup) clearPrintJob();
        throw error;
    }
}
