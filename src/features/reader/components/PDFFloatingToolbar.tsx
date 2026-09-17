import { useState } from "react";
import {
    Highlighter,
    Type,
    Eraser,
    X,
    Pencil,
    Edit3
} from "lucide-react";
import { cn } from "../../../core/lib/utils";
import { HIGHLIGHT_SOLID_COLORS } from "../../../core/lib/design-tokens";
import type { HighlightColor } from "../../../core/types";

interface PDFFloatingToolbarProps {
    annotationMode: 'none' | 'highlight' | 'pen' | 'text' | 'erase';
    highlightColor: HighlightColor;
    penColor: HighlightColor;
    penWidth: number;
    onAnnotationModeChange: (mode: 'none' | 'highlight' | 'pen' | 'text' | 'erase') => void;
    onHighlightColorChange: (color: HighlightColor) => void;
    onPenColorChange: (color: HighlightColor) => void;
    onPenWidthChange: (width: number) => void;
    className?: string;
}

const annotationColorSwatches: Array<{ color: HighlightColor; label: string; fill: string }> = [
    { color: "yellow", label: "Yellow", fill: HIGHLIGHT_SOLID_COLORS.yellow },
    { color: "green", label: "Green", fill: HIGHLIGHT_SOLID_COLORS.green },
    { color: "blue", label: "Blue", fill: HIGHLIGHT_SOLID_COLORS.blue },
    { color: "red", label: "Red", fill: HIGHLIGHT_SOLID_COLORS.red },
    { color: "orange", label: "Orange", fill: HIGHLIGHT_SOLID_COLORS.orange },
    { color: "purple", label: "Purple", fill: HIGHLIGHT_SOLID_COLORS.purple },
];

