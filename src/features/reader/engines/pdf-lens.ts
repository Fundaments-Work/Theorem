import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import type { PdfDestTarget } from "./pdf-links";

/**
 * Theorem Lens for PDF: preview what an internal link points at (a reference
 * entry, footnote, figure, equation, section) without leaving the page.
 *
 * Like GNOME Papers' link thumbnails and Zotero's reference popups, the
 * preview is a rendered crop of the destination, so it works for math,
 * figures and any font encoding. Text is extracted from the same region for
 * copying. Layout analysis is pure and operates in PDF user space (y up).
 */

export interface LensTextItem {
    x: number;
    /** Baseline y. */
    y: number;
    width: number;
    height: number;
    str: string;
}

export interface LensLine {
    y: number;
    x0: number;
    x1: number;
    height: number;
    text: string;
}

export interface LensRegion {
    x0: number;
    x1: number;
    /** Top edge (larger y). */
    top: number;
    /** Bottom edge (smaller y). */
    bottom: number;
    text: string;
}

const MAX_LENS_LINES = 12;
const MAX_LENS_SPAN_PT = 260;
const MAX_FIGURE_EXTENT_PT = 300;
const FALLBACK_CROP_HEIGHT_PT = 220;
const ENTRY_LABEL = /^\s*(\[\d{1,4}[a-z]?\]|\d{1,3}\.\s)/;
const FIGURE_CAPTION = /^\s*(figure|fig\.?)\s*[\dIVX]/i;
const TABLE_CAPTION = /^\s*(table|tab\.?)\s*[\dIVX]/i;

interface PdfJsTextItemLike {
    str?: string;
    transform?: number[];
    width?: number;
    height?: number;
}

/** Upright, non-empty text items in user space. Rotated text is skipped. */
export function toLensTextItems(items: ReadonlyArray<unknown>): LensTextItem[] {
    const result: LensTextItem[] = [];
    for (const raw of items) {
        const item = raw as PdfJsTextItemLike;
        if (typeof item.str !== "string" || item.str.trim().length === 0) continue;
        const t = item.transform;
        if (!Array.isArray(t) || t.length < 6) continue;
        const [a, b, c, d, e, f] = t;
        if (Math.abs(b) > Math.abs(a) * 0.05 || Math.abs(c) > Math.abs(d) * 0.05) continue;
        const height = item.height && item.height > 0 ? item.height : Math.hypot(c, d);
        const width = item.width && item.width > 0 ? item.width : 0;
        if (!Number.isFinite(e) || !Number.isFinite(f) || height <= 0) continue;
        result.push({ x: e, y: f, width, height, str: item.str });
    }
    return result;
}

