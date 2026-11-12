import { invoke } from "@tauri-apps/api/core";
import * as pdfjsLib from "pdfjs-dist";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import { isTauri, isWebKitBrowserEngine } from "../../../../core/lib/env";
import type { Annotation, PdfZoomMode, TocItem } from "../../../../core/types";
import type { PdfAttachmentInfo } from "../pdf-attachments";
import { resolvePdfDestTarget } from "../pdf-links";
import { interactionPixelRatio } from "../pdf-render-quality";
import { RenderedPageCache } from "../pdf-render-cache";
import { viewRotation } from "../pdf-rotation";

export interface PdfStructure {
    total_pages: number;
    default_width_pt: number;
    default_height_pt: number;
    file_size_bytes: number;
    title?: string;
    author?: string;
}

export interface PDFDocumentInfo {
    title?: string;
    author?: string;
    subject?: string;
    keywords?: string;
    creator?: string;
    producer?: string;
    creationDate?: Date;
    modificationDate?: Date;
    totalPages: number;
    filename: string;
    /** Real on-disk file name stem; see `PDFJsEngineProps.sourceFilename`. */
    sourceFilename?: string;
    hasOutline?: boolean;
    toc?: TocItem[];
    pageLabels?: string[];
    pdfVersion?: string;
    pageSize?: string;
    attachments?: PdfAttachmentInfo[];
}

export interface PDFSearchState {
    query: string;
    highlightAll: boolean;
    caseSensitive: boolean;
    entireWord: boolean;
}

export interface PageLayoutEntry {
    pageNumber: number;
    top: number;
    bottom: number;
    left: number;
    width: number;
}

export interface TextItemLike {
    str?: string;
    width?: number;
}

export type PageTextContent = Awaited<ReturnType<PDFPageProxy["getTextContent"]>>;

export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 5.0;
export const ZOOM_STEP = 0.10;
export const DEFAULT_SCALE = 1.0;
export const PDF_TO_CSS_UNITS = pdfjsLib.PixelsPerInch?.PDF_TO_CSS_UNITS ?? (96 / 72);
export const PAGE_PRERENDER_MARGIN = "90% 0px";
export const INITIAL_PAGE_LOAD_SIZE = 1;
export const PAGE_LOAD_BATCH_SIZE = 8;
export const PAGE_LOAD_AHEAD_THRESHOLD = 4;
export const PAGE_EDGE_PREFETCH_COUNT = 8;
export const EDGE_PREFETCH_MIN_INTERVAL_MS = 60;
export const PAGE_PROXY_LOAD_CONCURRENCY = 3;
export const ZOOM_SETTLE_EPSILON = 0.0005;
export const KEYBOARD_SCROLL_STEP_RATIO = 0.82;
export const KEYBOARD_SCROLL_STEP_MIN_PX = 72;

export const PAGE_PROXY_KEEP_WINDOW = 50;
export const PAGE_PROXY_PAGED_KEEP_WINDOW = 2;

const WEBKIT_MIN_OUTPUT_SCALE = 1.2;
const MAX_CANVAS_PIXEL_COUNT = 12_000_000;
const TEXT_CONTENT_CACHE_LIMIT = 12;
const PDF_INFO_CACHE_LIMIT = 12;
export const EMPTY_ANNOTATIONS: Annotation[] = [];
export const TEXT_LAYER_SELECTING_CLASS = "selecting";
export const WEBKIT_TEXT_LAYER_PAGE_WINDOW = 1;
const DEBUG_WEBKIT_TEXT_LAYER = false;
export const PDF_SEARCH_EXACT_LIMIT = 120;
export const PDF_SEARCH_EXCERPT_CONTEXT_CHARS = 80;
export const DEFAULT_ZOOM_MODE: PdfZoomMode = "width-fit";
export const DEFAULT_CANVAS_RENDER_PAGE_WINDOW = 2;
export const WEBKIT_CANVAS_RENDER_PAGE_WINDOW = 2;
export const ANDROID_CANVAS_RENDER_PAGE_WINDOW = 1;
export const VIEWPORT_INTERACTION_IDLE_MS = 150;
/** Quiet time after the last Ctrl+wheel event before the real zoom is committed. */
export const WHEEL_ZOOM_SETTLE_MS = 180;
const DESKTOP_PDF_RANGE_CHUNK_SIZE = 262_144;
const MOBILE_PDF_RANGE_CHUNK_SIZE = 131_072;
export const INITIAL_RENDER_STABILIZATION_MS = 300;
export const RESIZE_OBSERVER_DEBOUNCE_MS = 120;
const WEBKIT_CALIBRATION_SAMPLE_LIMIT = 600;
export const WEBKIT_CALIBRATION_SECOND_PASS_THRESHOLD = 0.015;
export const HIGH_ZOOM_RENDER_WINDOW_SCALE = 1.6;
export const LENS_HOVER_DELAY_MS = 280;
/** How long a link jump keeps re-applying itself while pages load in. */
export const DESTINATION_SETTLE_MS = 2000;
export const LENS_PREVIEW_CSS_WIDTH = 420;
export const PAGE_CANVAS_CLASS = "block absolute inset-0";

