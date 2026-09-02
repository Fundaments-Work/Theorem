
import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { Check, Copy, ArrowLeft } from 'lucide-react';
import { ask } from '@tauri-apps/plugin-dialog';
import { cn } from "../../../../core/lib/utils";
import { Spinner } from "../../../../ui";
import {
    HIGHLIGHT_COLOR_TOKENS,
    HIGHLIGHT_PICKER_ACTIVE_COLORS,
    HIGHLIGHT_PICKER_COLORS,
} from "../../../../core/lib/design-tokens";
import { isTauri } from "../../../../core/lib/env";
import type { HighlightColor } from "../../../../core/types";
import type { DictionaryLookupResult } from "../../../../core/services/DictionaryService";

interface HighlightDictionaryViewState {
    term: string;
    result: DictionaryLookupResult | null;
    loading: boolean;
    error?: string | null;
    saved: boolean;
    canSaveToVocabulary?: boolean;
    saveDisabledMessage?: string;
    onSave: () => void;
    onBack?: () => void;
    onLookupTerm?: (term: string) => void;
}

interface HighlightColorPickerProps {
    isOpen: boolean;
    position: { x: number; y: number; height?: number };
    currentColor?: HighlightColor | null;
    onSelectColor: (color: HighlightColor) => void;
    onAddNote: () => void;
    onCopy?: () => void;
    onDefine?: () => void;
    onBookmark: () => void;
    onDelete?: () => void;
    dictionary?: HighlightDictionaryViewState;
    viewportPadding?: Partial<{
        top: number;
        right: number;
        bottom: number;
        left: number;
    }>;
    onClose: () => void;
}

const COLOR_OPTIONS: {
    color: HighlightColor;
    label: string;
}[] = [
        { color: "yellow", label: HIGHLIGHT_COLOR_TOKENS.yellow.label },
        { color: "green", label: HIGHLIGHT_COLOR_TOKENS.green.label },
        { color: "blue", label: HIGHLIGHT_COLOR_TOKENS.blue.label },
        { color: "red", label: HIGHLIGHT_COLOR_TOKENS.red.label },
        { color: "orange", label: HIGHLIGHT_COLOR_TOKENS.orange.label },
        { color: "purple", label: HIGHLIGHT_COLOR_TOKENS.purple.label },
    ];

const ANIMATION_STYLES = `
    @keyframes picker-appear {
        from {
            opacity: 0;
            transform: translateY(8px) scale(0.96);
        }
        to {
            opacity: 1;
            transform: translateY(0) scale(1);
        }
    }
    
    @keyframes picker-disappear {
        from {
            opacity: 1;
            transform: translateY(0) scale(1);
        }
        to {
            opacity: 0;
            transform: translateY(8px) scale(0.96);
        }
    }
    
    .picker-animate-in {
        animation: picker-appear 200ms cubic-bezier(0.16, 1, 0.3, 1) forwards;
    }
    
    .picker-animate-out {
        animation: picker-disappear 150ms cubic-bezier(0.4, 0, 0.2, 1) forwards;
    }
`;

const PICKER_ACTION_BUTTON_CLASS = [
    "flex w-full items-center justify-center",
    "border border-[var(--color-border)] bg-[var(--color-surface)]",
    "px-3 py-2.5 text-sm font-medium text-[color:var(--color-text-secondary)]",
    "transition-[background-color,border-color,color,opacity] duration-200 ease-out",
    "hover:bg-[var(--color-surface-muted)] hover:text-[color:var(--color-text-primary)]",
    "disabled:cursor-not-allowed disabled:opacity-[0.45]",
].join(" ");

