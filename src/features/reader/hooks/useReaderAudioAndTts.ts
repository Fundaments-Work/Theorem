import { useCallback, useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { toast } from "sonner";
import { isTauriDesktop } from "../../../core/lib/env";
import { useLibraryStore, useSettingsStore } from "../../../core/store";
import type { AppRoute, AudioChapter } from "../../../core/types";
import { getNeuralStatus, immersionPlayer, resolveNeuralVoice } from "../audio/ImmersionPlayer";
import { showTtsError } from "../audio/tts-errors";
import type { ReaderViewportHandle } from "../components/ReaderViewport";
import type { MediaOverlayPlayer } from "../engines/foliate-engine";

export interface UseReaderAudioAndTtsParams {
    currentBookId?: string;
    readerRef: RefObject<ReaderViewportHandle | null>;
    isPdfFormat: boolean;
    ttsEnabled: boolean;
    immersionMode: boolean;
    mediaOverlay: MediaOverlayPlayer | null;
    ttsVoice: string;
    ttsSpeed: number;
    ttsState: "idle" | "loading" | "playing" | "paused";
    setTtsState: Dispatch<SetStateAction<"idle" | "loading" | "playing" | "paused">>;
    ttsData: { text: string; startWordId: string } | null;
    setTtsData: Dispatch<SetStateAction<{ text: string; startWordId: string } | null>>;
    setRoute: (route: AppRoute) => void;
}

export function useReaderAudioAndTts({
    currentBookId,
    readerRef,
    isPdfFormat,
    ttsEnabled,
    immersionMode,
    mediaOverlay,
    ttsVoice,
    ttsSpeed,
    ttsState,
    setTtsState,
    ttsData,
    setTtsData,
    setRoute,
}: UseReaderAudioAndTtsParams) {
    // Set when the listener chose "Use system voice" after a neural failure; kept while the reader is open.
    const ttsPlatformOnlyRef = useRef(false);
    const ttsSpeakOptions = useCallback(
        () => ({
            voice: ttsVoice,
            speed: ttsSpeed,
            lang: useLibraryStore.getState().getBook(currentBookId || "")?.language?.slice(0, 2) || "en",
            engine: ttsPlatformOnlyRef.current ? ("platform" as const) : ("auto" as const),
        }),
        [ttsVoice, ttsSpeed, currentBookId],
    );

    // Text of the page that just finished narrating, to recognise the end of the book.
    const lastSpokenTtsTextRef = useRef("");

    const handleTtsComplete = useCallback(async () => {
        if (isPdfFormat || !ttsEnabled || !immersionMode) return;
        const finished = lastSpokenTtsTextRef.current;
        // Skip pages with nothing to read (images, blank pages) instead of going quiet.
        const MAX_BLANK_PAGES = 5;
        for (let attempt = 0; attempt <= MAX_BLANK_PAGES; attempt++) {
            await readerRef.current?.next();
            await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
            const newData = readerRef.current?.getVisibleTextForTts?.();
            const text = newData?.text?.trim();
            if (!newData || !text) continue;
            if (text === finished) {
                // The page did not change: that was the last one. Re-reading it forever is wrong.
                lastSpokenTtsTextRef.current = "";
                setTtsState("idle");
                toast("Reached the end of the book");
                return;
            }
            lastSpokenTtsTextRef.current = text;
            setTtsData(newData);
            void immersionPlayer.speak(newData.text, ttsSpeakOptions());
            return;
        }
        setTtsState("idle");
    }, [isPdfFormat, ttsEnabled, immersionMode, readerRef, setTtsData, setTtsState, ttsSpeakOptions]);

    const handleTtsPlay = useCallback(() => {
        if (ttsState === "paused" || immersionPlayer.state === "paused") {
            void immersionPlayer.resume();
            return;
        }
        let text = ttsData?.text?.trim();
        if (!text) {
            const data = readerRef.current?.getVisibleTextForTts?.();
            if (data?.text?.trim()) {
                setTtsData(data);
                text = data.text.trim();
            }
        }
        if (!text) return;
        lastSpokenTtsTextRef.current = text;
        void immersionPlayer.speak(text, ttsSpeakOptions());
    }, [readerRef, setTtsData, ttsState, ttsData, ttsSpeakOptions]);

    const handleTtsPause = useCallback(() => {
        immersionPlayer.pause();
    }, []);

    const handleTtsStop = useCallback(() => {
        immersionPlayer.stop();
        setTtsState("idle");
    }, [setTtsState]);

    // Desktop only: probe once whether the Supertonic neural engine is installed.
    const [neuralReady, setNeuralReady] = useState(false);
    // Starts false so the install offer never flashes up before the probe answers, and stays
    // false on machines that have no neural runtime (e.g. Intel Macs).
    const [neuralSupported, setNeuralSupported] = useState(false);
    const showNeuralInstall = isTauriDesktop() && neuralSupported && !neuralReady;
    useEffect(() => {
        if (!isTauriDesktop()) return;
        let cancelled = false;
        getNeuralStatus().then((status) => {
            if (cancelled) return;
            setNeuralReady(status.available);
            setNeuralSupported(status.supported);
        });
        return () => { cancelled = true; };
    }, []);

    // Only warm the neural engine when immersion mode is actually active,
    // avoiding heavy CPU spikes and 800MB RAM allocation when opening books just to read.
    useEffect(() => {
        if (!isTauriDesktop() || !immersionMode || !neuralReady) return;
        import("@tauri-apps/api/core").then(({ invoke }) =>
            invoke("tts_engine_preload").catch(() => { /* best effort */ }),
        );
    }, [immersionMode, neuralReady]);

    const audioGenUnlistenersRef = useRef<Array<() => void>>([]);
    const audioGenActiveRef = useRef(false);
    const readerUnmountedRef = useRef(false);

    // When leaving the reader, ensure any loaded neural models are unloaded unless audiobook generation is active.
    useEffect(() => {
        readerUnmountedRef.current = false;
        return () => {
            readerUnmountedRef.current = true;
            for (const unlisten of audioGenUnlistenersRef.current) {
                unlisten();
            }
            audioGenUnlistenersRef.current = [];
            if (isTauriDesktop() && !audioGenActiveRef.current) {
                // Memory is trimmed by the cleanup above (sqliteShrinkMemory -> trim_memory);
                // a second request here only raced it.
                import("@tauri-apps/api/core").then(({ invoke }) => {
                    invoke("tts_engine_unload").catch(() => {});
                });
            }
        };
    }, []);

    const handleTtsVoiceChange = useCallback((voice: string) => {
        useSettingsStore.getState().updateTtsSettings({ voice });
    }, []);

    const handleTtsSpeedChange = useCallback((speed: number) => {
        useSettingsStore.getState().updateTtsSettings({ speed });
        void immersionPlayer.setSpeed(speed);
    }, []);

    const handleOpenNeuralSettings = useCallback(() => {
        immersionPlayer.stop();
        setTtsState("idle");
        setRoute("settings");
    }, [setRoute, setTtsState]);

    const [audioGenProgress, setAudioGenProgress] = useState<{ current: number; total: number } | null>(null);

    const handleGenerateAudiobook = useCallback(async () => {
        if (!currentBookId || audioGenProgress) return;
        const sections = await readerRef.current?.getAllSectionsForAudio?.();
        if (!sections || sections.length === 0) {
            toast.error("No extractable text to narrate");
            return;
        }
        audioGenActiveRef.current = true;
        setAudioGenProgress({ current: 0, total: sections.length });
        const { listen } = await import("@tauri-apps/api/event");
        const { invoke } = await import("@tauri-apps/api/core");
        if (readerUnmountedRef.current) {
            audioGenActiveRef.current = false;
            return;
        }
        // Events are broadcast app-wide: only react to this book's generation.
        const unlistenProgress = await listen<{ bookId?: string; current: number; total: number }>(
            "audiobook-gen-progress",
            (e) => {
                if (e.payload.bookId === currentBookId) {
                    setAudioGenProgress({ current: e.payload.current, total: e.payload.total });
                }
            },
        );
        const unlistenDone = await listen<{
            bookId: string;
            path: string | null;
            durationSec: number;
            chapters: AudioChapter[];
            error: string | null;
        }>("audiobook-gen-done", (e) => {
            if (e.payload.bookId !== currentBookId) return;
            unlistenProgress();
            unlistenDone();
            audioGenUnlistenersRef.current = [];
            audioGenActiveRef.current = false;
            setAudioGenProgress(null);
            if (e.payload.error) {
                if (e.payload.error === "cancelled") {
                    toast("Audiobook generation cancelled");
                } else {
                    toast.error(`Audiobook generation failed: ${e.payload.error}`);
                }
                return;
            }
            if (e.payload.path && e.payload.bookId === currentBookId) {
                useLibraryStore.getState().attachAudiobook(e.payload.bookId, {
                    filePath: e.payload.path,
                    format: "opus",
                    durationSec: e.payload.durationSec,
                    currentPositionSec: 0,
                    playbackSpeed: 1,
                    chapters: e.payload.chapters,
                });
                toast.success("Audiobook ready — open immersion mode to listen");
            }
        });
        if (readerUnmountedRef.current) {
            unlistenProgress();
            unlistenDone();
            return;
        }
        audioGenUnlistenersRef.current = [unlistenProgress, unlistenDone];
        try {
            await invoke("generate_audiobook", {
                bookId: currentBookId,
                sections,
                voice: resolveNeuralVoice(ttsVoice),
                speed: ttsSpeed,
                lang: ttsSpeakOptions().lang,
            });
        } catch (err) {
            unlistenProgress();
            unlistenDone();
            audioGenUnlistenersRef.current = [];
            audioGenActiveRef.current = false;
            setAudioGenProgress(null);
            toast.error(`Audiobook generation failed: ${err}`);
        }
    }, [currentBookId, audioGenProgress, readerRef, ttsVoice, ttsSpeed, ttsSpeakOptions]);

    const handleCancelAudiobook = useCallback(() => {
        if (!currentBookId) return;
        void import("@tauri-apps/api/core").then(({ invoke }) =>
            invoke("generate_audiobook_cancel", { bookId: currentBookId }).catch(() => { /* already finished */ }));
    }, [currentBookId]);

    useEffect(() => {
        immersionPlayer.init({
            onStateChange: (state) => {
                setTtsState(state);
            },
            onNearEnd: () => {
                const next = readerRef.current?.getNextPageTextForTts?.();
                if (next?.text) void immersionPlayer.prefetch(next.text, ttsSpeakOptions());
            },
            onError: (message, engine) => {
                setTtsState("idle");
                showTtsError(message, engine, () => {
                    ttsPlatformOnlyRef.current = true;
                    const text = lastSpokenTtsTextRef.current
                        || readerRef.current?.getVisibleTextForTts?.()?.text?.trim();
                    if (text) void immersionPlayer.speak(text, ttsSpeakOptions());
                });
            },
            onWarning: (message) => {
                toast(message);
            },
            onComplete: handleTtsComplete,
        });
    }, [handleTtsComplete, readerRef, setTtsState, ttsSpeakOptions]);

    useEffect(() => {
        return () => {
            immersionPlayer.destroy();
        };
    }, []);

    // Neural voice: warm the next page's first synthesized chunks while the
    // current page reads, so turning the page doesn't wait on synthesis.
    useEffect(() => {
        if (isPdfFormat || !ttsEnabled || !immersionMode || !ttsData || mediaOverlay) return;
        const next = readerRef.current?.getNextPageTextForTts?.();
        if (next?.text) void immersionPlayer.prefetch(next.text, ttsSpeakOptions());
    }, [ttsData, isPdfFormat, ttsEnabled, immersionMode, mediaOverlay, readerRef, ttsSpeakOptions]);

    return {
        readerUnmountedRef,
        neuralReady,
        showNeuralInstall,
        audioGenProgress,
        handleTtsPlay,
        handleTtsPause,
        handleTtsStop,
        handleTtsVoiceChange,
        handleTtsSpeedChange,
        handleOpenNeuralSettings,
        handleGenerateAudiobook,
        handleCancelAudiobook,
    };
}
