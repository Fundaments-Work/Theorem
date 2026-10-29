import React, { useState, useRef, useCallback, useEffect } from "react";
import {
    ChevronLeft, ChevronRight,
    RotateCcw, CheckCircle2, Pencil, Trash2, ChevronsLeft, ChevronsRight,
    ArrowUpRight, Check, StickyNote
} from "lucide-react";
import { cn } from "../../../core/lib/utils";
interface CardColorTheme {
    border: string;
    bgWash: string;
}

const CARD_PALETTES: CardColorTheme[] = [
    {
        border: "#e06c53", // Terracotta
        bgWash: "rgba(224, 108, 83, 0.08)",
    },
    {
        border: "#4e9b67", // Sage Green
        bgWash: "rgba(78, 155, 103, 0.08)",
    },
    {
        border: "#4f78cf", // Cobalt Blue
        bgWash: "rgba(79, 120, 207, 0.08)",
    },
    {
        border: "#d9822b", // Warm Ochre
        bgWash: "rgba(217, 130, 43, 0.08)",
    },
    {
        border: "#9b59b6", // Amethyst / Mauve
        bgWash: "rgba(155, 89, 182, 0.08)",
    },
    {
        border: "#2f9e99", // Teal
        bgWash: "rgba(47, 158, 153, 0.08)",
    },
    {
        border: "#d9536f", // Rose / Crimson
        bgWash: "rgba(217, 83, 111, 0.08)",
    },
    {
        border: "#8ba832", // Olive Lime
        bgWash: "rgba(139, 168, 50, 0.08)",
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
    onEdit,
    onDelete,
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

    const topColor = getCardColor(topCard, currentIndex);
    const nextColor = getCardColor(nextCard, currentIndex + 1);
    const thirdColor = getCardColor(thirdCard, currentIndex + 2);

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
            className="w-full max-w-[42rem] mx-auto select-none py-1"
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

            {/* Stack Viewport */}
            <div
                className="relative w-full my-1 pb-7 overflow-visible"
                style={{ width: "100%", minHeight: "360px" }}
            >
                {isFinished ? (
                    /* Completion Card in Native Theorem Swiss Style */
                    <div
                        className="border border-[var(--color-border)] bg-[var(--color-surface)] p-8 sm:p-12 flex flex-col items-center justify-center text-center w-full min-h-[360px]"
                    >
                        <div className="w-10 h-10 bg-[var(--color-surface-muted)] border border-[var(--color-border)] flex items-center justify-center mb-4 text-[color:var(--color-accent)]">
                            <Check className="w-5 h-5 stroke-[2]" />
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
                    <div className="border border-[var(--color-border)] bg-[var(--color-surface)] p-8 flex flex-col items-center justify-center text-center w-full min-h-[360px]">
                        <p className="font-serif text-lg text-[color:var(--color-text-primary)] mb-1">No Highlights Yet</p>
                        <p className="font-sans text-xs text-[color:var(--color-text-muted)] max-w-[20rem] mx-auto">
                            Highlight passages while reading books or RSS feeds to review them here.
                        </p>
                    </div>
                ) : (
                    <>
                        {/* Background Card 3 (Base of Stack) */}
                        {thirdCard && (
                            <div
                                className="absolute inset-0 border border-[var(--color-border)] pointer-events-none select-none transition-all duration-200 shadow-sm overflow-hidden bg-[var(--color-surface-muted)]"
                                style={{
                                    transformOrigin: "top center",
                                    transform: `translate3d(0, ${18 - 9 * dragProgress}px, 0) scale(${0.93 + 0.04 * dragProgress}) rotate(${-1.2 + 0.6 * dragProgress}deg)`,
                                    opacity: 0.55 + 0.35 * dragProgress,
                                    zIndex: 0,
                                    userSelect: "none",
                                    WebkitUserSelect: "none",
                                }}
                            >
                                <div className="h-1 w-full shrink-0" style={{ backgroundColor: thirdColor.border }} />
                            </div>
                        )}

                        {/* Background Card 2 (Middle of Stack / Next Card) */}
                        {nextCard && (
                            <div
                                className="absolute inset-0 border border-[var(--color-border)] shadow-md pointer-events-none transition-all duration-200 overflow-hidden flex flex-col justify-between select-none bg-[var(--color-surface)]"
                                style={{
                                    transformOrigin: "top center",
                                    transform: `translate3d(0, ${9 - 9 * dragProgress}px, 0) scale(${0.965 + 0.035 * dragProgress}) rotate(${1.0 - 1.0 * dragProgress}deg)`,
                                    opacity: 0.85 + 0.15 * dragProgress,
                                    zIndex: 1,
                                    userSelect: "none",
                                    WebkitUserSelect: "none",
                                }}
                            >
                                <div className="h-1 w-full shrink-0" style={{ backgroundColor: nextColor.border }} />
                                <div className="px-5 sm:px-8 pt-4 sm:pt-5 pb-3 border-b border-[var(--color-border-subtle)] flex items-center justify-between gap-3 shrink-0 opacity-70">
                                    <div className="flex items-center gap-2 text-xs text-[color:var(--color-text-secondary)] min-w-0">
                                        <span className="truncate font-medium text-xs text-[color:var(--color-text-primary)]">
                                            {nextSource?.title || "Unknown source"}
                                        </span>
                                        {nextSource?.author && (
                                            <>
                                                <span className="text-[color:var(--color-text-muted)] shrink-0">·</span>
                                                <span className="truncate text-xs hidden sm:inline">{nextSource.author}</span>
                                            </>
                                        )}
                                    </div>
                                    <span className="font-mono text-xs text-[color:var(--color-text-muted)] whitespace-nowrap ml-2">
                                        {currentIndex + 2} of {cards.length}
                                    </span>
                                </div>

                                <div className="relative px-5 sm:px-8 py-6 sm:py-8 flex-1 flex flex-col justify-center opacity-70 select-none overflow-hidden">
                                    <span
                                        className="absolute top-2 right-6 font-serif text-8xl select-none pointer-events-none leading-none opacity-5 dark:opacity-10 text-[color:var(--color-text-primary)]"
                                        aria-hidden="true"
                                    >
                                        ”
                                    </span>
                                    {nextCard.selectedText && (
                                        <blockquote
                                            className="font-serif text-[1.12rem] sm:text-[1.28rem] leading-relaxed text-[color:var(--color-text-primary)] select-none"
                                            style={{ userSelect: "none", WebkitUserSelect: "none" }}
                                        >
                                            {nextCard.selectedText}
                                        </blockquote>
                                    )}
                                </div>

                                <div className="px-5 sm:px-8 py-2.5 border-t border-[var(--color-border-subtle)] opacity-40 bg-[var(--color-surface-muted)]/20">
                                    <span className="text-[10px] text-[color:var(--color-text-muted)] font-mono">Next in deck</span>
                                </div>
                            </div>
                        )}

                        {/* Top Active Card: In-Flow to Guarantee Full Natural Width & Height */}
                        <div
                            key={topCard.id}
                            onPointerDown={handlePointerDown}
                            onPointerMove={handlePointerMove}
                            onPointerUp={handlePointerUp}
                            onPointerCancel={handlePointerUp}
                            onClick={handleCardClick}
                            className={cn(
                                "relative w-full border border-[var(--color-border)] bg-[var(--color-surface)] flex flex-col justify-between overflow-hidden touch-none select-none z-10 cursor-grab active:cursor-grabbing shadow-lg dark:shadow-2xl"
                            )}
                            style={{
                                width: "100%",
                                minHeight: "360px",
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
                            <div className="h-1 w-full shrink-0" style={{ backgroundColor: topColor.border }} />

                            {/* Card Header with Source Info and Progress */}
                            <div className="px-5 sm:px-8 pt-4 sm:pt-5 pb-3 border-b border-[var(--color-border-subtle)] flex items-center justify-between gap-3 shrink-0 select-none">
                                <div className="flex items-center gap-2 text-xs text-[color:var(--color-text-secondary)] min-w-0">
                                    <span className="truncate font-medium text-xs text-[color:var(--color-text-primary)]">
                                        {topSource?.title || "Unknown source"}
                                    </span>
                                    {topSource?.author && (
                                        <>
                                            <span className="text-[color:var(--color-text-muted)] shrink-0">·</span>
                                            <span className="truncate text-xs text-[color:var(--color-text-secondary)] hidden sm:inline">{topSource.author}</span>
                                        </>
                                    )}
                                </div>

                                <div className="flex items-center gap-1 font-mono text-xs text-[color:var(--color-text-muted)] whitespace-nowrap ml-2 select-none">
                                    <button
                                        type="button"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            handlePrev();
                                        }}
                                        disabled={currentIndex === 0}
                                        className="p-1 hover:text-[color:var(--color-text-primary)] disabled:opacity-20 transition-colors touch-manipulation"
                                        aria-label="Previous card"
                                    >
                                        <ChevronLeft className="w-3.5 h-3.5" />
                                    </button>
                                    <span>
                                        {currentIndex + 1} of {cards.length}
                                    </span>
                                    <button
                                        type="button"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            handleNext();
                                        }}
                                        className="p-1 hover:text-[color:var(--color-text-primary)] transition-colors touch-manipulation"
                                        aria-label="Next card"
                                    >
                                        <ChevronRight className="w-3.5 h-3.5" />
                                    </button>
                                </div>
                            </div>

                            {/* Card Body: Quote and Note */}
                            <div className="relative px-5 sm:px-8 py-6 sm:py-10 flex-1 min-h-[160px] flex flex-col justify-center overflow-hidden select-none">
                                <span
                                    className="absolute top-2 right-6 font-serif text-8xl select-none pointer-events-none leading-none opacity-5 dark:opacity-10 text-[color:var(--color-text-primary)]"
                                    aria-hidden="true"
                                >
                                    ”
                                </span>

                                {topCard.chapterTitle && (
                                    <div className="relative z-1 mb-3 text-[10px] font-mono uppercase tracking-widest text-[color:var(--color-text-muted)]">
                                        {topCard.chapterTitle}
                                    </div>
                                )}

                                {topCard.selectedText ? (
                                    <blockquote
                                        className="relative z-1 leading-relaxed font-serif text-[1.15rem] sm:text-[1.32rem] text-[color:var(--color-text-primary)] select-none"
                                        style={{ userSelect: "none", WebkitUserSelect: "none" }}
                                    >
                                        {topCard.selectedText}
                                    </blockquote>
                                ) : !topCard.noteContent ? (
                                    <p
                                        className="relative z-1 font-serif text-base sm:text-lg text-[color:var(--color-text-secondary)] italic select-none"
                                        style={{ userSelect: "none", WebkitUserSelect: "none" }}
                                    >
                                        Bookmark at {topCard.chapterTitle || "saved location"}
                                    </p>
                                ) : null}

                                {topCard.noteContent && (
                                    <div className="relative z-1 mt-5 pt-3.5 border-t border-[var(--color-border-subtle)] select-none">
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
                            </div>

                            {/* Actions row: Open in Reader, Tap hint, Edit, Delete */}
                            <div className="px-5 sm:px-8 py-3 border-t border-[var(--color-border-subtle)] flex items-center justify-between gap-2 shrink-0 bg-[var(--color-surface-muted)]/20">
                                <button
                                    type="button"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onClose?.();
                                        onGoToSource(topCard.bookId, topCard.location);
                                    }}
                                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-[color:var(--color-text-primary)] hover:text-[color:var(--color-accent)] border border-[var(--color-border)] hover:border-[var(--color-accent)] bg-[var(--color-surface)] transition-colors touch-manipulation font-medium shadow-xs"
                                    aria-label="Open in Reader"
                                >
                                    <span>Open in Reader</span>
                                    <ArrowUpRight className="w-3.5 h-3.5 text-[color:var(--color-accent)]" />
                                </button>

                                <span className="text-[10px] font-mono text-[color:var(--color-text-muted)] hidden sm:inline select-none">
                                    Tap card or swipe to advance
                                </span>

                                <div className="flex items-center gap-1">
                                    {onEdit && (
                                        <button
                                            type="button"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                onEdit(topCard.id);
                                            }}
                                            className="inline-flex items-center gap-1 px-2 py-1 text-[10px] text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)] transition-colors touch-manipulation"
                                            aria-label="Edit note"
                                        >
                                            <Pencil className="w-3 h-3" />
                                            <span className="hidden sm:inline">Edit</span>
                                        </button>
                                    )}

                                    {onDelete && (
                                        <button
                                            type="button"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                onDelete(topCard.id);
                                            }}
                                            className="inline-flex items-center gap-1 px-2 py-1 text-[10px] text-[color:var(--color-error)] hover:text-[color:var(--color-error)] transition-colors touch-manipulation"
                                            aria-label="Delete annotation"
                                        >
                                            <Trash2 className="w-3 h-3" />
                                            <span className="hidden sm:inline">Delete</span>
                                        </button>
                                    )}
                                </div>
                            </div>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}
