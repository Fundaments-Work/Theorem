
import {
    useRef,
    useState,
    useEffect,
    useCallback,
    forwardRef,
    useImperativeHandle,
    memo,
} from "react";
import { AlertCircle } from "lucide-react";
import { PDFJsEngine, type PDFJsEngineRef, type PDFDocumentInfo } from "../engines/pdfjs-engine";
import { cn } from "../../../core/lib/utils";
import type { ReaderTheme, Annotation, HighlightColor, PdfZoomMode } from "../../../core/types";

interface PDFReaderProps {
    
    pdfPath: string;
    
    pdfData?: Uint8Array;
    
    originalFilename?: string;
    
    initialPage?: number;
    
    initialZoom?: number;
    
    initialZoomMode?: PdfZoomMode;
    
    presentationMode?: 'scroll' | 'paged' | 'two-page';
    
    onPresentationModeChange?: (mode: 'scroll' | 'paged' | 'two-page') => void;
    
    theme?: ReaderTheme;
    
    brightness?: number;
    
    onPageChange?: (page: number, totalPages: number, scale: number) => void;
    
    onLoad?: (info: PDFDocumentInfo) => void;
    
    onError?: (error: Error) => void;
    
    onViewportTap?: () => void;
    
    annotations?: Annotation[];
    annotationMode?: 'none' | 'highlight' | 'pen' | 'text' | 'erase';
    highlightColor?: HighlightColor;
    penColor?: HighlightColor;
    penWidth?: number;
    onAnnotationAdd?: (annotation: Partial<Annotation>) => void;
    onAnnotationChange?: (annotation: Annotation) => void;
    onAnnotationRemove?: (id: string) => void;
    onZoomModeChange?: (mode: PdfZoomMode) => void;
    showControls?: boolean;
}

function ErrorState({
    error,
    onRetry,
}: {
    error: string;
    onRetry?: () => void;
}) {
    const displayError = error.replace(/\s+/g, " ").trim();

    return (
        <div className="absolute inset-0 flex items-center justify-center bg-[var(--color-surface)] z-20">
            <div className="mx-auto w-full max-w-[26rem] min-w-0 flex flex-col items-center gap-4 text-center p-8">
                <div
                    className="w-16 h-16 flex items-center justify-center"
                    style={{
                        backgroundColor: "color-mix(in srgb, var(--color-error) 14%, var(--color-surface))",
                    }}
                >
                    <AlertCircle
                        className="w-8 h-8"
                        style={{ color: "var(--color-error)" }}
                    />
                </div>
                <h3 className="w-full break-words text-balance text-lg font-medium text-[color:var(--color-text-primary)]">
                    Failed to load PDF
                </h3>
                <p className="mx-auto w-full max-w-[24rem] break-words text-sm text-[color:var(--color-text-secondary)] leading-relaxed">{displayError}</p>
                {onRetry && (
                    <button
                        onClick={onRetry}
                        className={cn(
                            "min-w-[10.5rem] whitespace-nowrap mt-4 px-4 py-2",
                            "bg-[var(--color-accent)] text-[color:var(--color-accent-contrast)]",
                            "hover:bg-[var(--color-accent-hover)]",
                            "transition-colors text-sm font-medium"
                        )}
                    >
                        Try Again
                    </button>
                )}
            </div>
        </div>
    );
}

