import React, { useState, useRef, useCallback, useEffect } from "react";
import {
    RotateCcw, CheckCircle2, ChevronsLeft, ChevronsRight,
    Check, StickyNote, Bookmark, BookOpen
} from "lucide-react";
import { cn } from "../../../core/lib/utils";
import { bookmarkPositionLabel } from "./bookmark-position";

interface CardColorTheme {
    border: string;       // single card border
    borderSubtle: string; // divider line
    bgWash: string;       // ambient background wash
    accent: string;       // accent color for icons
}

const CARD_PALETTES: CardColorTheme[] = [
    {
        // Terracotta
        border: "rgba(224, 108, 83, 0.22)",
        borderSubtle: "rgba(224, 108, 83, 0.12)",
        bgWash: "rgba(224, 108, 83, 0.05)",
        accent: "#e06c53",
    },
    {
        // Sage Green
        border: "rgba(78, 155, 103, 0.22)",
        borderSubtle: "rgba(78, 155, 103, 0.12)",
        bgWash: "rgba(78, 155, 103, 0.05)",
        accent: "#4e9b67",
    },
    {
        // Cobalt Blue
        border: "rgba(79, 120, 207, 0.22)",
        borderSubtle: "rgba(79, 120, 207, 0.12)",
        bgWash: "rgba(79, 120, 207, 0.05)",
        accent: "#4f78cf",
    },
    {
        // Warm Ochre
        border: "rgba(217, 130, 43, 0.22)",
        borderSubtle: "rgba(217, 130, 43, 0.12)",
        bgWash: "rgba(217, 130, 43, 0.05)",
        accent: "#d9822b",
    },
    {
        // Amethyst / Mauve
        border: "rgba(155, 89, 182, 0.22)",
        borderSubtle: "rgba(155, 89, 182, 0.12)",
        bgWash: "rgba(155, 89, 182, 0.05)",
        accent: "#9b59b6",
    },
    {
        // Teal
        border: "rgba(47, 158, 153, 0.22)",
        borderSubtle: "rgba(47, 158, 153, 0.12)",
        bgWash: "rgba(47, 158, 153, 0.05)",
        accent: "#2f9e99",
    },
    {
        // Rose / Crimson
        border: "rgba(217, 83, 111, 0.22)",
        borderSubtle: "rgba(217, 83, 111, 0.12)",
        bgWash: "rgba(217, 83, 111, 0.05)",
        accent: "#d9536f",
    },
    {
        // Olive Lime
        border: "rgba(139, 168, 50, 0.22)",
        borderSubtle: "rgba(139, 168, 50, 0.12)",
        bgWash: "rgba(139, 168, 50, 0.05)",
        accent: "#8ba832",
    },
];

function getCardColor(card?: Annotation, index?: number): CardColorTheme {
    if (!card) return CARD_PALETTES[0];
    let hash = 0;
    const str = card.id || String(index ?? 0);
    for (let i = 0; i < str.length; i++) {
        hash = (hash << 5) - hash + str.charCodeAt(i);
        hash |= 0;
    }
    return CARD_PALETTES[Math.abs(hash) % CARD_PALETTES.length];
}
import type { Annotation } from "../../../core/types";
import type { ResolvedAnnotationSource } from "../../../core/lib/annotation-source";

export interface ReviewCardStackProps {
    cards: Annotation[];
    sources: Map<string, ResolvedAnnotationSource>;
    onComplete?: () => void;
    onGoToSource: (sourceId: string, location?: string) => void;
    onClose?: () => void;
    deckTitle?: string;
    deckSubtitle?: string;
    hasPrevDeck?: boolean;
    hasNextDeck?: boolean;
    prevDeckLabel?: string;
    nextDeckLabel?: string;
    onPrevDeck?: () => void;
    onNextDeck?: () => void;
    onEdit?: (id: string) => void;
    onDelete?: (id: string) => void;
    completionTitle?: string;
    completionDescription?: string;
    completionActionLabel?: string;
    onCompletionAction?: () => void;
}