const IS_ANDROID_RUNTIME = typeof navigator !== "undefined" && /android/i.test(navigator.userAgent);
/**
 * Offscreen rendered pages kept for instant scroll-back. Desktop: 4 pages or
 * 12M canvas pixels (~48MB); Android: 3 pages or 8M pixels (~32MB).
 */
export const renderedPageCache = new RenderedPageCache<object>(
    IS_ANDROID_RUNTIME ? 3 : 4,
    IS_ANDROID_RUNTIME ? 8_000_000 : 12_000_000,
);

function getMaxActiveCanvasRenders(): number {
    if (typeof navigator === "undefined") return 2;
    const hardwareThreads = Math.max(1, navigator.hardwareConcurrency || 4);
    const isAndroid = /android/i.test(navigator.userAgent);
    if (isAndroid) return hardwareThreads >= 8 ? 3 : 2;
    if (hardwareThreads >= 12) return 4;
    if (hardwareThreads >= 8) return 3;
    return 2;
}

const MAX_ACTIVE_CANVAS_RENDERS = getMaxActiveCanvasRenders();

const activeTextLayers = new Map<HTMLDivElement, HTMLDivElement>();
const pageTextContentCache = new Map<number, PageTextContent>();
const pdfDocumentInfoCache = new Map<string, PDFDocumentInfo>();
let textLayerSelectionAbortController: AbortController | null = null;

interface CanvasRenderSlotRequest {
    id: number;
    priority: number;
    cancelled: boolean;
    resolve: (release: () => void) => void;
}

const canvasRenderQueue: CanvasRenderSlotRequest[] = [];
let activeCanvasRenders = 0;
let nextCanvasRenderRequestId = 1;

function pumpCanvasRenderQueue(): void {
    if (canvasRenderQueue.length > 1) {
        canvasRenderQueue.sort((left, right) => {
            if (left.priority === right.priority) return left.id - right.id;
            return left.priority - right.priority;
        });
    }
    while (activeCanvasRenders < MAX_ACTIVE_CANVAS_RENDERS && canvasRenderQueue.length > 0) {
        const request = canvasRenderQueue.shift();
        if (!request || request.cancelled) continue;
        activeCanvasRenders += 1;
        let released = false;
        request.resolve(() => {
            if (released) return;
            released = true;
            activeCanvasRenders = Math.max(0, activeCanvasRenders - 1);
            pumpCanvasRenderQueue();
        });
    }
}

export function requestCanvasRenderSlot(priority: number): { promise: Promise<() => void>; cancel: () => void } {
    let request: CanvasRenderSlotRequest | null = null;
    const id = nextCanvasRenderRequestId++;
    const promise = new Promise<() => void>((resolve) => {
        request = { id, priority, cancelled: false, resolve };
        canvasRenderQueue.push(request);
        pumpCanvasRenderQueue();
    });
    const cancel = () => {
        if (!request || request.cancelled) return;
        request.cancelled = true;
        const index = canvasRenderQueue.findIndex((c) => c.id === request?.id);
        if (index !== -1) canvasRenderQueue.splice(index, 1);
    };
    return { promise, cancel };
}

/** Below every page render (priority = distance from the current page). */
const THUMBNAIL_RENDER_PRIORITY = Number.MAX_SAFE_INTEGER;

export async function renderPdfThumbnail(
    pdf: PDFDocumentProxy,
    pageNumber: number,
    cssWidth: number,
    rotation: number,
    signal?: AbortSignal,
): Promise<Blob | null> {
    if (pageNumber < 1 || pageNumber > pdf.numPages || signal?.aborted) return null;
    const slot = requestCanvasRenderSlot(THUMBNAIL_RENDER_PRIORITY);
    const onAbort = () => slot.cancel();
    signal?.addEventListener("abort", onAbort, { once: true });
    // A cancelled slot never resolves; abort must still settle this call.
    const aborted = new Promise<null>((resolve) => signal?.addEventListener("abort", () => resolve(null), { once: true }));
    const release = await Promise.race([slot.promise, aborted]);
    signal?.removeEventListener("abort", onAbort);
    if (!release) return null;
    const canvas = document.createElement("canvas");
    try {
        if (signal?.aborted) return null;
        const page = await pdf.getPage(pageNumber);
        const base = page.getViewport({ scale: 1, rotation: viewRotation(page, rotation) });
        const pixelRatio = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
        const viewport = page.getViewport({ scale: (cssWidth * pixelRatio) / base.width, rotation: viewRotation(page, rotation) });
        canvas.width = Math.max(1, Math.round(viewport.width));
        canvas.height = Math.max(1, Math.round(viewport.height));
        const context = canvas.getContext("2d", { alpha: false });
        if (!context) return null;
        context.fillStyle = "#fff";
        context.fillRect(0, 0, canvas.width, canvas.height);
        const task = page.render({ canvas, canvasContext: context, viewport });
        const cancel = () => task.cancel();
        signal?.addEventListener("abort", cancel, { once: true });
        try {
            await task.promise;
        } finally {
            signal?.removeEventListener("abort", cancel);
        }
        if (signal?.aborted) return null;
        return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.8));
    } catch {
        return null;
    } finally {
        canvas.width = 0;
        canvas.height = 0;
        release();
    }
}

