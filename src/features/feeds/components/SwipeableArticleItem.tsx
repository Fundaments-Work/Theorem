import React, { useState, useRef, useCallback } from "react";
import { CheckCheck, Trash2 } from "lucide-react";
import { cn } from "../../../core/lib/utils";

export interface SwipeableArticleItemProps {
    children: React.ReactNode;
    onSwipeRight?: () => void;
    onSwipeLeft?: () => void;
    rightLabel?: string;
    rightIcon?: React.ReactNode;
    leftLabel?: string;
    leftIcon?: React.ReactNode;
    threshold?: number;
    disabled?: boolean;
    className?: string;
}

const DEFAULT_THRESHOLD = 72;
const MAX_SWIPE_DISTANCE = 160;
const DRAG_DEADZONE = 8;

export function SwipeableArticleItem({
    children,
    onSwipeRight,
    onSwipeLeft,
    rightLabel = "Mark Read",
    rightIcon,
    leftLabel = "Delete",
    leftIcon,
    threshold = DEFAULT_THRESHOLD,
    disabled = false,
    className,
}: SwipeableArticleItemProps) {
    const [offset, setOffset] = useState(0);
    const [isDragging, setIsDragging] = useState(false);
    const [isExiting, setIsExiting] = useState(false);

    const startXRef = useRef(0);
    const startYRef = useRef(0);
    const pointerIdRef = useRef<number | null>(null);
    const directionRef = useRef<"horizontal" | "vertical" | null>(null);
    const isTrackingRef = useRef(false);
    const wasSwipedRef = useRef(false);
    const containerRef = useRef<HTMLDivElement>(null);

    const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        if (disabled || isExiting) return;
        if (!e.isPrimary) return;

        // Ignore interactive targets inside the card
        const target = e.target as HTMLElement | null;
        if (target?.closest('button, a, input, textarea, select, [role="button"], [data-no-swipe]')) {
            return;
        }

        // Clear any text selection that might have started
        window.getSelection()?.removeAllRanges();

        isTrackingRef.current = true;
        pointerIdRef.current = e.pointerId;
        startXRef.current = e.clientX;
        startYRef.current = e.clientY;
        directionRef.current = null;
        wasSwipedRef.current = false;
    }, [disabled, isExiting]);

    const handlePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        if (!isTrackingRef.current || pointerIdRef.current !== e.pointerId || isExiting) return;

        const dx = e.clientX - startXRef.current;
        const dy = e.clientY - startYRef.current;

        // Determine gesture direction
        if (directionRef.current === null) {
            const distance = Math.hypot(dx, dy);
            if (distance < DRAG_DEADZONE) return;

            if (Math.abs(dy) > Math.abs(dx)) {
                // Vertical scroll takes priority
                directionRef.current = "vertical";
                isTrackingRef.current = false;
                return;
            }

            directionRef.current = "horizontal";
            setIsDragging(true);
            try {
                containerRef.current?.setPointerCapture?.(e.pointerId);
            } catch {
                // Pointer capture may fail on some browsers/platforms
            }
        }

        if (directionRef.current === "horizontal") {
            // Apply rubber-banding resistance past MAX_SWIPE_DISTANCE
            let clampedDx = dx;
            if (clampedDx > 0) {
                if (!onSwipeRight) {
                    clampedDx = 0;
                } else if (clampedDx > MAX_SWIPE_DISTANCE) {
                    clampedDx = MAX_SWIPE_DISTANCE + (clampedDx - MAX_SWIPE_DISTANCE) * 0.2;
                }
            } else if (clampedDx < 0) {
                if (!onSwipeLeft) {
                    clampedDx = 0;
                } else if (clampedDx < -MAX_SWIPE_DISTANCE) {
                    clampedDx = -MAX_SWIPE_DISTANCE + (clampedDx + MAX_SWIPE_DISTANCE) * 0.2;
                }
            }

            setOffset(clampedDx);
        }
    }, [onSwipeRight, onSwipeLeft, isExiting]);

    const handlePointerEnd = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        if (pointerIdRef.current !== e.pointerId) return;

        const activeDirection = directionRef.current;
        const currentOffset = offset;

        isTrackingRef.current = false;
        pointerIdRef.current = null;
        directionRef.current = null;
        setIsDragging(false);

        try {
            if (containerRef.current?.hasPointerCapture?.(e.pointerId)) {
                containerRef.current.releasePointerCapture(e.pointerId);
            }
        } catch {
            // Ignore capture release error
        }

        if (activeDirection === "horizontal" && Math.abs(currentOffset) > 10) {
            wasSwipedRef.current = true;
            setTimeout(() => {
                wasSwipedRef.current = false;
            }, 250);

            if (currentOffset >= threshold && onSwipeRight) {
                // Swipe right action (e.g. Mark Read)
                setOffset(0);
                onSwipeRight();
                return;
            }

            if (currentOffset <= -threshold && onSwipeLeft) {
                // Swipe left action (e.g. Delete)
                setIsExiting(true);
                setOffset(-window.innerWidth);
                setTimeout(() => {
                    onSwipeLeft();
                }, 200);
                return;
            }
        }

        // Return to rest position
        setOffset(0);
    }, [offset, threshold, onSwipeRight, onSwipeLeft]);

    const handleClickCapture = useCallback((e: React.MouseEvent) => {
        if (wasSwipedRef.current) {
            e.stopPropagation();
            e.preventDefault();
        }
    }, []);

    // Progress ratios for revealing icons
    const rightProgress = Math.min(1, Math.max(0, offset / threshold));
    const leftProgress = Math.min(1, Math.max(0, -offset / threshold));

    return (
        <div
            ref={containerRef}
            className={cn("relative overflow-hidden select-none", className)}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerEnd}
            onPointerCancel={handlePointerEnd}
            onClickCapture={handleClickCapture}
            style={{ touchAction: "pan-y" }}
        >
            {/* Background Revealed Actions */}
            {offset > 0 && onSwipeRight && (
                <div
                    className="absolute inset-0 flex items-center justify-start pl-5 bg-[color:var(--color-accent)]/15 text-[color:var(--color-accent)] pointer-events-none transition-colors"
                    aria-hidden="true"
                >
                    <div
                        className="flex items-center gap-2 font-sans font-medium text-xs transition-transform"
                        style={{
                            opacity: rightProgress,
                            transform: `scale(${0.75 + rightProgress * 0.25})`,
                        }}
                    >
                        {rightIcon ?? <CheckCheck className="w-4 h-4" />}
                        <span>{rightLabel}</span>
                    </div>
                </div>
            )}

            {offset < 0 && onSwipeLeft && (
                <div
                    className="absolute inset-0 flex items-center justify-end pr-5 bg-red-500/15 text-red-500 pointer-events-none transition-colors"
                    aria-hidden="true"
                >
                    <div
                        className="flex items-center gap-2 font-sans font-medium text-xs transition-transform"
                        style={{
                            opacity: leftProgress,
                            transform: `scale(${0.75 + leftProgress * 0.25})`,
                        }}
                    >
                        <span>{leftLabel}</span>
                        {leftIcon ?? <Trash2 className="w-4 h-4" />}
                    </div>
                </div>
            )}

            {/* Front Card Surface */}
            <div
                style={{
                    transform: `translate3d(${offset}px, 0, 0)`,
                    transition: isDragging ? "none" : "transform 220ms cubic-bezier(0.16, 1, 0.3, 1), opacity 200ms ease",
                    opacity: isExiting ? 0 : 1,
                    willChange: isDragging ? "transform" : "auto",
                }}
            >
                {children}
            </div>
        </div>
    );
}