const PICKER_DANGER_BUTTON_CLASS = [
    "flex w-full items-center justify-center",
    "border border-[color:color-mix(in_srgb,var(--color-error)_24%,var(--color-border))]",
    "bg-[color:color-mix(in_srgb,var(--color-error)_8%,var(--color-surface))]",
    "px-3 py-2.5 text-sm font-medium text-[color:var(--color-error)]",
    "transition-[background-color,border-color,color,opacity] duration-200 ease-out",
    "hover:bg-[color:color-mix(in_srgb,var(--color-error)_14%,var(--color-surface))]",
].join(" ");

export function HighlightColorPicker({
    isOpen,
    position,
    currentColor,
    onSelectColor,
    onAddNote,
    onCopy,
    onDefine,
    onBookmark: _onBookmark,
    onDelete,
    dictionary,
    viewportPadding,
    onClose,
}: HighlightColorPickerProps) {
    const popupRef = useRef<HTMLDivElement>(null);
    const closeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const hasScheduledCloseRef = useRef(false);
    const [adjustedPosition, setAdjustedPosition] = useState(position);
    const [isClosing, setIsClosing] = useState(false);
    const [selectedColor, setSelectedColor] = useState<HighlightColor | null>(currentColor || null);
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
    const isDictionaryView = Boolean(dictionary);
    const handlePopupMouseDownCapture = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
        const target = event.target as HTMLElement | null;
        if (target?.closest("button")) {
            event.preventDefault();
        }
    }, []);

    useEffect(() => {
        if (isOpen) {
            setSelectedColor(currentColor || null);
            setShowDeleteConfirm(false);
            setIsClosing(false);
            hasScheduledCloseRef.current = false;
            if (closeTimeoutRef.current) {
                clearTimeout(closeTimeoutRef.current);
                closeTimeoutRef.current = null;
            }
        }
    }, [isOpen, currentColor]);

    useEffect(() => {
        if (isDictionaryView) {
            setShowDeleteConfirm(false);
        }
    }, [isDictionaryView]);

    useEffect(() => {
        
        if (!isOpen) {
            setIsClosing(false);
            hasScheduledCloseRef.current = false;
            return;
        }

        const calculatePosition = () => {
            const popup = popupRef.current;
            if (!popup) return;

            const rect = popup.getBoundingClientRect();
            const viewportWidth = window.innerWidth;
            const viewportHeight = window.innerHeight;
            const isMobileViewport = viewportWidth <= 768;
            const boundaryPadding = 12;
            const leftBound = Math.max(boundaryPadding, viewportPadding?.left ?? boundaryPadding);
            const rightBound = Math.min(viewportWidth - boundaryPadding, viewportWidth - (viewportPadding?.right ?? boundaryPadding));
            const softTopBound = Math.max(boundaryPadding, viewportPadding?.top ?? boundaryPadding);
            const softBottomBound = Math.min(viewportHeight - boundaryPadding, viewportHeight - (viewportPadding?.bottom ?? boundaryPadding));
            const hardTopBound = boundaryPadding;
            const hardBottomBound = viewportHeight - boundaryPadding;

            let { x, y } = position;

            x = x - rect.width / 2;

            if (x + rect.width > rightBound) {
                x = rightBound - rect.width;
            }
            if (x < leftBound) {
                x = leftBound;
            }

            const clampY = (value: number, top: number, bottom: number) => {
                if (value < top) return top;
                if (value + rect.height > bottom) return bottom - rect.height;
                return value;
            };
            const fitsY = (value: number, top: number, bottom: number) => (
                value >= top && value + rect.height <= bottom
            );
            const overlapWithSelection = (popupTop: number, selectionTop: number, selectionBottom: number) => {
                const popupBottom = popupTop + rect.height;
                return Math.max(0, Math.min(popupBottom, selectionBottom) - Math.max(popupTop, selectionTop));
            };

            const fallbackSelectionHeight = isMobileViewport ? 32 : 24;
            const selectionHeight = Math.max(position.height ?? fallbackSelectionHeight, fallbackSelectionHeight);
            const inferredSelectionTop = position.height === undefined
                ? position.y - selectionHeight / 2
                : position.y;
            const selectionTop = Math.max(hardTopBound, Math.min(inferredSelectionTop, hardBottomBound - 1));
            const selectionBottom = Math.min(hardBottomBound, selectionTop + selectionHeight);
            const softViewportHeight = Math.max(softBottomBound - softTopBound, 1);
            const isLargeSelection = selectionHeight >= softViewportHeight * 0.55;

            if (isLargeSelection) {
                x = (viewportWidth - rect.width) / 2;
                if (x + rect.width > rightBound) {
                    x = rightBound - rect.width;
                }
                if (x < leftBound) {
                    x = leftBound;
                }

                y = clampY(
                    softTopBound + (softViewportHeight - rect.height) / 2,
                    softTopBound,
                    softBottomBound,
                );
                setAdjustedPosition({ x, y });
                return;
            }

            const verticalGap = isMobileViewport ? 24 : 14;
            const viewportMidpointY = (softTopBound + softBottomBound) / 2;
            const preferBelow = selectionTop < viewportMidpointY;
            const yBelow = selectionBottom + verticalGap;
            const yAbove = selectionTop - rect.height - verticalGap;
            const canPlaceBelowSoft = fitsY(yBelow, softTopBound, softBottomBound);
            const canPlaceAboveSoft = fitsY(yAbove, softTopBound, softBottomBound);
            const canPlaceBelowHard = fitsY(yBelow, hardTopBound, hardBottomBound);
            const canPlaceAboveHard = fitsY(yAbove, hardTopBound, hardBottomBound);

            if (preferBelow && canPlaceBelowSoft) {
                y = yBelow;
            } else if (!preferBelow && canPlaceAboveSoft) {
                y = yAbove;
            } else if (canPlaceBelowSoft) {
                y = yBelow;
            } else if (canPlaceAboveSoft) {
                y = yAbove;
            } else if (preferBelow && canPlaceBelowHard) {
                y = yBelow;
            } else if (!preferBelow && canPlaceAboveHard) {
                y = yAbove;
            } else if (canPlaceBelowHard) {
                y = yBelow;
            } else if (canPlaceAboveHard) {
                y = yAbove;
            } else {
                const belowClamped = clampY(yBelow, hardTopBound, hardBottomBound);
                const aboveClamped = clampY(yAbove, hardTopBound, hardBottomBound);
                const belowOverlap = overlapWithSelection(belowClamped, selectionTop, selectionBottom);
                const aboveOverlap = overlapWithSelection(aboveClamped, selectionTop, selectionBottom);

                if (preferBelow) {
                    y = belowOverlap <= aboveOverlap ? belowClamped : aboveClamped;
                } else {
                    y = aboveOverlap <= belowOverlap ? aboveClamped : belowClamped;
                }
            }

            if (y + rect.height > hardBottomBound) {
                y = hardBottomBound - rect.height;
            }
            if (y < hardTopBound) {
                y = hardTopBound;
            }

            setAdjustedPosition({ x, y });
        };

        requestAnimationFrame(calculatePosition);
    }, [
        dictionary?.error,
        dictionary?.loading,
        dictionary?.result,
        dictionary?.saved,
        isOpen,
        position,
        viewportPadding?.bottom,
        viewportPadding?.left,
        viewportPadding?.right,
        viewportPadding?.top,
    ]);

    const handleClose = useCallback(() => {
        if (hasScheduledCloseRef.current) {
            return;
        }
        hasScheduledCloseRef.current = true;
        setIsClosing(true);
        closeTimeoutRef.current = setTimeout(() => {
            closeTimeoutRef.current = null;
            hasScheduledCloseRef.current = false;
            onClose();
        }, 150);
    }, [onClose]);

    const handleColorClick = useCallback((color: HighlightColor) => {
        setSelectedColor(color);
        
        requestAnimationFrame(() => {
            onSelectColor(color);
        });
    }, [onSelectColor]);

    const handleDeleteClick = useCallback(async () => {
        if (isTauri()) {
            
            const confirmed = await ask('Delete this highlight and any associated notes?', {
                title: '',
                kind: 'warning',
            });
            if (confirmed) {
                onDelete?.();
                handleClose();
            }
        } else {
            
            setShowDeleteConfirm(true);
        }
    }, [onDelete, handleClose]);

    const handleDeleteConfirmed = useCallback(() => {
        setShowDeleteConfirm(false);
        onDelete?.();
        handleClose();
    }, [onDelete, handleClose]);

    const handleDeleteCancelled = useCallback(() => {
        setShowDeleteConfirm(false);
    }, []);

    useEffect(() => {
        if (!isOpen) return;

        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                if (showDeleteConfirm) {
                    setShowDeleteConfirm(false);
                } else {
                    handleClose();
                }
            }

            if (!showDeleteConfirm && !isDictionaryView) {
                const num = parseInt(e.key);
                if (num >= 1 && num <= 6) {
                    e.preventDefault();
                    handleColorClick(COLOR_OPTIONS[num - 1].color);
                }
            }
        };

        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [isDictionaryView, isOpen, showDeleteConfirm, handleClose, handleColorClick]);

    useEffect(() => {
        if (!isOpen) return;

        const handleClickOutside = (e: MouseEvent) => {
            if (isDictionaryView) return;
            if (popupRef.current && !popupRef.current.contains(e.target as Node)) {
                handleClose();
            }
        };

        const timer = setTimeout(() => {
            document.addEventListener('pointerdown', handleClickOutside, true);
            document.addEventListener('mousedown', handleClickOutside, true);
            document.addEventListener('click', handleClickOutside, true);
        }, 50);

        const handleScrollOrResize = () => {
            if (isDictionaryView) return;
            handleClose();
        };

        window.addEventListener('scroll', handleScrollOrResize, true);
        window.addEventListener('resize', handleScrollOrResize);

        return () => {
            clearTimeout(timer);
            document.removeEventListener('pointerdown', handleClickOutside, true);
            document.removeEventListener('mousedown', handleClickOutside, true);
            document.removeEventListener('click', handleClickOutside, true);
            window.removeEventListener('scroll', handleScrollOrResize, true);
            window.removeEventListener('resize', handleScrollOrResize);
        };
    }, [isOpen, isDictionaryView, handleClose]);

    useEffect(() => {
        return () => {
            if (closeTimeoutRef.current) {
                clearTimeout(closeTimeoutRef.current);
                closeTimeoutRef.current = null;
            }
            hasScheduledCloseRef.current = false;
        };
    }, []);

    if (!isOpen) return null;

    const popupContent = (
        <>
            <style>{ANIMATION_STYLES}</style>
            <div
                ref={popupRef}
                onMouseDownCapture={handlePopupMouseDownCapture}
                className={cn(
                    "fixed",
                    "w-[15.5rem] max-w-[calc(100vw-2rem)]",
                    "bg-[var(--color-surface)]",
                    "border-2 border-[var(--color-border)]",
                    "shadow-none",
                    "p-3",
                    isDictionaryView && "w-[20rem] max-w-[calc(100vw-2rem)]",
                    isClosing ? "picker-animate-out" : "picker-animate-in"
                )}
                style={{
                    left: adjustedPosition.x,
                    top: adjustedPosition.y,
                    zIndex: "calc(var(--z-tooltip) + 40)",
                }}
            >
                {isDictionaryView && dictionary ? (
                    <>
                        <div className="mb-3 border-b border-[var(--color-border)] px-1 pb-2">
                            <p className="text-xs font-semibold uppercase tracking-wide text-[color:var(--color-text-secondary)]">
                                Dictionary
                            </p>
                            {dictionary.term ? (
                                <p className="truncate text-sm font-semibold text-[color:var(--color-text-primary)]">
                                    {dictionary.term}
                                </p>
                            ) : null}
                        </div>
                        <div
                            className="max-h-60 overflow-y-auto px-1 py-1 [content-visibility:auto] overscroll-contain"
                            onClick={(e) => {
                                const target = (e.target as HTMLElement).closest("a");
                                if (target) {
                                    const href = target.getAttribute("href");
                                    if (href && (href.startsWith("entry://") || href.startsWith("bword://"))) {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        const cleanTerm = decodeURIComponent(href.replace(/^(entry|bword):\/\//, ""));
                                        if (cleanTerm && dictionary.onLookupTerm) {
                                            dictionary.onLookupTerm(cleanTerm);
                                        }
                                    }
                                }
                            }}
                        >
                            {dictionary.loading && (
                                <div className="flex items-center gap-2 text-sm text-[color:var(--color-text-secondary)]">
                                    <Spinner size="sm" label="Looking up definitions" />
                                    Looking up definitions...
                                </div>
                            )}

                            {!dictionary.loading && dictionary.error && (
                                <p className="text-sm text-[color:var(--color-error)]">{dictionary.error}</p>
                            )}

                            {!dictionary.loading && !dictionary.error && !dictionary.result && (
                                <p className="text-sm text-[color:var(--color-text-secondary)]">No definition found.</p>
                            )}

                            {!dictionary.loading && dictionary.result && dictionary.result.meanings.length > 0 && (
                                <div className="space-y-3">
                                    {dictionary.result.phonetic && (
                                        <p className="text-xs text-[color:var(--color-text-muted)]">/{dictionary.result.phonetic}/</p>
                                    )}
                                    {dictionary.result.meanings.slice(0, 3).map((meaning, idx) => (
                                        <div key={`${meaning.provider}-${idx}`} className="space-y-1">
                                            <p className="text-xs font-semibold uppercase tracking-wide text-[color:var(--color-text-muted)]">
                                                {meaning.partOfSpeech || "Meaning"}
                                            </p>
                                            <ul className="space-y-1 text-sm text-[color:var(--color-text-primary)] list-disc pl-4">
                                                {meaning.definitions.slice(0, 3).map((definition) => {
                                                    const isHtml = definition.includes("<") && definition.includes(">");
                                                    return isHtml ? (
                                                        <li
                                                            key={definition}
                                                            className="leading-snug dict-definition"
                                                            dangerouslySetInnerHTML={{ __html: definition }}
                                                        />
                                                    ) : (
                                                        <li key={definition} className="leading-snug">
                                                            {definition}
                                                        </li>
                                                    );
                                                })}
                                            </ul>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>

                        <div className="mt-2 flex items-center justify-between border-t border-[var(--color-border)] pt-2">
                            {dictionary.onBack ? (
                                <button
                                    onClick={dictionary.onBack}
                                    className="inline-flex items-center gap-1.5 border border-[var(--color-border)] px-3 py-2 text-xs font-medium text-[color:var(--color-text-secondary)] transition-[background-color,border-color,color] duration-200 ease-out hover:bg-[var(--color-surface-muted)] hover:text-[color:var(--color-text-primary)]"
                                >
                                    <ArrowLeft className="h-3.5 w-3.5" />
                                    Back
                                </button>
                            ) : (
                                <span />
                            )}
                            <button
                                onClick={dictionary.onSave}
                                disabled={
                                    dictionary.loading
                                    || !dictionary.result
                                    || dictionary.saved
                                    || dictionary.canSaveToVocabulary === false
                                }
                                className={cn(
                                    "inline-flex items-center gap-1.5 border px-3 py-2 text-xs font-medium transition-[background-color,border-color,color,opacity] duration-200 ease-out",
                                    dictionary.saved
                                        ? "border-[color:color-mix(in_srgb,var(--color-success)_24%,var(--color-border))] bg-[var(--color-success)]/10 text-[color:var(--color-success)]"
                                        : "border-[var(--color-accent)] bg-[var(--color-accent)] text-[color:var(--color-accent-contrast)] hover:border-[var(--color-accent-hover)] hover:bg-[var(--color-accent-hover)]",
                                    (
                                        dictionary.loading
                                        || !dictionary.result
                                        || dictionary.canSaveToVocabulary === false
                                    ) && "cursor-not-allowed opacity-60"
                                )}
                            >
                                {dictionary.saved ? <Check className="h-3.5 w-3.5" /> : null}
                                {dictionary.saved ? "Saved" : "Save to Vocabulary"}
                            </button>
                        </div>

                        {dictionary.canSaveToVocabulary === false && (
                            <div className="border-t border-[var(--color-border)] px-1 pt-2 text-xs text-[color:var(--color-text-muted)]">
                                {dictionary.saveDisabledMessage || "Enable Vocabulary Builder in Settings to save terms."}
                            </div>
                        )}
                    </>
                ) : showDeleteConfirm ? (
                    <div className="px-1 py-2">
                        <p className="text-xs text-[color:var(--color-text-secondary)] text-center mb-2">
                            Delete this highlight and any associated notes?
                        </p>
                        <div className="flex gap-1.5">
                            <button
                                onClick={handleDeleteCancelled}
                                className={cn(PICKER_ACTION_BUTTON_CLASS, "flex-1 px-2 py-2 text-xs")}
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleDeleteConfirmed}
                                className={cn(PICKER_DANGER_BUTTON_CLASS, "flex-1 px-2 py-2 text-xs")}
                            >
                                Delete
                            </button>
                        </div>
                    </div>
                ) : (
                    <>
                        <div className="grid grid-cols-6 gap-1.5">
                            {COLOR_OPTIONS.map(({ color, label }) => (
                                <button
                                    key={color}
                                    onClick={() => handleColorClick(color)}
                                    className={cn(
                                        "h-9 min-w-0",
                                        "flex items-center justify-center",
                                        "border transition-[background-color,border-color] duration-150",
                                        selectedColor === color
                                            ? "border-[color:var(--color-text-primary)]"
                                            : "border-[var(--color-overlay-subtle)] hover:border-[color:color-mix(in_srgb,var(--color-accent)_30%,var(--color-border))]",
                                        "focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] focus:ring-offset-1"
                                    )}
                                    style={{
                                        backgroundColor: selectedColor === color
                                            ? HIGHLIGHT_PICKER_ACTIVE_COLORS[color]
                                            : HIGHLIGHT_PICKER_COLORS[color],
                                    }}
                                    title={`${label} (Shortcut: ${COLOR_OPTIONS.findIndex(c => c.color === color) + 1})`}
                                    aria-label={`Select ${label}`}
                                >
                                </button>
                            ))}
                        </div>
                        <div className="mt-3 grid gap-1.5">
                            {onCopy && (
                                <button onClick={() => { onCopy(); handleClose(); }}
                                    className={PICKER_ACTION_BUTTON_CLASS}>
                                    <Copy className="w-4 h-4 mr-2" /> Copy
                                </button>
                            )}
                            <button onClick={() => { onAddNote(); handleClose(); }}
                                className={PICKER_ACTION_BUTTON_CLASS}>
                                Add Note
                            </button>
                            <button onClick={() => onDefine?.()}
                                className={PICKER_ACTION_BUTTON_CLASS}
                                disabled={!onDefine}>
                                Define
                            </button>
                        </div>

                        {onDelete && (
                            <>
                                <div className="my-3 border-t border-[var(--color-border)]" />
                                <button
                                    onClick={handleDeleteClick}
                                    className={PICKER_DANGER_BUTTON_CLASS}
                                >
                                    Delete
                                </button>
                            </>
                        )}
                    </>
                )}
            </div>
        </>
    );

    if (typeof document === "undefined") {
        return popupContent;
    }

    return createPortal(popupContent, document.body);
}

export default HighlightColorPicker;