export function getCanvasPixelRatio(
    cssWidth: number,
    cssHeight: number,
    preferSharpCanvas: boolean,
    currentScale: number,
    reduceRenderQuality: boolean,
): number {
    const rawDeviceRatio = Math.max(1, window.devicePixelRatio || 1);
    const isAndroid = typeof navigator !== "undefined" && /android/i.test(navigator.userAgent);
    const deviceRatio = isAndroid ? Math.min(rawDeviceRatio, 1.25) : rawDeviceRatio;
    const sharpRatioTarget = currentScale <= 1.2 ? WEBKIT_MIN_OUTPUT_SCALE
        : currentScale <= 1.8 ? 1.75
        : currentScale <= 2.6 ? 1.5
        : 1.25;
    const preferredRatio = preferSharpCanvas
        ? (isAndroid ? deviceRatio : Math.max(deviceRatio, sharpRatioTarget))
        : deviceRatio;
    const safePixelBudget = Math.max(1, cssWidth * cssHeight);
    const maxAllowedRatio = Math.sqrt(MAX_CANVAS_PIXEL_COUNT / safePixelBudget);
    // Fast scroll/zoom: a low-resolution first pass (see pdf-render-quality.ts);
    // the page is re-rendered sharp when the interaction ends.
    if (reduceRenderQuality) return Math.min(interactionPixelRatio(isAndroid), maxAllowedRatio);
    return Math.max(1, Math.min(preferredRatio, maxAllowedRatio));
}

export function getCssDimension(value: number, snapToPixelGrid: boolean): number {
    return snapToPixelGrid ? Math.max(1, Math.round(value)) : value;
}

function approximateFraction(value: number): [number, number] {
    if (Math.floor(value) === value) return [value, 1];
    const inverse = 1 / value;
    const limit = 8;
    if (inverse > limit) return [1, limit];
    if (Math.floor(inverse) === inverse) return [1, inverse];
    const target = value > 1 ? inverse : value;
    let a = 0, b = 1, c = 1, d = 1;
    while (true) {
        const p = a + c, q = b + d;
        if (q > limit) break;
        if (target <= p / q) { c = p; d = q; } else { a = p; b = q; }
    }
    return (target - a / b < c / d - target)
        ? (target === value ? [a, b] : [b, a])
        : (target === value ? [c, d] : [d, c]);
}

function floorToDivide(value: number, divider: number): number {
    return value - (value % divider);
}

export interface CanvasSizing { canvasWidth: number; canvasHeight: number; renderScaleX: number; renderScaleY: number; scaleRoundX: number; scaleRoundY: number; }

export function getCanvasSizing(cssWidth: number, cssHeight: number, outputScale: number): CanvasSizing {
    const sfx = approximateFraction(outputScale);
    const sfy = approximateFraction(outputScale);
    const canvasWidth = Math.max(1, floorToDivide(Math.round(cssWidth * outputScale), sfx[0]));
    const canvasHeight = Math.max(1, floorToDivide(Math.round(cssHeight * outputScale), sfy[0]));
    const pageWidth = Math.max(1, floorToDivide(Math.round(cssWidth), sfx[1]));
    const pageHeight = Math.max(1, floorToDivide(Math.round(cssHeight), sfy[1]));
    return { canvasWidth, canvasHeight, renderScaleX: canvasWidth / pageWidth, renderScaleY: canvasHeight / pageHeight, scaleRoundX: sfx[1], scaleRoundY: sfy[1] };
}

function resetTextLayerSelectionState(endNode: HTMLDivElement, layerNode: HTMLDivElement): void {
    layerNode.append(endNode);
    endNode.style.width = "";
    endNode.style.height = "";
    layerNode.classList.remove(TEXT_LAYER_SELECTING_CLASS);
}

