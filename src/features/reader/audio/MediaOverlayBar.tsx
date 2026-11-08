import { useCallback, useEffect, useRef, useState } from "react";
import { AudioLines, Moon, Pause, Play, SkipBack, SkipForward, X } from "lucide-react";
import { cn } from "../../../core/lib/utils";
import { isSafeImageUrl } from "../../../core/lib/url-safety";
import { Chip, IconButton } from "../../../ui";
import type { MediaOverlayPlayer } from "../engines";

const SPEEDS = [0.75, 1, 1.25, 1.5, 2];
const SLEEP_MINUTES = [15, 30, 45];

type BarState = "idle" | "loading" | "playing" | "paused" | "finished";

const STATUS_LABEL: Record<BarState, string> = {
    idle: "Starts at the beginning of this section",
    loading: "Loading...",
    playing: "Reading along",
    paused: "Paused",
    finished: "Finished",
};

export interface MediaOverlayBarProps {
    overlay: MediaOverlayPlayer;
    /** Starts narration at the beginning of the current section. */
    onStart: () => Promise<void>;
    bookTitle?: string;
    bookAuthor?: string;
    bookCover?: string;
    visible?: boolean;
    onClose: () => void;
}

/** Player for a book's own synced narration (EPUB 3 Media Overlays). See docs/tts.md. */
export function MediaOverlayBar({ overlay, onStart, bookTitle, bookAuthor, bookCover, visible = true, onClose }: MediaOverlayBarProps) {
    const [state, setState] = useState<BarState>("idle");
    const [error, setError] = useState<string | null>(null);
    const [speed, setSpeed] = useState(1);
    const [sleepMenuOpen, setSleepMenuOpen] = useState(false);
    const [sleepDeadline, setSleepDeadline] = useState<number | null>(null);

    const started = state === "playing" || state === "paused";

    useEffect(() => {
        // A skip while paused highlights the new phrase but stays paused.
        const onHighlight = () => setState(s => (s === "paused" ? s : "playing"));
        const onFinished = () => setState("finished");
        const onError = () => {
            setState("idle");
            setError("This narration could not be played");
        };
        overlay.addEventListener("highlight", onHighlight);
        overlay.addEventListener("finished", onFinished);
        overlay.addEventListener("error", onError);
        return () => {
            overlay.removeEventListener("highlight", onHighlight);
            overlay.removeEventListener("finished", onFinished);
            overlay.removeEventListener("error", onError);
            overlay.stop();
        };
    }, [overlay]);

    const pause = useCallback(() => {
        overlay.pause();
        setState("paused");
    }, [overlay]);

    const play = useCallback(() => {
        if (state === "paused") {
            overlay.resume();
            setState("playing");
        } else if (state !== "playing" && state !== "loading") {
            setError(null);
            setState("loading");
            onStart().catch(() => {
                setState("idle");
                setError("This narration could not be played");
            });
        }
    }, [overlay, onStart, state]);

    // Handlers registered once below always call the latest controls.
    const controlsRef = useRef({ play, pause });
    controlsRef.current = { play, pause };
    const startedRef = useRef(started);
    startedRef.current = started;

    // Sleep timer: pause and clear once the deadline passes.
    useEffect(() => {
        if (sleepDeadline === null) return;
        const timer = setInterval(() => {
            if (Date.now() >= sleepDeadline) {
                clearInterval(timer);
                setSleepDeadline(null);
                if (startedRef.current) controlsRef.current.pause();
            }
        }, 1000);
        return () => clearInterval(timer);
    }, [sleepDeadline]);

    // System media controls (lock screen, headphones).
    useEffect(() => {
        if (!("mediaSession" in navigator)) return;
        const session = navigator.mediaSession;
        try {
            if (typeof MediaMetadata !== "undefined") {
                session.metadata = new MediaMetadata({
                    title: bookTitle ?? "Read along",
                    artist: bookAuthor,
                    artwork: bookCover && isSafeImageUrl(bookCover) ? [{ src: bookCover }] : [],
                });
            }
        } catch { /* Metadata support varies by webview. */ }
        const actions: [MediaSessionAction, MediaSessionActionHandler][] = [
            ["play", () => controlsRef.current.play()],
            ["pause", () => { if (startedRef.current) controlsRef.current.pause(); }],
            ["previoustrack", () => { if (startedRef.current) overlay.prev(); }],
            ["nexttrack", () => { if (startedRef.current) overlay.next(); }],
        ];
        for (const [action, handler] of actions) {
            try { session.setActionHandler(action, handler); }
            catch { /* One unsupported action must not prevent the others. */ }
        }
        return () => {
            for (const [action] of actions) {
                try { session.setActionHandler(action, null); }
                catch { /* unsupported action */ }
            }
            try { session.metadata = null; session.playbackState = "none"; }
            catch { /* partial MediaSession support */ }
        };
    }, [overlay, bookTitle, bookAuthor, bookCover]);

    useEffect(() => {
        if (!("mediaSession" in navigator)) return;
        try { navigator.mediaSession.playbackState = state === "playing" ? "playing" : state === "paused" ? "paused" : "none"; }
        catch { /* partial MediaSession support */ }
    }, [state]);

    const changeSpeed = useCallback((next: number) => {
        setSpeed(next);
        overlay.setRate(next);
    }, [overlay]);

    const playing = state === "playing";

    return (
        <div
            className={cn(
                "absolute left-0 right-0 z-[139] transition-transform duration-300",
                visible ? "translate-y-0" : "translate-y-[150%] pointer-events-none",
            )}
            style={{ bottom: "calc(var(--reader-navbar-height, 3.5rem) + var(--safe-area-bottom))" }}
        >
            <div className="mx-auto max-w-[var(--container-width-sm)] px-3">
                <div className="border border-[var(--color-border)] bg-[var(--color-surface)]/95 backdrop-blur-xl px-3 pt-2 pb-2 shadow-[0_8px_32px_rgba(0,0,0,0.18)]">
                    <div className="flex items-center gap-2 min-w-0">
                        <AudioLines className="w-3.5 h-3.5 text-[color:var(--color-accent)] shrink-0" />
                        <span className="min-w-0 flex-1 text-[11px] text-[color:var(--color-text-primary)] truncate">
                            {/* Name the source: immersion can also play generated speech or an audiobook. */}
                            <span className="text-[color:var(--color-text-muted)]">Book narration · </span>
                            {error
                                ? <span role="alert" className="text-[color:var(--color-error)]">{error}</span>
                                : STATUS_LABEL[state]}
                        </span>
                        <div className="relative shrink-0">
                            <IconButton
                                label="Sleep timer"
                                aria-pressed={sleepDeadline !== null}
                                icon={<Moon className="w-3.5 h-3.5" />}
                                onClick={() => setSleepMenuOpen(v => !v)}
                            />
                            {sleepMenuOpen && (
                                <>
                                    <div className="fixed inset-0 z-[141]" onClick={() => setSleepMenuOpen(false)} />
                                    <div className="absolute bottom-9 right-0 z-[142] w-32 border border-[var(--color-border)] bg-[var(--color-surface)] p-1.5 shadow-[0_8px_32px_rgba(0,0,0,0.18)]">
                                        {sleepDeadline !== null && (
                                            <Chip className="w-full" onClick={() => { setSleepDeadline(null); setSleepMenuOpen(false); }}>
                                                Off
                                            </Chip>
                                        )}
                                        {SLEEP_MINUTES.map(min => (
                                            <Chip
                                                key={min}
                                                className="w-full"
                                                onClick={() => { setSleepDeadline(Date.now() + min * 60_000); setSleepMenuOpen(false); }}
                                            >
                                                {min} min
                                            </Chip>
                                        ))}
                                    </div>
                                </>
                            )}
                        </div>
                        <IconButton label="Close player" icon={<X className="w-3.5 h-3.5" />} onClick={onClose} />
                    </div>

                    <div className="mt-1 flex items-center justify-center gap-2">
                        <IconButton
                            label="Previous phrase"
                            disabled={!started}
                            icon={<SkipBack className="w-4 h-4" />}
                            onClick={() => overlay.prev()}
                        />
                        <button
                            type="button"
                            onClick={playing ? pause : play}
                            disabled={state === "loading"}
                            className={cn(
                                "flex items-center justify-center w-10 h-10 transition-colors",
                                "bg-[var(--color-accent)] text-[color:var(--color-accent-contrast)]",
                                "hover:bg-[var(--color-accent-hover)] active:scale-90",
                                "disabled:opacity-40 disabled:cursor-not-allowed",
                            )}
                            title={playing ? "Pause" : "Play"}
                            aria-label={playing ? "Pause" : "Play"}
                        >
                            {playing ? <Pause className="w-4 h-4 fill-current" /> : <Play className="w-4 h-4 fill-current" />}
                        </button>
                        <IconButton
                            label="Next phrase"
                            disabled={!started}
                            icon={<SkipForward className="w-4 h-4" />}
                            onClick={() => overlay.next()}
                        />
                        <div className="flex items-center gap-0.5 ml-1">
                            {SPEEDS.map(s => (
                                <Chip key={s} active={speed === s} aria-label={`Speed ${s}x`} onClick={() => changeSpeed(s)}>
                                    {s}×
                                </Chip>
                            ))}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
