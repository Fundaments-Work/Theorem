import type { BookFormat, PdfZoomMode, ReaderSettings as ReaderSettingsState } from "../../../core/types";

export const MOBILE_READER_MEDIA_QUERY = "(max-width: 768px)";
export const MIN_READER_ZOOM = 50;
export const MIN_PAGED_READER_ZOOM = 100;
export const MAX_READER_ZOOM = 200;
export const PDF_STATE_SAVE_DEBOUNCE_MS = 900;
export const READER_PROGRESS_SAVE_DEBOUNCE_MS = 1200;
export const DEFAULT_PDF_ZOOM = 1;
export const DEFAULT_PDF_ZOOM_MODE: PdfZoomMode = "width-fit";
export const PDF_ZOOM_PERSIST_PRECISION = 100;

export type PendingProgressUpdate = {
    bookId: string;
    percentage: number;
    cfi: string;
    lastClickFraction?: number;
    pageProgress?: {
        currentPage: number;
        endPage?: number;
        totalPages: number;
        range: string;
    };
};

export function clampReaderZoomByFlow(zoom: number, flow: ReaderSettingsState["flow"]): number {
    const minZoom = flow === "paged" ? MIN_PAGED_READER_ZOOM : MIN_READER_ZOOM;
    return Math.max(minZoom, Math.min(MAX_READER_ZOOM, Math.round(zoom)));
}

export function resolvePdfTargetPage(target: string): number | null {
    const directMatch = target.match(/pdf:page:(\d+)/i);
    if (directMatch) {
        return Number(directMatch[1]);
    }
    const hashMatch = target.match(/[?#&]page=(\d+)/i);
    if (hashMatch) {
        return Number(hashMatch[1]);
    }
    const numericValue = Number(target);
    if (Number.isFinite(numericValue) && numericValue > 0) {
        return Math.floor(numericValue);
    }
    return null;
}

/** Formats read through zip.js, which only needs byte ranges. */
export const RANGE_READ_FORMATS: ReadonlySet<BookFormat> = new Set<BookFormat>(["epub", "cbz", "cbr"]);

/** Freehand pen stroke width in CSS pixels at scale 1. */
export const PDF_BRUSH_WIDTH = 2;

export function getMimeTypeForBookFormat(format: BookFormat): string {
    switch (format) {
        case "epub":
            return "application/epub+zip";
        case "mobi":
        case "azw":
        case "azw3":
            return "application/x-mobipocket-ebook";
        case "fb2":
            return "application/x-fictionbook+xml";
        case "cbz":
            return "application/vnd.comicbook+zip";
        case "cbr":
            return "application/vnd.comicbook-rar";
        case "pdf":
            return "application/pdf";
        default:
            return "application/octet-stream";
    }
}

export function extractSectionIndex(cfi: string): number | null {
    const match = cfi.match(/\/6\/(\d+)/);
    return match ? parseInt(match[1], 10) : null;
}

export function isSyntheticSectionLocation(location: string): boolean {
    return /^section-\d+$/i.test(location.trim());
}

export function normalizeInitialReaderLocation(location?: string): string | undefined {
    if (!location) {
        return undefined;
    }
    const normalized = location.trim();
    if (!normalized) {
        return undefined;
    }
    if (isSyntheticSectionLocation(normalized) || normalized.startsWith("pdf:page:")) {
        return undefined;
    }
    return normalized;
}