function findScrollableAncestor(node: HTMLElement | null): HTMLElement | null {
    let current: HTMLElement | null = node;
    while (current) {
        const style = getComputedStyle(current);
        const overflowY = style.overflowY;
        if ((overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") && current.scrollHeight > current.clientHeight + 1) return current;
        current = current.parentElement;
    }
    const root = document.scrollingElement;
    return root instanceof HTMLElement ? root : null;
}

export function isEditableKeyboardTarget(target: EventTarget | null): boolean {
    const element = target instanceof Element ? target : null;
    if (!element) return false;
    return Boolean(element.closest("input,textarea,select,[contenteditable='true'],[role='textbox']"));
}

function ensureGlobalTextLayerSelectionListeners(): void {
    if (textLayerSelectionAbortController) return;
    textLayerSelectionAbortController = new AbortController();
    const { signal } = textLayerSelectionAbortController;
    let pointerDown = false;
    let isFirefox: boolean | undefined;
    let previousRange: Range | null = null;
    let autoScrollRafId = 0;
    let autoScrollVelocity = 0;
    let autoScrollTarget: HTMLElement | null = null;

    const stopAutoScroll = () => {
        if (autoScrollRafId !== 0) { cancelAnimationFrame(autoScrollRafId); autoScrollRafId = 0; }
        autoScrollVelocity = 0;
        autoScrollTarget = null;
    };
    const runAutoScroll = () => {
        if (!pointerDown || !autoScrollTarget || autoScrollVelocity === 0) { stopAutoScroll(); return; }
        autoScrollTarget.scrollTop += autoScrollVelocity;
        autoScrollRafId = requestAnimationFrame(runAutoScroll);
    };

    document.addEventListener("pointerdown", () => { pointerDown = true; }, { signal });
    document.addEventListener("pointerup", () => {
        pointerDown = false; stopAutoScroll();
        activeTextLayers.forEach((endNode, layerNode) => resetTextLayerSelectionState(endNode, layerNode));
    }, { signal });
    window.addEventListener("blur", () => {
        pointerDown = false; stopAutoScroll();
        activeTextLayers.forEach((endNode, layerNode) => resetTextLayerSelectionState(endNode, layerNode));
    }, { signal });
    document.addEventListener("keyup", () => {
        if (pointerDown) return;
        activeTextLayers.forEach((endNode, layerNode) => resetTextLayerSelectionState(endNode, layerNode));
    }, { signal });
    document.addEventListener("pointercancel", () => { pointerDown = false; stopAutoScroll(); }, { signal });
    document.addEventListener("pointermove", (event) => {
        if (!pointerDown) return;
        const selection = document.getSelection();
        if (!selection || selection.rangeCount === 0) return;
        let sourceElement = event.target instanceof HTMLElement ? event.target : null;
        if (!sourceElement) {
            const pointedElement = document.elementFromPoint(event.clientX, event.clientY);
            sourceElement = pointedElement instanceof HTMLElement ? pointedElement : null;
        }
        let layerNode = sourceElement?.closest<HTMLDivElement>(".textLayer") ?? null;
        if (!layerNode) {
            for (const candidate of activeTextLayers.keys()) {
                if (candidate.classList.contains(TEXT_LAYER_SELECTING_CLASS)) { layerNode = candidate; break; }
            }
        }
        if (!layerNode) { stopAutoScroll(); return; }
        const scrollContainer = findScrollableAncestor(layerNode);
        if (!scrollContainer) { stopAutoScroll(); return; }
        const rect = scrollContainer.getBoundingClientRect();
        const edgeThreshold = 52;
        let velocity = 0;
        if (event.clientY < rect.top + edgeThreshold) {
            const ratio = Math.min(1, (rect.top + edgeThreshold - event.clientY) / edgeThreshold);
            velocity = -Math.max(2, Math.round(24 * ratio));
        } else if (event.clientY > rect.bottom - edgeThreshold) {
            const ratio = Math.min(1, (event.clientY - (rect.bottom - edgeThreshold)) / edgeThreshold);
            velocity = Math.max(2, Math.round(24 * ratio));
        }
        if (velocity === 0) { stopAutoScroll(); return; }
        autoScrollTarget = scrollContainer;
        autoScrollVelocity = velocity;
        if (autoScrollRafId === 0) autoScrollRafId = requestAnimationFrame(runAutoScroll);
    }, { signal, passive: true });

    // Synchronous, as in pdf.js: deferring this to the next frame paints one
    // frame with the selection snapped to the end of the page on every drag
    // step, which reads as the selection blinking up and down.
    document.addEventListener("selectionchange", () => {
        const selection = document.getSelection();
        if (!selection || selection.rangeCount === 0) {
            if (pointerDown) return;
            activeTextLayers.forEach((endNode, layerNode) => resetTextLayerSelectionState(endNode, layerNode));
            return;
        }
        const selectedLayerNodes = new Set<HTMLDivElement>();
        for (let i = 0; i < selection.rangeCount; i++) {
            const range = selection.getRangeAt(i);
            for (const layerNode of activeTextLayers.keys()) {
                try { if (!selectedLayerNodes.has(layerNode) && range.intersectsNode(layerNode)) selectedLayerNodes.add(layerNode); } catch { }
            }
        }
        if (selectedLayerNodes.size === 0) {
            if (pointerDown) return;
            activeTextLayers.forEach((endNode, layerNode) => resetTextLayerSelectionState(endNode, layerNode));
            return;
        }
        for (const [layerNode, endNode] of activeTextLayers) {
            if (selectedLayerNodes.has(layerNode)) layerNode.classList.add(TEXT_LAYER_SELECTING_CLASS);
            else resetTextLayerSelectionState(endNode, layerNode);
        }
        const firstEndNode = activeTextLayers.values().next().value as HTMLDivElement | undefined;
        if (firstEndNode) isFirefox ??= getComputedStyle(firstEndNode).getPropertyValue("-moz-user-select") === "none";
        if (isFirefox) return;
        const range = selection.getRangeAt(0);
        const modifyStart = !!previousRange && (
            range.compareBoundaryPoints(Range.END_TO_END, previousRange) === 0 ||
            range.compareBoundaryPoints(Range.START_TO_END, previousRange) === 0
        );
        let anchorNode: Node | null = modifyStart ? range.startContainer : range.endContainer;
        if (anchorNode?.nodeType === Node.TEXT_NODE) anchorNode = anchorNode.parentNode;
        const anchorElement = anchorNode instanceof HTMLElement ? anchorNode : null;
        const layerNode = anchorElement?.closest<HTMLDivElement>(".textLayer");
        const endNode = layerNode ? activeTextLayers.get(layerNode) : undefined;
        if (layerNode && endNode) {
            endNode.style.width = layerNode.style.width;
            endNode.style.height = layerNode.style.height;
            anchorElement?.parentElement?.insertBefore(endNode, modifyStart ? anchorElement : anchorElement?.nextSibling ?? null);
        }
        previousRange = range.cloneRange();
    }, { signal });

    signal.addEventListener("abort", () => {
        stopAutoScroll();
    }, { once: true });
}

/** True when the current document selection touches `node`. */
export function selectionIntersects(node: Node): boolean {
    const selection = typeof document !== "undefined" ? document.getSelection() : null;
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return false;
    for (let i = 0; i < selection.rangeCount; i++) {
        try {
            if (selection.getRangeAt(i).intersectsNode(node)) return true;
        } catch {
            // Detached ranges throw; treat as not intersecting.
        }
    }
    return false;
}

export function registerTextLayer(layerNode: HTMLDivElement, endNode: HTMLDivElement): void {
    activeTextLayers.set(layerNode, endNode);
    ensureGlobalTextLayerSelectionListeners();
}

export function unregisterTextLayer(layerNode: HTMLDivElement): void {
    activeTextLayers.delete(layerNode);
    if (activeTextLayers.size > 0) return;
    textLayerSelectionAbortController?.abort();
    textLayerSelectionAbortController = null;
}

export function clearPageTextContentCache(): void { pageTextContentCache.clear(); }

export async function getPageTextContent(page: PDFPageProxy): Promise<PageTextContent> {
    const pageNumber = page.pageNumber;
    const cached = pageTextContentCache.get(pageNumber);
    if (cached) {
        pageTextContentCache.delete(pageNumber);
        pageTextContentCache.set(pageNumber, cached);
        return cached;
    }
    const textContent = await page.getTextContent({ includeMarkedContent: true, disableNormalization: true });
    pageTextContentCache.set(pageNumber, textContent);
    while (pageTextContentCache.size > TEXT_CONTENT_CACHE_LIMIT) {
        const oldestKey = pageTextContentCache.keys().next().value as number | undefined;
        if (oldestKey === undefined) break;
        pageTextContentCache.delete(oldestKey);
    }
    return textContent;
}

export function getNormalizedPageText(textContent: PageTextContent): string {
    const textItems = textContent.items as unknown as TextItemLike[];
    return textItems.map((item) => (typeof item?.str === "string" ? item.str : "")).join(" ").replace(/\s+/g, " ").trim();
}

export function buildPdfInfoCacheKey(pdfPath: string, originalFilename: string | undefined, dataByteLength?: number): string {
    if (pdfPath && pdfPath.length > 0) return `path:${pdfPath}`;
    const filenamePart = originalFilename || "document";
    const byteLengthPart = typeof dataByteLength === "number" ? `:len:${dataByteLength}` : "";
    return `blob:${filenamePart}${byteLengthPart}`;
}

export function setCachedPdfDocumentInfo(cacheKey: string, info: PDFDocumentInfo): void {
    if (!cacheKey) return;
    pdfDocumentInfoCache.delete(cacheKey);
    pdfDocumentInfoCache.set(cacheKey, info);
    while (pdfDocumentInfoCache.size > PDF_INFO_CACHE_LIMIT) {
        const oldestKey = pdfDocumentInfoCache.keys().next().value as string | undefined;
        if (!oldestKey) break;
        pdfDocumentInfoCache.delete(oldestKey);
    }
}

export function getCachedPdfDocumentInfo(cacheKey: string, totalPages: number): PDFDocumentInfo | null {
    const cached = pdfDocumentInfoCache.get(cacheKey);
    if (!cached || cached.totalPages !== totalPages) return null;
    pdfDocumentInfoCache.delete(cacheKey);
    pdfDocumentInfoCache.set(cacheKey, cached);
    return cached;
}

export function getFitWidthScale(container: HTMLElement, page: PDFPageProxy, isTwoPage = false): number {
    const viewportPadding = container.clientWidth < 768 ? 16 : 32;
    const spreadGap = isTwoPage ? 24 : 0;
    const containerWidth = (container.clientWidth - viewportPadding - spreadGap) / (isTwoPage ? 2 : 1);
    if (containerWidth <= 0) return DEFAULT_SCALE;
    const viewport = page.getViewport({ scale: PDF_TO_CSS_UNITS });
    if (viewport.width <= 0) return DEFAULT_SCALE;
    return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, containerWidth / viewport.width));
}

