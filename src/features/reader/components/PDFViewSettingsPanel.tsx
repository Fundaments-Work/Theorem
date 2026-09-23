import { BookOpen, FileText, Maximize2, RotateCw, Scroll, SlidersHorizontal, X, ZoomIn, ZoomOut } from "lucide-react";
import { cn } from "../../../core/lib/utils";
import type { PdfZoomMode } from "../../../core/types";
import { Backdrop, FloatingPanel } from "../../../ui";

interface PDFViewSettingsPanelProps {
    visible: boolean;
    zoom: number;
    zoomMode: PdfZoomMode;
    presentationMode?: 'scroll' | 'paged' | 'two-page';
    onClose: () => void;
    onZoomIn: () => void;
    onZoomOut: () => void;
    onZoomReset: () => void;
    onFitPage?: () => void;
    onFitWidth?: () => void;
    onRotate: () => void;
    onPresentationModeChange?: (mode: 'scroll' | 'paged' | 'two-page') => void;
    className?: string;
}

function formatZoomModeLabel(zoomMode: PdfZoomMode, zoom: number): string {
    if (zoomMode === "page-fit") {
        return "Fit Page";
    }
    if (zoomMode === "width-fit") {
        return "Fit Width";
    }
    return `${Math.round(zoom * 100)}%`;
}

