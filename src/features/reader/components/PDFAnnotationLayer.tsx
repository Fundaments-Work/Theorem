import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    HIGHLIGHT_COLORS,
    getHighlightSolidColor,
} from "../../../core/lib/design-tokens";
import { cn } from "../../../core/lib/utils";
import type { Annotation, HighlightColor } from "../../../core/types";

interface Point {
    x: number;
    y: number;
}

interface TextNoteEditorState {
    annotationId?: string;
    x: number;
    y: number;
    value: string;
}

interface PDFAnnotationLayerProps {
    pageNumber: number;
    annotations: Annotation[];
    mode: "none" | "highlight" | "pen" | "text" | "erase";
    scale: number;
    highlightColor: HighlightColor;
    penColor: HighlightColor;
    penWidth: number;
    onAnnotationAdd: (annotation: Partial<Annotation>) => void;
    onAnnotationChange?: (annotation: Annotation) => void;
    onAnnotationRemove: (id: string) => void;
}

const PDF_HIGHLIGHT_COLORS: Record<HighlightColor, string> = HIGHLIGHT_COLORS;

function getAnnotationRects(annotation: Annotation): Array<{ x: number; y: number; width: number; height: number }> {
    if (annotation.rects && annotation.rects.length > 0) {
        return annotation.rects;
    }
    if (annotation.rect) {
        return [annotation.rect];
    }
    return [];
}

function getHighlightFill(color?: HighlightColor): string {
    const key = color || "yellow";
    return PDF_HIGHLIGHT_COLORS[key] || PDF_HIGHLIGHT_COLORS.yellow;
}

function pointInRect(point: Point, rect: { x: number; y: number; width: number; height: number }, padding: number): boolean {
    return (
        point.x >= rect.x - padding
        && point.y >= rect.y - padding
        && point.x <= rect.x + rect.width + padding
        && point.y <= rect.y + rect.height + padding
    );
}

function pointToSegmentDistance(point: Point, start: Point, end: Point): number {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    if (dx === 0 && dy === 0) {
        return Math.hypot(point.x - start.x, point.y - start.y);
    }

    const projection = ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy);
    const t = Math.max(0, Math.min(1, projection));
    const closestX = start.x + t * dx;
    const closestY = start.y + t * dy;
    return Math.hypot(point.x - closestX, point.y - closestY);
}

function isPointNearPolyline(point: Point, points: Point[], tolerance: number): boolean {
    if (points.length < 2) {
        return false;
    }
    for (let i = 1; i < points.length; i += 1) {
        if (pointToSegmentDistance(point, points[i - 1], points[i]) <= tolerance) {
            return true;
        }
    }
    return false;
}