export function getFitPageScale(container: HTMLElement, page: PDFPageProxy, isTwoPage = false): number {
    const horizontalPadding = container.clientWidth < 768 ? 16 : 32;
    const spreadGap = isTwoPage ? 24 : 0;
    const verticalPadding = container.clientHeight < 768 ? 24 : 40;
    const containerHeight = container.clientHeight - verticalPadding;
    const containerWidth = (container.clientWidth - horizontalPadding - spreadGap) / (isTwoPage ? 2 : 1);
    if (containerWidth <= 0 || containerHeight <= 0) return DEFAULT_SCALE;
    const viewport = page.getViewport({ scale: PDF_TO_CSS_UNITS });
    if (viewport.width <= 0 || viewport.height <= 0) return DEFAULT_SCALE;
    return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.min(containerWidth / viewport.width, containerHeight / viewport.height)));
}

/**
 * Build a `Float64Array` of length `totalPages` where each entry is the
 * cumulative scroll-top (in CSS pixels) of that page's *top* edge, given a
 * uniform page height derived from the pre-fetched default aspect ratio.
 */
export function computeVirtualPageTops(
    totalPages: number,
    heightPt: number,
    scale: number,
    isTwoPage = false,
    gap = 16,
    topPad = 16,
): Float64Array {
    const tops = new Float64Array(totalPages);
    const cssHeight = Math.max(1, heightPt * PDF_TO_CSS_UNITS * scale) + 2;
    for (let i = 0; i < totalPages; i++) {
        const pageNum = i + 1;
        const rowIndex = isTwoPage
            ? Math.floor((pageNum - 1) / 2)
            : i;
        tops[i] = topPad + rowIndex * (cssHeight + gap);
    }
    return tops;
}