export const PDFReader = memo(forwardRef<PDFJsEngineRef, PDFReaderProps>(
    function PDFReader(
        {
            pdfPath,
            pdfData,
            originalFilename,
            initialPage,
            initialZoom,
            initialZoomMode,
            presentationMode = 'scroll',
            onPresentationModeChange,
            brightness = 100,
            onPageChange,
            onLoad,
            onError,
            onViewportTap,
            annotations,
            annotationMode,
            highlightColor = "yellow",
            penColor = "blue",
            penWidth = 2,
            onAnnotationAdd,
            onAnnotationChange,
            onAnnotationRemove,
            onZoomModeChange,
            showControls = true,
        },
        ref
    ) {
        
        const engineRef = useRef<PDFJsEngineRef>(null);

        const [error, setError] = useState<string | null>(null);
        const [currentPage, setCurrentPage] = useState(initialPage ?? 1);
        const [totalPages, setTotalPages] = useState(0);
        const [scale, setScale] = useState(initialZoom ?? 1);

        useEffect(() => {
            setCurrentPage(initialPage ?? 1);
        }, [initialPage]);

        useEffect(() => {
            setScale(initialZoom ?? 1);
        }, [initialZoom]);

        useImperativeHandle(ref, () => ({
            goToPage: (page: number) => engineRef.current?.goToPage(page),
            nextPage: () => engineRef.current?.nextPage(),
            prevPage: () => engineRef.current?.prevPage(),
            zoomIn: () => {
                engineRef.current?.zoomIn();
                const newScale = engineRef.current?.getZoom() ?? 1;
                setScale(newScale);
                onPageChange?.(currentPage, totalPages, newScale);
            },
            zoomOut: () => {
                engineRef.current?.zoomOut();
                const newScale = engineRef.current?.getZoom() ?? 1;
                setScale(newScale);
                onPageChange?.(currentPage, totalPages, newScale);
            },
            zoomReset: () => {
                engineRef.current?.zoomReset();
                setScale(1);
                onPageChange?.(currentPage, totalPages, 1);
            },
            setZoom: (s: number) => {
                engineRef.current?.setZoom(s);
                setScale(s);
                onPageChange?.(currentPage, totalPages, s);
            },
            getZoom: () => engineRef.current?.getZoom() ?? 1,
            getCurrentPage: () => engineRef.current?.getCurrentPage() ?? 1,
            getTotalPages: () => engineRef.current?.getTotalPages() ?? 0,
            rotateClockwise: () => engineRef.current?.rotateClockwise(),
            rotateCounterClockwise: () => engineRef.current?.rotateCounterClockwise(),
            zoomFitPage: () => {
                engineRef.current?.zoomFitPage();
                const newScale = engineRef.current?.getZoom() ?? 1;
                setScale(newScale);
                onPageChange?.(currentPage, totalPages, newScale);
            },
            zoomFitWidth: () => {
                engineRef.current?.zoomFitWidth();
                const newScale = engineRef.current?.getZoom() ?? 1;
                setScale(newScale);
                onPageChange?.(currentPage, totalPages, newScale);
            },
            search: (query: string) => engineRef.current?.search(query) || (async function* () {
                yield "done" as const;
            })(),
            clearSearch: () => engineRef.current?.clearSearch(),
            setPresentationMode: (mode: 'scroll' | 'paged' | 'two-page') => engineRef.current?.setPresentationMode(mode),
            getPresentationMode: () => engineRef.current?.getPresentationMode() ?? 'scroll',
        }));

        const handlePageChange = useCallback(
            (page: number, total: number, reportedScale: number) => {
                setCurrentPage(page);
                setTotalPages(total);
                setScale(reportedScale);
                onPageChange?.(page, total, reportedScale);
            },
            [onPageChange]
        );

        const handleLoad = useCallback(
            (info: PDFDocumentInfo) => {
                setTotalPages(info.totalPages);
                const loadedScale = engineRef.current?.getZoom() ?? scale;
                const loadedPage = engineRef.current?.getCurrentPage() ?? 1;
                onPageChange?.(loadedPage, info.totalPages, loadedScale);
                onLoad?.(info);
            },
            [onLoad, onPageChange, scale]
        );

        const handleError = useCallback(
            (err: Error) => {
                setError(err.message);
                onError?.(err);
            },
            [onError]
        );

        return (
            <div
                className="flex flex-col h-full w-full overflow-hidden transition-colors duration-200"
                style={{ filter: `brightness(${brightness}%)` }}
            >
                
                <div className="flex-1 relative overflow-hidden">
                    
                    {error && <ErrorState error={error} />}

                    <PDFJsEngine
                        ref={engineRef}
                        pdfPath={pdfPath}
                        pdfData={pdfData}
                        originalFilename={originalFilename}
                        initialPage={initialPage}
                        initialZoom={initialZoom}
                        initialZoomMode={initialZoomMode}
                        presentationMode={presentationMode}
                        onPresentationModeChange={onPresentationModeChange}
                        onPageChange={handlePageChange}
                        onZoomModeChange={onZoomModeChange}
                        onLoad={handleLoad}
                        onError={handleError}
                        onViewportTap={onViewportTap}
                        annotations={annotations}
                        annotationMode={annotationMode}
                        highlightColor={highlightColor}
                        penColor={penColor}
                        penWidth={penWidth}
                        onAnnotationAdd={onAnnotationAdd}
                        onAnnotationChange={onAnnotationChange}
                        onAnnotationRemove={onAnnotationRemove}
                        showControls={showControls}
                        className="w-full h-full"
                    />
                </div>
            </div>
        );
    }
));

export default PDFReader;
export type { PDFReaderProps };
