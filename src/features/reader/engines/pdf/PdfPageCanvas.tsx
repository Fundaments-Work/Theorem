import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { TextLayer, type PDFPageProxy } from "pdfjs-dist";
import type { Annotation, HighlightColor } from "../../../../core/types";
import { PDFAnnotationLayer } from "../../components/PDFAnnotationLayer";
import { PDFLinkLayer } from "../../components/PDFLinkLayer";
import { viewRotation } from "../pdf-rotation";
import {
    applySearchHighlights,
    calibrateWebKitTextLayerWidth,
    clearSearchHighlights,
    getCanvasPixelRatio,
    getCanvasSizing,
    getCssDimension,
    getPageTextContent,
    PAGE_CANVAS_CLASS,
    PAGE_PRERENDER_MARGIN,
    type PageTextContent,
    PDF_TO_CSS_UNITS,
    registerTextLayer,
    renderedPageCache,
    requestCanvasRenderSlot,
    selectionIntersects,
    TEXT_LAYER_SELECTING_CLASS,
    type TextItemLike,
    unregisterTextLayer,
    waitForNextFrame,
    WEBKIT_CALIBRATION_SECOND_PASS_THRESHOLD,
} from "./pdf-helpers";

export interface PageCanvasProps {
    page: PDFPageProxy;
    scale: number;
    rotation: number;
    isRenderActive: boolean;
    forceRenderActive?: boolean;
    getRenderPriority: (pageNumber: number) => number;
    annotations?: Annotation[];
    annotationMode?: "none" | "highlight" | "pen" | "text" | "erase";
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

export const PageCanvas = memo(function PageCanvas({
    page, scale, rotation, isRenderActive, forceRenderActive = false, getRenderPriority,
    annotations = [], annotationMode = "none", highlightColor, penColor, penWidth,
    enableTextLayer, preferSharpCanvas, reduceRenderQuality, snapCssToPixels, useStreamTextLayer,
    calibrateTextLayerWidths, searchQuery, onAnnotationAdd, onAnnotationChange, onAnnotationRemove,
}: PageCanvasProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    // The canvas is swapped out wholesale after each render (see renderPage), so
    // it lives in a host React never reconciles into.
    const canvasHostRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const textLayerRef = useRef<HTMLDivElement>(null);
    const renderTaskRef = useRef<ReturnType<PDFPageProxy["render"]> | null>(null);
    const textLayerInstanceRef = useRef<TextLayer | null>(null);
    const hasRenderedCanvasRef = useRef(false);
    const [isNearViewport, setIsNearViewport] = useState(() => isRenderActive || forceRenderActive || page.pageNumber <= 3);
    const shouldRenderAnnotationLayer = annotationMode !== "none" || annotations.length > 0;
    const shouldRender = isNearViewport || isRenderActive || forceRenderActive;

    useLayoutEffect(() => {
        const host = canvasHostRef.current;
        if (!host || canvasRef.current) return;
        const canvas = document.createElement("canvas");
        canvas.className = PAGE_CANVAS_CLASS;
        host.appendChild(canvas);
        canvasRef.current = canvas;
    }, []);

    useLayoutEffect(() => {
        const container = containerRef.current;
        const canvas = canvasRef.current;
        const textLayerDiv = textLayerRef.current;
        if (!container || !canvas) return;
        if (enableTextLayer && !textLayerDiv) return;
        const viewport = page.getViewport({ scale: scale * PDF_TO_CSS_UNITS, rotation: viewRotation(page, rotation) });
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

    // Pages that leave the render window go into a bounded LRU instead of being
    // freed on a timer, so scrolling back to them is instant.
    const cacheKeyRef = useRef<object>({});
    const releaseRenderedPage = useCallback(() => {
        const textLayerDiv = textLayerRef.current;
        const canvas = canvasRef.current;
        try { renderTaskRef.current?.cancel(); } catch { }
        renderTaskRef.current = null;
        try { textLayerInstanceRef.current?.cancel(); } catch { }
        textLayerInstanceRef.current = null;
        const keepTextLayer = !!textLayerDiv && selectionIntersects(textLayerDiv);
        if (textLayerDiv && !keepTextLayer) {
            unregisterTextLayer(textLayerDiv);
            textLayerDiv.replaceChildren();
            textLayerKeyRef.current = "";
        }
        if (canvas && hasRenderedCanvasRef.current) {
            canvas.width = 0; canvas.height = 0;
        }
        hasRenderedCanvasRef.current = false;
        canvasGeometryKeyRef.current = "";
        if (!keepTextLayer) page.cleanup();
    }, [page]);

    useEffect(() => {
        const key = cacheKeyRef.current;
        if (shouldRender) {
            renderedPageCache.reclaim(key);
            return;
        }
        if (!hasRenderedCanvasRef.current) return;
        const canvas = canvasRef.current;
        renderedPageCache.retain(key, canvas ? canvas.width * canvas.height : 0, releaseRenderedPage);
    }, [shouldRender, releaseRenderedPage]);

    useEffect(() => () => {
        renderedPageCache.reclaim(cacheKeyRef.current);
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

    // Values read when a render starts; changing them must not restart work that
    // is already correct (a scroll must never tear down canvases or text layers).
    const reduceRenderQualityRef = useRef(reduceRenderQuality);
    reduceRenderQualityRef.current = reduceRenderQuality;
    const getRenderPriorityRef = useRef(getRenderPriority);
    getRenderPriorityRef.current = getRenderPriority;
    const useStreamTextLayerRef = useRef(useStreamTextLayer);
    useStreamTextLayerRef.current = useStreamTextLayer;
    const calibrateTextLayerWidthsRef = useRef(calibrateTextLayerWidths);
    calibrateTextLayerWidthsRef.current = calibrateTextLayerWidths;
    const searchQueryRef = useRef(searchQuery);
    searchQueryRef.current = searchQuery;
    /** page:scale:rotation the canvas was last painted for, and whether at reduced quality. */
    const canvasGeometryKeyRef = useRef("");
    const canvasWasReducedRef = useRef(false);
    const textLayerKeyRef = useRef("");
    // Upgrading a canvas painted at reduced quality mid-scroll happens once,
    // when the interaction ends; nothing is ever downgraded.
    const [qualityEpoch, setQualityEpoch] = useState(0);
    useEffect(() => {
        if (!reduceRenderQuality && canvasWasReducedRef.current) setQualityEpoch((n) => n + 1);
    }, [reduceRenderQuality]);

    // ── Canvas ───────────────────────────────────────────────────────────
    useEffect(() => {
        if (!shouldRender) return;
        let cancelled = false;
        let cancelQueuedRenderSlot: (() => void) | null = null;
        let releaseRenderSlot: (() => void) | null = null;
        if (!canvasRef.current) return;

        const geometryKey = `${page.pageNumber}:${scale.toFixed(4)}:${rotation}`;
        const reduced = reduceRenderQualityRef.current;
        if (hasRenderedCanvasRef.current && canvasGeometryKeyRef.current === geometryKey && (reduced || !canvasWasReducedRef.current)) {
            return;
        }

        const renderCanvas = async () => {
            try { renderTaskRef.current?.cancel(); } catch { }
            renderTaskRef.current = null;
            try {
                const viewport = page.getViewport({ scale: scale * PDF_TO_CSS_UNITS, rotation: viewRotation(page, rotation) });
                const cssWidth = getCssDimension(viewport.width, snapCssToPixels);
                const cssHeight = getCssDimension(viewport.height, snapCssToPixels);
                const outputScale = getCanvasPixelRatio(cssWidth, cssHeight, preferSharpCanvas, scale, reduced);
                const sizing = getCanvasSizing(cssWidth, cssHeight, outputScale);

                containerRef.current?.style.setProperty("--scale-round-x", `${sizing.scaleRoundX}px`);
                containerRef.current?.style.setProperty("--scale-round-y", `${sizing.scaleRoundY}px`);

                const slotRequest = requestCanvasRenderSlot(getRenderPriorityRef.current(page.pageNumber));
                cancelQueuedRenderSlot = slotRequest.cancel;
                releaseRenderSlot = await slotRequest.promise;
                cancelQueuedRenderSlot = null;
                if (cancelled) return;

                // Double-buffered rendering: draw into a detached canvas so the visible one
                // keeps its previous content (CSS-scaled) until the new one is complete,
                // then swap the elements. No full-resolution copy, no doubled memory.
                const offscreen = document.createElement("canvas");
                offscreen.width = sizing.canvasWidth;
                offscreen.height = sizing.canvasHeight;
                const offscreenCtx = offscreen.getContext("2d", { alpha: false });
                if (!offscreenCtx || cancelled) return;

                const renderTask = page.render({
                    canvas: null,
                    canvasContext: offscreenCtx,
                    viewport,
                    transform: [sizing.renderScaleX, 0, 0, sizing.renderScaleY, 0, 0]
                });
                renderTaskRef.current = renderTask;
                await renderTask.promise;
                if (cancelled) { offscreen.width = 0; offscreen.height = 0; return; }

                const visible = canvasRef.current;
                offscreen.className = PAGE_CANVAS_CLASS;
                offscreen.style.width = `${cssWidth}px`;
                offscreen.style.height = `${cssHeight}px`;
                if (visible?.parentNode) {
                    visible.replaceWith(offscreen);
                } else {
                    canvasHostRef.current?.appendChild(offscreen);
                }
                canvasRef.current = offscreen;
                if (visible && visible !== offscreen) {
                    visible.width = 0;
                    visible.height = 0;
                }

                hasRenderedCanvasRef.current = true;
                canvasGeometryKeyRef.current = geometryKey;
                canvasWasReducedRef.current = reduced;
                renderTaskRef.current = null;
            } catch (error: unknown) {
                const isCancelled = error instanceof Error && (error.message.includes("cancelled") || error.message.includes("Rendering cancelled"));
                if (!isCancelled) { }
            } finally {
                cancelQueuedRenderSlot?.(); cancelQueuedRenderSlot = null;
                releaseRenderSlot?.(); releaseRenderSlot = null;
            }
        };

        void renderCanvas();

        return () => {
            cancelled = true;
            cancelQueuedRenderSlot?.();
            releaseRenderSlot?.();
            try { renderTaskRef.current?.cancel(); } catch { }
        };
    }, [page, scale, rotation, shouldRender, preferSharpCanvas, snapCssToPixels, qualityEpoch]);

    // ── Text layer ───────────────────────────────────────────────────────
    const textLayerActive = enableTextLayer && shouldRender;
    useEffect(() => {
        const textLayerDiv = textLayerRef.current;
        if (!textLayerDiv || !textLayerActive) return;
        const layerKey = `${page.pageNumber}:${scale.toFixed(4)}:${rotation}`;
        if (textLayerKeyRef.current === layerKey && textLayerDiv.childElementCount > 0) return;
        let cancelled = false;

        const buildTextLayer = async () => {
            try { textLayerInstanceRef.current?.cancel(); } catch { }
            textLayerInstanceRef.current = null;
            const viewport = page.getViewport({ scale: scale * PDF_TO_CSS_UNITS, rotation: viewRotation(page, rotation) });
            containerRef.current?.style.setProperty("--scale-factor", `${viewport.scale}`);
            containerRef.current?.style.setProperty("--total-scale-factor", `${viewport.scale}`);

            if (textLayerDiv.dataset.textSelectionBound !== "1") {
                textLayerDiv.tabIndex = 0;
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
                const calibrate = calibrateTextLayerWidthsRef.current;
                let textItemsForCalibration: TextItemLike[] | null = null;
                let textContentSource: PageTextContent | ReturnType<PDFPageProxy["streamTextContent"]>;
                if (useStreamTextLayerRef.current && !calibrate) {
                    textContentSource = page.streamTextContent({ includeMarkedContent: true, disableNormalization: true });
                } else {
                    const textContent = await getPageTextContent(page);
                    textContentSource = textContent;
                    textItemsForCalibration = (textContentSource.items as unknown as TextItemLike[]) ?? null;
                }
                if (cancelled) return;

                // Build off-DOM, then swap in one step: the old layer (and any
                // selection in it) stays intact until the new one is ready.
                const nextLayer = document.createElement("div");
                const textLayer = new TextLayer({ textContentSource, container: nextLayer, viewport });
                textLayerInstanceRef.current = textLayer;
                await textLayer.render();
                if (cancelled) return;

                unregisterTextLayer(textLayerDiv);
                textLayerDiv.replaceChildren(...nextLayer.childNodes);
                const endOfContent = document.createElement("div");
                endOfContent.className = "endOfContent";
                textLayerDiv.append(endOfContent);
                registerTextLayer(textLayerDiv, endOfContent);
                textLayerKeyRef.current = layerKey;

                if (calibrate && textItemsForCalibration) {
                    const renderedSpans = textLayer.textDivs as unknown as HTMLSpanElement[];
                    const firstPassMaxDeviation = calibrateWebKitTextLayerWidth(renderedSpans, textItemsForCalibration, viewport.scale);
                    if (firstPassMaxDeviation >= WEBKIT_CALIBRATION_SECOND_PASS_THRESHOLD) {
                        await waitForNextFrame();
                        if (!cancelled) calibrateWebKitTextLayerWidth(renderedSpans, textItemsForCalibration, viewport.scale);
                    }
                }
                const query = searchQueryRef.current;
                if (query) applySearchHighlights(textLayerDiv, query);
            } catch (textError) {
                const isAbortError = textError instanceof Error && (textError.name === "AbortException" || textError.message.toLowerCase().includes("abort") || textError.message.toLowerCase().includes("cancel"));
                if (!isAbortError) { }
            }
        };

        void buildTextLayer();

        return () => {
            cancelled = true;
            try { textLayerInstanceRef.current?.cancel(); } catch { }
        };
    }, [page, scale, rotation, textLayerActive]);

    // Leaving the text-layer window drops the layer, unless it holds the
    // user's selection: scrolling must never wipe what they selected.
    useEffect(() => {
        const textLayerDiv = textLayerRef.current;
        if (!textLayerDiv || textLayerActive) return;
        if (selectionIntersects(textLayerDiv)) return;
        unregisterTextLayer(textLayerDiv);
        textLayerDiv.replaceChildren();
        textLayerKeyRef.current = "";
    }, [textLayerActive]);

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
            <div ref={canvasHostRef} className="absolute inset-0" />
            {/* Always mounted: React must never remove a layer that holds the
                user's selection. Its contents are managed by the effects above. */}
            <div ref={textLayerRef} className="textLayer" />
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