/**
 * Compute a "fit-width" scale from raw PDF point dimensions (before any
 * `PDFPageProxy` is available) so we can apply the correct initial zoom
 * from the very first render.
 */
export function getFitWidthScaleFromPts(container: HTMLElement, widthPt: number, isTwoPage = false): number {
    const viewportPadding = container.clientWidth < 768 ? 16 : 32;
    const spreadGap = isTwoPage ? 24 : 0;
    const containerWidth = (container.clientWidth - viewportPadding - spreadGap) / (isTwoPage ? 2 : 1);
    if (containerWidth <= 0 || widthPt <= 0) return DEFAULT_SCALE;
    const cssPtWidth = widthPt * PDF_TO_CSS_UNITS;
    return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, containerWidth / cssPtWidth));
}

/**
 * `getFitPageScale` equivalent computed from raw PDF point dimensions, so the
 * opening zoom can honour "fit page" before any `PDFPageProxy` exists.
 */
export function getFitPageScaleFromPts(
    container: HTMLElement,
    widthPt: number,
    heightPt: number,
    isTwoPage = false,
): number {
    const horizontalPadding = container.clientWidth < 768 ? 16 : 32;
    const spreadGap = isTwoPage ? 24 : 0;
    const verticalPadding = container.clientHeight < 768 ? 24 : 40;
    const containerHeight = container.clientHeight - verticalPadding;
    const containerWidth = (container.clientWidth - horizontalPadding - spreadGap) / (isTwoPage ? 2 : 1);
    if (containerWidth <= 0 || containerHeight <= 0) return DEFAULT_SCALE;
    const cssPtWidth = widthPt * PDF_TO_CSS_UNITS;
    const cssPtHeight = heightPt * PDF_TO_CSS_UNITS;
    if (cssPtWidth <= 0 || cssPtHeight <= 0) return DEFAULT_SCALE;
    return Math.max(
        MIN_ZOOM,
        Math.min(MAX_ZOOM, Math.min(containerWidth / cssPtWidth, containerHeight / cssPtHeight)),
    );
}

export function clearSearchHighlights(textLayerDiv: HTMLElement) {
    const matches = textLayerDiv.querySelectorAll<HTMLSpanElement>(".pdf-search-match");
    for (let i = 0; i < matches.length; i++) {
        const match = matches[i];
        const text = match.textContent ?? "";
        const parent = match.parentNode;
        if (parent) {
            parent.replaceChild(document.createTextNode(text), match);
            parent.normalize();
        }
    }
}

