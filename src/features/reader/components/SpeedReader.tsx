import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { Play, Pause, X, Maximize2, Minimize2, Eye, EyeOff } from "lucide-react";
import { cn } from "../../../core/lib/utils";

interface SpeedReaderProps {
    isOpen: boolean;
    text: string;
    onClose: () => void;
    onAutoNext?: () => void;
    theme?: "light" | "sepia" | "dark";
}

function getOrpIndex(word: string): number {
    const len = word.length;
    if (len <= 1) return 0;
    if (len <= 5) return 1;
    if (len <= 9) return 2;
    if (len <= 13) return 3;
    return 4;
}

function splitWordForOrp(rawWord: string): { prefix: string; focal: string; suffix: string } {
    if (!rawWord) return { prefix: "", focal: "", suffix: "" };
    const orpIdx = getOrpIndex(rawWord);
    return {
        prefix: rawWord.slice(0, orpIdx),
        focal: rawWord[orpIdx] || "",
        suffix: rawWord.slice(orpIdx + 1),
    };
}

function getWordDelayFactor(word: string): number {
    if (!word) return 1;
    const lastChar = word[word.length - 1];
    if (lastChar === "." || lastChar === "!" || lastChar === "?" || lastChar === ":") {
        return 2.0;
    }
    if (lastChar === "," || lastChar === ";" || lastChar === "—" || lastChar === "-") {
        return 1.4;
    }
    if (word.length > 10) {
        return 1.2;
    }
    return 1.0;
}