export function ReviewCardStack({
    cards,
    sources,
    onComplete,
    onGoToSource,
    onClose,
    deckTitle,
    deckSubtitle,
    hasPrevDeck,
    hasNextDeck,
    prevDeckLabel,
    nextDeckLabel,
    onPrevDeck,
    onNextDeck,
    onEdit: _onEdit,
    onDelete: _onDelete,
    completionTitle = "All Caught Up",
    completionDescription,
    completionActionLabel = "Done",
    onCompletionAction,
}: ReviewCardStackProps) {
    const [currentIndex, setCurrentIndex] = useState(0);
    const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
    const [isDragging, setIsDragging] = useState(false);
    const [flingDirection, setFlingDirection] = useState<"left" | "right" | null>(null);

    const [isReturning, setIsReturning] = useState(false);

    const startXRef = useRef(0);
    const startYRef = useRef(0);
    const startTimeRef = useRef(0);
    const isTrackingRef = useRef(false);
    const hasDraggedRef = useRef(false);

    const isFinished = currentIndex >= cards.length;

    // Reset index if cards array changes (e.g. switching decks)
    useEffect(() => {
        setCurrentIndex(0);
        setDragOffset({ x: 0, y: 0 });
        setFlingDirection(null);
        setIsReturning(false);
    }, [cards]);

    // Trigger onComplete when user reaches the end
    useEffect(() => {
        if (isFinished && cards.length > 0) {
            onComplete?.();
        }
    }, [isFinished, cards.length, onComplete]);

    const flingCard = useCallback((direction: "left" | "right") => {
        if (currentIndex >= cards.length) return;
        setFlingDirection(direction);
        setTimeout(() => {
            setFlingDirection(null);
            setDragOffset({ x: 0, y: 0 });
            setCurrentIndex((prev) => prev + 1);
        }, 200);
    }, [currentIndex, cards.length]);

    const handleNext = useCallback(() => {
        if (currentIndex < cards.length) {
            flingCard("right");
        }
    }, [currentIndex, cards.length, flingCard]);

    const handlePrev = useCallback(() => {
        if (currentIndex > 0) {
            setIsReturning(true);
            setCurrentIndex((prev) => prev - 1);
            setFlingDirection(null);
            setDragOffset({ x: 0, y: 0 });
            const timer = setTimeout(() => {
                setIsReturning(false);
            }, 20);
            return () => clearTimeout(timer);
        }
    }, [currentIndex]);

    const handleRestart = useCallback(() => {
        setCurrentIndex(0);
        setDragOffset({ x: 0, y: 0 });
        setFlingDirection(null);
    }, []);

    // Keyboard navigation
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Escape" && onClose) {
                onClose();
            } else if (e.key === "ArrowLeft") {
                handlePrev();
            } else if (e.key === "ArrowRight" || e.key === " ") {
                handleNext();
            }
        };

        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [handlePrev, handleNext, onClose]);

    const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        if (isFinished || flingDirection) return;
        if (!e.isPrimary) return;

        const target = e.target as HTMLElement | null;
        if (target?.closest('button, a, [role="button"], input, select, textarea, [data-no-swipe]')) {
            return;
        }

        // Clear any text selection that might have started
        window.getSelection()?.removeAllRanges();

        isTrackingRef.current = true;
        hasDraggedRef.current = false;
        startXRef.current = e.clientX;
        startYRef.current = e.clientY;
        startTimeRef.current = performance.now();
        setIsDragging(true);

        try {
            (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
        } catch {
            // Ignore capture error
        }
    }, [isFinished, flingDirection]);

    const handlePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        if (!isTrackingRef.current || isFinished || flingDirection) return;

        const dx = e.clientX - startXRef.current;
        const dy = e.clientY - startYRef.current;
        if (Math.abs(dx) > 6 || Math.abs(dy) > 6) {
            hasDraggedRef.current = true;
            window.getSelection()?.removeAllRanges();
        }
        setDragOffset({ x: dx, y: dy });
    }, [isFinished, flingDirection]);

    const handlePointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        if (!isTrackingRef.current) return;
        isTrackingRef.current = false;
        setIsDragging(false);

        try {
            if ((e.currentTarget as HTMLElement).hasPointerCapture?.(e.pointerId)) {
                (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
            }
        } catch {
            // Ignore capture error
        }

        if (hasDraggedRef.current) {
            const duration = Math.max(performance.now() - startTimeRef.current, 1);
            const velocity = dragOffset.x / duration;

            if (Math.abs(dragOffset.x) > 45 || Math.abs(velocity) > 0.18) {
                const direction = dragOffset.x > 0 ? "right" : "left";
                flingCard(direction);
                return;
            }

            // Snap back
            setDragOffset({ x: 0, y: 0 });
        }
    }, [dragOffset.x, flingCard]);

    // Tap to swipe / advance
    const handleCardClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
        if (hasDraggedRef.current) return;

        const target = e.target as HTMLElement | null;
        if (target?.closest('button, a, [role="button"], input, select, textarea, [data-no-swipe]')) {
            return;
        }

        const rect = e.currentTarget.getBoundingClientRect();
        const clickX = e.clientX - rect.left;

        // Tapping the left 18% goes to previous card
        window.getSelection()?.removeAllRanges();
        if (clickX < rect.width * 0.18 && currentIndex > 0) {
            handlePrev();
        } else {
            // Tapping anywhere else advances
            handleNext();
        }
    }, [currentIndex, handlePrev, handleNext]);

    const dragProgress = flingDirection ? 1 : Math.min(1, Math.abs(dragOffset.x) / 100);

    const topCard = cards[currentIndex];
    const nextCard = cards[currentIndex + 1];
    const thirdCard = cards[currentIndex + 2];
    const fourthCard = cards[currentIndex + 3];
    const fifthCard = cards[currentIndex + 4];

    const topColor = getCardColor(topCard, currentIndex);
    const nextColor = getCardColor(nextCard, currentIndex + 1);

    const topSource = topCard ? sources.get(topCard.bookId) : undefined;
    const nextSource = nextCard ? sources.get(nextCard.bookId) : undefined;

    let topTransform = "";
    let topOpacity = 1;

    if (flingDirection) {
        const flingX = flingDirection === "right" ? 120 : -120;
        const flingRotate = flingDirection === "right" ? 14 : -14;
        topTransform = `translate3d(${flingX}%, 0, 0) rotate(${flingRotate}deg)`;
        topOpacity = 0;
    } else if (isDragging) {
        const rot = dragOffset.x * 0.04;
        topTransform = `translate3d(${dragOffset.x}px, ${dragOffset.y * 0.15}px, 0) rotate(${rot}deg)`;
    } else if (isReturning) {
        topTransform = "translate3d(100%, 0, 0) rotate(10deg)";
        topOpacity = 0.2;
    }

    return (
        <div
            className="w-full max-w-[42rem] mx-auto select-none py-1 pb-10"
            style={{ width: "100%", maxWidth: "42rem", userSelect: "none", WebkitUserSelect: "none" }}
        >
            {/* Optional Deck Header with Prev/Next Deck Buttons */}
            {deckTitle && (
                <div className="mb-3 flex items-center justify-between gap-3 px-1 select-none">
                    <div className="flex items-center gap-2 min-w-0">
                        <span className="font-serif text-sm font-medium text-[color:var(--color-text-primary)] truncate">
                            {deckTitle}
                        </span>
                        {deckSubtitle && (
                            <span className="text-[11px] text-[color:var(--color-text-muted)] shrink-0 hidden sm:inline">
                                · {deckSubtitle}
                            </span>
                        )}
                    </div>

                    {(onPrevDeck || onNextDeck) && (
                        <div className="flex items-center gap-1 shrink-0">
                            <button
                                type="button"
                                onClick={onPrevDeck}
                                disabled={!hasPrevDeck}
                                className="inline-flex items-center gap-1 px-2 py-1 text-[11px] text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)] disabled:opacity-20 border border-[var(--color-border)] hover:bg-[var(--color-surface-muted)] transition-colors touch-manipulation"
                                aria-label={prevDeckLabel || "Previous deck"}
                                title={prevDeckLabel || "Previous deck"}
                            >
                                <ChevronsLeft className="w-3.5 h-3.5" />
                                <span className="hidden sm:inline">Prev</span>
                            </button>
                            <button
                                type="button"
                                onClick={onNextDeck}
                                disabled={!hasNextDeck}
                                className="inline-flex items-center gap-1 px-2 py-1 text-[11px] text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)] disabled:opacity-20 border border-[var(--color-border)] hover:bg-[var(--color-surface-muted)] transition-colors touch-manipulation"
                                aria-label={nextDeckLabel || "Next deck"}
                                title={nextDeckLabel || "Next deck"}
                            >
                                <span className="hidden sm:inline">Next</span>
                                <ChevronsRight className="w-3.5 h-3.5" />
                            </button>
                        </div>
                    )}
                </div>
            )}

            {/* Stack Viewport: No padding-bottom on the relative container so inset-0 matches topCard exactly */}
            <div
                className="relative w-full my-1 overflow-visible"
                style={{ width: "100%", minHeight: "360px" }}
            >
                {isFinished ? (
                    /* Completion Card in Native Theorem Swiss Style */
                    <div
                        className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-8 sm:p-12 shadow-xl dark:shadow-2xl w-full min-h-[380px] flex flex-col items-center justify-center text-center"
                    >
                        <div className="w-12 h-12 rounded-2xl bg-[var(--color-surface-muted)] border border-[var(--color-border)] flex items-center justify-center mb-4 text-[color:var(--color-accent)] shadow-xs">
                            <Check className="w-6 h-6 stroke-[2]" />
                        </div>

                        <h3 className="font-serif text-2xl sm:text-3xl text-[color:var(--color-text-primary)] mb-2 font-normal">
                            {completionTitle}
                        </h3>

                        <p className="font-sans text-xs sm:text-sm text-[color:var(--color-text-secondary)] leading-relaxed max-w-[26rem] mx-auto mb-6">
                            {completionDescription || `You have reviewed all ${cards.length} ${cards.length === 1 ? "highlight" : "highlights"}. A fresh deck will be curated tomorrow.`}
                        </p>

                        <div className="flex items-center gap-3">
                            <button
                                type="button"
                                onClick={handleRestart}
                                className="ui-btn text-xs px-3.5 py-1.5 flex items-center gap-1.5"
                            >
                                <RotateCcw className="w-3.5 h-3.5" />
                                <span>Review Again</span>
                            </button>

                            {(onCompletionAction || onClose) && (
                                <button
                                    type="button"
                                    onClick={onCompletionAction || onClose}
                                    className="ui-btn-primary text-xs px-4 py-1.5 flex items-center gap-1.5"
                                >
                                    <CheckCircle2 className="w-3.5 h-3.5" />
                                    <span>{completionActionLabel}</span>
                                </button>
                            )}
                        </div>
                    </div>
                ) : cards.length === 0 ? (
                    <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-8 flex flex-col items-center justify-center text-center w-full min-h-[380px]">
                        <p className="font-serif text-lg text-[color:var(--color-text-primary)] mb-1">No Highlights Yet</p>
                        <p className="font-sans text-xs text-[color:var(--color-text-muted)] max-w-[20rem] mx-auto">
                            Highlight passages while reading books or RSS feeds to review them here.
                        </p>
                    </div>
                ) : (
                    <>
                        {/* Background Card 5 (Base Layer 4) */}
                        {fifthCard && (
                            <div
                                className="absolute inset-0 rounded-2xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-muted)] pointer-events-none select-none overflow-hidden"
                                style={{
                                    transformOrigin: "bottom center",
                                    transform: `translate3d(0, ${24 - 6 * dragProgress}px, 0) scale(${0.92 + 0.02 * dragProgress})`,
                                    opacity: 0.45 + 0.2 * dragProgress,
                                    zIndex: 1,
                                    boxShadow: "0 4px 10px -2px rgba(0,0,0,0.12)",
                                    userSelect: "none",
                                    WebkitUserSelect: "none",
                                    transition: isDragging
                                        ? "none"
                                        : isReturning
                                        ? "none"
                                        : "transform 260ms cubic-bezier(0.16, 1, 0.3, 1), opacity 220ms ease-out",
                                }}
                            />
                        )}

                        {/* Background Card 4 (Base Layer 3) */}
                        {fourthCard && (
                            <div
                                className="absolute inset-0 rounded-2xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-muted)] pointer-events-none select-none overflow-hidden"
                                style={{
                                    transformOrigin: "bottom center",
                                    transform: `translate3d(0, ${18 - 6 * dragProgress}px, 0) scale(${0.94 + 0.02 * dragProgress})`,
                                    opacity: 0.6 + 0.2 * dragProgress,
                                    zIndex: 2,
                                    boxShadow: "0 6px 14px -3px rgba(0,0,0,0.14)",
                                    userSelect: "none",
                                    WebkitUserSelect: "none",
                                    transition: isDragging
                                        ? "none"
                                        : isReturning
                                        ? "none"
                                        : "transform 260ms cubic-bezier(0.16, 1, 0.3, 1), opacity 220ms ease-out",
                                }}
                            />
                        )}

                        {/* Background Card 3 (Middle Layer 2) */}
                        {thirdCard && (
                            <div
                                className="absolute inset-0 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] pointer-events-none select-none overflow-hidden"
                                style={{
                                    transformOrigin: "bottom center",
                                    transform: `translate3d(0, ${12 - 6 * dragProgress}px, 0) scale(${0.96 + 0.02 * dragProgress})`,
                                    opacity: 0.75 + 0.15 * dragProgress,
                                    zIndex: 3,
                                    boxShadow: "0 8px 18px -3px rgba(0,0,0,0.16)",
                                    userSelect: "none",
                                    WebkitUserSelect: "none",
                                    transition: isDragging
                                        ? "none"
                                        : isReturning
                                        ? "none"
                                        : "transform 260ms cubic-bezier(0.16, 1, 0.3, 1), opacity 220ms ease-out",
                                }}
                            />
                        )}

                        {/* Background Card 2 (Next Card Layer 1) */}
                        {nextCard && (
                            <div
                                className="absolute inset-0 rounded-2xl border bg-[var(--color-surface)] pointer-events-none overflow-hidden flex flex-col justify-between p-6 sm:p-8 select-none"
                                style={{
                                    borderColor: nextColor.border,
                                    transformOrigin: "bottom center",
                                    transform: `translate3d(0, ${6 - 6 * dragProgress}px, 0) scale(${0.98 + 0.02 * dragProgress})`,
                                    opacity: 0.92 + 0.08 * dragProgress,
                                    zIndex: 4,
                                    boxShadow: "0 10px 22px -4px rgba(0,0,0,0.18)",
                                    userSelect: "none",
                                    WebkitUserSelect: "none",
                                    transition: isDragging
                                        ? "none"
                                        : isReturning
                                        ? "none"
                                        : "transform 260ms cubic-bezier(0.16, 1, 0.3, 1), opacity 220ms ease-out",
                                }}
                            >
                                <div
                                    className="absolute inset-0 pointer-events-none opacity-60"
                                    style={{ backgroundColor: nextColor.bgWash }}
                                />

                                {/* Body & Footer: Content reveals as top card is dragged away */}
                                <div
                                    className="relative z-1 flex-1 flex flex-col justify-between overflow-hidden transition-opacity duration-150"
                                    style={{ opacity: isDragging || flingDirection ? dragProgress : 0 }}
                                >
                                    <div className="py-4 flex-1 flex flex-col justify-center overflow-hidden">
                                        {nextCard.type === "bookmark" ? (
                                            <div className="flex flex-col items-center justify-center text-center">
                                                <div
                                                    className="w-10 h-10 rounded-xl flex items-center justify-center bg-[var(--color-surface)] border text-[color:var(--color-accent)] mb-2 shadow-xs"
                                                    style={{ borderColor: "var(--color-border-subtle)", color: nextColor.accent }}
                                                >
                                                    <Bookmark className="w-5 h-5 fill-current" />
                                                </div>
                                                <p className="font-serif text-sm font-medium text-[color:var(--color-text-primary)] line-clamp-1">
                                                    {nextCard.chapterTitle || "Bookmark"}
                                                </p>
                                            </div>
                                        ) : nextCard.selectedText ? (
                                            <blockquote
                                                className="font-serif text-[1.12rem] sm:text-[1.24rem] leading-relaxed text-[color:var(--color-text-primary)] line-clamp-4 text-center select-none"
                                                style={{ userSelect: "none", WebkitUserSelect: "none" }}
                                            >
                                                “{nextCard.selectedText}”
                                            </blockquote>
                                        ) : null}
                                    </div>

                                    {/* Footer: Book name in small letter */}
                                    <div
                                        className="pt-3 border-t flex items-center justify-center text-center shrink-0 select-none"
                                        style={{ borderColor: "var(--color-border-subtle)" }}
                                    >
                                        <span className="text-xs font-sans text-[color:var(--color-text-muted)] truncate max-w-full">
                                            {nextSource?.title ? `${nextSource.title}${nextSource.author ? ` · ${nextSource.author}` : ""}` : "Unknown source"}
                                        </span>
                                    </div>
                                </div>
                            </div>
                        )}

                        {/* Top Active Card: In-Flow Single Unified Card */}
                        <div
                            key={topCard.id}
                            onPointerDown={handlePointerDown}
                            onPointerMove={handlePointerMove}
                            onPointerUp={handlePointerUp}
                            onPointerCancel={handlePointerUp}
                            onClick={handleCardClick}
                            className={cn(
                                "relative w-full rounded-2xl border bg-[var(--color-surface)] p-6 sm:p-8 flex flex-col justify-between overflow-hidden touch-none select-none z-10 cursor-grab active:cursor-grabbing shadow-xl dark:shadow-2xl"
                            )}
                            style={{
                                width: "100%",
                                minHeight: "380px",
                                borderColor: topColor.border,
                                transformOrigin: "top center",
                                transform: topTransform,
                                opacity: topOpacity,
                                userSelect: "none",
                                WebkitUserSelect: "none",
                                transition: isDragging
                                    ? "none"
                                    : isReturning
                                    ? "none"
                                    : "transform 260ms cubic-bezier(0.16, 1, 0.3, 1), opacity 220ms ease-out",
                            }}
                        >
                            {/* Ambient tint wash overlay across card face */}
                            <div
                                className="absolute inset-0 pointer-events-none transition-colors"
                                style={{ backgroundColor: topColor.bgWash }}
                            />

                            {/* Card Body: Dedicated Bookmark vs Highlight/Note View */}
                            <div className="relative z-1 py-4 sm:py-6 flex-1 min-h-[180px] flex flex-col justify-center overflow-hidden select-none">
                                {topCard.type === "bookmark" ? (
                                    <div className="flex flex-col items-center justify-center text-center my-auto">
                                        <div
                                            className="w-14 h-14 rounded-2xl flex items-center justify-center bg-[var(--color-surface)] border shadow-xs mb-3 text-[color:var(--color-accent)]"
                                            style={{ color: topColor.accent, borderColor: topColor.border }}
                                        >
                                            <Bookmark className="w-7 h-7 fill-current" />
                                        </div>

                                        <h3 className="font-serif text-xl sm:text-2xl text-[color:var(--color-text-primary)] font-medium text-center leading-snug mb-2 max-w-[28rem] px-2">
                                            {topCard.chapterTitle || "Bookmark"}
                                        </h3>

                                        {topCard.pageNumber ? (
                                            <p className="font-mono text-xs text-[color:var(--color-text-muted)] text-center mb-4">
                                                {bookmarkPositionLabel(topCard)}
                                            </p>
                                        ) : null}

                                        {topCard.noteContent && (
                                            <div
                                                className="bg-[var(--color-surface)]/80 border rounded-xl p-3 max-w-[24rem] mx-auto mb-4 text-xs font-sans text-[color:var(--color-text-primary)]"
                                                style={{ borderColor: topColor.borderSubtle }}
                                            >
                                                {topCard.noteContent}
                                            </div>
                                        )}

                                        <button
                                            type="button"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                onClose?.();
                                                onGoToSource(topCard.bookId, topCard.location);
                                            }}
                                            className="ui-btn-primary mx-auto text-xs px-5 py-2 rounded-xl flex items-center gap-2 shadow-sm cursor-pointer hover:scale-[1.02] active:scale-[0.98] transition-all"
                                        >
                                            <BookOpen className="w-4 h-4" />
                                            <span>Jump to Bookmark</span>
                                        </button>
                                    </div>
                                ) : (
                                    <>
                                        {topCard.chapterTitle && (
                                            <div className="relative z-1 mb-2.5 text-[10px] font-mono uppercase tracking-widest text-[color:var(--color-text-muted)] text-center">
                                                {topCard.chapterTitle}
                                            </div>
                                        )}

                                        {topCard.selectedText ? (
                                            <blockquote
                                                className="relative z-1 leading-relaxed font-serif text-[1.18rem] sm:text-[1.38rem] text-[color:var(--color-text-primary)] text-center select-none max-w-[34rem] mx-auto my-auto"
                                                style={{ userSelect: "none", WebkitUserSelect: "none" }}
                                            >
                                                “{topCard.selectedText}”
                                            </blockquote>
                                        ) : !topCard.noteContent ? (
                                            <p
                                                className="relative z-1 font-serif text-base sm:text-lg text-[color:var(--color-text-secondary)] italic text-center select-none"
                                                style={{ userSelect: "none", WebkitUserSelect: "none" }}
                                            >
                                                Highlight at {topCard.chapterTitle || "saved location"}
                                            </p>
                                        ) : null}

                                        {topCard.noteContent && (
                                            <div
                                                className="relative z-1 mt-4 pt-3 border-t select-none max-w-[32rem] mx-auto w-full"
                                                style={{ borderColor: topColor.borderSubtle }}
                                            >
                                                <div className="flex items-center gap-1 text-[10px] font-mono uppercase tracking-wider text-[color:var(--color-text-muted)] mb-1">
                                                    <StickyNote className="w-3 h-3" /> Personal Note
                                                </div>
                                                <p
                                                    className="font-sans text-xs sm:text-sm leading-relaxed text-[color:var(--color-text-secondary)] whitespace-pre-wrap select-none"
                                                    style={{ userSelect: "none", WebkitUserSelect: "none" }}
                                                >
                                                    {topCard.noteContent}
                                                </p>
                                            </div>
                                        )}
                                    </>
                                )}
                            </div>

                            {/* Card Footer: Book name in small letter */}
                            <div
                                className="relative z-1 pt-3 border-t flex items-center justify-center text-center shrink-0 select-none"
                                style={{ borderColor: topColor.borderSubtle }}
                            >
                                <span
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onClose?.();
                                        onGoToSource(topCard.bookId, topCard.location);
                                    }}
                                    className="text-xs font-sans text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-accent)] hover:underline transition-colors cursor-pointer truncate max-w-full"
                                    title="Open in Reader"
                                >
                                    {topSource?.title ? `${topSource.title}${topSource.author ? ` · ${topSource.author}` : ""}` : "Unknown source"}
                                </span>
                            </div>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}