export function applySearchHighlights(textLayerDiv: HTMLElement, query: string) {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return;

    const walker = document.createTreeWalker(textLayerDiv, NodeFilter.SHOW_TEXT);
    const targetNodes: Text[] = [];
    let currNode = walker.nextNode();
    while (currNode) {
        if (currNode.textContent && currNode.textContent.toLowerCase().includes(normalizedQuery)) {
            targetNodes.push(currNode as Text);
        }
        currNode = walker.nextNode();
    }

    for (const textNode of targetNodes) {
        const parent = textNode.parentElement;
        if (!parent || parent.classList.contains("pdf-search-match")) continue;
        const originalText = textNode.textContent ?? "";
        const lowerText = originalText.toLowerCase();
        let startIndex = 0;
        let matchIdx = lowerText.indexOf(normalizedQuery, startIndex);
        if (matchIdx === -1) continue;

        const frag = document.createDocumentFragment();
        while (matchIdx !== -1) {
            if (matchIdx > startIndex) {
                frag.appendChild(document.createTextNode(originalText.slice(startIndex, matchIdx)));
            }
            const span = document.createElement("span");
            span.className = "pdf-search-match";
            span.textContent = originalText.slice(matchIdx, matchIdx + normalizedQuery.length);
            frag.appendChild(span);
            startIndex = matchIdx + normalizedQuery.length;
            matchIdx = lowerText.indexOf(normalizedQuery, startIndex);
        }
        if (startIndex < originalText.length) {
            frag.appendChild(document.createTextNode(originalText.slice(startIndex)));
        }
        parent.replaceChild(frag, textNode);
    }
}

export function getSpreads(pageCount: number): number[][] {
    if (pageCount <= 0) return [];
    const spreads: number[][] = [];
    for (let p = 1; p <= pageCount; p += 2) {
        if (p + 1 <= pageCount) {
            spreads.push([p, p + 1]);
        } else {
            spreads.push([p]);
        }
    }
    return spreads;
}