export function PDFViewSettingsPanel({
    visible,
    zoom,
    zoomMode,
    presentationMode = "scroll",
    onClose,
    onZoomIn,
    onZoomOut,
    onZoomReset,
    onFitPage,
    onFitWidth,
    onRotate,
    onPresentationModeChange,
    className,
}: PDFViewSettingsPanelProps) {
    const zoomLabel = formatZoomModeLabel(zoomMode, zoom);

    return (
        <>
            <Backdrop visible={visible} onClick={onClose} className="z-[145]" />

            <FloatingPanel
                visible={visible}
                className={cn("z-[160] overflow-hidden bg-[var(--color-surface)]", className)}
            >
                <div className="reader-panel-header flex items-center justify-between border-b border-[var(--color-border)] px-5 py-3.5">
                    <div className="flex items-center gap-2.5">
                        <span className="inline-flex h-10 w-10 items-center justify-center bg-[var(--color-surface-muted)]">
                            <SlidersHorizontal className="w-4 h-4 text-[color:var(--color-text-secondary)]" />
                        </span>
                        <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-[color:var(--color-text-primary)]">View</span>
                    </div>
                    <button
                        onClick={onClose}
                        className="inline-flex h-10 w-10 items-center justify-center text-[color:var(--color-text-muted)] hover:text-[color:var(--color-text-primary)] hover:bg-[var(--color-surface-muted)] transition-colors"
                        aria-label="Close view settings"
                    >
                        <X className="w-4 h-4" />
                    </button>
                </div>

                <div className="flex-1 min-h-0 overflow-y-auto p-4 sm:p-5 space-y-5 [content-visibility:auto] overscroll-contain">
                    {/* Layout / Presentation Mode */}
                    <section className="space-y-2">
                        <p className="text-[10px] font-bold uppercase tracking-[0.08em] text-[color:var(--color-text-muted)]">Layout</p>
                        <div className="grid grid-cols-3 gap-1.5">
                            {[
                                { id: "scroll" as const, label: "Continuous", icon: Scroll },
                                { id: "paged" as const, label: "Single", icon: FileText },
                                { id: "two-page" as const, label: "Facing", icon: BookOpen },
                            ].map(({ id, label, icon: Icon }) => {
                                const active = presentationMode === id;
                                return (
                                    <button
                                        key={id}
                                        type="button"
                                        onClick={() => onPresentationModeChange?.(id)}
                                        className={cn(
                                            "flex flex-col items-center justify-center gap-1.5 py-2.5 px-1 border text-center transition-colors min-h-[52px] select-none",
                                            active
                                                ? "border-[var(--color-text-primary)] text-[color:var(--color-text-primary)] font-medium"
                                                : "border-[var(--color-border)] text-[color:var(--color-text-secondary)] hover:border-[var(--color-text-muted)] hover:text-[color:var(--color-text-primary)]"
                                        )}
                                        data-active={active}
                                        aria-pressed={active}
                                        title={`${label} view`}
                                    >
                                        <Icon className="w-4 h-4 shrink-0" />
                                        <span className="text-[11px] leading-tight truncate max-w-full px-0.5">
                                            {label}
                                        </span>
                                    </button>
                                );
                            })}
                        </div>
                    </section>

                    {/* Zoom Controls */}
                    <section className="space-y-2">
                        <div className="flex items-center justify-between">
                            <p className="text-[10px] font-bold uppercase tracking-[0.08em] text-[color:var(--color-text-muted)]">Zoom</p>
                            <span className="text-xs text-[color:var(--color-text-secondary)]">{zoomLabel}</span>
                        </div>
                        <div className="grid grid-cols-3 gap-1.5">
                            <button
                                type="button"
                                onClick={onZoomOut}
                                className="ui-chip-btn !px-1.5 !py-2"
                                title="Zoom out"
                            >
                                <span className="inline-flex items-center justify-center gap-1">
                                    <ZoomOut className="w-3.5 h-3.5 shrink-0" />
                                    <span className="text-xs">Out</span>
                                </span>
                            </button>
                            <button
                                type="button"
                                onClick={onZoomReset}
                                className="ui-chip-btn !px-1.5 !py-2 text-xs truncate"
                                title="Reset zoom to 100%"
                            >
                                {zoomLabel}
                            </button>
                            <button
                                type="button"
                                onClick={onZoomIn}
                                className="ui-chip-btn !px-1.5 !py-2"
                                title="Zoom in"
                            >
                                <span className="inline-flex items-center justify-center gap-1">
                                    <ZoomIn className="w-3.5 h-3.5 shrink-0" />
                                    <span className="text-xs">In</span>
                                </span>
                            </button>
                        </div>
                    </section>

                    {/* Fit Controls */}
                    <section className="space-y-2">
                        <p className="text-[10px] font-bold uppercase tracking-[0.08em] text-[color:var(--color-text-muted)]">Fit</p>
                        <div className="grid grid-cols-2 gap-1.5">
                            <button
                                type="button"
                                onClick={onFitPage}
                                className="ui-chip-btn !px-2 !py-2"
                                data-active={zoomMode === "page-fit"}
                            >
                                <span className="inline-flex items-center justify-center gap-1.5">
                                    <Maximize2 className="w-3.5 h-3.5 shrink-0" />
                                    <span className="text-xs">Fit Page</span>
                                </span>
                            </button>
                            <button
                                type="button"
                                onClick={onFitWidth}
                                className="ui-chip-btn !px-2 !py-2"
                                data-active={zoomMode === "width-fit"}
                            >
                                <span className="inline-flex items-center justify-center gap-1.5">
                                    <Maximize2 className="w-3.5 h-3.5 shrink-0" />
                                    <span className="text-xs">Fit Width</span>
                                </span>
                            </button>
                        </div>
                    </section>

                    {/* Page Rotation */}
                    <section className="space-y-2">
                        <p className="text-[10px] font-bold uppercase tracking-[0.08em] text-[color:var(--color-text-muted)]">Page</p>
                        <button
                            type="button"
                            onClick={onRotate}
                            className="ui-chip-btn w-full !py-2"
                            title="Rotate clockwise"
                        >
                            <span className="inline-flex items-center justify-center gap-1.5">
                                <RotateCw className="w-3.5 h-3.5 shrink-0" />
                                <span className="text-xs">Rotate Clockwise</span>
                            </span>
                        </button>
                    </section>
                </div>
            </FloatingPanel>
        </>
    );
}

export default PDFViewSettingsPanel;
