
import { useCallback, useMemo, useState, useRef, memo } from "react";
import { List, Play, Pause, Square, Headphones, Download, SlidersHorizontal } from "lucide-react";
import { cn } from "../../../../core/lib/utils";
import { Spinner } from "../../../../ui";
import type { TocItem, DocLocation } from "../../../../core/types";
import { NEURAL_VOICES, NEURAL_VOICE_LABELS, resolveNeuralVoice, type NeuralVoice } from "../../audio/ImmersionPlayer";

interface ReaderNavbarProps {
    location: DocLocation | null;
    toc: TocItem[];
    sectionFractions: number[];
    onSeek: (fraction: number) => void;
    totalPages?: number;
    onToggleToc: () => void;
    className?: string;
    immersionMode?: boolean;
    ttsState?: 'idle' | 'loading' | 'playing' | 'paused';
    onTtsPlay?: () => void;
    onTtsPause?: () => void;
    onTtsStop?: () => void;
    /** Neural voice engine is installed (desktop). Enables voice/speed controls. */
    neuralReady?: boolean;
    /** Desktop without the neural engine — offer the one-time download. */
    showNeuralInstall?: boolean;
    ttsVoice?: string;
    ttsSpeed?: number;
    onTtsVoiceChange?: (voice: string) => void;
    onTtsSpeedChange?: (speed: number) => void;
    onOpenNeuralSettings?: () => void;
}

const AVERAGE_WPM = 225;

const WORDS_PER_PAGE = 250;

function formatTimeRemaining(minutes: number): string {
    if (minutes < 1) {
        return "< 1 min left";
    }
    if (minutes < 60) {
        return `${Math.round(minutes)} min left`;
    }
    const hours = Math.floor(minutes / 60);
    const remainingMins = Math.round(minutes % 60);
    if (remainingMins === 0) {
        return `${hours} hr left`;
    }
    return `${hours} hr ${remainingMins} min left`;
}

function calculateTimeRemaining(
    currentProgress: number,
    totalPages: number
): number {
    if (totalPages <= 0 || currentProgress >= 1) return 0;

    const pagesRemaining = Math.ceil(totalPages * (1 - currentProgress));
    const wordsRemaining = pagesRemaining * WORDS_PER_PAGE;
    const minutesRemaining = wordsRemaining / AVERAGE_WPM;

    return minutesRemaining;
}