function computeMedian(values: number[]): number | null {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function parseScaleX(transform: string): number | null {
    const match = transform.match(/scaleX\(([-+0-9.eE]+)\)/);
    if (!match) return null;
    const parsed = Number(match[1]);
    return Number.isFinite(parsed) ? parsed : null;
}

function mergeScaleX(transform: string, correction: number): string {
    const existing = parseScaleX(transform);
    if (existing === null) return `${transform} scaleX(${correction})`;
    return transform.replace(/scaleX\(([-+0-9.eE]+)\)/, `scaleX(${existing * correction})`);
}

export function calibrateWebKitTextLayerWidth(
    textDivs: HTMLSpanElement[],
    textItems: TextItemLike[],
    viewportScale: number,
): number {
    if (textDivs.length === 0 || textItems.length === 0 || viewportScale <= 0) return 0;

    const ratiosByFont = new Map<string, number[]>();
    const allRatios: number[] = [];
    let textDivIndex = 0;
    let sampledPairs = 0;

    for (const item of textItems) {
        if (sampledPairs >= WEBKIT_CALIBRATION_SAMPLE_LIMIT || textDivIndex >= textDivs.length) break;
        if (typeof item.str !== "string") continue;
        const span = textDivs[textDivIndex++];
        if (!span?.isConnected || !item.str.trim()) continue;
        const expectedWidth = Math.abs((item.width ?? 0) * viewportScale);
        const actualWidth = span.getBoundingClientRect().width;
        if (actualWidth <= 0.01 || expectedWidth <= 0.01) continue;
        const ratio = expectedWidth / actualWidth;
        if (ratio < 0.5 || ratio > 1.5) continue;
        sampledPairs++;
        allRatios.push(ratio);
        const fontKey = span.style.fontFamily || "__default__";
        const bucket = ratiosByFont.get(fontKey);
        if (bucket) bucket.push(ratio); else ratiosByFont.set(fontKey, [ratio]);
    }

    if (allRatios.length < 24) {
        if (import.meta.env.DEV && DEBUG_WEBKIT_TEXT_LAYER)
            return 0;
    }

    const globalMedian = computeMedian(allRatios);
    if (!globalMedian) return 0;

    let globalCorrection: number | null = null;
    if (Math.abs(1 - globalMedian) >= 0.02) globalCorrection = Math.max(0.75, Math.min(1.25, globalMedian));

    const correctionsByFont = new Map<string, number>();
    for (const [fontKey, ratios] of ratiosByFont) {
        if (ratios.length < 8) continue;
        const medianRatio = computeMedian(ratios);
        if (!medianRatio || Math.abs(1 - medianRatio) < 0.02) continue;
        correctionsByFont.set(fontKey, Math.max(0.75, Math.min(1.25, medianRatio)));
    }

    if (correctionsByFont.size === 0 && !globalCorrection) return 0;

    let maxAppliedDeviation = 0;
    for (const span of textDivs) {
        if (!span.isConnected) continue;
        const fontKey = span.style.fontFamily || "__default__";
        const correction = correctionsByFont.get(fontKey) ?? globalCorrection;
        if (!correction || !span.style.transform) continue;
        span.style.transform = mergeScaleX(span.style.transform, correction);
        const deviation = Math.abs(1 - correction);
        if (deviation > maxAppliedDeviation) maxAppliedDeviation = deviation;
    }

    return maxAppliedDeviation;
}

export function waitForNextFrame(): Promise<void> {
    return new Promise((resolve) => { requestAnimationFrame(() => resolve()); });
}

interface PdfOutlineItemLike { title?: string | null; dest?: unknown; items?: PdfOutlineItemLike[] | null; }

async function resolvePdfDestPageNumber(pdfDocument: PDFDocumentProxy, destination: unknown): Promise<number | null> {
    return (await resolvePdfDestTarget(pdfDocument, destination))?.pageNumber ?? null;
}

function sanitizeTocLabel(label?: string | null, fallback?: string): string {
    const trimmed = (label || "").replace(/\s+/g, " ").trim();
    return trimmed.length > 0 ? trimmed : (fallback || "Section");
}

async function convertPdfOutlineItems(pdfDocument: PDFDocumentProxy, items: PdfOutlineItemLike[], depth: number, maxDepth: number): Promise<TocItem[]> {
    if (depth > maxDepth) return [];
    return Promise.all(items.map(async (item, index) => {
        const pageNumber = await resolvePdfDestPageNumber(pdfDocument, item.dest);
        const subitems = item.items && item.items.length > 0 ? await convertPdfOutlineItems(pdfDocument, item.items, depth + 1, maxDepth) : undefined;
        const href = pageNumber ? `pdf:page:${pageNumber}` : (subitems && subitems.length > 0 ? subitems[0].href : "pdf:page:1");
        return { label: sanitizeTocLabel(item.title, `Section ${index + 1}`), href, subitems: subitems && subitems.length > 0 ? subitems : undefined } satisfies TocItem;
    }));
}

export async function buildPdfToc(pdfDocument: PDFDocumentProxy): Promise<{ tocItems: TocItem[]; hasOutline: boolean }> {
    try {
        const outline = await pdfDocument.getOutline();
        if (outline && outline.length > 0) {
            const convertedOutline = await convertPdfOutlineItems(pdfDocument, outline as unknown as PdfOutlineItemLike[], 0, 8);
            if (convertedOutline.length > 0) return { tocItems: convertedOutline, hasOutline: true };
        }
    } catch { }
    return { tocItems: [], hasOutline: false };
}

export function toSerializablePdfData(data: Uint8Array): Uint8Array {
    if (data.byteOffset === 0 && data.byteLength === data.buffer.byteLength) return data;
    if (!isWebKitBrowserEngine()) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return new Uint8Array(data);
}

export function getPreferredPdfRangeChunkSize(): number {
    if (typeof navigator === "undefined") return DESKTOP_PDF_RANGE_CHUNK_SIZE;
    const isAndroid = /android/i.test(navigator.userAgent);
    return isAndroid ? MOBILE_PDF_RANGE_CHUNK_SIZE : DESKTOP_PDF_RANGE_CHUNK_SIZE;
}

export class TauriPdfRangeTransport extends pdfjsLib.PDFDataRangeTransport {
    private aborted = false;
    private loadedBytes = 0;
    private readonly path: string;

    constructor(path: string, length: number) {
        super(length, null, false);
        this.path = path;
        this.transportReady(() => {});
    }

    override requestDataRange(begin: number, end: number): void {
        if (this.aborted) return;
        const safeBegin = Math.max(0, Math.floor(begin));
        const safeEnd = Math.max(safeBegin, Math.floor(end));
        const length = safeEnd - safeBegin;
        if (length <= 0) {
            this.onDataRange(safeBegin, new Uint8Array(0));
            return;
        }

        void invoke<Uint8Array>("read_pdf_range", { path: this.path, offset: safeBegin, length })
            .then((chunk) => {
                if (this.aborted) return;
                const normalizedChunk = toSerializablePdfData(chunk);
                this.loadedBytes = Math.min(this.length, Math.max(this.loadedBytes, safeBegin + normalizedChunk.byteLength));
                this.onDataRange(safeBegin, normalizedChunk);
            })
            .catch(() => {
                if (this.aborted) return;
                this.abort();
            });
    }

    override abort(): void {
        if (this.aborted) return;
        this.aborted = true;
        super.abort();
    }
}

export function openExternalUrl(url: string): void {
    if (isTauri()) {
        void import("@tauri-apps/plugin-opener").then(({ openUrl }) => openUrl(url)).catch(() => undefined);
        return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
}

export function findPageForScrollCenter(pageLayout: PageLayoutEntry[], centerY: number): number | null {
    if (pageLayout.length === 0) return null;
    let low = 0, high = pageLayout.length - 1;
    while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        const entry = pageLayout[mid];
        if (centerY < entry.top) { high = mid - 1; continue; }
        if (centerY > entry.bottom) { low = mid + 1; continue; }
        return entry.pageNumber;
    }
    if (high < 0) return pageLayout[0].pageNumber;
    if (low >= pageLayout.length) return pageLayout[pageLayout.length - 1].pageNumber;
    const aboveEntry = pageLayout[high];
    const belowEntry = pageLayout[low];
    return Math.abs(centerY - aboveEntry.bottom) <= Math.abs(belowEntry.top - centerY) ? aboveEntry.pageNumber : belowEntry.pageNumber;
}