export function PDFAnnotationLayer({
    pageNumber,
    annotations,
    mode,
    scale,
    highlightColor,
    penColor,
    penWidth,
    onAnnotationAdd,
    onAnnotationChange,
    onAnnotationRemove,
}: PDFAnnotationLayerProps) {
    const layerRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const activePointerIdRef = useRef<number | null>(null);
    const currentPathRef = useRef<Point[]>([]);
    const highlightDedupRef = useRef<string>("");
    const textEditorRef = useRef<HTMLTextAreaElement>(null);
    const [isDrawing, setIsDrawing] = useState(false);
    const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
    const [textNoteEditor, setTextNoteEditor] = useState<TextNoteEditorState | null>(null);
    const textNoteEditorFocusKey = textNoteEditor
        ? `${textNoteEditor.annotationId || "new"}:${textNoteEditor.x.toFixed(2)}:${textNoteEditor.y.toFixed(2)}`
        : null;

    const pageAnnotations = useMemo(
        () => annotations.filter((annotation) => annotation.pageNumber === pageNumber),
        [annotations, pageNumber],
    );

    const syncCanvasSize = useCallback(() => {
        const layerNode = layerRef.current;
        if (!layerNode) {
            return;
        }
        const width = Math.max(1, Math.round(layerNode.clientWidth));
        const height = Math.max(1, Math.round(layerNode.clientHeight));
        setCanvasSize((currentSize) => {
            if (currentSize.width === width && currentSize.height === height) {
                return currentSize;
            }
            return { width, height };
        });
    }, []);

    useEffect(() => {
        syncCanvasSize();

        const layerNode = layerRef.current;
        if (!layerNode) {
            return;
        }
        if (typeof ResizeObserver === "undefined") {
            window.addEventListener("resize", syncCanvasSize);
            return () => {
                window.removeEventListener("resize", syncCanvasSize);
            };
        }

        const resizeObserver = new ResizeObserver(() => {
            syncCanvasSize();
        });
        resizeObserver.observe(layerNode);

        return () => {
            resizeObserver.disconnect();
        };
    }, [syncCanvasSize]);

    useEffect(() => {
        if (!textNoteEditorFocusKey) {
            return;
        }
        const frame = window.requestAnimationFrame(() => {
            textEditorRef.current?.focus();
        });
        return () => {
            window.cancelAnimationFrame(frame);
        };
    }, [textNoteEditorFocusKey]);

    useEffect(() => {
        if (mode !== "text") {
            setTextNoteEditor(null);
        }
    }, [mode]);

    const clearTempCanvas = useCallback(() => {
        const context = canvasRef.current?.getContext("2d");
        if (!context) {
            return;
        }
        context.clearRect(0, 0, context.canvas.width, context.canvas.height);
        context.beginPath();
    }, []);

    const getLocalPoint = useCallback((event: React.PointerEvent<HTMLElement>): Point | null => {
        const layerNode = layerRef.current;
        if (!layerNode || scale <= 0) {
            return null;
        }
        const rect = layerNode.getBoundingClientRect();
        return {
            x: (event.clientX - rect.left) / scale,
            y: (event.clientY - rect.top) / scale,
        };
    }, [scale]);

    const startDrawing = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        const localPoint = getLocalPoint(event);
        if (!localPoint) {
            return;
        }

        activePointerIdRef.current = event.pointerId;
        event.currentTarget.setPointerCapture(event.pointerId);
        setIsDrawing(true);
        currentPathRef.current = [localPoint];

        const context = canvasRef.current?.getContext("2d");
        if (!context) {
            return;
        }
        context.clearRect(0, 0, context.canvas.width, context.canvas.height);
        context.beginPath();
        context.moveTo(localPoint.x * scale, localPoint.y * scale);
    }, [getLocalPoint, scale]);

    const continueDrawing = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        if (!isDrawing || activePointerIdRef.current !== event.pointerId) {
            return;
        }
        const localPoint = getLocalPoint(event);
        if (!localPoint) {
            return;
        }

        currentPathRef.current.push(localPoint);
        const context = canvasRef.current?.getContext("2d");
        if (!context) {
            return;
        }
        context.lineWidth = penWidth * scale;
        context.lineCap = "round";
        context.lineJoin = "round";
        context.strokeStyle = getHighlightSolidColor(penColor);
        context.lineTo(localPoint.x * scale, localPoint.y * scale);
        context.stroke();
    }, [getLocalPoint, isDrawing, penColor, penWidth, scale]);

    const finishDrawing = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        if (activePointerIdRef.current !== null && activePointerIdRef.current === event.pointerId) {
            try {
                event.currentTarget.releasePointerCapture(event.pointerId);
            } catch {
                
            }
        }

        if (!isDrawing) {
            activePointerIdRef.current = null;
            return;
        }

        setIsDrawing(false);
        activePointerIdRef.current = null;

        if (currentPathRef.current.length > 1) {
            onAnnotationAdd({
                type: "note",
                pdfAnnotationType: "drawing",
                drawingData: JSON.stringify(currentPathRef.current),
                pageNumber,
                location: `pdf:page:${pageNumber}`,
                selectedText: "Freehand annotation",
                color: penColor,
                strokeWidth: penWidth,
            });
        }

        currentPathRef.current = [];
        clearTempCanvas();
    }, [clearTempCanvas, isDrawing, onAnnotationAdd, pageNumber, penColor, penWidth]);

    const openTextNoteEditor = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        const localPoint = getLocalPoint(event);
        if (!localPoint) {
            return;
        }
        setTextNoteEditor({
            x: localPoint.x,
            y: localPoint.y,
            value: "",
        });
    }, [getLocalPoint]);

    const openExistingTextNoteEditor = useCallback((annotation: Annotation) => {
        if (!annotation.rect) {
            return;
        }
        setTextNoteEditor({
            annotationId: annotation.id,
            x: annotation.rect.x,
            y: annotation.rect.y,
            value: annotation.textNoteContent || annotation.noteContent || "",
        });
    }, []);

    const saveTextNoteEditor = useCallback(() => {
        if (!textNoteEditor) {
            return;
        }

        const trimmedText = textNoteEditor.value.trim();
        const existingAnnotation = textNoteEditor.annotationId
            ? pageAnnotations.find((annotation) => annotation.id === textNoteEditor.annotationId)
            : undefined;

        if (!trimmedText) {
            if (existingAnnotation) {
                onAnnotationRemove(existingAnnotation.id);
            }
            setTextNoteEditor(null);
            return;
        }

        const baseRect = existingAnnotation?.rect || {
            x: textNoteEditor.x,
            y: textNoteEditor.y,
            width: 18 / Math.max(scale, 0.01),
            height: 18 / Math.max(scale, 0.01),
        };

        if (existingAnnotation) {
            const updatedAnnotation: Annotation = {
                ...existingAnnotation,
                textNoteContent: trimmedText,
                noteContent: trimmedText,
                selectedText: trimmedText,
                color: existingAnnotation.color || penColor,
                rect: baseRect,
                updatedAt: new Date(),
            };
            if (onAnnotationChange) {
                onAnnotationChange(updatedAnnotation);
            } else {
                onAnnotationAdd(updatedAnnotation);
            }
        } else {
            onAnnotationAdd({
                type: "note",
                pdfAnnotationType: "textNote",
                textNoteContent: trimmedText,
                noteContent: trimmedText,
                selectedText: trimmedText,
                pageNumber,
                location: `pdf:page:${pageNumber}`,
                color: penColor,
                rect: baseRect,
            });
        }

        setTextNoteEditor(null);
    }, [
        onAnnotationAdd,
        onAnnotationChange,
        onAnnotationRemove,
        pageAnnotations,
        pageNumber,
        penColor,
        scale,
        textNoteEditor,
    ]);

    const eraseAnnotationAtPoint = useCallback((point: Point) => {
        const padding = 3 / Math.max(scale, 0.01);

        for (let index = pageAnnotations.length - 1; index >= 0; index -= 1) {
            const annotation = pageAnnotations[index];

            if (annotation.pdfAnnotationType === "highlight") {
                const rects = getAnnotationRects(annotation);
                const hasHit = rects.some((rect) => pointInRect(point, rect, padding));
                if (hasHit) {
                    onAnnotationRemove(annotation.id);
                    return;
                }
            }

            if (annotation.pdfAnnotationType === "drawing" && annotation.drawingData) {
                try {
                    const points = JSON.parse(annotation.drawingData) as Point[];
                    const strokeWidth = annotation.strokeWidth ?? 2;
                    const tolerance = strokeWidth + (4 / Math.max(scale, 0.01));
                    if (isPointNearPolyline(point, points, tolerance)) {
                        onAnnotationRemove(annotation.id);
                        return;
                    }
                } catch {
                    continue;
                }
            }
        }
    }, [onAnnotationRemove, pageAnnotations, scale]);

    const captureHighlightFromSelection = useCallback(() => {
        if (mode !== "highlight") {
            return;
        }
        const layerNode = layerRef.current;
        if (!layerNode || scale <= 0) {
            return;
        }
        const textLayerNode = layerNode.parentElement?.querySelector<HTMLDivElement>(".textLayer");
        if (!textLayerNode) {
            return;
        }

        const selection = document.getSelection();
        if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
            return;
        }

        const range = selection.getRangeAt(0);
        try {
            if (!range.intersectsNode(textLayerNode)) {
                return;
            }
        } catch {
            return;
        }

        let pageRange: Range;
        try {
            const nodeRange = document.createRange();
            nodeRange.selectNodeContents(textLayerNode);

            const startCmp = range.compareBoundaryPoints(Range.START_TO_START, nodeRange);
            const startContainer = startCmp < 0 ? nodeRange.startContainer : range.startContainer;
            const startOffset = startCmp < 0 ? nodeRange.startOffset : range.startOffset;

            const endCmp = range.compareBoundaryPoints(Range.END_TO_END, nodeRange);
            const endContainer = endCmp > 0 ? nodeRange.endContainer : range.endContainer;
            const endOffset = endCmp > 0 ? nodeRange.endOffset : range.endOffset;

            pageRange = document.createRange();
            pageRange.setStart(startContainer, startOffset);
            pageRange.setEnd(endContainer, endOffset);
        } catch {
            pageRange = range;
        }

        const selectedText = pageRange.toString().trim();
        if (!selectedText) {
            return;
        }

        const layerRect = layerNode.getBoundingClientRect();
        const EPSILON = 2;
        const rects = Array.from(pageRange.getClientRects())
            .filter((rect) => (
                rect.bottom >= layerRect.top - EPSILON &&
                rect.top <= layerRect.bottom + EPSILON &&
                rect.right >= layerRect.left - EPSILON &&
                rect.left <= layerRect.right + EPSILON
            ))
            .map((rect) => ({
                x: (rect.left - layerRect.left) / scale,
                y: (rect.top - layerRect.top) / scale,
                width: rect.width / scale,
                height: rect.height / scale,
            }))
            .filter((rect) => rect.width > 1 / scale && rect.height > 1 / scale);

        if (rects.length === 0) {
            return;
        }

        const firstRect = rects[0];
        const dedupKey = `${selectedText.slice(0, 80)}:${firstRect.x.toFixed(2)}:${firstRect.y.toFixed(2)}:${rects.length}`;
        if (highlightDedupRef.current === dedupKey) {
            return;
        }
        highlightDedupRef.current = dedupKey;
        window.setTimeout(() => {
            if (highlightDedupRef.current === dedupKey) {
                highlightDedupRef.current = "";
            }
        }, 250);

        onAnnotationAdd({
            type: "highlight",
            pdfAnnotationType: "highlight",
            pageNumber,
            location: `pdf:page:${pageNumber}`,
            selectedText,
            color: highlightColor,
            rects,
        });

        // Defer clearing selection so adjacent pages can capture their portion of a cross-page selection
        window.setTimeout(() => {
            const currentSel = window.getSelection();
            if (currentSel && !currentSel.isCollapsed) {
                currentSel.removeAllRanges();
            }
        }, 80);
    }, [highlightColor, mode, onAnnotationAdd, pageNumber, scale]);

    useEffect(() => {
        if (mode !== "highlight") {
            return;
        }

        const scheduleHighlightCapture = () => {
            window.requestAnimationFrame(() => {
                captureHighlightFromSelection();
            });
        };

        document.addEventListener("pointerup", scheduleHighlightCapture, true);
        document.addEventListener("keyup", scheduleHighlightCapture, true);

        return () => {
            document.removeEventListener("pointerup", scheduleHighlightCapture, true);
            document.removeEventListener("keyup", scheduleHighlightCapture, true);
        };
    }, [captureHighlightFromSelection, mode]);

    const handleLayerPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        if (event.button !== 0) {
            return;
        }

        if (mode === "pen") {
            event.preventDefault();
            event.stopPropagation();
            startDrawing(event);
            return;
        }

        if (mode === "text") {
            event.preventDefault();
            event.stopPropagation();
            openTextNoteEditor(event);
            return;
        }

        if (mode === "erase") {
            event.preventDefault();
            event.stopPropagation();
            const localPoint = getLocalPoint(event);
            if (!localPoint) {
                return;
            }
            eraseAnnotationAtPoint(localPoint);
        }
    }, [eraseAnnotationAtPoint, getLocalPoint, mode, openTextNoteEditor, startDrawing]);

    const handleLayerPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        if (mode === "pen") {
            event.preventDefault();
            event.stopPropagation();
            continueDrawing(event);
            return;
        }

        if (mode === "erase" && (event.buttons & 1) === 1) {
            event.preventDefault();
            event.stopPropagation();
            const localPoint = getLocalPoint(event);
            if (!localPoint) {
                return;
            }
            eraseAnnotationAtPoint(localPoint);
        }
    }, [continueDrawing, eraseAnnotationAtPoint, getLocalPoint, mode]);

    const handleLayerPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        if (mode !== "pen") {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        finishDrawing(event);
    }, [finishDrawing, mode]);

    const handleLayerPointerCancel = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        if (mode !== "pen") {
            return;
        }
        finishDrawing(event);
    }, [finishDrawing, mode]);

    const noteEditorPosition = useMemo(() => {
        if (!textNoteEditor) {
            return null;
        }

        const editorWidth = Math.min(300, Math.max(190, Math.round(canvasSize.width * 0.28)));
        const editorHeight = 132;
        const margin = 8;
        const desiredLeft = (textNoteEditor.x * scale) + 14;
        const desiredTop = (textNoteEditor.y * scale) + 18;
        const maxLeft = Math.max(margin, canvasSize.width - editorWidth - margin);
        const maxTop = Math.max(margin, canvasSize.height - editorHeight - margin);

        return {
            left: Math.min(Math.max(margin, desiredLeft), maxLeft),
            top: Math.min(Math.max(margin, desiredTop), maxTop),
            width: editorWidth,
        };
    }, [canvasSize.height, canvasSize.width, scale, textNoteEditor]);

    return (
        <div
            ref={layerRef}
            className={cn(
                "absolute inset-0 z-20",
                mode === "pen" && "cursor-crosshair touch-none",
                mode === "text" && "cursor-copy touch-none",
                mode === "erase" && "cursor-not-allowed touch-none",
                (mode === "none" || mode === "highlight") && "pointer-events-none",
            )}
            onPointerDown={handleLayerPointerDown}
            onPointerMove={handleLayerPointerMove}
            onPointerUp={handleLayerPointerUp}
            onPointerCancel={handleLayerPointerCancel}
            onPointerLeave={handleLayerPointerCancel}
        >
            <canvas
                ref={canvasRef}
                className={cn(
                    "absolute inset-0 w-full h-full pointer-events-none",
                    mode === "pen" ? "opacity-100" : "opacity-0",
                )}
                width={canvasSize.width}
                height={canvasSize.height}
            />

            {pageAnnotations.map((annotation) => {
                if (annotation.pdfAnnotationType === "highlight") {
                    const rects = getAnnotationRects(annotation);
                    return rects.map((rect, index) => (
                        <div
                            key={`${annotation.id}-${index}`}
                            title={annotation.selectedText || "Highlight"}
                            className="absolute pointer-events-none"
                            style={{
                                left: `${rect.x * scale}px`,
                                top: `${(rect.y + Math.min(rect.height * 0.16, 1.4 / Math.max(scale, 0.01))) * scale}px`,
                                width: `${rect.width * scale}px`,
                                height: `${Math.max(
                                    (rect.height - (Math.min(rect.height * 0.16, 1.4 / Math.max(scale, 0.01)) * 2)),
                                    1 / Math.max(scale, 0.01),
                                ) * scale}px`,
                                backgroundColor: getHighlightFill(annotation.color),
                                mixBlendMode: "multiply",
                            }}
                        />
                    ));
                }

                if (annotation.pdfAnnotationType === "drawing" && annotation.drawingData) {
                    let points: Point[] = [];
                    try {
                        points = JSON.parse(annotation.drawingData) as Point[];
                    } catch {
                        return null;
                    }
                    if (!Array.isArray(points) || points.length < 2) {
                        return null;
                    }

                    const pathData = points
                        .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x * scale} ${point.y * scale}`)
                        .join(" ");
                    const strokeWidth = (annotation.strokeWidth ?? 2) * scale;
                    const strokeColor = getHighlightSolidColor(annotation.color || penColor);

                    return (
                        <svg key={annotation.id} className="absolute inset-0 w-full h-full pointer-events-none">
                            <path
                                d={pathData}
                                stroke={strokeColor}
                                strokeWidth={strokeWidth}
                                fill="none"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                pointerEvents="none"
                            />
                        </svg>
                    );
                }

                if (annotation.pdfAnnotationType === "textNote" && annotation.rect) {
                    const noteRect = annotation.rect;
                    const iconSize = Math.max(14, 18 * Math.min(1.3, Math.max(0.8, scale)));
                    const left = noteRect.x * scale;
                    const top = noteRect.y * scale;
                    const noteText = annotation.textNoteContent || annotation.noteContent || "";

                    return (
                        <button
                            key={annotation.id}
                            type="button"
                            title={noteText || "Note"}
                            className="absolute border shadow-sm flex items-center justify-center"
                            style={{
                                left: `${left}px`,
                                top: `${top}px`,
                                width: `${iconSize}px`,
                                height: `${iconSize}px`,
                                backgroundColor: getHighlightSolidColor(annotation.color || penColor),
                                color: "var(--color-text-inverse)",
                                borderColor: "var(--color-overlay-medium)",
                                pointerEvents: mode === "text" ? "auto" : "none",
                            }}
                            onPointerDown={(event) => {
                                event.stopPropagation();
                            }}
                            onClick={() => {
                                if (mode === "text") {
                                    openExistingTextNoteEditor(annotation);
                                }
                            }}
                        >
                            <span className="text-[var(--font-size-4xs)] leading-none font-semibold">T</span>
                        </button>
                    );
                }

                return null;
            })}

            {textNoteEditor && noteEditorPosition && (
                <div
                    className="absolute border shadow-lg z-30 p-4"
                    style={{
                        left: `${noteEditorPosition.left}px`,
                        top: `${noteEditorPosition.top}px`,
                        width: `${noteEditorPosition.width}px`,
                        backgroundColor: "var(--color-surface)",
                        borderColor: "var(--color-border)",
                        borderRadius: "var(--radius-md, 6px)",
                    }}
                    onPointerDown={(event) => {
                        event.stopPropagation();
                    }}
                >
                    <textarea
                        ref={textEditorRef}
                        value={textNoteEditor.value}
                        onChange={(event) => {
                            const nextValue = event.target.value;
                            setTextNoteEditor((currentState) => {
                                if (!currentState) {
                                    return currentState;
                                }
                                return {
                                    ...currentState,
                                    value: nextValue,
                                };
                            });
                        }}
                        onKeyDown={(event) => {
                            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                                event.preventDefault();
                                saveTextNoteEditor();
                            }
                            if (event.key === "Escape") {
                                event.preventDefault();
                                setTextNoteEditor(null);
                            }
                        }}
                        className="w-full min-h-[var(--layout-annotation-editor-min-height)] resize-none border text-xs p-2.5 focus:outline-none focus:border-[var(--color-accent)] transition-colors"
                        placeholder="Write a note..."
                        style={{
                            color: "var(--color-text-primary)",
                            backgroundColor: "var(--color-background)",
                            borderColor: "var(--color-border)",
                            borderRadius: "var(--radius-sm, 4px)",
                        }}
                    />
                    <div className="mt-3 flex items-center justify-end gap-2">
                        <button
                            type="button"
                            className="px-3 py-1.5 text-[11px] font-medium border border-[var(--color-border)] hover:bg-[var(--color-surface-muted)] transition-colors"
                            style={{
                                color: "var(--color-text-secondary)",
                                borderRadius: "var(--radius-sm, 4px)",
                            }}
                            onClick={() => setTextNoteEditor(null)}
                        >
                            Cancel
                        </button>
                        <button
                            type="button"
                            className="px-3 py-1.5 text-[11px] font-medium bg-[var(--color-accent)] text-[var(--color-accent-contrast)] hover:opacity-90 transition-opacity"
                            style={{
                                borderRadius: "var(--radius-sm, 4px)",
                            }}
                            onClick={saveTextNoteEditor}
                        >
                            Save
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