export function SpeedReader({ isOpen, text, onClose, onAutoNext }: SpeedReaderProps) {
    const [wpm, setWpm] = useState(350);
    const [isPlaying, setIsPlaying] = useState(false);
    const [currentIndex, setCurrentIndex] = useState(0);
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [showContext, setShowContext] = useState(true);

    const wordsRef = useRef<string[]>([]);
    const timerRef = useRef<number | null>(null);
    const autoPlayRef = useRef(false);
    const activeWordRef = useRef<HTMLSpanElement | null>(null);
    const contextScrollRef = useRef<HTMLDivElement | null>(null);

    // Parse tokens from text
    const words = useMemo(() => {
        if (!text) return [];
        const normalized = text.replace(/\s+/g, " ").trim();
        const tokens = normalized.split(" ").filter(Boolean);
        const avgLen = tokens.reduce((s, t) => s + t.length, 0) / Math.max(1, tokens.length);
        return (avgLen < 2 ? [normalized.replace(/\s+/g, "")] : tokens).filter((w) => w.length > 0);
    }, [text]);

    useEffect(() => {
        wordsRef.current = words;
        setCurrentIndex(0);
        if (autoPlayRef.current) {
            autoPlayRef.current = false;
            setIsPlaying(true);
        } else {
            setIsPlaying(false);
        }
    }, [words]);

    // Timer scheduling with dynamic punctuation pauses
    useEffect(() => {
        if (!isPlaying || !isOpen || wordsRef.current.length === 0) {
            if (timerRef.current) {
                clearTimeout(timerRef.current);
                timerRef.current = null;
            }
            return;
        }

        const tick = () => {
            setCurrentIndex((prev) => {
                if (prev >= wordsRef.current.length - 1) {
                    setIsPlaying(false);
                    if (onAutoNext) autoPlayRef.current = true;
                    setTimeout(() => onAutoNext?.(), 400);
                    return prev;
                }

                const nextIndex = prev + 1;
                const currentWord = wordsRef.current[nextIndex] || "";
                const factor = getWordDelayFactor(currentWord);
                const delay = Math.round(((60 * 1000) / wpm) * factor);

                timerRef.current = window.setTimeout(tick, delay);
                return nextIndex;
            });
        };

        const currentWord = wordsRef.current[currentIndex] || "";
        const factor = getWordDelayFactor(currentWord);
        const initialDelay = Math.round(((60 * 1000) / wpm) * factor);
        timerRef.current = window.setTimeout(tick, initialDelay);

        return () => {
            if (timerRef.current) {
                clearTimeout(timerRef.current);
                timerRef.current = null;
            }
        };
    }, [isPlaying, wpm, isOpen, onAutoNext, currentIndex]);

    // Smooth auto-scroll paragraph context to keep active word visible
    useEffect(() => {
        if (!showContext || !activeWordRef.current || !contextScrollRef.current) return;
        const container = contextScrollRef.current;
        const activeEl = activeWordRef.current;

        const containerTop = container.scrollTop;
        const containerHeight = container.clientHeight;
        const activeTop = activeEl.offsetTop - container.offsetTop;
        const activeHeight = activeEl.offsetHeight;

        // If active element is near edge or outside viewport, scroll it to center
        if (activeTop < containerTop + 24 || activeTop + activeHeight > containerTop + containerHeight - 24) {
            container.scrollTo({
                top: Math.max(0, activeTop - containerHeight / 2 + activeHeight / 2),
                behavior: "smooth",
            });
        }
    }, [currentIndex, showContext]);

    // Keyboard navigation
    useEffect(() => {
        if (!isOpen) return;
        const handler = (e: KeyboardEvent) => {
            switch (e.key) {
                case " ":
                    e.preventDefault();
                    setIsPlaying((p) => !p);
                    break;
                case "ArrowRight":
                    e.preventDefault();
                    setCurrentIndex((i) => Math.min(i + 10, wordsRef.current.length - 1));
                    break;
                case "ArrowLeft":
                    e.preventDefault();
                    setCurrentIndex((i) => Math.max(i - 10, 0));
                    break;
                case "ArrowUp":
                    e.preventDefault();
                    setWpm((w) => Math.min(w + 25, 2000));
                    break;
                case "ArrowDown":
                    e.preventDefault();
                    setWpm((w) => Math.max(w - 25, 50));
                    break;
                case "c":
                case "C":
                    e.preventDefault();
                    setShowContext((prev) => !prev);
                    break;
                case "Escape":
                    if (isFullscreen) {
                        void document.exitFullscreen?.();
                    } else {
                        setIsPlaying(false);
                        onClose();
                    }
                    break;
                case "f":
                case "F":
                    isFullscreen
                        ? void document.exitFullscreen?.()
                        : void document.documentElement.requestFullscreen?.();
                    break;
            }
        };
        window.addEventListener("keydown", handler);
        return () => window.removeEventListener("keydown", handler);
    }, [isOpen, isFullscreen, onClose]);

    useEffect(() => {
        const handler = () => setIsFullscreen(!!document.fullscreenElement);
        document.addEventListener("fullscreenchange", handler);
        return () => document.removeEventListener("fullscreenchange", handler);
    }, []);

    const wordCount = words.length;
    const progress = wordCount > 0 ? (currentIndex / wordCount) * 100 : 0;
    const currentWord = words[currentIndex] || "";
    const { prefix, focal, suffix } = useMemo(() => splitWordForOrp(currentWord), [currentWord]);

    const handleWordClick = useCallback((idx: number) => {
        setCurrentIndex(idx);
    }, []);

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-[200] w-full h-full flex flex-col select-none bg-[var(--color-background)] text-[var(--color-text-primary)] pt-[max(env(safe-area-inset-top,0px),0.25rem)] pb-[max(env(safe-area-inset-bottom,0px),0.75rem)]">
            {/* Top Toolbar */}
            <div className="flex items-center justify-between shrink-0 h-12 w-full px-4 sm:px-6 border-b border-[var(--color-border)] bg-[var(--color-surface)]">
                <button
                    onClick={() => {
                        setIsPlaying(false);
                        onClose();
                    }}
                    className="flex items-center justify-center w-9 h-9 rounded-md text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)] hover:bg-[var(--color-surface-muted)] cursor-pointer transition-colors"
                    aria-label="Close Speed Reader (Esc)"
                    title="Close (Esc)"
                >
                    <X className="w-5 h-5" />
                </button>

                <div className="flex items-center gap-3 sm:gap-4">
                    <span className="text-xs font-mono font-medium text-[color:var(--color-text-muted)] tracking-wider">
                        {currentIndex + 1} <span className="opacity-40">/</span> {wordCount}
                    </span>
                    <div className="w-24 sm:w-36 h-1 overflow-hidden bg-[var(--color-surface-muted)] rounded-full border border-[var(--color-border)]">
                        <div className="h-full bg-[var(--color-accent)] transition-[width] duration-150 ease-out rounded-full" style={{ width: `${progress}%` }} />
                    </div>
                </div>

                <div className="flex items-center gap-1">
                    <button
                        onClick={() => setShowContext(!showContext)}
                        className={cn(
                            "flex items-center justify-center w-9 h-9 rounded-md transition-colors cursor-pointer",
                            showContext
                                ? "text-[color:var(--color-accent)] bg-[var(--color-surface-muted)]"
                                : "text-[color:var(--color-text-muted)] hover:text-[color:var(--color-text-primary)] hover:bg-[var(--color-surface-muted)]"
                        )}
                        title={showContext ? "Hide Paragraph Context (C)" : "Show Paragraph Context (C)"}
                        aria-label="Toggle Paragraph Context"
                    >
                        {showContext ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
                    </button>

                    <button
                        onClick={() => setIsFullscreen(!isFullscreen)}
                        className="flex items-center justify-center w-9 h-9 rounded-md text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)] hover:bg-[var(--color-surface-muted)] cursor-pointer transition-colors"
                        aria-label="Fullscreen (F)"
                        title="Fullscreen (F)"
                    >
                        {isFullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
                    </button>
                </div>
            </div>

            {/* Main Reading Canvas */}
            <div className="flex-1 min-h-0 w-full overflow-y-auto flex flex-col items-center justify-center px-4 sm:px-6 md:px-8 py-4">
                <div className="w-full max-w-3xl flex flex-col gap-6 my-auto" style={{ width: "100%", maxWidth: "48rem" }}>
                    {/* Hero-Sized Spritz-Style Optimal Recognition Point (ORP) Box */}
                    <div className="w-full flex flex-col items-center justify-center" style={{ width: "100%" }}>
                        <div className="relative w-full py-8 sm:py-12 md:py-16 px-4 border-2 border-[var(--color-border)] bg-[var(--color-surface)] shadow-lg rounded-xl flex items-center justify-center" style={{ width: "100%" }}>
                            {/* Top and Bottom Center Focus Reticles */}
                            <div className="absolute top-0 left-1/2 -translate-x-1/2 w-1.5 h-4 sm:h-5 bg-[var(--color-accent)] rounded-b-md shadow-sm" />
                            <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-1.5 h-4 sm:h-5 bg-[var(--color-accent)] rounded-t-md shadow-sm" />

                            {/* Centered Word with 50/50 Fixed Center Line Alignment */}
                            <div className="flex items-center justify-center w-full font-sans select-none text-4xl sm:text-6xl md:text-7xl lg:text-8xl font-bold tracking-tight" style={{ width: "100%" }}>
                                <div className="flex-1 text-right text-[color:var(--color-text-primary)] whitespace-nowrap overflow-hidden pr-1">
                                    {prefix}
                                </div>
                                <div className="shrink-0 text-[color:var(--color-accent)] font-black px-1 scale-105">
                                    {focal || (currentWord ? "" : "—")}
                                </div>
                                <div className="flex-1 text-left text-[color:var(--color-text-primary)] whitespace-nowrap overflow-hidden pl-1">
                                    {suffix}
                                </div>
                            </div>
                        </div>

                        <div className="mt-3 flex items-center gap-2 text-xs tracking-[0.25em] uppercase font-bold text-[color:var(--color-text-muted)] font-mono">
                            <span className={cn("inline-block w-2 h-2 rounded-full", isPlaying ? "bg-[var(--color-accent)] animate-pulse" : "bg-[var(--color-text-muted)]")} />
                            <span>{isPlaying ? "Reading" : "Paused"}</span>
                        </div>
                    </div>

                    {/* Large, Spacious Paragraph Context Box */}
                    {showContext && (
                        <div
                            ref={contextScrollRef}
                            className="w-full h-48 sm:h-60 md:h-72 overflow-y-auto px-5 sm:px-8 py-4 sm:py-6 bg-[var(--color-surface)] border-2 border-[var(--color-border)] rounded-xl text-base sm:text-lg md:text-xl leading-relaxed sm:leading-loose custom-scrollbar shadow-md select-text transition-[border-color,box-shadow] duration-300 ease-out"
                            style={{ width: "100%" }}
                        >
                            <div className="flex flex-wrap gap-x-2 gap-y-2">
                                {words.map((w, idx) => {
                                    const isCurrent = idx === currentIndex;
                                    const isPast = idx < currentIndex;

                                    return (
                                        <span
                                            key={idx}
                                            ref={isCurrent ? activeWordRef : null}
                                            onClick={() => handleWordClick(idx)}
                                            className={cn(
                                                "cursor-pointer rounded-md transition-[color,background-color,transform,box-shadow] duration-150 ease-out",
                                                isCurrent
                                                    ? "bg-[var(--color-accent)] text-[color:var(--color-accent-contrast)] font-black px-2.5 py-1 shadow-md ring-2 ring-[var(--color-accent)]/50 scale-110 inline-block mx-1"
                                                    : isPast
                                                    ? "text-[color:var(--color-text-muted)] opacity-50 hover:opacity-90"
                                                    : "text-[color:var(--color-text-primary)] hover:text-[color:var(--color-accent)] font-medium"
                                            )}
                                        >
                                            {w}
                                        </span>
                                    );
                                })}
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* Bottom Controls Bar */}
            <div className="shrink-0 px-4 sm:px-8 pb-3 sm:pb-5 space-y-3 bg-[var(--color-surface)] border-t border-[var(--color-border)] pt-3">
                <div className="flex items-center justify-center gap-3 sm:gap-6 flex-wrap">
                    <button
                        onClick={() => setWpm((w) => Math.max(50, w - 25))}
                        className="flex items-center justify-center min-h-[40px] min-w-[40px] sm:min-h-[44px] sm:min-w-[44px] text-base font-bold border border-[var(--color-border)] text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)] hover:bg-[var(--color-surface-muted)] cursor-pointer transition-colors rounded-md"
                        title="Decrease Speed"
                    >
                        −
                    </button>

                    <div className="flex items-center gap-1.5 min-w-[4.5rem] justify-center font-mono">
                        <span className="text-base sm:text-lg font-bold text-[color:var(--color-text-primary)]">{wpm}</span>
                        <span className="text-[10px] sm:text-xs tracking-[0.05em] uppercase text-[color:var(--color-text-muted)]">wpm</span>
                    </div>

                    <button
                        onClick={() => setWpm((w) => Math.min(2000, w + 25))}
                        className="flex items-center justify-center min-h-[40px] min-w-[40px] sm:min-h-[44px] sm:min-w-[44px] text-base font-bold border border-[var(--color-border)] text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)] hover:bg-[var(--color-surface-muted)] cursor-pointer transition-colors rounded-md"
                        title="Increase Speed"
                    >
                        +
                    </button>

                    <button
                        onClick={() => setIsPlaying(!isPlaying)}
                        className="flex items-center justify-center min-h-[46px] min-w-[46px] sm:min-h-[50px] sm:min-w-[50px] rounded-full transition-transform active:scale-95 bg-[var(--color-accent)] text-[color:var(--color-accent-contrast)] cursor-pointer shadow-lg"
                        aria-label={isPlaying ? "Pause" : "Play"}
                    >
                        {isPlaying ? <Pause className="w-6 h-6" /> : <Play className="w-6 h-6 ml-0.5" />}
                    </button>

                    <div className="w-32 sm:w-48 text-[color:var(--color-text-muted)]">
                        <input
                            type="range"
                            min={50}
                            max={1200}
                            step={10}
                            value={wpm}
                            onChange={(e) => setWpm(Number(e.target.value))}
                            className="w-full cursor-pointer accent-[var(--color-accent)]"
                            aria-label="Speed"
                        />
                    </div>
                </div>

                <div className="flex items-center justify-center gap-2 sm:gap-4 text-[10px] sm:text-xs tracking-[0.08em] uppercase text-[color:var(--color-text-muted)] font-mono flex-wrap">
                    <span>Space (Play/Pause)</span>
                    <span>·</span>
                    <span>↑↓ (WPM)</span>
                    <span>·</span>
                    <span>←→ (±10 Words)</span>
                    <span>·</span>
                    <span>C (Context)</span>
                    <span>·</span>
                    <span>F (Fullscreen)</span>
                </div>
            </div>
        </div>
    );
}
