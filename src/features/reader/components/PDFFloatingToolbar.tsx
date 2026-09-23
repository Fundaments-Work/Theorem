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

const TOOLS = [
    { mode: 'highlight', label: "Highlight", title: "Highlight text", Icon: Highlighter },
    { mode: 'pen', label: "Pen", title: "Freehand pen", Icon: Pencil },
    { mode: 'text', label: "Text", title: "Add note", Icon: Type },
    { mode: 'erase', label: "Eraser", title: "Eraser", Icon: Eraser },
] as const;

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
        <div className={cn("fixed z-[100] flex flex-col items-end gap-2 pointer-events-none", className)}>
            <div
                className={cn(
                    "transition-[transform,opacity] duration-200 ease-out origin-bottom-right pointer-events-auto",
                    isOpen ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4 pointer-events-none"
                )}
            >
                <div className="flex flex-col gap-2 p-2 border border-[var(--color-border)] bg-[var(--color-surface)] shadow-lg">
                    <div className="grid grid-cols-4 gap-1.5" role="toolbar" aria-label="Annotation tools">
                        {TOOLS.map(({ mode, label, title, Icon }) => {
                            const active = annotationMode === mode;
                            return (
                                <button
                                    key={mode}
                                    type="button"
                                    onClick={() => onAnnotationModeChange(active ? 'none' : mode)}
                                    className={cn(
                                        "flex h-9 w-9 items-center justify-center border transition-colors duration-150",
                                        active
                                            ? "border-[var(--color-text-primary)] bg-[var(--color-text-primary)] text-[color:var(--color-surface)]"
                                            : "border-[var(--color-border)] text-[color:var(--color-text-primary)] hover:border-[var(--color-text-muted)] hover:bg-[var(--color-surface-muted)]"
                                    )}
                                    aria-label={label}
                                    aria-pressed={active}
                                    title={title}
                                >
                                    <Icon className="w-4 h-4" />
                                </button>
                            );
                        })}
                    </div>

                    {(annotationMode === 'highlight' || annotationMode === 'pen') && (
                        <div className="grid grid-cols-6 gap-1.5 border-t border-[var(--color-border)] pt-2">
                            {annotationColorSwatches.map((swatch) => (
                                <button
                                    key={swatch.color}
                                    type="button"
                                    onClick={() => onHighlightColorChange(swatch.color)}
                                    className={cn(
                                        "h-6 min-w-0 border transition-colors duration-150",
                                        highlightColor === swatch.color
                                            ? "border-[var(--color-text-primary)]"
                                            : "border-[var(--color-overlay-subtle)] hover:border-[var(--color-text-muted)]"
                                    )}
                                    style={{ backgroundColor: swatch.fill }}
                                    aria-label={`${swatch.label} colour`}
                                    aria-pressed={highlightColor === swatch.color}
                                    title={swatch.label}
                                />
                            ))}
                        </div>
                    )}
                </div>
            </div>

            <button
                type="button"
                onClick={toggleOpen}
                className={cn(
                    "pointer-events-auto flex h-11 w-11 items-center justify-center border shadow-lg transition-colors duration-150",
                    isOpen
                        ? "border-[var(--color-text-primary)] bg-[var(--color-text-primary)] text-[color:var(--color-surface)]"
                        : "border-[var(--color-border)] bg-[var(--color-surface)] text-[color:var(--color-text-primary)] hover:bg-[var(--color-surface-muted)]"
                )}
                aria-label={isOpen ? "Close tools" : "Open tools"}
                aria-expanded={isOpen}
                title={isOpen ? "Close annotation tools" : "Open annotation tools"}
            >
                {isOpen ? <X className="w-5 h-5" /> : <Edit3 className="w-5 h-5" />}
            </button>
        </div>
    );
}
