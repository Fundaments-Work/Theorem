import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { ListMusic, Moon, Pause, Play, Rewind, FastForward, X } from "lucide-react";
import { cn } from "../../../core/lib/utils";
import { useLibraryStore } from "../../../core/store";
import type { BookAudioTrack } from "../../../core/types";
import type { AudioChapter } from "../../../core/types";

const SKIP_SECONDS = 15;
const SPEEDS = [0.75, 1, 1.25, 1.5, 2];
const SLEEP_MINUTES = [15, 30, 45];
const PROGRESS_SAVE_INTERVAL_MS = 5000;

function formatTime(totalSec: number): string {
    const s = Math.max(0, Math.floor(totalSec));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
    return (h > 0 ? `${h}:${mm}` : mm) + ":" + String(sec).padStart(2, "0");
}

interface AudiobookBarProps {
    bookId: string;
    bookTitle?: string;
    bookAuthor?: string;
    audioTrack: BookAudioTrack;
    /** Chrome visible (auto-hide aware); playback continues while hidden. */
    visible?: boolean;
    onClose: () => void;
}

export function AudiobookBar({ bookId, bookTitle, bookAuthor, audioTrack, visible = true, onClose }: AudiobookBarProps) {
    const audioRef = useRef<HTMLAudioElement | null>(null);
    const [playing, setPlaying] = useState(false);
    const [ready, setReady] = useState(false);
    const [currentTime, setCurrentTime] = useState(audioTrack.currentPositionSec);
    const [duration, setDuration] = useState(audioTrack.durationSec);
    const [speed, setSpeed] = useState(audioTrack.playbackSpeed || 1);
    const [chapterMenuOpen, setChapterMenuOpen] = useState(false);
    const [sleepMenuOpen, setSleepMenuOpen] = useState(false);
    const [sleepDeadline, setSleepDeadline] = useState<number | null>(null);
    const lastSaveRef = useRef(0);
    const resumeRef = useRef(audioTrack.currentPositionSec);
    const trackRef = useRef(audioTrack);
    trackRef.current = audioTrack;

    const saveProgress = useCallback((positionSec: number, playbackSpeed: number) => {
        useLibraryStore.getState().updateAudiobookProgress(bookId, {
            currentPositionSec: Math.floor(positionSec),
            playbackSpeed,
            lastListenedAt: new Date().toISOString(),
        });
    }, [bookId]);

    // Create the audio element once and resume at the saved position.
    useEffect(() => {
        const audio = new Audio(convertFileSrc(trackRef.current.filePath));
        audio.preload = "metadata";
        audio.playbackRate = trackRef.current.playbackSpeed || 1;
        audioRef.current = audio;

        const onLoadedMetadata = () => {
            // Prefer the real decoded duration over the container estimate.
            if (Number.isFinite(audio.duration) && audio.duration > 0) {
                setDuration(audio.duration);
            }
            // Resume at the saved position (only settable after metadata).
            if (resumeRef.current > 0 && Number.isFinite(audio.duration)) {
                audio.currentTime = Math.min(resumeRef.current, Math.max(0, audio.duration - 1));
            }
            setReady(true);
        };
        const onPlay = () => setPlaying(true);
        const onPause = () => setPlaying(false);
        const onTimeUpdate = () => {
            setCurrentTime(audio.currentTime);
            const now = Date.now();
            if (now - lastSaveRef.current > PROGRESS_SAVE_INTERVAL_MS) {
                lastSaveRef.current = now;
                saveProgress(audio.currentTime, audio.playbackRate);
            }
        };
        audio.addEventListener("loadedmetadata", onLoadedMetadata);
        audio.addEventListener("play", onPlay);
        audio.addEventListener("pause", onPause);
        audio.addEventListener("timeupdate", onTimeUpdate);

        return () => {
            audio.pause();
            saveProgress(audio.currentTime, audio.playbackRate);
            audio.removeEventListener("loadedmetadata", onLoadedMetadata);
            audio.removeEventListener("play", onPlay);
            audio.removeEventListener("pause", onPause);
            audio.removeEventListener("timeupdate", onTimeUpdate);
            audio.src = "";
            audioRef.current = null;
        };
    }, [bookId, saveProgress]);

    // Sleep timer: pause and clear once the deadline passes.
    useEffect(() => {
        if (sleepDeadline === null) return;
        const timer = setInterval(() => {
            if (Date.now() >= sleepDeadline) {
                setSleepDeadline(null);
                audioRef.current?.pause();
            }
        }, 1000);
        return () => clearInterval(timer);
    }, [sleepDeadline]);

    // System media controls (lock screen, headphones).
    useEffect(() => {
        if (!("mediaSession" in navigator)) return;
        navigator.mediaSession.metadata = new MediaMetadata({
            title: bookTitle ?? "Audiobook",
            artist: bookAuthor,
        });
        const actions: [MediaSessionAction, () => void][] = [
            ["play", () => void audioRef.current?.play()],
            ["pause", () => audioRef.current?.pause()],
            ["seekbackward", () => skip(-SKIP_SECONDS)],
            ["seekforward", () => skip(SKIP_SECONDS)],
        ];
        try {
            for (const [action, handler] of actions) {
                navigator.mediaSession.setActionHandler(action, handler);
            }
        } catch { /* unsupported actions are fine */ }
        return () => {
            try {
                for (const [action] of actions) {
                    navigator.mediaSession.setActionHandler(action, null);
                }
            } catch { /* noop */ }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [bookTitle, bookAuthor]);

    const togglePlay = useCallback(() => {
        const audio = audioRef.current;
        if (!audio) return;
        if (audio.paused) {
            void audio.play().catch(() => { /* autoplay rejection — user can retry */ });
        } else {
            audio.pause();
            saveProgress(audio.currentTime, audio.playbackRate);
        }
    }, [saveProgress]);

    const skip = useCallback((seconds: number) => {
        const audio = audioRef.current;
        if (!audio) return;
        audio.currentTime = Math.max(0, Math.min(audio.currentTime + seconds, audio.duration || Infinity));
        setCurrentTime(audio.currentTime);
    }, []);

    const seek = useCallback((sec: number) => {
        const audio = audioRef.current;
        if (!audio) return;
        audio.currentTime = Math.max(0, Math.min(sec, audio.duration || Infinity));
        setCurrentTime(audio.currentTime);
    }, []);

    const changeSpeed = useCallback((next: number) => {
        setSpeed(next);
        if (audioRef.current) audioRef.current.playbackRate = next;
        saveProgress(audioRef.current?.currentTime ?? 0, next);
    }, [saveProgress]);

    const currentChapter = useMemo<AudioChapter | null>(() => {
        if (audioTrack.chapters.length === 0) return null;
        return (
            audioTrack.chapters.find(
                (ch) => currentTime >= ch.startSec && currentTime < ch.endSec,
            ) ?? audioTrack.chapters[0]
        );
    }, [audioTrack.chapters, currentTime]);

    const durationSafe = duration > 0 ? duration : 1;
    const progressPct = Math.min(100, (currentTime / durationSafe) * 100);

    const close = useCallback(() => {
        const audio = audioRef.current;
        if (audio) saveProgress(audio.currentTime, audio.playbackRate);
        onClose();
    }, [onClose, saveProgress]);

    return (
        <div
            className={cn(
                "absolute left-0 right-0 z-[139] transition-transform duration-300",
                visible ? "translate-y-0" : "translate-y-[150%] pointer-events-none",
            )}
            style={{ bottom: "calc(var(--reader-navbar-height, 3.5rem) + env(safe-area-inset-bottom, 0px))" }}
        >
            <div className="mx-auto max-w-2xl px-3">
                <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]/95 backdrop-blur-xl px-3 pt-2 pb-2 shadow-[0_8px_32px_rgba(0,0,0,0.18)]">
                    {/* Row 1: chapter / time / actions */}
                    <div className="flex items-center gap-2 min-w-0">
                        <ListMusic className="w-3.5 h-3.5 text-[color:var(--color-accent)] shrink-0" />
                        <button
                            onClick={() => setChapterMenuOpen(v => !v)}
                            disabled={audioTrack.chapters.length === 0}
                            className="min-w-0 flex-1 text-left"
                            title={audioTrack.chapters.length > 0 ? "Jump to chapter" : undefined}
                        >
                            <span className="block text-[11px] font-medium text-[color:var(--color-text-primary)] truncate">
                                {currentChapter ? currentChapter.title : "Audiobook"}
                            </span>
                        </button>
                        <span className="text-[10px] font-mono text-[color:var(--color-text-muted)] shrink-0">
                            {formatTime(currentTime)} / {formatTime(duration)}
                        </span>
                        <div className="relative shrink-0">
                            <button
                                onClick={() => setSleepMenuOpen(v => !v)}
                                className={cn(
                                    "flex items-center justify-center w-7 h-7 rounded-full transition-colors",
                                    sleepDeadline !== null
                                        ? "bg-[var(--color-accent)] text-[var(--color-accent-contrast)]"
                                        : "text-[color:var(--color-text-secondary)] hover:bg-[var(--color-overlay-subtle)]",
                                )}
                                title="Sleep timer"
                                aria-label="Sleep timer"
                            >
                                <Moon className="w-3.5 h-3.5" />
                            </button>
                            {sleepMenuOpen && (
                                <>
                                    <div className="fixed inset-0 z-[141]" onClick={() => setSleepMenuOpen(false)} />
                                    <div className="absolute bottom-9 right-0 z-[142] w-32 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-1.5 shadow-[0_8px_32px_rgba(0,0,0,0.18)]">
                                        {sleepDeadline !== null && (
                                            <button
                                                onClick={() => { setSleepDeadline(null); setSleepMenuOpen(false); }}
                                                className="w-full rounded-md px-2 py-1.5 text-left text-[11px] text-[color:var(--color-text-primary)] hover:bg-[var(--color-overlay-subtle)]"
                                            >
                                                Off
                                            </button>
                                        )}
                                        {SLEEP_MINUTES.map((min) => (
                                            <button
                                                key={min}
                                                onClick={() => {
                                                    setSleepDeadline(Date.now() + min * 60_000);
                                                    setSleepMenuOpen(false);
                                                }}
                                                className="w-full rounded-md px-2 py-1.5 text-left text-[11px] text-[color:var(--color-text-primary)] hover:bg-[var(--color-overlay-subtle)]"
                                            >
                                                {min} min
                                            </button>
                                        ))}
                                        <button
                                            onClick={() => {
                                                const ch = audioTrack.chapters.find((c) => c.startSec > currentTime);
                                                setSleepDeadline(Date.now() + Math.max(1, (ch ? ch.startSec - currentTime : duration - currentTime)) * 1000);
                                                setSleepMenuOpen(false);
                                            }}
                                            disabled={audioTrack.chapters.length === 0}
                                            className="w-full rounded-md px-2 py-1.5 text-left text-[11px] text-[color:var(--color-text-primary)] hover:bg-[var(--color-overlay-subtle)] disabled:opacity-40"
                                        >
                                            End of chapter
                                        </button>
                                    </div>
                                </>
                            )}
                        </div>
                        <button
                            onClick={close}
                            className="flex items-center justify-center w-7 h-7 rounded-full text-[color:var(--color-text-secondary)] hover:bg-[var(--color-overlay-subtle)] hover:text-[color:var(--color-error)] transition-colors shrink-0"
                            title="Close player"
                            aria-label="Close player"
                        >
                            <X className="w-3.5 h-3.5" />
                        </button>
                    </div>

                    {/* Row 2: scrubber */}
                    <div
                        className="relative mt-1.5 h-2 cursor-pointer"
                        role="slider"
                        aria-label="Playback position"
                        aria-valuemin={0}
                        aria-valuemax={Math.floor(duration)}
                        aria-valuenow={Math.floor(currentTime)}
                        onClick={(e) => {
                            const rect = e.currentTarget.getBoundingClientRect();
                            seek(((e.clientX - rect.left) / rect.width) * duration);
                        }}
                    >
                        <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-1 rounded-full bg-[var(--color-surface-muted)]" />
                        <div
                            className="absolute left-0 top-1/2 -translate-y-1/2 h-1 rounded-full bg-[var(--color-accent)]"
                            style={{ width: `${progressPct}%` }}
                        />
                        <div
                            className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-2.5 h-2.5 rounded-full bg-[var(--color-accent)]"
                            style={{ left: `${progressPct}%` }}
                        />
                    </div>

                    {/* Row 3: transport + speed */}
                    <div className="mt-1 flex items-center justify-center gap-2">
                        <button
                            onClick={() => skip(-SKIP_SECONDS)}
                            className="flex items-center justify-center w-8 h-8 rounded-full text-[color:var(--color-text-secondary)] hover:bg-[var(--color-overlay-subtle)] transition-colors"
                            title={`Back ${SKIP_SECONDS}s`}
                            aria-label={`Back ${SKIP_SECONDS} seconds`}
                        >
                            <Rewind className="w-4 h-4" />
                        </button>
                        <button
                            onClick={togglePlay}
                            disabled={!ready}
                            className={cn(
                                "flex items-center justify-center w-10 h-10 rounded-full transition-colors",
                                "bg-[var(--color-accent)] text-[color:var(--color-accent-contrast)]",
                                "hover:bg-[var(--color-accent-hover)] active:scale-90",
                                "disabled:opacity-40 disabled:cursor-not-allowed",
                            )}
                            title={playing ? "Pause" : "Play"}
                            aria-label={playing ? "Pause" : "Play"}
                        >
                            {playing ? <Pause className="w-4 h-4 fill-current" /> : <Play className="w-4 h-4 fill-current" />}
                        </button>
                        <button
                            onClick={() => skip(SKIP_SECONDS)}
                            className="flex items-center justify-center w-8 h-8 rounded-full text-[color:var(--color-text-secondary)] hover:bg-[var(--color-overlay-subtle)] transition-colors"
                            title={`Forward ${SKIP_SECONDS}s`}
                            aria-label={`Forward ${SKIP_SECONDS} seconds`}
                        >
                            <FastForward className="w-4 h-4" />
                        </button>
                        <div className="flex items-center gap-0.5 ml-1">
                            {SPEEDS.map((s) => (
                                <button
                                    key={s}
                                    onClick={() => changeSpeed(s)}
                                    className={cn(
                                        "px-1.5 py-0.5 rounded-md text-[10px] font-medium transition-colors",
                                        speed === s
                                            ? "bg-[var(--color-accent)] text-[var(--color-accent-contrast)]"
                                            : "text-[color:var(--color-text-secondary)] hover:bg-[var(--color-overlay-subtle)]",
                                    )}
                                >
                                    {s}×
                                </button>
                            ))}
                        </div>
                    </div>
                </div>
            </div>

            {/* Chapter menu */}
            {chapterMenuOpen && audioTrack.chapters.length > 0 && (
                <>
                    <div className="fixed inset-0 z-[141]" onClick={() => setChapterMenuOpen(false)} />
                    <div className="absolute right-3 bottom-[calc(100%+8px)] z-[142] w-72 max-h-72 overflow-y-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-1.5 shadow-[0_8px_32px_rgba(0,0,0,0.18)]">
                        {audioTrack.chapters.map((ch) => {
                            const active = currentChapter?.id === ch.id;
                            return (
                                <button
                                    key={ch.id}
                                    onClick={() => { seek(ch.startSec + 0.05); setChapterMenuOpen(false); }}
                                    className={cn(
                                        "w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-[11px] transition-colors",
                                        active
                                            ? "bg-[var(--color-accent)]/10 text-[color:var(--color-accent)]"
                                            : "text-[color:var(--color-text-primary)] hover:bg-[var(--color-overlay-subtle)]",
                                    )}
                                >
                                    <span className="truncate flex-1">{ch.title}</span>
                                    <span className="font-mono text-[10px] text-[color:var(--color-text-muted)] shrink-0">
                                        {formatTime(ch.startSec)}
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                </>
            )}

        </div>
    );
}

export default AudiobookBar;
