
import {
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
    useCallback,
    forwardRef,
    useImperativeHandle,
    useMemo,
    memo,
} from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { cn } from "../../../core/lib/utils";
import { isTauri, isWebKitBrowserEngine } from "../../../core/lib/env";
import { configurePdfJsWorker, PDFJS_ASSET_OPTIONS } from "../../../core/lib/pdfjs-runtime";
import { rankByFuzzyQuery } from "../../../core/lib/search/fuzzy";
import * as pdfjsLib from "pdfjs-dist";
import { Dropdown, PageLoader } from "../../../ui";
import { AlertCircle, ChevronLeft, ChevronRight } from "lucide-react";
import { TextLayer } from "pdfjs-dist";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import type { Annotation, HighlightColor, PdfZoomMode, SearchResult, TocItem } from "../../../core/types";
import { PDFAnnotationLayer } from "../components/PDFAnnotationLayer";
import { PDFLinkLayer, PdfLinkHandlersContext, type PdfLinkHandlers } from "../components/PDFLinkLayer";
import { resolvePdfDestTarget, type PdfDestTarget, type PdfLink } from "./pdf-links";
import { buildPdfLensPreview, type PdfLensPreview } from "./pdf-lens";
import { pushPdfHistory, stepPdfHistory, type PdfHistoryEntry } from "./pdf-history";
import { captureZoomAnchor, resolveZoomAnchor, type ZoomAnchor } from "./pdf-zoom-anchor";

import "./pdfjs-engine.css";

configurePdfJsWorker(pdfjsLib);

export interface PDFJsEngineProps {
    pdfPath: string;
    pdfData?: Uint8Array;
    originalFilename?: string;
    initialPage?: number;
    initialZoom?: number;
    initialZoomMode?: PdfZoomMode;
    presentationMode?: 'scroll' | 'paged' | 'two-page';
    onPresentationModeChange?: (mode: 'scroll' | 'paged' | 'two-page') => void;
    onLoad?: (info: PDFDocumentInfo) => void;
    onError?: (error: Error) => void;
    onPageChange?: (page: number, totalPages: number, scale: number) => void;
    onZoomModeChange?: (mode: PdfZoomMode) => void;
    onViewportTap?: () => void;
    showControls?: boolean;
    className?: string;
    annotations?: Annotation[];
    annotationMode?: 'none' | 'highlight' | 'pen' | 'text' | 'erase';
    highlightColor?: HighlightColor;
    penColor?: HighlightColor;
    penWidth?: number;
    onAnnotationAdd?: (annotation: Partial<Annotation>) => void;
    onAnnotationChange?: (annotation: Annotation) => void;
    onAnnotationRemove?: (id: string) => void;
    /** Back/forward availability after link, TOC and page jumps. */
    onHistoryChange?: (state: { canGoBack: boolean; canGoForward: boolean }) => void;
    /** Theorem Lens preview for an internal link; null asks to hide a hover preview. */
    onLinkPreview?: (event: PdfLinkPreviewEvent | null) => void;
}

export interface PdfLinkPreviewEvent {
    preview: PdfLensPreview;
    target: PdfDestTarget;
    /** Viewport rect of the link that triggered the preview. */
    anchorRect: { top: number; left: number; right: number; bottom: number; width: number; height: number };
    /** Hover previews close when the pointer leaves; tap previews stay until dismissed. */
    mode: "hover" | "tap";
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
    hasOutline?: boolean;
    toc?: TocItem[];
}

export interface PDFSearchState {
    query: string;
    highlightAll: boolean;
    caseSensitive: boolean;
    entireWord: boolean;
}

export interface PDFJsEngineRef {
    goToPage: (page: number) => void;
    nextPage: () => void;
    prevPage: () => void;
    zoomIn: () => void;
    zoomOut: () => void;
    zoomReset: () => void;
    setZoom: (scale: number) => void;
    getZoom: () => number;
    getCurrentPage: () => number;
    getTotalPages: () => number;
    rotateClockwise: () => void;
    rotateCounterClockwise: () => void;
    zoomFitPage: () => void;
    zoomFitWidth: () => void;
    setPresentationMode: (mode: 'scroll' | 'paged' | 'two-page') => void;
    getPresentationMode: () => 'scroll' | 'paged' | 'two-page';
    search: (query: string) => AsyncGenerator<SearchResult | { progress: number } | "done">;
    clearSearch: () => void;
    goBack: () => void;
    goForward: () => void;
    canGoBack: () => boolean;
    canGoForward: () => boolean;
    /** Jump to a resolved destination (records history), e.g. from the Lens. */
    goToDestination: (target: PdfDestTarget) => void;
}

/** Shape of the `prefetch_pdf_structure` Tauri command response. */
interface PdfStructure {
    total_pages: number;
    default_width_pt: number;
    default_height_pt: number;
    file_size_bytes: number;
    title?: string;
    author?: string;
}

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 5.0;
const ZOOM_STEP = 0.10;
const DEFAULT_SCALE = 1.0;
const PDF_TO_CSS_UNITS = pdfjsLib.PixelsPerInch?.PDF_TO_CSS_UNITS ?? (96 / 72);
const PAGE_PRERENDER_MARGIN = "90% 0px";
const INITIAL_PAGE_LOAD_SIZE = 1;
const PAGE_LOAD_BATCH_SIZE = 8;
const PAGE_LOAD_AHEAD_THRESHOLD = 4;
const PAGE_EDGE_PREFETCH_COUNT = 8;
const EDGE_PREFETCH_MIN_INTERVAL_MS = 60;
const PAGE_PROXY_LOAD_CONCURRENCY = 3;
const KEYBOARD_SCROLL_STEP_RATIO = 0.82;
const KEYBOARD_SCROLL_STEP_MIN_PX = 72;

const PAGE_PROXY_KEEP_WINDOW = 50;
const PAGE_PROXY_PAGED_KEEP_WINDOW = 2;

const WEBKIT_MIN_OUTPUT_SCALE = 1.2;
const MAX_CANVAS_PIXEL_COUNT = 12_000_000;
const TEXT_CONTENT_CACHE_LIMIT = 12;
const PDF_INFO_CACHE_LIMIT = 12;
const EMPTY_ANNOTATIONS: Annotation[] = [];
const TEXT_LAYER_SELECTING_CLASS = "selecting";
const WEBKIT_TEXT_LAYER_PAGE_WINDOW = 1;
const DEBUG_WEBKIT_TEXT_LAYER = false;
const PDF_SEARCH_EXACT_LIMIT = 120;
const PDF_SEARCH_FALLBACK_TRIGGER_THRESHOLD = 3;
const PDF_SEARCH_FALLBACK_LIMIT = 12;
const PDF_SEARCH_FALLBACK_PAGE_CHAR_LIMIT = 8_000;

const PDF_SEARCH_FALLBACK_TOTAL_CHAR_BUDGET = 600_000;
const PDF_SEARCH_MAX_PAGES_SCANNED = 500;

const PDF_SEARCH_EXCERPT_CONTEXT_CHARS = 80;
const PDF_SEARCH_EXACT_SCAN_PROGRESS_WEIGHT = 0.9;
const DEFAULT_ZOOM_MODE: PdfZoomMode = "width-fit";
const DEFAULT_CANVAS_RENDER_PAGE_WINDOW = 2;
const WEBKIT_CANVAS_RENDER_PAGE_WINDOW = 2;
const ANDROID_CANVAS_RENDER_PAGE_WINDOW = 1;
const VIEWPORT_INTERACTION_IDLE_MS = 150;
const WHEEL_ZOOM_RENDER_INTERVAL_MS = 90;
const DESKTOP_PDF_RANGE_CHUNK_SIZE = 262_144;
const MOBILE_PDF_RANGE_CHUNK_SIZE = 131_072;
const INITIAL_RENDER_STABILIZATION_MS = 300;
const INACTIVE_CANVAS_RELEASE_DELAY_MS = 600;
const DESKTOP_WEBKIT_INACTIVE_RELEASE_DELAY_MS = 1200;

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

const RESIZE_OBSERVER_DEBOUNCE_MS = 120;

const WEBKIT_CALIBRATION_SAMPLE_LIMIT = 600;

const WEBKIT_CALIBRATION_SECOND_PASS_THRESHOLD = 0.015;

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