export function PDFFloatingToolbar({
    annotationMode,
    highlightColor,
    penColor: _penColor,
    penWidth: _penWidth,
    onAnnotationModeChange,
    onHighlightColorChange,
    onPenColorChange: _onPenColorChange,
    onPenWidthChange: _onPenWidthChange,
    className,
}: PDFFloatingToolbarProps) {
    const [isOpen, setIsOpen] = useState(false);

    const toggleOpen = () => {
        if (isOpen) {
            setIsOpen(false);
            onAnnotationModeChange('none');
        } else {
            setIsOpen(true);
        }
    };

    return (
        <div className={cn("fixed z-[100] flex flex-col items-end gap-3 pointer-events-none", className)}>
            
            <div
                className={cn(
                    "flex flex-col gap-2 transition-[transform,opacity] duration-300 ease-out origin-bottom-right pointer-events-auto",
                    isOpen ? "opacity-100 scale-100 translate-y-0" : "opacity-0 scale-90 translate-y-8 pointer-events-none"
                )}
            >
                
                <div className="flex flex-col items-center gap-2 p-2 rounded-2xl bg-[var(--color-surface)]/95 backdrop-blur-xl border border-[var(--color-border)] shadow-xl">
                    
                    <div className="flex items-center gap-1.5">
                        <button
                            onClick={() => onAnnotationModeChange(annotationMode === 'highlight' ? 'none' : 'highlight')}
                            className={cn(
                                "relative w-9 h-9 rounded-xl flex items-center justify-center transition-[color,background-color,transform,box-shadow] duration-200 ease-out",
                                annotationMode === 'highlight'
                                    ? "bg-[var(--color-accent)] text-[color:var(--color-accent-contrast)] shadow-sm scale-105"
                                    : "hover:bg-[var(--color-surface-muted)] text-[color:var(--color-text-primary)]"
                            )}
                            aria-label="Highlight"
                            title="Highlight text"
                        >
                            <Highlighter className="w-4.5 h-4.5" />
                        </button>

                        <button
                            onClick={() => onAnnotationModeChange(annotationMode === 'pen' ? 'none' : 'pen')}
                            className={cn(
                                "relative w-9 h-9 rounded-xl flex items-center justify-center transition-[color,background-color,transform,box-shadow] duration-200 ease-out",
                                annotationMode === 'pen'
                                    ? "bg-[var(--color-accent)] text-[color:var(--color-accent-contrast)] shadow-sm scale-105"
                                    : "hover:bg-[var(--color-surface-muted)] text-[color:var(--color-text-primary)]"
                            )}
                            aria-label="Pen"
                            title="Freehand pen"
                        >
                            <Pencil className="w-4.5 h-4.5" />
                        </button>

                        <button
                            onClick={() => onAnnotationModeChange(annotationMode === 'text' ? 'none' : 'text')}
                            className={cn(
                                "relative w-9 h-9 rounded-xl flex items-center justify-center transition-[color,background-color,transform,box-shadow] duration-200 ease-out",
                                annotationMode === 'text'
                                    ? "bg-[var(--color-accent)] text-[color:var(--color-accent-contrast)] shadow-sm scale-105"
                                    : "hover:bg-[var(--color-surface-muted)] text-[color:var(--color-text-primary)]"
                            )}
                            aria-label="Text"
                            title="Add note"
                        >
                            <Type className="w-4.5 h-4.5" />
                        </button>

                        <button
                            onClick={() => onAnnotationModeChange(annotationMode === 'erase' ? 'none' : 'erase')}
                            className={cn(
                                "relative w-9 h-9 rounded-xl flex items-center justify-center transition-[color,background-color,transform,box-shadow] duration-200 ease-out",
                                annotationMode === 'erase'
                                    ? "bg-[var(--color-accent)] text-[color:var(--color-accent-contrast)] shadow-sm scale-105"
                                    : "hover:bg-[var(--color-surface-muted)] text-[color:var(--color-text-primary)]"
                            )}
                            aria-label="Eraser"
                            title="Eraser"
                        >
                            <Eraser className="w-4.5 h-4.5" />
                        </button>
                    </div>

                    {(annotationMode === 'highlight' || annotationMode === 'pen') && (
                        <div className="w-full h-px bg-[var(--color-border)] my-0.5" />
                    )}

                    {(annotationMode === 'highlight' || annotationMode === 'pen') && (
                        <div className="flex items-center justify-center gap-1.5 p-1 w-full overflow-x-auto no-scrollbar">
                            {annotationColorSwatches.map((swatch) => (
                                <button
                                    key={swatch.color}
                                    onClick={() => onHighlightColorChange(swatch.color)}
                                    className={cn(
                                        "w-5 h-5 rounded-full transition-transform ring-2 ring-transparent",
                                        highlightColor === swatch.color ? "scale-110 ring-[var(--color-border)] shadow-sm" : "hover:scale-110"
                                    )}
                                    style={{ backgroundColor: swatch.fill }}
                                    title={swatch.label}
                                />
                            ))}
                        </div>
                    )}
                </div>
            </div>

            <button
                onClick={toggleOpen}
                className={cn(
                    "pointer-events-auto flex items-center justify-center w-11 h-11 rounded-full shadow-lg transition-[color,background-color,transform,box-shadow] duration-300 ease-out",
                    isOpen
                        ? "bg-[var(--color-surface)]/95 backdrop-blur-xl text-[color:var(--color-text-primary)] border border-[var(--color-border)] rotate-90"
                        : "bg-[var(--color-surface)]/95 backdrop-blur-xl text-[color:var(--color-text-primary)] border border-[var(--color-border)] hover:bg-[var(--color-surface)] hover:scale-105 active:scale-95"
                )}
                aria-label={isOpen ? "Close tools" : "Open tools"}
                title={isOpen ? "Close annotation tools" : "Open annotation tools"}
            >
                {isOpen ? (
                    <X className="w-5 h-5 text-[color:var(--color-text-primary)]" />
                ) : (
                    <Edit3 className="w-5 h-5 text-[color:var(--color-text-primary)]" />
                )}
            </button>
        </div>
    );
}