export const ReaderNavbar = memo(function ReaderNavbar({
    location,
    toc,
    sectionFractions,
    onSeek,
    totalPages,
    onToggleToc,
    className,
    immersionMode,
    ttsState = 'idle',
    onTtsPlay,
    onTtsPause,
    onTtsStop,
    neuralReady,
    showNeuralInstall,
    ttsVoice,
    ttsSpeed,
    onTtsVoiceChange,
    onTtsSpeedChange,
    onOpenNeuralSettings,
}: ReaderNavbarProps) {
    const [isDragging, setIsDragging] = useState(false);
    const [hoverFraction, setHoverFraction] = useState<number | null>(null);
    const [dragFraction, setDragFraction] = useState<number | null>(null);
    const [voiceMenuOpen, setVoiceMenuOpen] = useState(false);
    const trackRef = useRef<HTMLDivElement>(null);
    const activeVoice: NeuralVoice = resolveNeuralVoice(ttsVoice);

    const normalizedSectionFractions = useMemo(() => {
        if (sectionFractions.length === 0) {
            return [];
        }

        const normalized: number[] = [];
        let last = -1;
        for (const fraction of sectionFractions) {
            if (!Number.isFinite(fraction)) {
                continue;
            }
            const clamped = Math.max(0, Math.min(1, fraction));
            if (clamped + 1e-6 < last) {
                continue;
            }
            if (Math.abs(clamped - last) < 1e-4) {
                continue;
            }
            normalized.push(clamped);
            last = clamped;
        }
        return normalized;
    }, [sectionFractions]);

    const progress = useMemo(() => {
        const percentage = typeof location?.percentage === "number" && Number.isFinite(location.percentage)
            ? Math.max(0, Math.min(1, location.percentage))
            : 0;
        const pageInfo = location?.pageInfo;
        if (pageInfo && pageInfo.totalPages > 1) {
            const pageFraction = (pageInfo.currentPage - 1) / (pageInfo.totalPages - 1);
            if (Number.isFinite(pageFraction)) {
                return Math.max(0, Math.min(1, pageFraction));
            }
        }
        return percentage;
    }, [location?.percentage, location?.pageInfo?.currentPage, location?.pageInfo?.totalPages]);

    const displayFraction = isDragging && dragFraction !== null ? dragFraction : progress;

    const getSectionLabelForFraction = useCallback((fraction: number): string | null => {
        if (toc.length === 0) {
            return null;
        }
        if (normalizedSectionFractions.length === 0) {
            return toc[0]?.label ?? null;
        }
        for (let i = normalizedSectionFractions.length - 1; i >= 0; i--) {
            if (normalizedSectionFractions[i] <= fraction) {
                const tocIndex = Math.max(0, Math.min(i, toc.length - 1));
                return toc[tocIndex]?.label ?? null;
            }
        }
        return toc[0]?.label ?? null;
    }, [toc, normalizedSectionFractions]);

    const currentSectionLabel = useMemo(() => {
        if (location?.tocItem?.label) {
            return location.tocItem.label;
        }
        return getSectionLabelForFraction(progress) ?? "";
    }, [location?.tocItem?.label, getSectionLabelForFraction, progress]);

    const hoveredSectionLabel = useMemo(() => {
        if (hoverFraction === null) return null;
        return getSectionLabelForFraction(hoverFraction);
    }, [hoverFraction, getSectionLabelForFraction]);

    const timeRemaining = useMemo(() => {
        const pages = totalPages ?? location?.pageInfo?.totalPages ?? 0;
        if (pages <= 0) return null;
        return formatTimeRemaining(calculateTimeRemaining(progress, pages));
    }, [progress, totalPages, location?.pageInfo?.totalPages]);

    const progressText = useMemo(() => {
        const pct = Math.round(displayFraction * 100);
        return `${pct}%`;
    }, [displayFraction]);

    const getFractionFromEvent = useCallback(
        (clientX: number): number => {
            const track = trackRef.current;
            if (!track) return 0;

            const rect = track.getBoundingClientRect();
            const x = clientX - rect.left;
            const fraction = Math.max(0, Math.min(1, x / rect.width));
            return fraction;
        },
        []
    );

    const handlePointerDown = useCallback(
        (e: React.PointerEvent) => {
            e.preventDefault();
            const fraction = getFractionFromEvent(e.clientX);
            setIsDragging(true);
            setDragFraction(fraction);
            (e.target as HTMLElement).setPointerCapture(e.pointerId);
        },
        [getFractionFromEvent]
    );

    const handlePointerMove = useCallback(
        (e: React.PointerEvent) => {
            const fraction = getFractionFromEvent(e.clientX);
            if (isDragging) {
                setDragFraction(fraction);
            } else {
                setHoverFraction(fraction);
            }
        },
        [getFractionFromEvent, isDragging]
    );

    const handlePointerUp = useCallback(
        (e: React.PointerEvent) => {
            if (isDragging && dragFraction !== null) {
                onSeek(dragFraction);
            }
            setIsDragging(false);
            setDragFraction(null);
            (e.target as HTMLElement).releasePointerCapture(e.pointerId);
        },
        [isDragging, dragFraction, onSeek]
    );

    const handlePointerLeave = useCallback(() => {
        if (!isDragging) {
            setHoverFraction(null);
        }
    }, [isDragging]);

    const handleClick = useCallback(
        (e: React.MouseEvent) => {
            if (isDragging) return;
            const fraction = getFractionFromEvent(e.clientX);
            onSeek(fraction);
        },
        [isDragging, getFractionFromEvent, onSeek]
    );

    const sectionMarkers = useMemo(() => {
        if (normalizedSectionFractions.length === 0) return null;

        return normalizedSectionFractions.map((fraction, index) => {
            
            if (fraction < 0.01) return null;
            
            if (fraction > 0.99) return null;
            
            if (index > 0 && fraction - normalizedSectionFractions[index - 1] < 0.02) return null;

            return (
                <div
                    key={index}
                    className="absolute top-1/2 -translate-y-1/2 w-px h-2 bg-[var(--color-text-muted)]/40"
                    style={{ left: `${fraction * 100}%` }}
                />
            );
        });
    }, [normalizedSectionFractions]);

    const tooltipContent = useMemo(() => {
        if (hoverFraction === null && !isDragging) return null;

        const fraction = isDragging ? dragFraction : hoverFraction;
        if (fraction === null) return null;

        const pct = Math.round(fraction * 100);
        return (
            <div className="text-center">
                <div className="font-medium">{pct}%</div>
                {hoveredSectionLabel && (
                    <div className="text-[color:var(--color-text-muted)] text-xs max-w-[var(--layout-tooltip-max-width)] truncate">
                        {hoveredSectionLabel}
                    </div>
                )}
            </div>
        );
    }, [hoverFraction, isDragging, dragFraction, hoveredSectionLabel]);

    const tooltipPosition = isDragging ? dragFraction : hoverFraction;

    return (
        <div
            className={cn(
                "flex flex-col gap-0.5 px-3 py-1 sm:px-4",
                "border-t border-[var(--color-border)] bg-[var(--color-surface)]",
                className
            )}
            style={{
                paddingBottom: "max(0.25rem, env(safe-area-inset-bottom))",
            }}
        >
            
            <div className="flex items-center gap-1.5">
                <button
                    onClick={onToggleToc}
                    className="flex items-center justify-center p-1 -ml-1 text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)] hover:bg-[var(--color-surface-hover)] transition-colors h-7 w-7 rounded-md"
                    aria-label="Table of Contents"
                >
                    <List size={16} />
                </button>

                {immersionMode ? (
                    <div className="flex-1 flex items-center gap-1.5 min-w-0">
                        <Headphones className={cn(
                            'w-3.5 h-3.5 shrink-0 transition-colors',
                            ttsState === 'playing' || ttsState === 'loading' ? 'text-[color:var(--color-accent)]' : 'text-[color:var(--color-text-muted)]'
                        )} />
                        {ttsState === 'loading' && (
                            <Spinner size="sm" tone="accent" label="Preparing text-to-speech" className="shrink-0" />
                        )}
                        {ttsState === 'playing' && (
                            <div className="flex items-end gap-[2px] h-3.5 shrink-0">
                                {[0, 1, 2].map((i) => (
                                    <div
                                        key={i}
                                        className="w-[2.5px] rounded-full bg-[var(--color-accent)]"
                                        style={{
                                            animation: `tts-bar-bounce 0.6s ease-in-out ${i * 0.12}s infinite alternate`,
                                            height: `${50 + i * 25}%`,
                                        }}
                                    />
                                ))}
                            </div>
                        )}
                        <span className="text-[10px] sm:text-xs text-[var(--color-text-muted)] truncate">
                            {ttsState === 'playing' ? 'Reading aloud' : ttsState === 'paused' ? 'Paused' : ttsState === 'loading' ? 'Loading...' : 'Immersion Reading'}
                        </span>
                        <div className="flex items-center gap-1 ml-auto shrink-0">
                            {showNeuralInstall && onOpenNeuralSettings && (
                                <button
                                    onClick={onOpenNeuralSettings}
                                    className="flex items-center justify-center w-7 h-7 rounded-full bg-[var(--color-surface-muted)] text-[var(--color-text-secondary)] hover:bg-[var(--color-overlay-subtle)] hover:text-[color:var(--color-accent)] active:scale-90 transition-colors"
                                    title="Install Neural Voice for natural offline reading"
                                    aria-label="Install Neural Voice"
                                >
                                    <Download className="w-3 h-3" />
                                </button>
                            )}
                            {neuralReady && onTtsVoiceChange && (
                                <div className="relative">
                                    <button
                                        onClick={() => setVoiceMenuOpen(v => !v)}
                                        className={cn(
                                            "flex items-center justify-center w-7 h-7 rounded-full transition-colors active:scale-90",
                                            voiceMenuOpen
                                                ? "bg-[var(--color-accent)] text-[var(--color-accent-contrast)]"
                                                : "bg-[var(--color-surface-muted)] text-[var(--color-text-secondary)] hover:bg-[var(--color-overlay-subtle)]",
                                        )}
                                        title="Voice & speed"
                                        aria-label="Voice and speed settings"
                                    >
                                        <SlidersHorizontal className="w-3 h-3" />
                                    </button>
                                    {voiceMenuOpen && (
                                        <>
                                            <div className="fixed inset-0 z-[141]" onClick={() => setVoiceMenuOpen(false)} />
                                            <div className="absolute bottom-9 right-0 z-[142] w-56 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3 shadow-[0_8px_32px_rgba(0,0,0,0.18)]">
                                                <div className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)] mb-1.5">Voice</div>
                                                <div className="grid grid-cols-5 gap-1">
                                                    {NEURAL_VOICES.map((v) => (
                                                        <button
                                                            key={v}
                                                            title={NEURAL_VOICE_LABELS[v]}
                                                            onClick={() => onTtsVoiceChange(v)}
                                                            className={cn(
                                                                "h-7 rounded-md text-[10px] font-medium transition-colors",
                                                                activeVoice === v
                                                                    ? "bg-[var(--color-accent)] text-[var(--color-accent-contrast)]"
                                                                    : "bg-[var(--color-surface-muted)] text-[var(--color-text-secondary)] hover:bg-[var(--color-overlay-subtle)]",
                                                            )}
                                                        >
                                                            {v}
                                                        </button>
                                                    ))}
                                                </div>
                                                <div className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)] mt-2.5 mb-1.5">Speed</div>
                                                <div className="flex gap-1">
                                                    {[0.75, 1, 1.25, 1.5].map((s) => (
                                                        <button
                                                            key={s}
                                                            onClick={() => onTtsSpeedChange?.(s)}
                                                            className={cn(
                                                                "flex-1 h-7 rounded-md text-[10px] font-medium transition-colors",
                                                                ttsSpeed === s
                                                                    ? "bg-[var(--color-accent)] text-[var(--color-accent-contrast)]"
                                                                    : "bg-[var(--color-surface-muted)] text-[var(--color-text-secondary)] hover:bg-[var(--color-overlay-subtle)]",
                                                            )}
                                                        >
                                                            {s}×
                                                        </button>
                                                    ))}
                                                </div>
                                            </div>
                                        </>
                                    )}
                                </div>
                            )}
                            {ttsState === 'playing' ? (
                                <>
                                    <button onClick={onTtsPause}
                                        className="flex items-center justify-center w-7 h-7 rounded-full bg-[var(--color-surface-muted)] text-[var(--color-text-primary)] hover:bg-[var(--color-overlay-subtle)] active:scale-90 transition-colors"
                                        aria-label="Pause">
                                        <Pause className="w-3 h-3 fill-current" />
                                    </button>
                                    <button onClick={onTtsStop}
                                        className="flex items-center justify-center w-7 h-7 rounded-full bg-[var(--color-surface-muted)] text-[var(--color-text-secondary)] hover:bg-[var(--color-overlay-subtle)] hover:text-[var(--color-error)] active:scale-90 transition-colors"
                                        aria-label="Stop">
                                        <Square className="w-3 h-3 fill-current" />
                                    </button>
                                </>
                            ) : (
                                <button onClick={onTtsPlay} disabled={ttsState === 'loading'}
                                    className="flex items-center justify-center w-7 h-7 rounded-full bg-[var(--color-accent)] text-[var(--color-accent-contrast)] hover:bg-[var(--color-accent-hover)] active:scale-90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                                    aria-label="Play">
                                    <Play className="w-3 h-3 fill-current" />
                                </button>
                            )}
                        </div>
                    </div>
                ) : (
                    <div className="flex-1 flex items-center justify-between gap-1 text-[10px] sm:text-xs text-[var(--color-text-muted)] min-w-0">
                        <span
                            className="truncate max-w-[55%]"
                            title={currentSectionLabel}
                        >
                            {currentSectionLabel}
                        </span>
                        <div className="flex items-center gap-2 shrink-0">
                            {timeRemaining && (
                                <span className="hidden sm:inline text-[var(--color-text-muted)]">{timeRemaining}</span>
                            )}
                            <span className="font-medium text-[var(--color-text-primary)] font-mono text-[11px] sm:text-xs">
                                {progressText}
                            </span>
                        </div>
                    </div>
                )}
            </div>

            {!immersionMode && (
                <div
                    ref={trackRef}
                    className={cn(
                        "relative h-3.5 cursor-pointer select-none",
                        "flex items-center",
                        isDragging && "cursor-grabbing"
                    )}
                    onClick={handleClick}
                    onPointerDown={handlePointerDown}
                    onPointerMove={handlePointerMove}
                    onPointerUp={handlePointerUp}
                    onPointerLeave={handlePointerLeave}
                >
                    
                    <div className="absolute inset-x-0 h-[3px] bg-[var(--color-surface-variant)] overflow-hidden rounded-full">
                        
                        <div
                            className={cn(
                                "h-full bg-[var(--color-accent)]",
                                !isDragging && "transition-[width] duration-150"
                            )}
                            style={{ width: `${displayFraction * 100}%` }}
                        />
                    </div>

                    {sectionMarkers}

                    <div
                        className={cn(
                            "absolute top-1/2 -translate-y-1/2 -translate-x-1/2",
                            "w-2.5 h-2.5 rounded-full",
                            "bg-[var(--color-accent)]",
                            "border border-[var(--color-surface)] shadow-sm",
                            isDragging ? "scale-125" : "transition-transform",
                            "pointer-events-none"
                        )}
                        style={{ left: `${displayFraction * 100}%` }}
                    />

                    {(hoverFraction !== null || isDragging) && tooltipPosition !== null && (
                        <div
                            className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-0.5 h-2.5 bg-[var(--color-accent)]/50 pointer-events-none"
                            style={{ left: `${tooltipPosition * 100}%` }}
                        />
                    )}

                    {tooltipContent && tooltipPosition !== null && (
                        <div
                            className={cn(
                                "absolute bottom-full mb-2 -translate-x-1/2",
                                "px-2 py-1",
                                "bg-[var(--color-surface)] border border-[var(--color-border)] rounded-md shadow-md",
                                "text-xs",
                                "pointer-events-none z-50",
                                "whitespace-nowrap"
                            )}
                            style={{ left: `${tooltipPosition * 100}%` }}
                        >
                            {tooltipContent}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
});

export default ReaderNavbar;