function requestCanvasRenderSlot(priority: number): { promise: Promise<() => void>; cancel: () => void } {
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

function getCanvasPixelRatio(
    cssWidth: number,
    cssHeight: number,
    preferSharpCanvas: boolean,
    currentScale: number,
    reduceRenderQuality: boolean,
): number {
    const rawDeviceRatio = Math.max(1, window.devicePixelRatio || 1);
    const isAndroid = typeof navigator !== 'undefined' && /android/i.test(navigator.userAgent);
    const deviceRatio = isAndroid ? Math.min(rawDeviceRatio, 1.25) : rawDeviceRatio;
    const sharpRatioTarget = currentScale <= 1.2 ? WEBKIT_MIN_OUTPUT_SCALE
        : currentScale <= 1.8 ? 1.75
        : currentScale <= 2.6 ? 1.5
        : 1.25;
    const preferredRatio = preferSharpCanvas
        ? (isAndroid ? deviceRatio : Math.max(deviceRatio, sharpRatioTarget))
        : deviceRatio;
    const interactionRatioCap = reduceRenderQuality ? (isAndroid ? 1.0 : 1.2) : Number.POSITIVE_INFINITY;
    const targetRatio = Math.min(preferredRatio, interactionRatioCap);
    const safePixelBudget = Math.max(1, cssWidth * cssHeight);
    const maxAllowedRatio = Math.sqrt(MAX_CANVAS_PIXEL_COUNT / safePixelBudget);
    return Math.max(1, Math.min(targetRatio, maxAllowedRatio));
}

function getCssDimension(value: number, snapToPixelGrid: boolean): number {
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

interface CanvasSizing { canvasWidth: number; canvasHeight: number; renderScaleX: number; renderScaleY: number; scaleRoundX: number; scaleRoundY: number; }

function getCanvasSizing(cssWidth: number, cssHeight: number, outputScale: number): CanvasSizing {
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

function isEditableKeyboardTarget(target: EventTarget | null): boolean {
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
    let selectionFrameId = 0;
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

    document.addEventListener("selectionchange", () => {
        if (selectionFrameId !== 0) return;
        selectionFrameId = requestAnimationFrame(() => {
            selectionFrameId = 0;
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
                    try { if (!selectedLayerNodes.has(layerNode) && range.intersectsNode(layerNode)) selectedLayerNodes.add(layerNode); } catch {  }
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
        });
    }, { signal });

    signal.addEventListener("abort", () => {
        if (selectionFrameId !== 0) { cancelAnimationFrame(selectionFrameId); selectionFrameId = 0; }
        stopAutoScroll();
    }, { once: true });
}

function registerTextLayer(layerNode: HTMLDivElement, endNode: HTMLDivElement): void {
    activeTextLayers.set(layerNode, endNode);
    ensureGlobalTextLayerSelectionListeners();
}

function unregisterTextLayer(layerNode: HTMLDivElement): void {
    activeTextLayers.delete(layerNode);
    if (activeTextLayers.size > 0) return;
    textLayerSelectionAbortController?.abort();
    textLayerSelectionAbortController = null;
}

interface TextItemLike { str?: string; width?: number; }
type PageTextContent = Awaited<ReturnType<PDFPageProxy["getTextContent"]>>;
interface PDFSearchPageItem { pageNumber: number; text: string; }

function clearPageTextContentCache(): void { pageTextContentCache.clear(); }

async function getPageTextContent(page: PDFPageProxy): Promise<PageTextContent> {
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

function getNormalizedPageText(textContent: PageTextContent): string {
    const textItems = textContent.items as unknown as TextItemLike[];
    return textItems.map((item) => (typeof item?.str === "string" ? item.str : "")).join(" ").replace(/\s+/g, " ").trim();
}

function buildPdfInfoCacheKey(pdfPath: string, originalFilename: string | undefined, dataByteLength?: number): string {
    if (pdfPath && pdfPath.length > 0) return `path:${pdfPath}`;
    const filenamePart = originalFilename || "document";
    const byteLengthPart = typeof dataByteLength === "number" ? `:len:${dataByteLength}` : "";
    return `blob:${filenamePart}${byteLengthPart}`;
}

function setCachedPdfDocumentInfo(cacheKey: string, info: PDFDocumentInfo): void {
    if (!cacheKey) return;
    pdfDocumentInfoCache.delete(cacheKey);
    pdfDocumentInfoCache.set(cacheKey, info);
    while (pdfDocumentInfoCache.size > PDF_INFO_CACHE_LIMIT) {
        const oldestKey = pdfDocumentInfoCache.keys().next().value as string | undefined;
        if (!oldestKey) break;
        pdfDocumentInfoCache.delete(oldestKey);
    }
}

function getCachedPdfDocumentInfo(cacheKey: string, totalPages: number): PDFDocumentInfo | null {
    const cached = pdfDocumentInfoCache.get(cacheKey);
    if (!cached || cached.totalPages !== totalPages) return null;
    pdfDocumentInfoCache.delete(cacheKey);
    pdfDocumentInfoCache.set(cacheKey, cached);
    return cached;
}

function getFitWidthScale(container: HTMLElement, page: PDFPageProxy, isTwoPage = false): number {
    const viewportPadding = container.clientWidth < 768 ? 16 : 32;
    const spreadGap = isTwoPage ? 24 : 0;
    const containerWidth = (container.clientWidth - viewportPadding - spreadGap) / (isTwoPage ? 2 : 1);
    if (containerWidth <= 0) return DEFAULT_SCALE;
    const viewport = page.getViewport({ scale: PDF_TO_CSS_UNITS });
    if (viewport.width <= 0) return DEFAULT_SCALE;
    return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, containerWidth / viewport.width));
}

function getFitPageScale(container: HTMLElement, page: PDFPageProxy, isTwoPage = false): number {
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

function getPdfSearchLocation(pageNumber: number): string { return `pdf:page:${pageNumber}`; }

/**
 * Build a `Float64Array` of length `totalPages` where each entry is the
 * cumulative scroll-top (in CSS pixels) of that page's *top* edge, given a
 * uniform page height derived from the pre-fetched default aspect ratio.
 */
function computeVirtualPageTops(
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
function getFitWidthScaleFromPts(container: HTMLElement, widthPt: number, isTwoPage = false): number {
    const viewportPadding = container.clientWidth < 768 ? 16 : 32;
    const spreadGap = isTwoPage ? 24 : 0;
    const containerWidth = (container.clientWidth - viewportPadding - spreadGap) / (isTwoPage ? 2 : 1);
    if (containerWidth <= 0 || widthPt <= 0) return DEFAULT_SCALE;
    const cssPtWidth = widthPt * PDF_TO_CSS_UNITS;
    return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, containerWidth / cssPtWidth));
}

function clearSearchHighlights(textLayerDiv: HTMLElement) {
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

function applySearchHighlights(textLayerDiv: HTMLElement, query: string) {
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

function getSpreads(pageCount: number): number[][] {
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

function createPdfSearchExcerpt(pageText: string, query: string, knownMatchIndex?: number): string {
    const normalizedText = pageText.replace(/\s+/g, " ").trim();
    if (!normalizedText) return "";
    const normalizedQuery = query.trim();
    if (!normalizedQuery) return normalizedText.slice(0, PDF_SEARCH_EXCERPT_CONTEXT_CHARS * 2);
    const matchIndex = typeof knownMatchIndex === "number" ? knownMatchIndex : normalizedText.toLowerCase().indexOf(normalizedQuery.toLowerCase());
    if (matchIndex === -1) return normalizedText.slice(0, PDF_SEARCH_EXCERPT_CONTEXT_CHARS * 2);
    const excerptStart = Math.max(0, matchIndex - PDF_SEARCH_EXCERPT_CONTEXT_CHARS);
    const excerptEnd = Math.min(normalizedText.length, matchIndex + normalizedQuery.length + PDF_SEARCH_EXCERPT_CONTEXT_CHARS);
    return `${excerptStart > 0 ? "…" : ""}${normalizedText.slice(excerptStart, excerptEnd)}${excerptEnd < normalizedText.length ? "…" : ""}`;
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

function calibrateWebKitTextLayerWidth(
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

    if (import.meta.env.DEV && DEBUG_WEBKIT_TEXT_LAYER) {
    }

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

function waitForNextFrame(): Promise<void> {
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

async function buildPdfToc(pdfDocument: PDFDocumentProxy): Promise<{ tocItems: TocItem[]; hasOutline: boolean }> {
    try {
        const outline = await pdfDocument.getOutline();
        if (outline && outline.length > 0) {
            const convertedOutline = await convertPdfOutlineItems(pdfDocument, outline as unknown as PdfOutlineItemLike[], 0, 8);
            if (convertedOutline.length > 0) return { tocItems: convertedOutline, hasOutline: true };
        }
    } catch (error) {  }
    return { tocItems: [], hasOutline: false };
}

function toSerializablePdfData(data: Uint8Array): Uint8Array {
    if (data.byteOffset === 0 && data.byteLength === data.buffer.byteLength) return data;
    if (!isWebKitBrowserEngine()) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return new Uint8Array(data);
}

function getPreferredPdfRangeChunkSize(): number {
    if (typeof navigator === "undefined") return DESKTOP_PDF_RANGE_CHUNK_SIZE;
    const isAndroid = /android/i.test(navigator.userAgent);
    return isAndroid ? MOBILE_PDF_RANGE_CHUNK_SIZE : DESKTOP_PDF_RANGE_CHUNK_SIZE;
}

class TauriPdfRangeTransport extends pdfjsLib.PDFDataRangeTransport {
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

interface PageCanvasProps {
    page: PDFPageProxy;
    scale: number;
    rotation: number;
    isRenderActive: boolean;
    forceRenderActive?: boolean;
    inactiveReleaseDelayMs: number;
    getRenderPriority: (pageNumber: number) => number;
    annotations?: Annotation[];
    annotationMode?: 'none' | 'highlight' | 'pen' | 'text' | 'erase';
    highlightColor: HighlightColor;
    penColor: HighlightColor;
    penWidth: number;
    enableTextLayer: boolean;
    preferSharpCanvas: boolean;
    reduceRenderQuality: boolean;
    snapCssToPixels: boolean;
    useStreamTextLayer: boolean;
    calibrateTextLayerWidths: boolean;
    searchQuery?: string;
    onAnnotationAdd?: (annotation: Partial<Annotation>) => void;
    onAnnotationChange?: (annotation: Annotation) => void;
    onAnnotationRemove?: (id: string) => void;
}

const PageCanvas = memo(function PageCanvas({
    page, scale, rotation, isRenderActive, forceRenderActive = false, inactiveReleaseDelayMs, getRenderPriority,
    annotations = [], annotationMode = "none", highlightColor, penColor, penWidth,
    enableTextLayer, preferSharpCanvas, reduceRenderQuality, snapCssToPixels, useStreamTextLayer,
    calibrateTextLayerWidths, searchQuery, onAnnotationAdd, onAnnotationChange, onAnnotationRemove,
}: PageCanvasProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const textLayerRef = useRef<HTMLDivElement>(null);
    const renderTaskRef = useRef<ReturnType<PDFPageProxy["render"]> | null>(null);
    const textLayerInstanceRef = useRef<TextLayer | null>(null);
    const inactiveReleaseTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const lastCanvasRenderKeyRef = useRef<string>("");
    const hasRenderedCanvasRef = useRef(false);
    const [isNearViewport, setIsNearViewport] = useState(() => isRenderActive || forceRenderActive || page.pageNumber <= 3);
    const shouldRenderAnnotationLayer = annotationMode !== "none" || annotations.length > 0;
    const shouldRender = isNearViewport || isRenderActive || forceRenderActive;

    useLayoutEffect(() => {
        const container = containerRef.current;
        const canvas = canvasRef.current;
        const textLayerDiv = textLayerRef.current;
        if (!container || !canvas) return;
        if (enableTextLayer && !textLayerDiv) return;
        const viewport = page.getViewport({ scale: scale * PDF_TO_CSS_UNITS, rotation });
        const cssWidth = getCssDimension(viewport.width, snapCssToPixels);
        const cssHeight = getCssDimension(viewport.height, snapCssToPixels);
        container.style.width = `${cssWidth}px`;
        container.style.height = `${cssHeight}px`;
        container.style.setProperty("--scale-factor", `${viewport.scale}`);
        container.style.setProperty("--total-scale-factor", `${viewport.scale}`);
        canvas.style.width = `${cssWidth}px`;
        canvas.style.height = `${cssHeight}px`;
    }, [page, scale, rotation, enableTextLayer, snapCssToPixels]);

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;
        if (typeof IntersectionObserver === "undefined") { setIsNearViewport(true); return; }
        const observer = new IntersectionObserver(
            (entries) => { const next = Boolean(entries[0]?.isIntersecting); setIsNearViewport((prev) => prev === next ? prev : next); },
            { root: null, rootMargin: PAGE_PRERENDER_MARGIN },
        );
        observer.observe(container);
        return () => { observer.disconnect(); };
    }, []);

    useEffect(() => {
        if (shouldRender) {
            if (inactiveReleaseTimeoutRef.current) {
                clearTimeout(inactiveReleaseTimeoutRef.current);
                inactiveReleaseTimeoutRef.current = null;
            }
            return;
        }
        if (inactiveReleaseTimeoutRef.current) return;
        const canvas = canvasRef.current;
        const textLayerDiv = textLayerRef.current;
        inactiveReleaseTimeoutRef.current = setTimeout(() => {
            inactiveReleaseTimeoutRef.current = null;
            try { renderTaskRef.current?.cancel(); } catch {  }
            renderTaskRef.current = null;
            try { textLayerInstanceRef.current?.cancel(); } catch {  }
            textLayerInstanceRef.current = null;
            if (enableTextLayer && textLayerDiv) { unregisterTextLayer(textLayerDiv); textLayerDiv.innerHTML = ""; }
            if (canvas && hasRenderedCanvasRef.current) {
                canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
                canvas.width = 0; canvas.height = 0;
            }
            hasRenderedCanvasRef.current = false;
            lastCanvasRenderKeyRef.current = "";
            page.cleanup();
        }, inactiveReleaseDelayMs);

        return () => {
            if (inactiveReleaseTimeoutRef.current) {
                clearTimeout(inactiveReleaseTimeoutRef.current);
                inactiveReleaseTimeoutRef.current = null;
            }
        };
    }, [enableTextLayer, shouldRender, inactiveReleaseDelayMs, page]);

    useEffect(() => () => {
        if (inactiveReleaseTimeoutRef.current) {
            clearTimeout(inactiveReleaseTimeoutRef.current);
            inactiveReleaseTimeoutRef.current = null;
        }
        try { renderTaskRef.current?.cancel(); } catch {}
        renderTaskRef.current = null;
        try { textLayerInstanceRef.current?.cancel(); } catch {}
        textLayerInstanceRef.current = null;
        if (canvasRef.current) {
            canvasRef.current.width = 0;
            canvasRef.current.height = 0;
        }
        page.cleanup();
    }, [page]);

    useEffect(() => {
        if (!shouldRender) return;
        let cancelled = false;
        let cancelQueuedRenderSlot: (() => void) | null = null;
        let releaseRenderSlot: (() => void) | null = null;
        const canvas = canvasRef.current;
        const textLayerDiv = textLayerRef.current;
        if (!canvas) return;
        if (enableTextLayer && !textLayerDiv) return;

        const renderPage = async () => {
            try { renderTaskRef.current?.cancel(); } catch {  }
            renderTaskRef.current = null;
            try { textLayerInstanceRef.current?.cancel(); } catch {  }
            textLayerInstanceRef.current = null;

            try {
                const viewport = page.getViewport({ scale: scale * PDF_TO_CSS_UNITS, rotation });
                const cssWidth = getCssDimension(viewport.width, snapCssToPixels);
                const cssHeight = getCssDimension(viewport.height, snapCssToPixels);
                const outputScale = getCanvasPixelRatio(cssWidth, cssHeight, preferSharpCanvas, scale, reduceRenderQuality);
                const sizing = getCanvasSizing(cssWidth, cssHeight, outputScale);
                const canvasRenderKey = [page.pageNumber, viewport.scale.toFixed(4), rotation, sizing.canvasWidth, sizing.canvasHeight].join(":");
                const shouldRenderCanvas = !hasRenderedCanvasRef.current || lastCanvasRenderKeyRef.current !== canvasRenderKey;

                containerRef.current?.style.setProperty("--scale-factor", `${viewport.scale}`);
                containerRef.current?.style.setProperty("--total-scale-factor", `${viewport.scale}`);
                containerRef.current?.style.setProperty("--scale-round-x", `${sizing.scaleRoundX}px`);
                containerRef.current?.style.setProperty("--scale-round-y", `${sizing.scaleRoundY}px`);

                if (shouldRenderCanvas) {
                    const slotRequest = requestCanvasRenderSlot(getRenderPriority(page.pageNumber));
                    cancelQueuedRenderSlot = slotRequest.cancel;
                    releaseRenderSlot = await slotRequest.promise;
                    cancelQueuedRenderSlot = null;
                    if (cancelled) { releaseRenderSlot(); releaseRenderSlot = null; return; }

                    // Double-buffered rendering: draw to offscreen canvas first so the on-screen
                    // canvas maintains its previous content (smoothly scaled via CSS width/height)
                    // without any blank white flash during zoom or resolution changes.
                    const offscreen = document.createElement("canvas");
                    offscreen.width = sizing.canvasWidth;
                    offscreen.height = sizing.canvasHeight;
                    const offscreenCtx = offscreen.getContext("2d", { alpha: false });
                    if (!offscreenCtx || cancelled) { releaseRenderSlot(); releaseRenderSlot = null; return; }

                    const renderTask = page.render({
                        canvas: null,
                        canvasContext: offscreenCtx,
                        viewport,
                        transform: [sizing.renderScaleX, 0, 0, sizing.renderScaleY, 0, 0]
                    });
                    renderTaskRef.current = renderTask;
                    await renderTask.promise;
                    if (cancelled) return;

                    // Atomically blit the completed offscreen image onto the visible canvas in a single frame
                    canvas.width = sizing.canvasWidth;
                    canvas.height = sizing.canvasHeight;
                    const mainCtx = canvas.getContext("2d", { alpha: false });
                    if (mainCtx) {
                        mainCtx.drawImage(offscreen, 0, 0);
                    }

                    hasRenderedCanvasRef.current = true;
                    lastCanvasRenderKeyRef.current = canvasRenderKey;
                    releaseRenderSlot();
                    releaseRenderSlot = null;
                }

                if (enableTextLayer && textLayerDiv) {
                    unregisterTextLayer(textLayerDiv);
                    textLayerDiv.innerHTML = "";
                    textLayerDiv.tabIndex = 0;
                    if (textLayerDiv.dataset.textSelectionBound !== "1") {
                        textLayerDiv.addEventListener("pointerdown", () => { textLayerDiv.classList.add(TEXT_LAYER_SELECTING_CLASS); });
                        textLayerDiv.addEventListener("copy", (event) => {
                            const selection = document.getSelection();
                            if (!selection) return;
                            event.preventDefault();
                            event.clipboardData?.setData("text/plain", selection.toString());
                        });
                        textLayerDiv.dataset.textSelectionBound = "1";
                    }

                    try {
                        let textItemsForCalibration: TextItemLike[] | null = null;
                        let textContentSource: PageTextContent | ReturnType<PDFPageProxy["streamTextContent"]>;
                        if (useStreamTextLayer) {
                            textContentSource = page.streamTextContent({ includeMarkedContent: true, disableNormalization: true });
                        } else {
                            const textContent = await getPageTextContent(page);
                            textContentSource = textContent;
                            textItemsForCalibration = (textContentSource.items as unknown as TextItemLike[]) ?? null;
                        }
                        if (cancelled) return;

                        const textLayer = new TextLayer({ textContentSource, container: textLayerDiv, viewport });
                        textLayerInstanceRef.current = textLayer;
                        await textLayer.render();

                        if (calibrateTextLayerWidths && textItemsForCalibration) {
                            const renderedSpans = textLayer.textDivs as unknown as HTMLSpanElement[];
                            const firstPassMaxDeviation = calibrateWebKitTextLayerWidth(renderedSpans, textItemsForCalibration, viewport.scale);
                            if (firstPassMaxDeviation >= WEBKIT_CALIBRATION_SECOND_PASS_THRESHOLD) {
                                await waitForNextFrame();
                                await waitForNextFrame();
                                if (!cancelled) calibrateWebKitTextLayerWidth(renderedSpans, textItemsForCalibration, viewport.scale);
                            }
                        }

                        const endOfContent = document.createElement("div");
                        endOfContent.className = "endOfContent";
                        textLayerDiv.append(endOfContent);
                        registerTextLayer(textLayerDiv, endOfContent);
                        if (searchQuery) {
                            applySearchHighlights(textLayerDiv, searchQuery);
                        }
                    } catch (textError) {
                        const isAbortError = textError instanceof Error && (textError.name === "AbortException" || textError.message.toLowerCase().includes("abort") || textError.message.toLowerCase().includes("cancel"));
                        if (!isAbortError) {  }
                    }
                }

                if (!cancelled) { renderTaskRef.current = null; }
            } catch (error: unknown) {
                const isCancelled = error instanceof Error && (error.message.includes("cancelled") || error.message.includes("Rendering cancelled"));
                if (!isCancelled) {  }
            } finally {
                cancelQueuedRenderSlot?.(); cancelQueuedRenderSlot = null;
                releaseRenderSlot?.(); releaseRenderSlot = null;
            }
        };

        renderPage();

        return () => {
            cancelled = true;
            if (inactiveReleaseTimeoutRef.current) {
                clearTimeout(inactiveReleaseTimeoutRef.current);
                inactiveReleaseTimeoutRef.current = null;
            }
            cancelQueuedRenderSlot?.();
            releaseRenderSlot?.();
            try { renderTaskRef.current?.cancel(); } catch {  }
            if (enableTextLayer) {
                try { textLayerInstanceRef.current?.cancel(); } catch {  }
                if (textLayerRef.current) unregisterTextLayer(textLayerRef.current);
            }
        };
    }, [page, scale, rotation, shouldRender, enableTextLayer, preferSharpCanvas, reduceRenderQuality, snapCssToPixels, useStreamTextLayer, calibrateTextLayerWidths, getRenderPriority, searchQuery]);

    useEffect(() => {
        const textLayerDiv = textLayerRef.current;
        if (!textLayerDiv || !enableTextLayer) return;
        clearSearchHighlights(textLayerDiv);
        if (searchQuery) {
            applySearchHighlights(textLayerDiv, searchQuery);
        }
    }, [searchQuery, enableTextLayer]);

    return (
        <div ref={containerRef} className="pdf-page-container">
            <canvas ref={canvasRef} className="block absolute inset-0" />
            {enableTextLayer && <div ref={textLayerRef} className="textLayer" />}
            {shouldRender && <PDFLinkLayer page={page} cssScale={scale * PDF_TO_CSS_UNITS} rotation={rotation} />}
            {shouldRender && shouldRenderAnnotationLayer && (
                <PDFAnnotationLayer
                    pageNumber={page.pageNumber} annotations={annotations} mode={annotationMode}
                    scale={scale} highlightColor={highlightColor} penColor={penColor} penWidth={penWidth}
                    onAnnotationAdd={(ann) => onAnnotationAdd?.(ann)}
                    onAnnotationChange={(annotation) => onAnnotationChange?.(annotation)}
                    onAnnotationRemove={(id) => onAnnotationRemove?.(id)}
                />
            )}
        </div>
    );
});

interface PageLayoutEntry { pageNumber: number; top: number; bottom: number; left: number; width: number; }

const LENS_HOVER_DELAY_MS = 280;
const LENS_PREVIEW_CSS_WIDTH = 420;


function openExternalUrl(url: string): void {
    if (isTauri()) {
        void import("@tauri-apps/plugin-opener").then(({ openUrl }) => openUrl(url)).catch(() => undefined);
        return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
}

function findPageForScrollCenter(pageLayout: PageLayoutEntry[], centerY: number): number | null {
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

export const PDFJsEngine = memo(forwardRef<PDFJsEngineRef, PDFJsEngineProps>(
    function PDFJsEngine({
        pdfPath, pdfData, originalFilename,
        initialPage = 1, initialZoom = DEFAULT_SCALE, initialZoomMode = DEFAULT_ZOOM_MODE,
        presentationMode: initialPresentationMode = 'scroll', onPresentationModeChange,
        onLoad, onError, onPageChange, onZoomModeChange, onViewportTap, showControls = true, className,
        annotations = [], annotationMode = 'none',
        highlightColor = "yellow", penColor = "blue", penWidth = 2,
        onAnnotationAdd, onAnnotationChange, onAnnotationRemove,
        onHistoryChange, onLinkPreview,
    }, ref) {
        const containerRef = useRef<HTMLDivElement>(null);
        const zoomContainerRef = useRef<HTMLDivElement>(null);
        const [isLoading, setIsLoading] = useState(false);
        const loadingGraceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
        const [error, setError] = useState<string | null>(null);
        const [currentPage, setCurrentPage] = useState(initialPage);
        const [totalPages, setTotalPages] = useState(0);
        const [scale, setScale] = useState(DEFAULT_SCALE);
        const [rotation, setRotation] = useState(0);
        const rotationRef = useRef(0);
        rotationRef.current = rotation;
        const [presentationMode, setPresentationModeState] = useState<'scroll' | 'paged' | 'two-page'>(initialPresentationMode);
        const presentationModeRef = useRef<'scroll' | 'paged' | 'two-page'>(initialPresentationMode);
        const [activeSearchQuery, setActiveSearchQuery] = useState<string>("");


        const [isViewportInteracting, setIsViewportInteracting] = useState(false);
        const [isInitialRenderStabilizing, setIsInitialRenderStabilizing] = useState(false);
        const [pdfDocument, setPdfDocument] = useState<PDFDocumentProxy | null>(null);
        const [pages, setPages] = useState<PDFPageProxy[]>([]);
        const hasAppliedInitialViewStateRef = useRef(false);
        const initialPageRestoreTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
        const interactionIdleTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
        const renderStabilizationTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
        const loadingTaskRef = useRef<any>(null);
        const pendingScrollPageRef = useRef<number | null>(null);
        const pendingScrollAdjustmentRef = useRef<ZoomAnchor | null>(null);
        const loadingPageNumbersRef = useRef<Set<number>>(new Set());
        const loadedPageBoundsRef = useRef<{ min: number; max: number }>({ min: 0, max: 0 });
        const lastEdgePrefetchAtRef = useRef(0);
        const lastScrollTopRef = useRef(0);
        const pageLayoutRef = useRef<PageLayoutEntry[]>([]);
        const currentPageRef = useRef(initialPage);
        const totalPagesRef = useRef(0);
        const scaleRef = useRef(DEFAULT_SCALE);
        const initialPageToRestoreRef = useRef(initialPage);
        const zoomModeRef = useRef<PdfZoomMode>(initialZoomMode);
        const searchSessionRef = useRef(0);
        /** Pre-computed cumulative page-top positions from `prefetch_pdf_structure`. */
        const pageTopsRef = useRef<Float64Array>(new Float64Array(0));
        /** Raw structure returned by the Rust `prefetch_pdf_structure` command. */
        const prefetchedStructureRef = useRef<PdfStructure | null>(null);
        /** Target page currently being navigated to via programmatic jump. Suppresses intermediate scroll overwrites. */
        const isNavigatingPageRef = useRef<number | null>(null);
        const navigationTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
        /** IntersectionObserver watching placeholder divs for lazy pre-fetching */
        const placeholderObserverRef = useRef<IntersectionObserver | null>(null);
        
        const resizeDebounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
        
        const lastWheelMouseRef = useRef<{ x: number; y: number } | null>(null);

        const isDesktopWebKit = useMemo(() => isWebKitBrowserEngine(), []);
        const isAndroidRuntime = useMemo(
            () => typeof navigator !== "undefined" && /android/i.test(navigator.userAgent),
            [],
        );
        const canvasRenderWindow = isDesktopWebKit
            ? WEBKIT_CANVAS_RENDER_PAGE_WINDOW
            : isAndroidRuntime
                ? ANDROID_CANVAS_RENDER_PAGE_WINDOW
                : DEFAULT_CANVAS_RENDER_PAGE_WINDOW;
        const inactiveCanvasReleaseDelayMs = isDesktopWebKit
            ? DESKTOP_WEBKIT_INACTIVE_RELEASE_DELAY_MS
            : INACTIVE_CANVAS_RELEASE_DELAY_MS;
        
        const textLayerPageWindow = isDesktopWebKit
            ? Math.max(WEBKIT_TEXT_LAYER_PAGE_WINDOW, canvasRenderWindow)
            : Math.max(1, canvasRenderWindow);
        const enableTextLayer = true;
        const useStreamTextLayer = !isDesktopWebKit;

        const callbacksRef = useRef({ onLoad, onError, onPageChange, onZoomModeChange });
        useEffect(() => { callbacksRef.current = { onLoad, onError, onPageChange, onZoomModeChange }; }, [onLoad, onError, onPageChange, onZoomModeChange]);

        useEffect(() => { currentPageRef.current = currentPage; }, [currentPage]);
        useEffect(() => { totalPagesRef.current = totalPages; }, [totalPages]);
        useEffect(() => { scaleRef.current = scale; }, [scale]);
        useEffect(() => {
            if (pages.length === 0) {
                loadedPageBoundsRef.current = { min: 0, max: 0 };
                return;
            }
            loadedPageBoundsRef.current = {
                min: pages[0]?.pageNumber ?? 0,
                max: pages[pages.length - 1]?.pageNumber ?? 0,
            };
        }, [pages]);

        const markViewportInteracting = useCallback(() => {
            setIsViewportInteracting((prev) => (prev ? prev : true));
            if (interactionIdleTimeoutRef.current) clearTimeout(interactionIdleTimeoutRef.current);
            interactionIdleTimeoutRef.current = setTimeout(() => {
                interactionIdleTimeoutRef.current = null;
                setIsViewportInteracting(false);
            }, VIEWPORT_INTERACTION_IDLE_MS);
        }, []);

        useEffect(() => () => {
            if (interactionIdleTimeoutRef.current) {
                clearTimeout(interactionIdleTimeoutRef.current);
                interactionIdleTimeoutRef.current = null;
            }
            if (renderStabilizationTimeoutRef.current) {
                clearTimeout(renderStabilizationTimeoutRef.current);
                renderStabilizationTimeoutRef.current = null;
            }
        }, []);

        const prunePageProxyCache = useCallback((existingPages: PDFPageProxy[], centerPage: number, pageCount: number) => {
            if (existingPages.length === 0) return existingPages;
            if (presentationModeRef.current === 'paged') {
                const keepStart = Math.max(1, centerPage - PAGE_PROXY_PAGED_KEEP_WINDOW);
                const keepEnd = Math.min(pageCount, centerPage + PAGE_PROXY_PAGED_KEEP_WINDOW);
                let changed = false;
                const nextPages: PDFPageProxy[] = [];
                for (const page of existingPages) {
                    if (page.pageNumber < keepStart || page.pageNumber > keepEnd) { changed = true; page.cleanup(); continue; }
                    nextPages.push(page);
                }
                return changed ? nextPages : existingPages;
            }
            // In continuous scroll mode, retain loaded page proxies to preserve exact DOM layout height
            // and prevent scroll jumps, blank pages, or halting. Prune only under extreme memory pressure (>80 pages).
            if (existingPages.length <= 80) return existingPages;
            const keepStart = Math.max(1, centerPage - PAGE_PROXY_KEEP_WINDOW);
            const keepEnd = Math.min(pageCount, centerPage + PAGE_PROXY_KEEP_WINDOW);
            let changed = false;
            const nextPages: PDFPageProxy[] = [];
            for (const page of existingPages) {
                if (page.pageNumber < keepStart || page.pageNumber > keepEnd) { changed = true; page.cleanup(); continue; }
                nextPages.push(page);
            }
            return changed ? nextPages : existingPages;
        }, []);

        const rebuildPageLayout = useCallback(() => {
            const container = containerRef.current;
            if (!container) { pageLayoutRef.current = []; return; }
            const pageNodes = container.querySelectorAll<HTMLElement>(".pdf-page-wrapper");
            if (pageNodes.length === 0) { pageLayoutRef.current = []; return; }
            const entries: PageLayoutEntry[] = [];
            for (let i = 0; i < pageNodes.length; i++) {
                const node = pageNodes[i];
                const pageNumber = Number(node.dataset.pageNumber);
                if (!Number.isFinite(pageNumber)) continue;
                entries.push({ pageNumber, top: node.offsetTop, bottom: node.offsetTop + node.offsetHeight, left: node.offsetLeft, width: node.offsetWidth });
            }
            entries.sort((l, r) => l.pageNumber - r.pageNumber);
            pageLayoutRef.current = entries;

            // Synchronize pageTopsRef with true measured DOM positions
            if (entries.length > 0) {
                const maxPage = entries[entries.length - 1].pageNumber;
                const tops = new Float64Array(Math.max(totalPagesRef.current, maxPage));
                for (let i = 0; i < entries.length; i++) {
                    const e = entries[i];
                    if (e.pageNumber - 1 < tops.length) {
                        tops[e.pageNumber - 1] = e.top;
                    }
                }
                pageTopsRef.current = tops;
            }
        }, []);

        const scrollToPage = useCallback((targetPage: number, behavior: ScrollBehavior = "smooth"): boolean => {
            if (presentationModeRef.current === 'paged') {
                containerRef.current?.scrollTo({ top: 0, left: 0, behavior: "auto" });
                return true;
            }
            const container = containerRef.current;
            if (!container) return false;

            // 1. Primary: query the exact DOM node for targetPage (100% pixel-perfect layout)
            const pageNode = container.querySelector<HTMLElement>(`.pdf-page-wrapper[data-page-number="${targetPage}"]`);
            if (pageNode) {
                container.scrollTo({ top: Math.max(0, pageNode.offsetTop - 8), behavior });
                return true;
            }

            // 2. Fallback: use pre-computed or measured pageTops
            const tops = pageTopsRef.current;
            const idx = targetPage - 1;
            if (tops.length > idx && tops.length > 0 && tops[idx] > 0) {
                container.scrollTo({ top: Math.max(0, tops[idx] - 8), behavior });
                return true;
            }

            return false;
        }, []);

        useLayoutEffect(() => {
            const rafId = window.requestAnimationFrame(() => {
                rebuildPageLayout();
                if (pendingScrollPageRef.current !== null && presentationModeRef.current !== 'paged') {
                    const target = pendingScrollPageRef.current;
                    if (scrollToPage(target, "smooth")) {
                        pendingScrollPageRef.current = null;
                    }
                }
            });
            return () => { cancelAnimationFrame(rafId); };
        }, [pages, scale, rotation, totalPages, rebuildPageLayout, scrollToPage]);

        useLayoutEffect(() => {
            const container = containerRef.current;
            // Page sizes for the new scale are already applied (children's layout
            // effects run first), so measure, then put the anchor back under the focus.
            rebuildPageLayout();
            const anchor = pendingScrollAdjustmentRef.current;
            if (container && anchor && Math.abs(anchor.scale - scale) < 0.001) {
                pendingScrollAdjustmentRef.current = null;
                const position = resolveZoomAnchor(pageLayoutRef.current, anchor);
                if (position) {
                    container.scrollLeft = position.left;
                    container.scrollTop = position.top;
                }
            }
        }, [scale, rebuildPageLayout]);

        const setZoomMode = useCallback((mode: PdfZoomMode, force = false) => {
            if (!force && zoomModeRef.current === mode) return;
            zoomModeRef.current = mode;
            callbacksRef.current.onZoomModeChange?.(mode);
        }, []);

        const applyZoom = useCallback((
            requestedScale: number,
            options?: {
                mode?: PdfZoomMode;
                preserveMode?: boolean;
                /** Focus point (px from the container's top-left) kept fixed; default: viewport centre; false: no anchoring. */
                anchor?: { x: number; y: number } | false;
            },
        ): number => {
            const clampedScale = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, requestedScale));
            if (options?.mode) setZoomMode(options.mode);
            else if (!options?.preserveMode) setZoomMode("custom");
            if (Math.abs(clampedScale - scaleRef.current) < 0.0001) return scaleRef.current;

            const oldScale = scaleRef.current;
            scaleRef.current = clampedScale;

            // Keep the page point under the focus fixed across the re-layout.
            const container = containerRef.current;
            if (container && options?.anchor !== false && Math.abs(clampedScale - oldScale) > 0.0001) {
                if (pageLayoutRef.current.length === 0) rebuildPageLayout();
                const focus = options?.anchor ?? { x: container.clientWidth / 2, y: container.clientHeight / 2 };
                pendingScrollAdjustmentRef.current = captureZoomAnchor(
                    pageLayoutRef.current,
                    container.scrollLeft,
                    container.scrollTop,
                    focus.x,
                    focus.y,
                    clampedScale,
                );
            } else {
                pendingScrollAdjustmentRef.current = null;
            }

            setScale(clampedScale);
            callbacksRef.current.onPageChange?.(currentPageRef.current, totalPagesRef.current, clampedScale);
            return clampedScale;
        }, [setZoomMode, rebuildPageLayout]);

        // Keep pageTopsRef in sync with scale changes so that scrollToPage remains accurate
        // after the user zooms in or out.
        useEffect(() => {
            const struct = prefetchedStructureRef.current;
            if (!struct || struct.total_pages <= 0) return;
            pageTopsRef.current = computeVirtualPageTops(
                struct.total_pages,
                struct.default_height_pt,
                scale,
                presentationModeRef.current === 'two-page',
            );
        }, [scale, presentationMode]);

        useEffect(() => {
            const container = containerRef.current;
            if (!container || typeof ResizeObserver === "undefined") return;
            const observer = new ResizeObserver(() => {
                if (resizeDebounceTimerRef.current !== null) clearTimeout(resizeDebounceTimerRef.current);
                resizeDebounceTimerRef.current = setTimeout(() => {
                    resizeDebounceTimerRef.current = null;
                    window.requestAnimationFrame(() => {
                        rebuildPageLayout();
                        const fp = pages[0];
                        if (fp && containerRef.current) {
                            const isTwoPage = presentationModeRef.current === 'two-page';
                            if (zoomModeRef.current === 'width-fit') {
                                applyZoom(getFitWidthScale(containerRef.current, fp, isTwoPage), { preserveMode: true });
                            } else if (zoomModeRef.current === 'page-fit') {
                                applyZoom(getFitPageScale(containerRef.current, fp, isTwoPage), { preserveMode: true });
                            }
                        }
                    });
                }, RESIZE_OBSERVER_DEBOUNCE_MS);
            });
            observer.observe(container);
            return () => {
                observer.disconnect();
                if (resizeDebounceTimerRef.current !== null) { clearTimeout(resizeDebounceTimerRef.current); resizeDebounceTimerRef.current = null; }
            };
        }, [rebuildPageLayout, applyZoom, pages]);

        useEffect(() => {
            if (presentationModeRef.current === initialPresentationMode) return;
            presentationModeRef.current = initialPresentationMode;
            setPresentationModeState(initialPresentationMode);
            const isTwoPage = initialPresentationMode === 'two-page';
            const fp = pages[0];
            if (containerRef.current && fp) {
                if (initialPresentationMode === 'paged') {
                    applyZoom(getFitPageScale(containerRef.current, fp, false), { mode: "page-fit", preserveMode: true });
                } else if (isTwoPage) {
                    const nextScale = zoomModeRef.current === 'page-fit'
                        ? getFitPageScale(containerRef.current, fp, true)
                        : getFitWidthScale(containerRef.current, fp, true);
                    applyZoom(nextScale, { mode: zoomModeRef.current, preserveMode: true });
                } else {
                    const nextScale = zoomModeRef.current === 'page-fit'
                        ? getFitPageScale(containerRef.current, fp, false)
                        : getFitWidthScale(containerRef.current, fp, false);
                    applyZoom(nextScale, { mode: zoomModeRef.current, preserveMode: true });
                }
            }
        }, [initialPresentationMode, pages, applyZoom]);

        const getLoadedPageNumbers = useCallback(() => new Set(pages.map((page) => page.pageNumber)), [pages]);

        const loadSpecificPages = useCallback(async (pageNumbers: number[]) => {
            if (!pdfDocument) return false;
            const loadedPageNumbers = getLoadedPageNumbers();
            const numbersToLoad = pageNumbers
                .filter((pn) => pn >= 1 && pn <= pdfDocument.numPages)
                .filter((pn) => !loadedPageNumbers.has(pn))
                .filter((pn) => !loadingPageNumbersRef.current.has(pn));
            if (numbersToLoad.length === 0) return false;
            numbersToLoad.forEach((pn) => loadingPageNumbersRef.current.add(pn));
            try {
                let loadedAnyPage = false;
                for (let offset = 0; offset < numbersToLoad.length; offset += PAGE_PROXY_LOAD_CONCURRENCY) {
                    const batchNumbers = numbersToLoad.slice(offset, offset + PAGE_PROXY_LOAD_CONCURRENCY);
                    if (batchNumbers.length === 0) continue;
                    const loadedBatch = await Promise.all(batchNumbers.map(async (pageNumber) => {
                        try {
                            return await pdfDocument.getPage(pageNumber);
                        } catch (error) {
                            const msg = error instanceof Error ? error.message : String(error);
                            if (!msg.includes("Transport") && !msg.includes("destroyed")) {
                            }
                            return null;
                        }
                    }));
                    const resolvedPages = loadedBatch.filter((page): page is PDFPageProxy => page !== null);
                    if (resolvedPages.length === 0) continue;
                    loadedAnyPage = true;
                    setPages((previousPages) => {
                        const pageMap = new Map(previousPages.map((p) => [p.pageNumber, p]));
                        for (const page of resolvedPages) pageMap.set(page.pageNumber, page);
                        const mergedPages = Array.from(pageMap.values()).sort((l, r) => l.pageNumber - r.pageNumber);
                        return prunePageProxyCache(mergedPages, currentPageRef.current, pdfDocument.numPages);
                    });
                }
                return loadedAnyPage;
            } catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                if (!msg.includes("Transport") && !msg.includes("destroyed")) 
                return false;
            } finally {
                numbersToLoad.forEach((pn) => loadingPageNumbersRef.current.delete(pn));
            }
        }, [getLoadedPageNumbers, pdfDocument, prunePageProxyCache]);

        useEffect(() => {
            if (typeof IntersectionObserver === "undefined") return;
            const observer = new IntersectionObserver(
                (entries) => {
                    const pagesToLoad: number[] = [];
                    for (const entry of entries) {
                        if (entry.isIntersecting) {
                            const pn = Number((entry.target as HTMLElement).dataset.pageNumber);
                            if (pn && !loadingPageNumbersRef.current.has(pn)) {
                                pagesToLoad.push(pn);
                            }
                        }
                    }
                    if (pagesToLoad.length > 0) {
                        void loadSpecificPages(pagesToLoad);
                    }
                },
                { root: null, rootMargin: "120% 0px" }
            );
            placeholderObserverRef.current = observer;
            return () => {
                observer.disconnect();
                placeholderObserverRef.current = null;
            };
        }, [loadSpecificPages]);

        const registerPlaceholderRef = useCallback((node: HTMLElement | null) => {
            if (!node) return;
            placeholderObserverRef.current?.observe(node);
        }, []);

        const clearSearch = useCallback(() => {
            searchSessionRef.current += 1;
            setActiveSearchQuery("");
        }, []);

        const restoreInitialPageWithRetry = useCallback((targetPage: number, attempts = 0) => {
            const container = containerRef.current;
            if (!container) return;
            // Primary: exact DOM node offset
            const pageNode = container.querySelector<HTMLElement>(`.pdf-page-wrapper[data-page-number="${targetPage}"]`);
            if (pageNode) {
                container.scrollTo({ top: Math.max(0, pageNode.offsetTop - 8), behavior: "auto" });
                currentPageRef.current = targetPage;
                setCurrentPage(targetPage);
                callbacksRef.current.onPageChange?.(targetPage, totalPagesRef.current, scaleRef.current);
                return;
            }
            // Fallback: pre-computed or measured pageTops
            const tops = pageTopsRef.current;
            const idx = targetPage - 1;
            if (tops.length > idx && tops.length > 0 && tops[idx] > 0) {
                container.scrollTo({ top: Math.max(0, tops[idx] - 8), behavior: "auto" });
                currentPageRef.current = targetPage;
                setCurrentPage(targetPage);
                callbacksRef.current.onPageChange?.(targetPage, totalPagesRef.current, scaleRef.current);
                return;
            }
            if (attempts >= 100) return;
            if (initialPageRestoreTimeoutRef.current) clearTimeout(initialPageRestoreTimeoutRef.current);
            initialPageRestoreTimeoutRef.current = setTimeout(() => { restoreInitialPageWithRetry(targetPage, attempts + 1); }, 50);
        }, []);

        const search = useCallback(async function* (query: string): AsyncGenerator<SearchResult | { progress: number } | "done"> {
            const normalizedQuery = query.trim();
            setActiveSearchQuery(normalizedQuery);
            if (!normalizedQuery) { yield "done"; return; }
            const activePdfDocument = pdfDocument;
            if (!activePdfDocument) { yield "done"; return; }

            searchSessionRef.current += 1;
            const sessionId = searchSessionRef.current;

            // Native Rust PDF Search Fast-Path
            if (isTauri() && pdfPath && !pdfPath.startsWith("idb://") && !pdfPath.startsWith("blob:")) {
                try {
                    yield { progress: 0.1 };
                    const nativeResult = await invoke<{
                        matches: Array<{
                            sectionIndex: number;
                            sectionHref: string;
                            snippet: string;
                            matchText: string;
                            charOffset: number;
                        }>;
                        total: number;
                        durationMs: number;
                    }>("search_book_content", {
                        path: pdfPath,
                        query: normalizedQuery,
                        matchCase: false,
                    });

                    if (searchSessionRef.current !== sessionId) return;

                    if (nativeResult && Array.isArray(nativeResult.matches)) {
                        const yieldedLocations = new Set<string>();
                        let matchCount = 0;
                        const total = nativeResult.matches.length;
                        for (const m of nativeResult.matches) {
                            if (searchSessionRef.current !== sessionId) return;
                            const location = getPdfSearchLocation(m.sectionIndex + 1);
                            if (!yieldedLocations.has(location)) {
                                yieldedLocations.add(location);
                                yield {
                                    cfi: location,
                                    excerpt: m.snippet,
                                };
                            }
                            matchCount++;
                            yield { progress: 0.1 + (matchCount / Math.max(1, total)) * 0.9 };
                        }
                        yield "done";
                        return;
                    }
                } catch (e) {
                    if (import.meta.env.DEV) {
                        console.warn("[pdfjs-engine] Native PDF search failed, falling back to JS worker:", e);
                    }
                }
            }

            const normalizedQueryLower = normalizedQuery.toLowerCase();
            const yieldedLocations = new Set<string>();
            const searchablePages: PDFSearchPageItem[] = [];
            
            let searchablePagesCharTotal = 0;
            let exactMatchCount = 0;
            let pagesScanned = 0;
            const totalPageCount = Math.max(1, activePdfDocument.numPages);

            for (let pageNumber = 1; pageNumber <= totalPageCount; pageNumber++) {
                if (searchSessionRef.current !== sessionId) return;
                pagesScanned++;
                let pageText = "";
                try {
                    if (!activePdfDocument || searchSessionRef.current !== sessionId) return;
                    const page = await activePdfDocument.getPage(pageNumber);
                    const pageTextContent = await getPageTextContent(page);
                    pageText = getNormalizedPageText(pageTextContent);
                } catch (error) {
                    const msg = error instanceof Error ? error.message : String(error);
                    if (msg.includes("Transport") || msg.includes("destroyed")) {  return; }
                }

                if (pageText) {
                    
                    if (searchablePagesCharTotal < PDF_SEARCH_FALLBACK_TOTAL_CHAR_BUDGET) {
                        const boundedPageText = pageText.slice(0, PDF_SEARCH_FALLBACK_PAGE_CHAR_LIMIT);
                        searchablePages.push({ pageNumber, text: boundedPageText });
                        searchablePagesCharTotal += boundedPageText.length;
                    }
                    const matchIndex = pageText.toLowerCase().indexOf(normalizedQueryLower);
                    if (matchIndex !== -1) {
                        const location = getPdfSearchLocation(pageNumber);
                        if (!yieldedLocations.has(location)) {
                            yieldedLocations.add(location);
                            exactMatchCount++;
                            yield { cfi: location, excerpt: createPdfSearchExcerpt(pageText, normalizedQuery, matchIndex) };
                        }
                    }
                }
                yield { progress: (pageNumber / totalPageCount) * PDF_SEARCH_EXACT_SCAN_PROGRESS_WEIGHT };
                if (exactMatchCount >= PDF_SEARCH_EXACT_LIMIT) break;
                if (pagesScanned >= PDF_SEARCH_MAX_PAGES_SCANNED && searchablePages.length > 0) {
                    yield { progress: PDF_SEARCH_EXACT_SCAN_PROGRESS_WEIGHT };
                    break;
                }
            }

            if (searchSessionRef.current !== sessionId) return;

            if (exactMatchCount < PDF_SEARCH_FALLBACK_TRIGGER_THRESHOLD && searchablePages.length > 0) {
                const fuzzyResults = rankByFuzzyQuery(searchablePages, normalizedQuery, { keys: [{ name: "text", weight: 1 }], limit: PDF_SEARCH_FALLBACK_LIMIT });
                const fallbackResultCount = Math.max(1, fuzzyResults.length);
                let fallbackResultIndex = 0;
                for (const { item } of fuzzyResults) {
                    if (searchSessionRef.current !== sessionId) return;
                    fallbackResultIndex++;
                    const location = getPdfSearchLocation(item.pageNumber);
                    if (!yieldedLocations.has(location)) {
                        yieldedLocations.add(location);
                        yield { cfi: location, excerpt: createPdfSearchExcerpt(item.text, normalizedQuery) };
                    }
                    yield { progress: PDF_SEARCH_EXACT_SCAN_PROGRESS_WEIGHT + ((fallbackResultIndex / fallbackResultCount) * (1 - PDF_SEARCH_EXACT_SCAN_PROGRESS_WEIGHT)) };
                }
            }

            if (searchSessionRef.current !== sessionId) return;
            yield "done";
        }, [pdfDocument, pdfPath]);

        const annotationsByPage = useMemo(() => {
            const grouped = new Map<number, Annotation[]>();
            for (const annotation of annotations) {
                if (annotation.pageNumber == null) continue;
                const arr = grouped.get(annotation.pageNumber);
                if (arr) arr.push(annotation); else grouped.set(annotation.pageNumber, [annotation]);
            }
            return grouped;
        }, [annotations]);

        useEffect(() => {
            let cancelled = false;
            let loadedPdf: PDFDocumentProxy | null = null;
            let activeRangeTransport: TauriPdfRangeTransport | null = null;

            const loadPdf = async () => {
                const isVirtualPath = pdfPath.startsWith("idb://") || pdfPath.startsWith("browser://") || pdfPath.startsWith("sqlite://");
                const requiresProvidedData = !isTauri() || isVirtualPath || !pdfPath;
                if (requiresProvidedData && !pdfData) return;

                try {
                    setError(null); setPages([]);
                    
                    if (loadingGraceTimerRef.current) clearTimeout(loadingGraceTimerRef.current);
                    loadingGraceTimerRef.current = setTimeout(() => {
                        loadingGraceTimerRef.current = null;
                        setIsLoading(true);
                    }, 300);
                    setIsViewportInteracting(false);
                    setIsInitialRenderStabilizing(true);
                    pageLayoutRef.current = [];
                    pageTopsRef.current = new Float64Array(0);
                    prefetchedStructureRef.current = null;
                    loadingPageNumbersRef.current.clear();
                    lastEdgePrefetchAtRef.current = 0;
                    lastScrollTopRef.current = 0;
                    pendingScrollPageRef.current = null;
                    clearPageTextContentCache();
                    searchSessionRef.current += 1;
                    hasAppliedInitialViewStateRef.current = false;
                    if (initialPageRestoreTimeoutRef.current) { clearTimeout(initialPageRestoreTimeoutRef.current); initialPageRestoreTimeoutRef.current = null; }
                    if (renderStabilizationTimeoutRef.current) { clearTimeout(renderStabilizationTimeoutRef.current); renderStabilizationTimeoutRef.current = null; }
                    zoomModeRef.current = initialZoomMode;

                    const canUseDirectAssetUrl = isTauri() && Boolean(pdfPath) && !isVirtualPath && !pdfData;

                    // ── Rust pre-fetch ──────────────────────────────────────────────────────────
                    // Fire `prefetch_pdf_structure` in parallel with data preparation so we
                    // know the full page count + default page dimensions as early as possible.
                    // This lets us:
                    //  1. Set `totalPages` before any `PDFPageProxy` is loaded
                    //  2. Render N placeholder <div>s with correct sizes immediately
                    //  3. Make `scrollToPage` work instantly without DOM queries
                    let prefetchPromise: Promise<PdfStructure | null> = Promise.resolve(null);
                    if (canUseDirectAssetUrl && pdfPath) {
                        prefetchPromise = invoke<PdfStructure>("prefetch_pdf_structure", { path: pdfPath })
                            .catch(() => null);
                    }

                    let data: Uint8Array | undefined;
                    let dataByteLength: number | undefined;
                    if (pdfData) {
                        data = pdfData;
                        dataByteLength = data.byteLength;
                    } else if (!canUseDirectAssetUrl) {
                        throw new Error("PDF data not provided. Please ensure the book is properly loaded.");
                    }

                    // Wait for the Rust pre-fetch to complete (it runs in <5ms on disk).
                    const prefetched = await prefetchPromise;
                    if (cancelled) return;

                    if (prefetched && prefetched.total_pages > 0) {
                        prefetchedStructureRef.current = prefetched;
                        // Determine the initial scale to use for the tops computation.
                        // If zoom mode is width-fit we can compute the initial scale now from
                        // the container width and the default page width in pts.
                        const container = containerRef.current;
                        const isInitialTwoPage = initialPresentationMode === 'two-page';
                        let initialScaleForTops = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, initialZoom));
                        if (container && (initialZoomMode === 'width-fit' || initialZoomMode === 'page-fit')) {
                            initialScaleForTops = getFitWidthScaleFromPts(container, prefetched.default_width_pt, isInitialTwoPage);
                        }
                        scaleRef.current = initialScaleForTops;
                        setScale(initialScaleForTops);
                        // Pre-compute page tops using default aspect ratio
                        pageTopsRef.current = computeVirtualPageTops(
                            prefetched.total_pages,
                            prefetched.default_height_pt,
                            initialScaleForTops,
                            isInitialTwoPage,
                        );
                        // Set totalPages immediately so N placeholder divs render right away
                        totalPagesRef.current = prefetched.total_pages;
                        setTotalPages(prefetched.total_pages);
                        // Update dataByteLength for the range transport if not already set
                        if (dataByteLength === undefined) {
                            dataByteLength = prefetched.file_size_bytes;
                        }
                    }

                    if (cancelled) return;

                    const displayFilename = originalFilename || pdfPath.split("/").pop()?.replace(/\.[^/.]+$/, "") || "document";
                    const infoCacheKey = buildPdfInfoCacheKey(pdfPath, originalFilename, dataByteLength);
                    const commonPdfOptions = PDFJS_ASSET_OPTIONS;
                    const preferredRangeChunkSize = getPreferredPdfRangeChunkSize();

                    let pdf: PDFDocumentProxy;
                    if (canUseDirectAssetUrl) {
                        try {
                            const directUrl = convertFileSrc(pdfPath);
                            const task = pdfjsLib.getDocument({
                                ...commonPdfOptions,
                                url: directUrl,
                                rangeChunkSize: preferredRangeChunkSize,
                                disableAutoFetch: true,
                                disableStream: true,
                            });
                            loadingTaskRef.current = task;
                            pdf = await task.promise;
                        } catch (urlLoadError) {
                            try {
                                const fileSize = await invoke<number>("read_pdf_file_size", { path: pdfPath });
                                dataByteLength = fileSize;
                                activeRangeTransport?.abort();
                                activeRangeTransport = new TauriPdfRangeTransport(pdfPath, fileSize);
                                const task = pdfjsLib.getDocument({
                                    ...commonPdfOptions,
                                    range: activeRangeTransport,
                                    rangeChunkSize: preferredRangeChunkSize,
                                    disableStream: true,
                                    disableAutoFetch: true,
                                });
                                loadingTaskRef.current = task;
                                pdf = await task.promise;
                            } catch (rangeLoadError) {
                                const fallbackData = await invoke<Uint8Array>("read_pdf_file", { path: pdfPath });
                                dataByteLength = fallbackData.byteLength;
                                const task = pdfjsLib.getDocument({
                                    ...commonPdfOptions,
                                    data: toSerializablePdfData(fallbackData),
                                    disableAutoFetch: true,
                                    disableStream: true,
                                });
                                loadingTaskRef.current = task;
                                pdf = await task.promise;
                            }
                        }
                    } else {
                        const task = pdfjsLib.getDocument({
                            ...commonPdfOptions,
                            data: toSerializablePdfData(data as Uint8Array),
                            disableAutoFetch: true,
                            disableStream: true,
                        });
                        loadingTaskRef.current = task;
                        pdf = await task.promise;
                    }

                    loadedPdf = pdf;
                    if (cancelled) {
                        pdf.cleanup();
                        try { void (pdf as any)?.destroy?.(); } catch {}
                        try { void loadingTaskRef.current?.destroy(); } catch {}
                        loadingTaskRef.current = null;
                        return;
                    }

                    setPdfDocument(pdf);
                    const totalPageCount = Math.max(1, pdf.numPages);
                    const clampedInitialPage = Math.max(1, Math.min(initialPage, totalPageCount));
                    initialPageToRestoreRef.current = clampedInitialPage;
                    currentPageRef.current = clampedInitialPage;
                    totalPagesRef.current = totalPageCount;
                    scaleRef.current = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, initialZoom));
                    setCurrentPage(clampedInitialPage); setTotalPages(totalPageCount); setScale(scaleRef.current);
                    setZoomMode(initialZoomMode, true);

                    const initialPages = [await pdf.getPage(clampedInitialPage)];
                    if (!cancelled) {
                        setPages(initialPages.sort((l, r) => l.pageNumber - r.pageNumber));
                        if (loadingGraceTimerRef.current) { clearTimeout(loadingGraceTimerRef.current); loadingGraceTimerRef.current = null; }
                        setIsLoading(false);
                        renderStabilizationTimeoutRef.current = setTimeout(() => {
                            renderStabilizationTimeoutRef.current = null;
                            setIsInitialRenderStabilizing(false);
                        }, INITIAL_RENDER_STABILIZATION_MS);
                        const cachedInfo = getCachedPdfDocumentInfo(infoCacheKey, totalPageCount);
                        const initialInfo: PDFDocumentInfo = cachedInfo ?? { title: displayFilename, totalPages: totalPageCount, filename: displayFilename, hasOutline: false, toc: [] };
                        callbacksRef.current.onLoad?.(initialInfo);
                        callbacksRef.current.onPageChange?.(clampedInitialPage, totalPageCount, scaleRef.current);
                        const warmupTargets: number[] = [clampedInitialPage];
                        if (presentationModeRef.current !== 'paged') {
                            if (clampedInitialPage + 1 <= totalPageCount) warmupTargets.push(clampedInitialPage + 1);
                            if (clampedInitialPage - 1 >= 1) warmupTargets.push(clampedInitialPage - 1);
                        }
                        void loadSpecificPages(warmupTargets);
                    } else {
                        initialPages.forEach((p) => p.cleanup());
                        pdf.cleanup();
                        try { void (pdf as any)?.destroy?.(); } catch {}
                        try { void loadingTaskRef.current?.destroy(); } catch {}
                        loadingTaskRef.current = null;
                    }

                    if (!cancelled && !getCachedPdfDocumentInfo(infoCacheKey, totalPageCount)) {
                        void (async () => {
                            try {
                                const [metadata, { tocItems, hasOutline }] = await Promise.all([pdf.getMetadata(), buildPdfToc(pdf)]);
                                if (cancelled) return;
                                const metaInfo = metadata.info as Record<string, unknown>;
                                const finalInfo: PDFDocumentInfo = {
                                    title: (metaInfo?.Title as string) || displayFilename,
                                    author: metaInfo?.Author as string | undefined, subject: metaInfo?.Subject as string | undefined,
                                    keywords: metaInfo?.Keywords as string | undefined, creator: metaInfo?.Creator as string | undefined,
                                    producer: metaInfo?.Producer as string | undefined,
                                    creationDate: metaInfo?.CreationDate ? new Date(metaInfo.CreationDate as string) : undefined,
                                    modificationDate: metaInfo?.ModDate ? new Date(metaInfo.ModDate as string) : undefined,
                                    totalPages: totalPageCount, filename: displayFilename, hasOutline, toc: tocItems,
                                };
                                setCachedPdfDocumentInfo(infoCacheKey, finalInfo);
                                callbacksRef.current.onLoad?.(finalInfo);
                            } catch (metadataError) {  }
                        })();
                    }
                } catch (err) {
                    if (!cancelled) {
                        const errorMsg = err instanceof Error ? err.message : "Failed to load PDF";
                        setError(errorMsg);
                        setIsInitialRenderStabilizing(false);
                        if (loadingGraceTimerRef.current) { clearTimeout(loadingGraceTimerRef.current); loadingGraceTimerRef.current = null; }
                        callbacksRef.current.onError?.(err instanceof Error ? err : new Error(errorMsg));
                        setIsLoading(false);
                    }
                }
            };

            loadPdf();
            return () => {
                cancelled = true;
                loadingPageNumbersRef.current.clear();
                lastEdgePrefetchAtRef.current = 0;
                lastScrollTopRef.current = 0;
                pendingScrollPageRef.current = null;
                if (loadingGraceTimerRef.current) { clearTimeout(loadingGraceTimerRef.current); loadingGraceTimerRef.current = null; }
                if (initialPageRestoreTimeoutRef.current) { clearTimeout(initialPageRestoreTimeoutRef.current); initialPageRestoreTimeoutRef.current = null; }
                if (interactionIdleTimeoutRef.current) { clearTimeout(interactionIdleTimeoutRef.current); interactionIdleTimeoutRef.current = null; }
                if (renderStabilizationTimeoutRef.current) { clearTimeout(renderStabilizationTimeoutRef.current); renderStabilizationTimeoutRef.current = null; }
                setIsInitialRenderStabilizing(false);
                setPages((existingPages) => { existingPages.forEach((p) => p.cleanup()); return []; });
                pageLayoutRef.current = [];
                activeRangeTransport?.abort();
                loadedPdf?.cleanup();
                try { void (loadedPdf as any)?.destroy?.(); } catch {}
                try { void loadingTaskRef.current?.destroy(); } catch {}
                loadingTaskRef.current = null;
                setPdfDocument(null);
                clearPageTextContentCache();
                searchSessionRef.current += 1;
            };
            
        }, [initialPage, initialZoom, initialZoomMode, pdfPath, pdfData, originalFilename, setZoomMode]);

        useEffect(() => {
            if (hasAppliedInitialViewStateRef.current) return;
            if (!containerRef.current || pages.length === 0) return;
            const rafId = window.requestAnimationFrame(() => {
                const container = containerRef.current;
                if (!container) return;
                const firstPage = pages[0];
                if (!firstPage) return;
                const normalizedMode = initialZoomMode;
                const isTwoPage = presentationModeRef.current === 'two-page';
                const nextScale = normalizedMode === "page-fit" ? getFitPageScale(container, firstPage, isTwoPage)
                    : normalizedMode === "width-fit" ? getFitWidthScale(container, firstPage, isTwoPage)
                    : Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, initialZoom));
                hasAppliedInitialViewStateRef.current = true;
                // Opening: no anchoring. Page 1 must start at its top, and later
                // pages are positioned by restoreInitialPageWithRetry below.
                applyZoom(nextScale, { mode: normalizedMode, preserveMode: normalizedMode !== "custom", anchor: false });
                const targetPage = Math.max(1, Math.min(initialPageToRestoreRef.current, totalPagesRef.current || 1));
                if (targetPage > 1) restoreInitialPageWithRetry(targetPage);
            });
            return () => { cancelAnimationFrame(rafId); };
        }, [pages, applyZoom, initialZoom, initialZoomMode, restoreInitialPageWithRetry]);

        useEffect(() => {
            if (!pdfDocument || totalPages <= 0) return;
            if (presentationModeRef.current === 'paged') {
                void loadSpecificPages([currentPage]);
                return;
            }
            const rangeStart = Math.max(1, currentPage - PAGE_LOAD_AHEAD_THRESHOLD);
            const rangeEnd = Math.min(totalPagesRef.current, Math.max(INITIAL_PAGE_LOAD_SIZE, currentPage + PAGE_LOAD_AHEAD_THRESHOLD));
            const targetRange = Array.from({ length: rangeEnd - rangeStart + 1 }, (_, i) => rangeStart + i);
            if (targetRange.length === 0) return;
            const sortedByDistance = [...targetRange].sort((l, r) => Math.abs(l - currentPage) - Math.abs(r - currentPage));
            void loadSpecificPages(sortedByDistance.slice(0, PAGE_LOAD_BATCH_SIZE));
        }, [currentPage, loadSpecificPages, pdfDocument, totalPages]);

        useEffect(() => {
            if (!pdfDocument || pages.length === 0) return;
            setPages((existingPages) => prunePageProxyCache(existingPages, currentPage, pdfDocument.numPages));
        }, [currentPage, pages.length, pdfDocument, prunePageProxyCache]);

        useEffect(() => {
            const container = containerRef.current;
            if (!container || pages.length === 0) return;
            if (pageLayoutRef.current.length === 0) rebuildPageLayout();
            let rafId: number | null = null;
            let zoomRafId: number | null = null;
            let pendingWheelDelta = 0;
            let lastWheelCommitAt = 0;
            let wheelCommitTimeoutId: ReturnType<typeof setTimeout> | null = null;
            lastScrollTopRef.current = container.scrollTop;

            const handleScroll = () => {
                if (rafId !== null) return;
                rafId = window.requestAnimationFrame(() => {
                    rafId = null;
                    if (isInitialRenderStabilizing) return;

                    // If programmatic navigation is in flight, do not let intermediate scroll frames overwrite currentPage!
                    if (isNavigatingPageRef.current !== null) {
                        const target = isNavigatingPageRef.current;
                        const targetNode = container.querySelector<HTMLElement>(`.pdf-page-wrapper[data-page-number="${target}"]`);
                        if (targetNode && Math.abs(container.scrollTop - (targetNode.offsetTop - 8)) < 24) {
                            isNavigatingPageRef.current = null;
                        }
                        return;
                    }

                    const scrollTop = container.scrollTop;
                    const scrollDelta = scrollTop - lastScrollTopRef.current;
                    const scrollDirection = scrollDelta > 0 ? 1 : scrollDelta < 0 ? -1 : 0;
                    lastScrollTopRef.current = scrollTop;
                    const centerY = scrollTop + (container.clientHeight / 2);
                    const newPage = findPageForScrollCenter(pageLayoutRef.current, centerY) ?? currentPageRef.current;
                    const totalPageCount = totalPagesRef.current;
                    if (newPage !== currentPageRef.current && newPage >= 1 && newPage <= totalPageCount) {
                        currentPageRef.current = newPage; setCurrentPage(newPage);
                        callbacksRef.current.onPageChange?.(newPage, totalPageCount, scaleRef.current);
                    }

                    const { min: minLoadedPage, max: maxLoadedPage } = loadedPageBoundsRef.current;
                    if (maxLoadedPage >= minLoadedPage && totalPageCount > 0) {
                        const edgeThreshold = Math.max(800, Math.round(container.clientHeight * 2.0));
                        const distanceToTop = scrollTop;
                        const distanceToBottom = container.scrollHeight - (scrollTop + container.clientHeight);
                        const shouldPrefetchPrevious = distanceToTop <= edgeThreshold && scrollDirection <= 0;
                        const shouldPrefetchNext = distanceToBottom <= edgeThreshold && scrollDirection >= 0;

                        if (shouldPrefetchPrevious || shouldPrefetchNext) {
                            const edgeTargets: number[] = [];
                            if (shouldPrefetchPrevious) {
                                for (let offset = 1; offset <= PAGE_EDGE_PREFETCH_COUNT; offset++) edgeTargets.push(minLoadedPage - offset);
                            }
                            if (shouldPrefetchNext) {
                                for (let offset = 1; offset <= PAGE_EDGE_PREFETCH_COUNT; offset++) edgeTargets.push(maxLoadedPage + offset);
                            }
                            if (edgeTargets.length > 0) {
                                const now = performance.now();
                                if (now - lastEdgePrefetchAtRef.current >= EDGE_PREFETCH_MIN_INTERVAL_MS) {
                                    lastEdgePrefetchAtRef.current = now;
                                    void loadSpecificPages(edgeTargets);
                                }
                            }
                        }
                    }
                });
            };

            const commitWheelZoom = () => {
                if (pendingWheelDelta === 0) return;
                const oldScale = scaleRef.current;
                const nextScale = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, oldScale + pendingWheelDelta));
                pendingWheelDelta = 0;

                const mouse = lastWheelMouseRef.current;
                applyZoom(nextScale, mouse ? { anchor: mouse } : undefined);
                lastWheelCommitAt = performance.now();
            };

            const flushWheelZoom = () => {
                zoomRafId = null;
                if (pendingWheelDelta === 0) return;
                const now = performance.now();
                const elapsed = now - lastWheelCommitAt;
                if (elapsed >= WHEEL_ZOOM_RENDER_INTERVAL_MS) {
                    if (wheelCommitTimeoutId !== null) {
                        clearTimeout(wheelCommitTimeoutId);
                        wheelCommitTimeoutId = null;
                    }
                    commitWheelZoom();
                    return;
                }
                if (wheelCommitTimeoutId === null) {
                    wheelCommitTimeoutId = setTimeout(() => {
                        wheelCommitTimeoutId = null;
                        commitWheelZoom();
                    }, WHEEL_ZOOM_RENDER_INTERVAL_MS - elapsed);
                }
            };

            const handleWheel = (e: WheelEvent) => {
                if (e.ctrlKey || e.metaKey) {
                    e.preventDefault();
                    markViewportInteracting();
                    const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
                    pendingWheelDelta = Math.max(-ZOOM_STEP * 3, Math.min(ZOOM_STEP * 3, pendingWheelDelta + delta));
                    
                    const rect = container.getBoundingClientRect();
                    lastWheelMouseRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
                    if (zoomRafId === null) zoomRafId = window.requestAnimationFrame(flushWheelZoom);
                }
            };

            container.addEventListener("scroll", handleScroll, { passive: true });
            container.addEventListener("wheel", handleWheel, { passive: false });
            return () => {
                container.removeEventListener("scroll", handleScroll);
                container.removeEventListener("wheel", handleWheel);
                if (rafId !== null) cancelAnimationFrame(rafId);
                if (zoomRafId !== null) cancelAnimationFrame(zoomRafId);
                if (wheelCommitTimeoutId !== null) clearTimeout(wheelCommitTimeoutId);
            };
        }, [pages.length, applyZoom, rebuildPageLayout, markViewportInteracting, isInitialRenderStabilizing, loadSpecificPages]);

        useEffect(() => {
            const container = containerRef.current;
            const zoomContainer = zoomContainerRef.current;
            if (!container || !zoomContainer || pages.length === 0) return;
            let isPinching = false, initialDistance = 0, initialScale = 1;
            let initialPinchCenterX = 0, initialPinchCenterY = 0, initialScrollLeft = 0, initialScrollTop = 0;

            const onTouchStart = (e: TouchEvent) => {
                if (e.touches.length === 2) {
                    markViewportInteracting();
                    e.preventDefault(); isPinching = true; initialScale = scaleRef.current;
                    const dx = e.touches[1].clientX - e.touches[0].clientX;
                    const dy = e.touches[1].clientY - e.touches[0].clientY;
                    initialDistance = Math.sqrt(dx * dx + dy * dy);
                    const rect = container.getBoundingClientRect();
                    initialPinchCenterX = ((e.touches[0].clientX + e.touches[1].clientX) / 2) - rect.left;
                    initialPinchCenterY = ((e.touches[0].clientY + e.touches[1].clientY) / 2) - rect.top;
                    initialScrollLeft = container.scrollLeft; initialScrollTop = container.scrollTop;
                    zoomContainer.style.transformOrigin = `${initialPinchCenterX + initialScrollLeft}px ${initialPinchCenterY + initialScrollTop}px`;
                }
            };
            const onTouchMove = (e: TouchEvent) => {
                if (isPinching && e.touches.length === 2) {
                    markViewportInteracting();
                    e.preventDefault();
                    const dx = e.touches[1].clientX - e.touches[0].clientX;
                    const dy = e.touches[1].clientY - e.touches[0].clientY;
                    const distance = Math.sqrt(dx * dx + dy * dy);
                    const targetScale = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, initialScale * (distance / initialDistance)));
                    zoomContainer.style.transform = `scale(${targetScale / initialScale})`;
                }
            };
            const onTouchEnd = (e: TouchEvent) => {
                if (isPinching && e.touches.length < 2) {
                    markViewportInteracting();
                    isPinching = false;
                    const transformValue = zoomContainer.style.transform;
                    zoomContainer.style.transform = ''; zoomContainer.style.transformOrigin = '';
                    if (transformValue) {
                        const match = transformValue.match(/scale\(([^)]+)\)/);
                        if (match && match[1]) {
                            const visualScale = parseFloat(match[1]);
                            const finalScale = initialScale * visualScale;
                            // Scrolling is blocked while pinching, so the container is
                            // still at initialScroll*; anchor on the pinch centre.
                            applyZoom(finalScale, { anchor: { x: initialPinchCenterX, y: initialPinchCenterY } });
                        }
                    }
                }
            };
            container.addEventListener("touchstart", onTouchStart, { passive: false });
            container.addEventListener("touchmove", onTouchMove, { passive: false });
            container.addEventListener("touchend", onTouchEnd);
            container.addEventListener("touchcancel", onTouchEnd);
            return () => {
                container.removeEventListener("touchstart", onTouchStart);
                container.removeEventListener("touchmove", onTouchMove);
                container.removeEventListener("touchend", onTouchEnd);
                container.removeEventListener("touchcancel", onTouchEnd);
            };
        }, [pages.length, applyZoom, markViewportInteracting]);

        const navigateToPage = useCallback((targetPage: number, behavior: ScrollBehavior = "smooth") => {
            const totalPageCount = totalPagesRef.current;
            if (targetPage < 1 || targetPage > totalPageCount) return;

            // If jumping more than 2 pages (TOC, search result, direct jump), use "auto"
            // to instantly land on the exact page without smooth-scroll delay or intermediate drift.
            const pageDiff = Math.abs(targetPage - currentPageRef.current);
            const effectiveBehavior: ScrollBehavior = pageDiff > 2 ? "auto" : behavior;

            if (targetPage !== currentPageRef.current && totalPageCount > 0) {
                currentPageRef.current = targetPage; setCurrentPage(targetPage);
                callbacksRef.current.onPageChange?.(targetPage, totalPageCount, scaleRef.current);
            }

            // Lock navigation so handleScroll does NOT fight the jump
            isNavigatingPageRef.current = targetPage;
            if (navigationTimeoutRef.current) clearTimeout(navigationTimeoutRef.current);
            navigationTimeoutRef.current = setTimeout(() => {
                isNavigatingPageRef.current = null;
            }, effectiveBehavior === "smooth" ? 400 : 120);

            // ALWAYS immediately load the target page and surrounding pages!
            const nearTargets: number[] = [targetPage];
            for (let offset = 1; offset <= PAGE_LOAD_AHEAD_THRESHOLD; offset++) {
                if (targetPage + offset <= totalPageCount) nearTargets.push(targetPage + offset);
                if (targetPage - offset >= 1) nearTargets.push(targetPage - offset);
            }
            void loadSpecificPages(nearTargets);

            if (presentationModeRef.current === 'paged') {
                containerRef.current?.scrollTo({ top: 0, left: 0, behavior: "auto" });
                return;
            }

            if (scrollToPage(targetPage, effectiveBehavior)) {
                pendingScrollPageRef.current = null;
                return;
            }
            pendingScrollPageRef.current = targetPage;
        }, [loadSpecificPages, scrollToPage]);

        const handleViewportClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
            if (isLoading || !!error || annotationMode !== "none") return;
            if (event.defaultPrevented || event.button !== 0) return;
            const target = event.target as Element | null;
            if (target?.closest('a,button,input,textarea,select,label,[role="button"],[contenteditable="true"],[data-no-viewport-tap]')) return;
            const selection = window.getSelection();
            if (selection && !selection.isCollapsed && selection.toString().trim().length > 0) return;

            if (presentationModeRef.current === 'paged' || presentationModeRef.current === 'two-page') {
                const container = containerRef.current;
                if (container) {
                    const rect = container.getBoundingClientRect();
                    const clickX = event.clientX - rect.left;
                    const width = rect.width;
                    // Left 25% tap zone: Previous
                    if (clickX < width * 0.25) {
                        if (presentationModeRef.current === 'two-page') {
                            const currentSpreadStart = currentPageRef.current % 2 === 1 ? currentPageRef.current : currentPageRef.current - 1;
                            const prev = Math.max(1, currentSpreadStart - 2);
                            if (prev >= 1 && prev !== currentPageRef.current) {
                                navigateToPage(prev, "smooth");
                                return;
                            }
                        } else if (currentPageRef.current > 1) {
                            navigateToPage(currentPageRef.current - 1, "smooth");
                            return;
                        }
                    }
                    // Right 25% tap zone: Next
                    if (clickX > width * 0.75) {
                        if (presentationModeRef.current === 'two-page') {
                            const currentSpreadStart = currentPageRef.current % 2 === 1 ? currentPageRef.current : currentPageRef.current - 1;
                            const next = currentSpreadStart + 2;
                            if (next <= totalPagesRef.current) {
                                navigateToPage(next, "smooth");
                                return;
                            }
                        } else if (currentPageRef.current < totalPagesRef.current) {
                            navigateToPage(currentPageRef.current + 1, "smooth");
                            return;
                        }
                    }
                }
            }

            onViewportTap?.();
        }, [annotationMode, error, isLoading, navigateToPage, onViewportTap]);

        useEffect(() => {
            const container = containerRef.current;
            if (!container) return;

            let touchStartX = 0;
            let touchStartY = 0;
            let isSwiping = false;

            const onTouchStart = (e: TouchEvent) => {
                if (e.touches.length === 1 && (presentationModeRef.current === 'paged' || presentationModeRef.current === 'two-page')) {
                    touchStartX = e.touches[0].clientX;
                    touchStartY = e.touches[0].clientY;
                    isSwiping = true;
                }
            };

            const onTouchEnd = (e: TouchEvent) => {
                if (!isSwiping || (presentationModeRef.current !== 'paged' && presentationModeRef.current !== 'two-page') || e.changedTouches.length === 0) return;
                isSwiping = false;
                const deltaX = e.changedTouches[0].clientX - touchStartX;
                const deltaY = e.changedTouches[0].clientY - touchStartY;
                if (Math.abs(deltaX) > 48 && Math.abs(deltaX) > Math.abs(deltaY) * 1.5) {
                    const container = containerRef.current;
                    const isHorizontallyScrollable = container ? (container.scrollWidth > container.clientWidth + 16) : false;

                    // If the container is horizontally scrollable (spread wider than viewport or zoomed in),
                    // allow smooth horizontal panning without accidentally flipping pages, unless swiping at the edges.
                    if (isHorizontallyScrollable && container) {
                        const atLeftEdge = container.scrollLeft <= 16;
                        const atRightEdge = container.scrollLeft + container.clientWidth >= container.scrollWidth - 16;
                        if (deltaX < 0 && !atRightEdge) return;
                        if (deltaX > 0 && !atLeftEdge) return;
                    }

                    if (deltaX < 0) {
                        if (presentationModeRef.current === 'two-page') {
                            const currentSpreadStart = currentPageRef.current % 2 === 1 ? currentPageRef.current : currentPageRef.current - 1;
                            const next = currentSpreadStart + 2;
                            if (next <= totalPagesRef.current) navigateToPage(next, "smooth");
                        } else if (currentPageRef.current < totalPagesRef.current) {
                            navigateToPage(currentPageRef.current + 1, "smooth");
                        }
                    } else if (deltaX > 0) {
                        if (presentationModeRef.current === 'two-page') {
                            const currentSpreadStart = currentPageRef.current % 2 === 1 ? currentPageRef.current : currentPageRef.current - 1;
                            const prev = Math.max(1, currentSpreadStart - 2);
                            if (prev >= 1) navigateToPage(prev, "smooth");
                        } else if (currentPageRef.current > 1) {
                            navigateToPage(currentPageRef.current - 1, "smooth");
                        }
                    }
                }
            };

            container.addEventListener("touchstart", onTouchStart, { passive: true });
            container.addEventListener("touchend", onTouchEnd, { passive: true });
            return () => {
                container.removeEventListener("touchstart", onTouchStart);
                container.removeEventListener("touchend", onTouchEnd);
            };
        }, [navigateToPage]);

        const firstLoadedPage = useMemo(() => pages.length > 0 ? pages[0] : undefined, [pages]);
        const getRenderPriority = useCallback((pageNumber: number) => Math.abs(pageNumber - currentPageRef.current), []);

        useEffect(() => {
            const container = containerRef.current;
            if (!container || isLoading || !!error) return;

            const handleKeyDown = (event: KeyboardEvent) => {
                if (event.defaultPrevented) return;
                if (isEditableKeyboardTarget(event.target)) return;

                const targetElement = event.target instanceof Element ? event.target : null;
                if (targetElement
                    && !container.contains(targetElement)
                    && targetElement !== document.body
                    && targetElement !== document.documentElement) {
                    return;
                }

                const isCtrlOrCmd = event.ctrlKey || event.metaKey;

                // Zoom shortcuts with Ctrl/Cmd
                if (isCtrlOrCmd) {
                    if (event.key === "=" || event.key === "+") {
                        event.preventDefault();
                        applyZoom(scaleRef.current + ZOOM_STEP);
                        return;
                    }
                    if (event.key === "-" || event.key === "_") {
                        event.preventDefault();
                        applyZoom(scaleRef.current - ZOOM_STEP);
                        return;
                    }
                    if (event.key === "0") {
                        event.preventDefault();
                        if (container && firstLoadedPage) {
                            applyZoom(getFitPageScale(container, firstLoadedPage, presentationModeRef.current === 'two-page'), { mode: "page-fit", preserveMode: true });
                        }
                        return;
                    }
                    if (event.key === "1") {
                        event.preventDefault();
                        applyZoom(DEFAULT_SCALE, { mode: "custom" });
                        return;
                    }
                    if (event.key === "2") {
                        event.preventDefault();
                        if (container && firstLoadedPage) {
                            applyZoom(getFitWidthScale(container, firstLoadedPage, presentationModeRef.current === 'two-page'), { mode: "width-fit", preserveMode: true });
                        }
                        return;
                    }
                    return;
                }

                if (event.altKey) return;

                // Jump to start / end
                if (event.key === "Home") {
                    event.preventDefault();
                    if (currentPageRef.current !== 1) pushHistory();
                    navigateToPage(1, "auto");
                    return;
                }
                if (event.key === "End") {
                    event.preventDefault();
                    if (currentPageRef.current !== totalPagesRef.current) pushHistory();
                    navigateToPage(totalPagesRef.current, "auto");
                    return;
                }

                // Previous page
                if (event.key === "ArrowLeft" || event.key === "PageUp" || (event.key === " " && event.shiftKey) || event.key === "k") {
                    if (currentPageRef.current <= 1) return;
                    event.preventDefault();
                    if (presentationModeRef.current === 'two-page') {
                        const currentSpreadStart = currentPageRef.current % 2 === 1 ? currentPageRef.current : currentPageRef.current - 1;
                        const prev = Math.max(1, currentSpreadStart - 2);
                        if (prev >= 1) navigateToPage(prev, "smooth");
                    } else {
                        navigateToPage(currentPageRef.current - 1, "smooth");
                    }
                    return;
                }

                // Next page
                if (event.key === "ArrowRight" || event.key === "PageDown" || (event.key === " " && !event.shiftKey) || event.key === "j") {
                    if (currentPageRef.current >= totalPagesRef.current) return;
                    event.preventDefault();
                    if (presentationModeRef.current === 'two-page') {
                        const currentSpreadStart = currentPageRef.current % 2 === 1 ? currentPageRef.current : currentPageRef.current - 1;
                        const next = currentSpreadStart + 2;
                        if (next <= totalPagesRef.current) navigateToPage(next, "smooth");
                    } else {
                        navigateToPage(currentPageRef.current + 1, "smooth");
                    }
                    return;
                }

                if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                    event.preventDefault();
                    if (presentationModeRef.current === 'paged') {
                        if (event.key === "ArrowUp" && currentPageRef.current > 1) {
                            navigateToPage(currentPageRef.current - 1, "smooth");
                        } else if (event.key === "ArrowDown" && currentPageRef.current < totalPagesRef.current) {
                            navigateToPage(currentPageRef.current + 1, "smooth");
                        }
                        return;
                    }
                    markViewportInteracting();
                    const scrollStep = Math.max(
                        KEYBOARD_SCROLL_STEP_MIN_PX,
                        Math.round(container.clientHeight * KEYBOARD_SCROLL_STEP_RATIO),
                    );
                    const delta = event.key === "ArrowUp" ? -scrollStep : scrollStep;
                    container.scrollBy({ top: delta, behavior: "auto" });
                }
            };

            window.addEventListener("keydown", handleKeyDown);
            return () => { window.removeEventListener("keydown", handleKeyDown); };
        }, [applyZoom, error, firstLoadedPage, isLoading, markViewportInteracting, navigateToPage]);

        // ── Navigation history (link / TOC / page jumps) ─────────────────────
        const historyRef = useRef<{ back: PdfHistoryEntry[]; forward: PdfHistoryEntry[] }>({ back: [], forward: [] });
        const historyCallbackRef = useRef(onHistoryChange);
        historyCallbackRef.current = onHistoryChange;
        const linkPreviewCallbackRef = useRef(onLinkPreview);
        linkPreviewCallbackRef.current = onLinkPreview;

        const emitHistoryChange = useCallback(() => {
            const { back, forward } = historyRef.current;
            historyCallbackRef.current?.({ canGoBack: back.length > 0, canGoForward: forward.length > 0 });
        }, []);

        const captureLocation = useCallback((): PdfHistoryEntry => {
            const page = currentPageRef.current;
            const container = containerRef.current;
            const entry = pageLayoutRef.current.find((item) => item.pageNumber === page);
            if (!container || !entry || entry.bottom <= entry.top) return { page, ratio: 0 };
            // Unclamped: the viewport top may sit in the padding/gap above the page.
            return { page, ratio: (container.scrollTop - entry.top) / (entry.bottom - entry.top) };
        }, []);

        const pushHistory = useCallback(() => {
            historyRef.current = pushPdfHistory(historyRef.current, captureLocation());
            emitHistoryChange();
        }, [captureLocation, emitHistoryChange]);

        /** Scroll so that viewport-space y (CSS px within the page) sits near the top. */
        const scrollWithinPage = useCallback((pageNumber: number, yCss: number, xCss: number | null) => {
            const container = containerRef.current;
            if (!container) return;
            const wrapper = container.querySelector<HTMLElement>(`.pdf-page-wrapper[data-page-number="${pageNumber}"]`);
            if (!wrapper) return;
            const containerRect = container.getBoundingClientRect();
            const inner = wrapper.querySelector<HTMLElement>(".pdf-page-container") ?? wrapper;
            const innerRect = inner.getBoundingClientRect();
            const pageTop = innerRect.top - containerRect.top + container.scrollTop;
            const pageLeft = innerRect.left - containerRect.left + container.scrollLeft;
            const top = Math.max(0, pageTop + yCss - 16);
            const left = xCss !== null && container.scrollWidth > container.clientWidth
                ? Math.max(0, pageLeft + xCss - 16)
                : container.scrollLeft;
            container.scrollTo({ top, left, behavior: "auto" });
        }, []);

        const restoreLocation = useCallback((entry: PdfHistoryEntry) => {
            navigateToPage(entry.page, "auto");
            // Exact restore: the same offset relative to the page as when captured.
            const container = containerRef.current;
            const layout = pageLayoutRef.current.find((item) => item.pageNumber === entry.page);
            if (container && layout) {
                container.scrollTo({ top: Math.max(0, layout.top + entry.ratio * (layout.bottom - layout.top)), behavior: "auto" });
            }
        }, [navigateToPage]);

        const goBack = useCallback(() => {
            const result = stepPdfHistory(historyRef.current, captureLocation(), "back");
            if (!result) return;
            historyRef.current = result.history;
            restoreLocation(result.target);
            emitHistoryChange();
        }, [captureLocation, restoreLocation, emitHistoryChange]);

        const goForward = useCallback(() => {
            const result = stepPdfHistory(historyRef.current, captureLocation(), "forward");
            if (!result) return;
            historyRef.current = result.history;
            restoreLocation(result.target);
            emitHistoryChange();
        }, [captureLocation, restoreLocation, emitHistoryChange]);

        const goToDestination = useCallback((target: PdfDestTarget) => {
            if (target.pageNumber < 1 || target.pageNumber > totalPagesRef.current) return;
            pushHistory();
            navigateToPage(target.pageNumber, "auto");
            if (!pdfDocument || (target.top === null && target.left === null)) return;
            const expectedScale = scaleRef.current;
            void pdfDocument.getPage(target.pageNumber).then((page) => {
                if (scaleRef.current !== expectedScale) return;
                const viewport = page.getViewport({ scale: expectedScale * PDF_TO_CSS_UNITS, rotation: rotationRef.current });
                const [x, y] = viewport.convertToViewportPoint(target.left ?? page.view[0], target.top ?? page.view[3]);
                scrollWithinPage(target.pageNumber, y, target.left !== null ? x : null);
            }).catch(() => undefined);
        }, [pdfDocument, pushHistory, navigateToPage, scrollWithinPage]);

        // Reset history when a different document loads.
        useEffect(() => {
            historyRef.current = { back: [], forward: [] };
            emitHistoryChange();
        }, [pdfDocument, emitHistoryChange]);

        // Mouse back/forward buttons.
        useEffect(() => {
            const container = containerRef.current;
            if (!container) return;
            const onMouseUp = (event: MouseEvent) => {
                if (event.button === 3) { event.preventDefault(); goBack(); }
                else if (event.button === 4) { event.preventDefault(); goForward(); }
            };
            container.addEventListener("mouseup", onMouseUp);
            return () => container.removeEventListener("mouseup", onMouseUp);
        }, [goBack, goForward]);

        // ── Links + Theorem Lens ─────────────────────────────────────────────
        const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
        const linkRequestRef = useRef(0);

        const showLinkPreview = useCallback(async (link: PdfLink, anchor: HTMLElement, mode: "hover" | "tap") => {
            if (link.kind !== "internal" || !pdfDocument) return;
            const request = ++linkRequestRef.current;
            const target = await resolvePdfDestTarget(pdfDocument, link.dest);
            if (!target || request !== linkRequestRef.current) return;
            const pixelRatio = typeof window !== "undefined" ? Math.min(2, window.devicePixelRatio || 1) : 1;
            let preview: PdfLensPreview;
            try {
                preview = await buildPdfLensPreview(pdfDocument, target, LENS_PREVIEW_CSS_WIDTH, pixelRatio);
            } catch {
                return;
            }
            if (request !== linkRequestRef.current || !anchor.isConnected) return;
            const rect = anchor.getBoundingClientRect();
            linkPreviewCallbackRef.current?.({
                preview,
                target,
                mode,
                anchorRect: { top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
            });
        }, [pdfDocument]);

        const cancelLinkHover = useCallback(() => {
            if (hoverTimerRef.current) {
                clearTimeout(hoverTimerRef.current);
                hoverTimerRef.current = null;
            }
            linkRequestRef.current++;
        }, []);

        const runNamedAction = useCallback((action: string) => {
            switch (action) {
                case "NextPage": if (currentPageRef.current < totalPagesRef.current) navigateToPage(currentPageRef.current + 1, "auto"); break;
                case "PrevPage": if (currentPageRef.current > 1) navigateToPage(currentPageRef.current - 1, "auto"); break;
                case "FirstPage": pushHistory(); navigateToPage(1, "auto"); break;
                case "LastPage": pushHistory(); navigateToPage(totalPagesRef.current, "auto"); break;
                case "GoBack": goBack(); break;
                case "GoForward": goForward(); break;
            }
        }, [navigateToPage, pushHistory, goBack, goForward]);

        const linkHandlers = useMemo<PdfLinkHandlers>(() => ({
            enabled: annotationMode === "none",
            onActivate: (link, anchor, pointerType) => {
                cancelLinkHover();
                if (link.kind === "external") {
                    openExternalUrl(link.url);
                    return;
                }
                if (link.kind === "named") {
                    runNamedAction(link.action);
                    return;
                }
                if (pointerType === "touch" || pointerType === "pen") {
                    // No hover on touch: a tap opens the Lens, which offers Jump.
                    void showLinkPreview(link, anchor, "tap");
                    return;
                }
                linkPreviewCallbackRef.current?.(null);
                const request = ++linkRequestRef.current;
                void (async () => {
                    if (!pdfDocument) return;
                    const target = await resolvePdfDestTarget(pdfDocument, link.dest);
                    if (target && request === linkRequestRef.current) goToDestination(target);
                })();
            },
            onHoverStart: (link, anchor) => {
                cancelLinkHover();
                hoverTimerRef.current = setTimeout(() => {
                    hoverTimerRef.current = null;
                    void showLinkPreview(link, anchor, "hover");
                }, LENS_HOVER_DELAY_MS);
            },
            onHoverEnd: () => {
                cancelLinkHover();
                linkPreviewCallbackRef.current?.(null);
            },
        }), [annotationMode, cancelLinkHover, runNamedAction, showLinkPreview, pdfDocument, goToDestination]);

        useEffect(() => () => cancelLinkHover(), [cancelLinkHover]);

        useImperativeHandle(ref, () => ({
            goToPage: (page: number) => {
                if (page < 1 || page > totalPagesRef.current) return;
                if (page !== currentPageRef.current) pushHistory();
                navigateToPage(page, "auto");
            },
            goBack,
            goForward,
            canGoBack: () => historyRef.current.back.length > 0,
            canGoForward: () => historyRef.current.forward.length > 0,
            goToDestination,
            nextPage: () => {
                const page = currentPageRef.current;
                if (presentationModeRef.current === 'two-page') {
                    const currentSpreadStart = page % 2 === 1 ? page : page - 1;
                    const next = currentSpreadStart + 2;
                    if (next <= totalPagesRef.current) {
                        navigateToPage(next, "smooth");
                    } else if (page < totalPagesRef.current) {
                        navigateToPage(totalPagesRef.current, "smooth");
                    }
                } else if (page < totalPagesRef.current) {
                    navigateToPage(page + 1, "smooth");
                }
            },
            prevPage: () => {
                const page = currentPageRef.current;
                if (presentationModeRef.current === 'two-page') {
                    const currentSpreadStart = page % 2 === 1 ? page : page - 1;
                    const prev = Math.max(1, currentSpreadStart - 2);
                    if (prev >= 1 && prev !== page) {
                        navigateToPage(prev, "smooth");
                    }
                } else if (page > 1) {
                    navigateToPage(page - 1, "smooth");
                }
            },
            zoomIn: () => { applyZoom(scaleRef.current + ZOOM_STEP); },
            zoomOut: () => {
                const currentScale = scaleRef.current;
                if (currentScale <= MIN_ZOOM + 0.001) {
                    applyZoom(DEFAULT_SCALE, { mode: "custom" });
                    return;
                }
                applyZoom(currentScale - ZOOM_STEP);
            },
            zoomReset: () => { applyZoom(DEFAULT_SCALE, { mode: "custom" }); },
            setZoom: (newScale: number) => { applyZoom(newScale, { mode: "custom" }); },
            getZoom: () => scaleRef.current,
            getCurrentPage: () => currentPageRef.current,
            getTotalPages: () => totalPagesRef.current,
            rotateClockwise: () => { setRotation((prev) => (prev + 90) % 360); },
            rotateCounterClockwise: () => { setRotation((prev) => (prev - 90 + 360) % 360); },
            zoomFitPage: () => {
                if (!containerRef.current || !firstLoadedPage) return;
                applyZoom(getFitPageScale(containerRef.current, firstLoadedPage, presentationModeRef.current === 'two-page'), { mode: "page-fit", preserveMode: true });
            },
            zoomFitWidth: () => {
                if (!containerRef.current || !firstLoadedPage) return;
                applyZoom(getFitWidthScale(containerRef.current, firstLoadedPage, presentationModeRef.current === 'two-page'), { mode: "width-fit", preserveMode: true });
            },
            setPresentationMode: (mode: 'scroll' | 'paged' | 'two-page') => {
                if (presentationModeRef.current === mode) return;
                presentationModeRef.current = mode;
                setPresentationModeState(mode);
                if (mode === 'paged') {
                    setPages((existing) => {
                        const curr = currentPageRef.current;
                        const kept = existing.filter((p) => p.pageNumber === curr);
                        existing.filter((p) => p.pageNumber !== curr).forEach((p) => p.cleanup());
                        return kept;
                    });
                    if (containerRef.current && firstLoadedPage) {
                        applyZoom(getFitPageScale(containerRef.current, firstLoadedPage, false), { mode: "page-fit", preserveMode: true });
                    }
                } else if (mode === 'two-page') {
                    if (containerRef.current && firstLoadedPage) {
                        const nextScale = zoomModeRef.current === 'page-fit'
                            ? getFitPageScale(containerRef.current, firstLoadedPage, true)
                            : getFitWidthScale(containerRef.current, firstLoadedPage, true);
                        applyZoom(nextScale, { mode: zoomModeRef.current, preserveMode: true });
                    }
                } else {
                    if (containerRef.current && firstLoadedPage) {
                        const nextScale = zoomModeRef.current === 'page-fit'
                            ? getFitPageScale(containerRef.current, firstLoadedPage, false)
                            : getFitWidthScale(containerRef.current, firstLoadedPage, false);
                        applyZoom(nextScale, { mode: zoomModeRef.current, preserveMode: true });
                    }
                }
                onPresentationModeChange?.(mode);
            },
            getPresentationMode: () => presentationModeRef.current,
            search: (query: string) => search(query),
            clearSearch: () => clearSearch(),
        }), [applyZoom, clearSearch, firstLoadedPage, navigateToPage, onPresentationModeChange, search]);

        const displayError = error?.replace(/\s+/g, " ").trim();

        // Build a fast lookup map from pageNumber → PDFPageProxy for the JSX render.
        // This avoids O(n²) Array.find() calls in the map loop.
        const pageProxyMap = useMemo(() => {
            const m = new Map<number, PDFPageProxy>();
            for (const p of pages) m.set(p.pageNumber, p);
            return m;
        }, [pages]);

        const spreads = useMemo(() => getSpreads(totalPages), [totalPages]);

        // In paged mode: only render the current page's proxy (or its placeholder).
        // In scroll/two-page mode: render page slots using pre-fetched structure or first loaded page for sizing.
        const prefetchedStruct = prefetchedStructureRef.current;
        const defaultWidthPt = prefetchedStruct?.default_width_pt ?? (firstLoadedPage ? firstLoadedPage.getViewport({ scale: 1 }).width / PDF_TO_CSS_UNITS : 612);
        const defaultHeightPt = prefetchedStruct?.default_height_pt ?? (firstLoadedPage ? firstLoadedPage.getViewport({ scale: 1 }).height / PDF_TO_CSS_UNITS : 792);
        const hasVirtualLayout = totalPages > 0 && presentationMode !== 'paged';

        // Compute placeholder dimensions from pre-fetched aspect ratio (CSS units)
        const placeholderCssWidth  = Math.max(1, getCssDimension(defaultWidthPt  * PDF_TO_CSS_UNITS * scale, isDesktopWebKit));
        const placeholderCssHeight = Math.max(1, getCssDimension(defaultHeightPt * PDF_TO_CSS_UNITS * scale, isDesktopWebKit));

        const renderPageSlot = (pageNumber: number) => {
            const page = pageProxyMap.get(pageNumber);
            const pageDistanceFromCurrent = Math.abs(pageNumber - currentPage);
            const pageIsInCanvasRenderWindow = pageDistanceFromCurrent <= canvasRenderWindow;
            const pageTextLayerEnabled = enableTextLayer && pageDistanceFromCurrent <= textLayerPageWindow;
            const pageUseStreamTextLayer = isDesktopWebKit ? pageNumber !== currentPage : useStreamTextLayer;

            if (page) {
                return (
                    <div
                        key={`page-${pageNumber}`}
                        className="pdf-page-wrapper"
                        data-page-number={pageNumber}
                    >
                        <PageCanvas
                            page={page} scale={scale} rotation={rotation}
                            isRenderActive={pageIsInCanvasRenderWindow}
                            forceRenderActive={isInitialRenderStabilizing}
                            inactiveReleaseDelayMs={inactiveCanvasReleaseDelayMs}
                            getRenderPriority={getRenderPriority}
                            enableTextLayer={pageTextLayerEnabled} preferSharpCanvas={isDesktopWebKit}
                            reduceRenderQuality={isViewportInteracting}
                            snapCssToPixels={isDesktopWebKit} useStreamTextLayer={pageUseStreamTextLayer}
                            calibrateTextLayerWidths={isDesktopWebKit && pageNumber === currentPage}
                            annotations={annotationsByPage.get(pageNumber) ?? EMPTY_ANNOTATIONS}
                            annotationMode={annotationMode} highlightColor={highlightColor} penColor={penColor} penWidth={penWidth}
                            onAnnotationAdd={onAnnotationAdd} onAnnotationChange={onAnnotationChange} onAnnotationRemove={onAnnotationRemove}
                            searchQuery={activeSearchQuery}
                        />
                    </div>
                );
            }

            if (hasVirtualLayout) {
                const cssW = placeholderCssWidth;
                const cssH = placeholderCssHeight;

                return (
                    <div
                        key={`page-${pageNumber}`}
                        ref={registerPlaceholderRef}
                        className="pdf-page-wrapper"
                        data-page-number={pageNumber}
                        style={{ width: `${cssW}px`, height: `${cssH}px` }}
                    />
                );
            }

            return null;
        };

        return (
            <PdfLinkHandlersContext.Provider value={linkHandlers}>
            <div className={cn("relative w-full h-full", className)}>
                {isLoading && (
                    <PageLoader
                        message="Loading PDF..."
                        className="absolute inset-0 z-20"
                    />
                )}
                {displayError && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center bg-[var(--color-surface)] p-6 sm:p-8 z-20 animate-fade-in">
                        <div className="mx-auto w-full max-w-[26rem] min-w-0 flex flex-col items-center text-center">
                            <div className="mb-4 flex h-14 w-14 items-center justify-center border border-[var(--color-border)] bg-[var(--color-surface-muted)] text-[color:var(--color-error)]">
                                <AlertCircle className="h-6 w-6" />
                            </div>
                            <h3 className="mb-2 text-base font-bold text-[color:var(--color-text-primary)]">
                                Failed to load PDF
                            </h3>
                            <p className="mx-auto w-full max-w-[22rem] break-words text-sm text-[color:var(--color-text-secondary)] text-center leading-relaxed">
                                {displayError}
                            </p>
                        </div>
                    </div>
                )}
                <div
                    ref={containerRef}
                    className={cn(
                        "absolute inset-0 overflow-auto bg-[var(--color-surface)] scrollbar-solid",
                        error && "invisible"
                    )}
                    onClick={handleViewportClick}
                >
                    <div
                        ref={zoomContainerRef}
                        className={cn(
                            "pdf-zoom-container flex flex-col items-center min-h-full py-2 sm:py-4 px-1 sm:px-0 mx-auto",
                            presentationMode === 'paged'
                                ? "justify-center min-h-full space-y-0"
                                : presentationMode === 'two-page'
                                    ? "justify-start space-y-3 sm:space-y-6"
                                    : "justify-start space-y-2 sm:space-y-4"
                        )}
                    >
                        {presentationMode === 'paged' ? (
                            // Paged mode: show only the current page proxy or placeholder
                            renderPageSlot(currentPage)
                        ) : presentationMode === 'two-page' ? (
                            // Two-page facing spread mode
                            spreads.map((spread) => (
                                <div
                                    key={`spread-${spread[0]}`}
                                    className="pdf-spread-row flex flex-row flex-nowrap items-center gap-2 sm:gap-4 my-1 sm:my-2 mx-auto"
                                >
                                    {spread.map((pageNum) => renderPageSlot(pageNum))}
                                </div>
                            ))
                        ) : hasVirtualLayout ? (
                            // Scroll mode with Rust pre-fetch: render all N page slots immediately
                            Array.from({ length: totalPages }, (_, i) => renderPageSlot(i + 1))
                        ) : (
                            // Fallback (no Rust pre-fetch / browser env): render loaded proxies
                            pages.map((page) => renderPageSlot(page.pageNumber))
                        )}
                    </div>
                </div>
                {!isLoading && !error && totalPages > 0 && (
                    <div
                        data-no-viewport-tap
                        className={cn(
                            "absolute bottom-6 left-1/2 -translate-x-1/2 z-50 px-2.5 py-1.5 rounded-full bg-[var(--color-surface)]/95 backdrop-blur-xl border border-[var(--color-border)] text-xs text-[color:var(--color-text-primary)] shadow-lg flex items-center gap-1.5 transition-[transform,opacity] duration-150 ease-out select-none",
                            showControls ? "opacity-100 translate-y-0" : "opacity-0 translate-y-8 pointer-events-none"
                        )}
                    >
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                if (presentationModeRef.current === 'two-page') {
                                    const currentSpreadStart = currentPage % 2 === 1 ? currentPage : currentPage - 1;
                                    const prev = Math.max(1, currentSpreadStart - 2);
                                    if (prev >= 1) navigateToPage(prev, "smooth");
                                } else if (currentPage > 1) {
                                    navigateToPage(currentPage - 1, "smooth");
                                }
                            }}
                            disabled={currentPage <= 1}
                            className="p-1 rounded-full text-[color:var(--color-text-primary)] hover:bg-[var(--color-surface-hover)] disabled:opacity-30 disabled:pointer-events-none transition-colors"
                            title="Previous page"
                            aria-label="Previous page"
                        >
                            <ChevronLeft className="w-4 h-4" />
                        </button>
                        <span className="font-medium text-[color:var(--color-text-primary)] tabular-nums px-0.5">
                            {presentationMode === 'two-page' ? (
                                (() => {
                                    const spreadStart = currentPage % 2 === 1 ? currentPage : currentPage - 1;
                                    const spreadEnd = Math.min(totalPages, spreadStart + 1);
                                    return spreadStart === spreadEnd ? `${spreadStart}` : `${spreadStart}–${spreadEnd}`;
                                })()
                            ) : currentPage}
                        </span>
                        <span className="text-[color:var(--color-text-muted)]">/</span>
                        <span className="tabular-nums px-0.5">{totalPages}</span>
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                if (presentationModeRef.current === 'two-page') {
                                    const currentSpreadStart = currentPage % 2 === 1 ? currentPage : currentPage - 1;
                                    const next = currentSpreadStart + 2;
                                    if (next <= totalPages) navigateToPage(next, "smooth");
                                } else if (currentPage < totalPages) {
                                    navigateToPage(currentPage + 1, "smooth");
                                }
                            }}
                            disabled={currentPage >= totalPages}
                            className="p-1 rounded-full text-[color:var(--color-text-primary)] hover:bg-[var(--color-surface-hover)] disabled:opacity-30 disabled:pointer-events-none transition-colors"
                            title="Next page"
                            aria-label="Next page"
                        >
                            <ChevronRight className="w-4 h-4" />
                        </button>
                        <span className="mx-0.5 w-px h-3.5 bg-[var(--color-border)]" />
                        <Dropdown
                            options={[
                                { value: 'fitW', label: 'Fit Width' },
                                { value: 'fitP', label: 'Fit Page' },
                                { value: '100', label: '100%' },
                            ]}
                            value={String(Math.round(scale * 100))}
                            placeholder={`${Math.round(scale * 100)}%`}
                            onChange={(v) => {
                                const isTwoPage = presentationModeRef.current === 'two-page';
                                if (v === 'fitW' && containerRef.current && firstLoadedPage) {
                                    applyZoom(getFitWidthScale(containerRef.current, firstLoadedPage, isTwoPage), { mode: "width-fit", preserveMode: true });
                                } else if (v === 'fitP' && containerRef.current && firstLoadedPage) {
                                    applyZoom(getFitPageScale(containerRef.current, firstLoadedPage, isTwoPage), { mode: "page-fit", preserveMode: true });
                                } else if (v === '100') {
                                    applyZoom(DEFAULT_SCALE, { mode: "custom" });
                                }
                            }}
                            size="sm"
                            variant="default"
                            align="right"
                            openUp
                            showCheckmark={false}
                            className="min-w-[4.25rem]"
                        />
                    </div>
                )}
            </div>
            </PdfLinkHandlersContext.Provider>
        );
    }
));

export default PDFJsEngine;