function median(values: number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((l, r) => l - r);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Detect a two-column layout from a vertical gutter near the page centre and
 * return the horizontal extent of the column containing `anchorX`. Returns the
 * full text extent for single-column pages or when there is no anchor.
 */
export function detectColumnRange(
    items: ReadonlyArray<LensTextItem>,
    pageX0: number,
    pageX1: number,
    anchorX: number | null,
): { x0: number; x1: number } {
    if (items.length === 0) return { x0: pageX0, x1: pageX1 };
    let minX = Infinity;
    let maxX = -Infinity;
    for (const item of items) {
        minX = Math.min(minX, item.x);
        maxX = Math.max(maxX, item.x + item.width);
    }
    const full = { x0: minX, x1: maxX };
    if (anchorX === null) return full;

    const width = pageX1 - pageX0;
    const buckets = Math.max(1, Math.ceil(width));
    const coverage = new Uint32Array(buckets);
    for (const item of items) {
        const from = Math.max(0, Math.floor(item.x - pageX0));
        const to = Math.min(buckets - 1, Math.ceil(item.x + item.width - pageX0));
        for (let i = from; i <= to; i++) coverage[i]++;
    }
    const emptyThreshold = Math.max(1, Math.floor(items.length * 0.04));
    const searchFrom = Math.floor(width * 0.3);
    const searchTo = Math.ceil(width * 0.7);
    let bestStart = -1;
    let bestLength = 0;
    let runStart = -1;
    for (let i = searchFrom; i <= searchTo; i++) {
        if (coverage[i] <= emptyThreshold) {
            if (runStart < 0) runStart = i;
            const length = i - runStart + 1;
            if (length > bestLength) {
                bestLength = length;
                bestStart = runStart;
            }
        } else {
            runStart = -1;
        }
    }
    if (bestLength < 6) return full;

    const gutterStart = pageX0 + bestStart;
    const gutterEnd = gutterStart + bestLength;
    let leftCount = 0;
    let rightCount = 0;
    for (const item of items) {
        if (item.x + item.width <= gutterStart + 1) leftCount++;
        else if (item.x >= gutterEnd - 1) rightCount++;
    }
    if (leftCount < items.length * 0.2 || rightCount < items.length * 0.2) return full;

    return anchorX < gutterStart
        ? { x0: minX, x1: gutterStart }
        : { x0: gutterEnd, x1: maxX };
}

function joinLineItems(items: LensTextItem[]): string {
    let text = "";
    let prevEnd = -Infinity;
    for (const item of items) {
        const gap = item.x - prevEnd;
        if (text.length > 0 && gap > item.height * 0.15 && !text.endsWith(" ") && !item.str.startsWith(" ")) {
            text += " ";
        }
        text += item.str;
        prevEnd = item.x + item.width;
    }
    return text.replace(/\s+/g, " ").trim();
}

/** Group items (already restricted to one column) into baseline-sorted lines, top first. */
export function groupLensLines(items: ReadonlyArray<LensTextItem>): LensLine[] {
    const sorted = [...items].sort((l, r) => r.y - l.y || l.x - r.x);
    const groups: LensTextItem[][] = [];
    for (const item of sorted) {
        const current = groups[groups.length - 1];
        if (current) {
            const ref = current[0];
            if (Math.abs(ref.y - item.y) <= Math.max(ref.height, item.height) * 0.5) {
                current.push(item);
                continue;
            }
        }
        groups.push([item]);
    }
    return groups.map((group) => {
        group.sort((l, r) => l.x - r.x);
        let x0 = Infinity;
        let x1 = -Infinity;
        let height = 0;
        for (const item of group) {
            x0 = Math.min(x0, item.x);
            x1 = Math.max(x1, item.x + item.width);
            height = Math.max(height, item.height);
        }
        return { y: group[0].y, x0, x1, height, text: joinLineItems(group) };
    });
}

function joinLensText(lines: LensLine[], headingHeight: number): string {
    let text = "";
    for (const line of lines) {
        if (text.length === 0) {
            text = line.text;
        } else if (/[A-Za-z]-$/.test(text) && /^[a-z]/.test(line.text)) {
            text = text.slice(0, -1) + line.text;
        } else if (text.endsWith("-")) {
            text += line.text;
        } else {
            text += " " + line.text;
        }
        if (line.height > headingHeight) text += "\n";
    }
    return text.replace(/ ?\n ?/g, "\n").trim();
}

/**
 * Choose the region to preview for a destination. `lines` must be the lines
 * of the destination's column, top first. `top` is the destination's top
 * (null = top of page).
 */
export function selectLensRegion(
    lines: ReadonlyArray<LensLine>,
    column: { x0: number; x1: number },
    top: number | null,
    pageTop: number,
    pageBottom: number,
): LensRegion {
    const anchorTop = top ?? pageTop;
    const fallback: LensRegion = {
        x0: column.x0,
        x1: column.x1,
        top: Math.min(pageTop, anchorTop + 4),
        bottom: Math.max(pageBottom, anchorTop - FALLBACK_CROP_HEIGHT_PT),
        text: "",
    };

    const firstIndex = lines.findIndex((line) => line.y <= anchorTop + 2);
    if (firstIndex < 0) return fallback;

    const bodyHeight = median(lines.map((line) => line.height)) || lines[firstIndex].height;
    const headingHeight = bodyHeight * 1.15;
    const gaps: number[] = [];
    for (let i = 1; i < lines.length; i++) {
        const gap = lines[i - 1].y - lines[i].y;
        if (gap > 0 && gap < bodyHeight * 3) gaps.push(gap);
    }
    const typicalGap = median(gaps) || bodyHeight * 1.2;

    const first = lines[firstIndex];
    const isFigure = FIGURE_CAPTION.test(first.text);
    const isTable = TABLE_CAPTION.test(first.text);
    // A destination far above the first text line points at a graphic.
    const graphicAboveText = anchorTop - first.y > Math.max(40, bodyHeight * 4);

    const picked: LensLine[] = [first];
    let hasBody = first.height <= headingHeight;
    for (let i = firstIndex + 1; i < lines.length && picked.length < MAX_LENS_LINES; i++) {
        const line = lines[i];
        const prev = picked[picked.length - 1];
        if (first.y - line.y > MAX_LENS_SPAN_PT) break;
        if (!isTable) {
            if (ENTRY_LABEL.test(line.text)) break;
            if (hasBody && prev.y - line.y > typicalGap * 1.6) break;
        }
        picked.push(line);
        if (line.height <= headingHeight) hasBody = true;
    }

    const last = picked[picked.length - 1];
    let regionTop = first.y + first.height + 3;
    if (graphicAboveText) {
        regionTop = Math.max(regionTop, Math.min(anchorTop + 4, first.y + MAX_FIGURE_EXTENT_PT));
    }
    if (isFigure) {
        // The graphic sits above its caption and has no text: extend up to the
        // nearest text line above, bounded.
        const above = firstIndex > 0 ? lines[firstIndex - 1] : null;
        const limit = first.y + MAX_FIGURE_EXTENT_PT;
        const graphicTop = above ? above.y - above.height * 0.3 - 2 : pageTop;
        regionTop = Math.max(regionTop, Math.min(graphicTop, limit));
    }

    return {
        x0: column.x0,
        x1: column.x1,
        top: Math.min(pageTop, regionTop),
        bottom: Math.max(pageBottom, last.y - last.height * 0.3 - 3),
        text: joinLensText(picked, headingHeight),
    };
}

/** Full layout pass for one page. */
export function computeLensRegion(
    rawTextItems: ReadonlyArray<unknown>,
    view: readonly number[],
    target: Pick<PdfDestTarget, "left" | "top">,
): LensRegion {
    const [pageX0, pageY0, pageX1, pageY1] = view;
    const items = toLensTextItems(rawTextItems);
    const column = detectColumnRange(items, pageX0, pageX1, target.left);
    const inColumn = items.filter((item) => item.x >= column.x0 - 2 && item.x < column.x1);
    const lines = groupLensLines(inColumn);
    const region = selectLensRegion(lines, column, target.top, pageY1, pageY0);
    const pad = 6;
    return {
        ...region,
        x0: Math.max(pageX0, region.x0 - pad),
        x1: Math.min(pageX1, region.x1 + pad),
    };
}

export interface PdfLensPreview {
    pageNumber: number;
    text: string;
    /** PNG data URL of the destination crop, or null if rendering failed. */
    imageUrl: string | null;
}

interface CanvasAndContext {
    canvas: { width: number; height: number; toDataURL(type?: string): string };
    context: CanvasRenderingContext2D;
}

interface CanvasFactoryLike {
    create(width: number, height: number): CanvasAndContext;
    destroy(canvasAndContext: CanvasAndContext): void;
}

const MAX_PREVIEW_PX_WIDTH = 1600;
const MAX_PREVIEW_PX_HEIGHT = 1400;
const PREVIEW_CACHE_LIMIT = 32;
const previewCache = new WeakMap<object, Map<string, Promise<PdfLensPreview>>>();

async function renderRegion(
    pdfDocument: PDFDocumentProxy,
    page: PDFPageProxy,
    region: LensRegion,
    cssWidth: number,
    pixelRatio: number,
): Promise<string | null> {
    const regionWidthPt = region.x1 - region.x0;
    const regionHeightPt = region.top - region.bottom;
    if (regionWidthPt <= 0 || regionHeightPt <= 0) return null;

    let scale = Math.min(4, Math.max(1, (cssWidth * pixelRatio) / regionWidthPt));
    scale = Math.min(scale, MAX_PREVIEW_PX_WIDTH / regionWidthPt, MAX_PREVIEW_PX_HEIGHT / regionHeightPt);
    const viewport = page.getViewport({ scale });
    // pdf.js 6 has no convertToViewportRectangle; map both corners.
    const [ax, ay] = viewport.convertToViewportPoint(region.x0, region.bottom);
    const [bx, by] = viewport.convertToViewportPoint(region.x1, region.top);
    const left = Math.min(ax, bx);
    const topPx = Math.min(ay, by);
    const width = Math.max(1, Math.ceil(Math.abs(bx - ax)));
    const height = Math.max(1, Math.ceil(Math.abs(by - ay)));

    const factory = (pdfDocument as unknown as { canvasFactory: CanvasFactoryLike }).canvasFactory;
    const target = factory.create(width, height);
    try {
        target.context.fillStyle = "#ffffff";
        target.context.fillRect(0, 0, width, height);
        await page.render({
            canvas: null,
            canvasContext: target.context,
            viewport,
            transform: [1, 0, 0, 1, -left, -topPx],
        } as unknown as Parameters<PDFPageProxy["render"]>[0]).promise;
        return target.canvas.toDataURL("image/png");
    } finally {
        factory.destroy(target);
    }
}

/**
 * Build (and cache per document) the Lens preview for a destination.
 * `cssWidth` is the popover's content width; `pixelRatio` the display DPR.
 */
export function buildPdfLensPreview(
    pdfDocument: PDFDocumentProxy,
    target: PdfDestTarget,
    cssWidth = 400,
    pixelRatio = 1,
): Promise<PdfLensPreview> {
    const key = `${target.pageNumber}:${target.left ?? "-"}:${target.top ?? "-"}:${Math.round(cssWidth * pixelRatio)}`;
    let cache = previewCache.get(pdfDocument);
    if (!cache) {
        cache = new Map();
        previewCache.set(pdfDocument, cache);
    }
    const cached = cache.get(key);
    if (cached) {
        cache.delete(key);
        cache.set(key, cached);
        return cached;
    }

    const promise = (async (): Promise<PdfLensPreview> => {
        const page = await pdfDocument.getPage(target.pageNumber);
        const textContent = await page.getTextContent();
        const region = computeLensRegion(textContent.items, page.view, target);
        let imageUrl: string | null = null;
        try {
            imageUrl = await renderRegion(pdfDocument, page, region, cssWidth, pixelRatio);
        } catch {
            imageUrl = null;
        }
        return { pageNumber: target.pageNumber, text: region.text, imageUrl };
    })();

    cache.set(key, promise);
    promise.catch(() => cache?.delete(key));
    while (cache.size > PREVIEW_CACHE_LIMIT) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
    }
    return promise;
}
