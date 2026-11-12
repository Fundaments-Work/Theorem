// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Book, BookAudioTrack } from "../src/core/types";
import type { MediaOverlayPlayer } from "../src/features/reader/engines";

const coreMocks = vi.hoisted(() => ({
    invoke: vi.fn(),
    convertFileSrc: vi.fn((path: string) => `asset://localhost/${path}`),
}));

const eventMocks = vi.hoisted(() => ({
    listeners: new Map<string, Array<(event: { payload: unknown }) => void>>(),
    listen: vi.fn(async (eventName: string, cb: (event: { payload: unknown }) => void) => {
        const list = eventMocks.listeners.get(eventName) ?? [];
        list.push(cb);
        eventMocks.listeners.set(eventName, list);
        return () => {
            const cur = eventMocks.listeners.get(eventName) ?? [];
            eventMocks.listeners.set(eventName, cur.filter((fn) => fn !== cb));
        };
    }),
    emit: (eventName: string, payload: unknown) => {
        for (const cb of eventMocks.listeners.get(eventName) ?? []) {
            cb({ payload });
        }
    },
}));

vi.mock("@tauri-apps/api/core", () => ({
    invoke: coreMocks.invoke,
    convertFileSrc: coreMocks.convertFileSrc,
}));

vi.mock("@tauri-apps/api/event", () => ({
    listen: eventMocks.listen,
}));

import { immersionPlayer } from "../src/features/reader/audio/ImmersionPlayer";
import { immersionUsesTts } from "../src/features/reader/lib/immersion-source";
import { NativeAudiobookAudio } from "../src/features/reader/audio/native-audiobook";
import { AudiobookBar } from "../src/features/reader/audio/AudiobookBar";
import { MediaOverlayBar } from "../src/features/reader/audio/MediaOverlayBar";
import { ReaderNavbar } from "../src/features/reader/components/progress/ReaderNavbar";
import { useLibraryStore } from "../src/core/store";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

const makeTrack = (overrides: Partial<BookAudioTrack> = {}): BookAudioTrack => ({
    filePath: "/audio/book.m4b",
    format: "m4b",
    durationSec: 600,
    currentPositionSec: 120,
    playbackSpeed: 1,
    chapters: [
        { id: "ch-1", title: "Chapter 1", startSec: 0, endSec: 200 },
        { id: "ch-2", title: "Chapter 2", startSec: 200, endSec: 400 },
    ],
    ...overrides,
});

const makeBook = (id: string, audioTrack?: BookAudioTrack): Book => ({
    id,
    title: `Book ${id}`,
    author: "Author",
    filePath: `/books/${id}.epub`,
    format: "epub",
    fileSize: 1024,
    addedAt: new Date("2026-01-01T00:00:00Z"),
    progress: 0,
    readingTime: 0,
    tags: [],
    isFavorite: false,
    audioTrack,
});

class FakeAudioElement extends EventTarget {
    src = "";
    preload = "";
    playbackRate = 1;
    currentTime = 0;
    duration = NaN;
    paused = true;
    error: MediaError | null = null;
    playCalls = 0;
    pauseCalls = 0;
    canPlayOgg = "";

    canPlayType(mime: string): CanPlayTypeResult {
        if (mime.includes("ogg")) return this.canPlayOgg as CanPlayTypeResult;
        return "probably";
    }

    load = vi.fn();
    play = vi.fn(async () => {
        this.playCalls++;
        this.paused = false;
        this.dispatchEvent(new Event("play"));
    });
    pause = vi.fn(() => {
        this.pauseCalls++;
        this.paused = true;
        this.dispatchEvent(new Event("pause"));
    });

    simulateLoaded(durationSec: number) {
        this.duration = durationSec;
        this.dispatchEvent(new Event("loadedmetadata"));
    }
}

beforeEach(() => {
    coreMocks.invoke.mockReset();
    coreMocks.invoke.mockResolvedValue(null);
    coreMocks.convertFileSrc.mockClear();
    eventMocks.listeners.clear();
    eventMocks.listen.mockClear();
    (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__ = {};
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
});

afterEach(async () => {
    await immersionPlayer.stop();
    immersionPlayer.destroy();
    act(() => root.unmount());
    host.remove();
    delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe("B9 & M11: ImmersionPlayer platform/neural lifecycle and pause word math", () => {
    it("stops active OS platform speech in _clearAll when switching to neural TTS", async () => {
        let resolveSpeak: (v: unknown) => void = () => {};
        coreMocks.invoke.mockImplementation((cmd: string) => {
            if (cmd === "tts_neural_status") {
                return Promise.resolve({
                    runtimeReady: true,
                    modelsReady: true,
                    engineLoaded: false,
                    available: true,
                    supported: true,
                });
            }
            if (cmd === "tts_speak") {
                return new Promise((resolve) => {
                    resolveSpeak = resolve;
                });
            }
            if (cmd === "tts_synthesize") {
                return Promise.resolve({ path: "/tmp/chunk.wav", durationSec: 1.5, cached: false });
            }
            return Promise.resolve(null);
        });

        // Start a platform session first (`available: false` or `tts_speak` path)
        coreMocks.invoke.mockImplementationOnce((cmd: string) => {
            if (cmd === "tts_neural_status") {
                return Promise.resolve({
                    runtimeReady: false,
                    modelsReady: false,
                    engineLoaded: false,
                    available: false,
                    supported: true,
                });
            }
            return Promise.resolve(null);
        });
        const firstSpeak = immersionPlayer.speak("First platform sentence.");
        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });
        resolveSpeak?.({ completionEvents: true });
        await firstSpeak;

        // Now switch immediately to neural without calling stop() first
        coreMocks.invoke.mockClear();
        coreMocks.invoke.mockImplementation((cmd: string) => {
            if (cmd === "tts_neural_status") {
                return Promise.resolve({
                    runtimeReady: true,
                    modelsReady: true,
                    engineLoaded: true,
                    available: true,
                    supported: true,
                });
            }
            if (cmd === "tts_text_chunks") return Promise.resolve(["Neural sentence."]);
            if (cmd === "tts_synthesize") {
                return Promise.resolve({ path: "/tmp/chunk.wav", durationSec: 1.5, cached: false });
            }
            if (cmd === "tts_audio_status") {
                return Promise.resolve({ position: 0, duration: 1.5, chunkIndex: 0, finished: false });
            }
            return Promise.resolve(null);
        });

        await immersionPlayer.speak("Neural sentence.");
        expect(coreMocks.invoke).toHaveBeenCalledWith("tts_stop");
    });

    it("handles tts-utterance-done arriving while platform speak is still loading", async () => {
        let resolveSpeak: (v: unknown) => void = () => {};
        const onComplete = vi.fn();
        immersionPlayer.init({ onComplete });

        coreMocks.invoke.mockImplementation((cmd: string) => {
            if (cmd === "tts_neural_status") {
                return Promise.resolve({
                    runtimeReady: false,
                    modelsReady: false,
                    engineLoaded: false,
                    available: false,
                    supported: true,
                });
            }
            if (cmd === "tts_speak") {
                return new Promise((resolve) => {
                    resolveSpeak = resolve;
                });
            }
            return Promise.resolve(null);
        });

        const speakPromise = immersionPlayer.speak("Hi.");
        // Wait until bindPlatformEvents + tts_speak invocation start
        for (let i = 0; i < 6; i++) {
            await Promise.resolve();
        }
        const speakCall = coreMocks.invoke.mock.calls.find(([cmd]) => cmd === "tts_speak");
        const utteranceId = (speakCall?.[1] as { utteranceId?: string })?.utteranceId;
        expect(utteranceId).toBeTruthy();

        // Short utterance finishes while tts_speak IPC is still resolving (state === 'loading')
        eventMocks.emit("tts-utterance-done", { utteranceId });
        resolveSpeak?.({ completionEvents: true });
        await speakPromise;
        await Promise.resolve();

        expect(onComplete).toHaveBeenCalledTimes(1);
    });

    it("accounts for inter-word spaces on platform pause/resume instead of over-dropping words", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
        coreMocks.invoke.mockImplementation((cmd: string) => {
            if (cmd === "tts_neural_status") {
                return Promise.resolve({
                    runtimeReady: false,
                    modelsReady: false,
                    engineLoaded: false,
                    available: false,
                    supported: true,
                });
            }
            if (cmd === "tts_speak") {
                return Promise.resolve({ completionEvents: true });
            }
            return Promise.resolve(null);
        });

        // Single-char words separated by spaces make the +1 bug maximal:
        // "a b c d e f g h i j k" (1-char words; each word+space = 2 chars, so 10 chars = 5 words).
        // Start TTS and advance virtual clock 800ms -> ~11-12 chars spoken (~6 words).
        // Without counting spaces, charCount sums 1 per word -> drops ALL 11 words!
        await immersionPlayer.speak("a b c d e f g h i j k", { speed: 1 });
        vi.advanceTimersByTime(800);
        await immersionPlayer.pause();

        coreMocks.invoke.mockClear();
        await immersionPlayer.resume();
        const resumeSpeakCall = coreMocks.invoke.mock.calls.find(([cmd]) => cmd === "tts_speak");
        expect((resumeSpeakCall?.[1] as { text?: string })?.text).toBe("g h i j k");
    });
});

describe("M9: immersionUsesTts", () => {
    it("returns false for book-narration while keeping tts and audiobook behavior", () => {
        expect(immersionUsesTts("tts")).toBe(true);
        expect(immersionUsesTts("audiobook")).toBe(true);
        expect(immersionUsesTts("book-narration")).toBe(false);
    });
});

describe("B9 & M14: NativeAudiobookAudio session cleanup and AudiobookBar guards", () => {
    it("closes the Linux GStreamer session when NativeAudiobookAudio fails after open", async () => {
        coreMocks.invoke.mockImplementation((cmd: string) => {
            if (cmd === "linux_audiobook_open") return Promise.resolve(42);
            if (cmd === "linux_audiobook_snapshot") return Promise.reject(new Error("Pipeline failed"));
            return Promise.resolve(null);
        });

        const audio = new NativeAudiobookAudio("/tmp/book.ogg");
        await new Promise<void>((resolve) => {
            audio.addEventListener("error", () => resolve());
        });
        await expect(audio.play()).rejects.toThrow("Cannot load audiobook");
        expect(coreMocks.invoke).toHaveBeenCalledWith("linux_audiobook_close", { id: 42 });
    });

    it("disables AudiobookBar skip buttons until metadata is ready and resets timers when re-keyed on book switch", () => {
        const fakeAudio = new FakeAudioElement();
        vi.stubGlobal("Audio", function MockAudio() { return fakeAudio; });

        const t1 = makeTrack({ filePath: "/audio/one.m4b", currentPositionSec: 0, durationSec: 0 });
        const t2 = makeTrack({ filePath: "/audio/two.m4b", currentPositionSec: 30, durationSec: 300 });
        useLibraryStore.setState({
            books: [makeBook("b1", t1), makeBook("b2", t2)],
            collections: [],
        });

        act(() => {
            root.render(
                <AudiobookBar
                    key="b1"
                    bookId="b1"
                    bookTitle="Book 1"
                    audioTrack={t1}
                    onClose={() => {}}
                />,
            );
        });

        const backBtn = host.querySelector('button[aria-label="Back 15 seconds"]') as HTMLButtonElement;
        const fwdBtn = host.querySelector('button[aria-label="Forward 15 seconds"]') as HTMLButtonElement;
        expect(backBtn.disabled).toBe(true);
        expect(fwdBtn.disabled).toBe(true);

        // Sleep timer set for book 1 should not carry over when switching to book 2 (when keyed by bookId)
        const sleepBtn = host.querySelector('button[aria-label="Sleep timer"]') as HTMLButtonElement;
        act(() => sleepBtn.click());
        const chip15 = [...host.querySelectorAll("button")].find((b) => b.textContent === "15 min") as HTMLButtonElement;
        act(() => chip15.click());

        act(() => {
            root.render(
                <AudiobookBar
                    key="b2"
                    bookId="b2"
                    bookTitle="Book 2"
                    audioTrack={t2}
                    onClose={() => {}}
                />,
            );
        });
        act(() => {
            (host.querySelector('button[aria-label="Sleep timer"]') as HTMLButtonElement).click();
        });
        // Book 2 has fresh sleep menu ("Off" is only rendered when a sleep timer is active)
        const offChip = [...host.querySelectorAll("button")].find((b) => b.textContent === "Off");
        expect(offChip).toBeUndefined();
    });
});

describe("N2: ReaderNavbar TTS 2x chip & MediaOverlayBar speed persistence", () => {
    it("includes 2x speed option in ReaderNavbar TTS speed menu", () => {
        act(() => {
            root.render(
                <ReaderNavbar
                    location={null}
                    toc={[]}
                    sectionFractions={[]}
                    onSeek={() => {}}
                    onToggleToc={() => {}}
                    immersionMode
                    neuralReady
                    ttsSpeed={1}
                    onTtsSpeedChange={() => {}}
                />,
            );
        });

        const settingsBtn = host.querySelector('button[aria-label="Voice and speed settings"]') as HTMLButtonElement;
        act(() => settingsBtn.click());
        const twoX = [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === "2×");
        expect(twoX).toBeTruthy();
    });

    it("uses initial speed and calls onSpeedChange on MediaOverlayBar", () => {
        const setRate = vi.fn();
        const overlay = {
            play: vi.fn(),
            pause: vi.fn(),
            resume: vi.fn(),
            stop: vi.fn(),
            next: vi.fn(),
            prev: vi.fn(),
            setRate,
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
        } as unknown as MediaOverlayPlayer;
        const onSpeedChange = vi.fn();

        act(() => {
            root.render(
                <MediaOverlayBar
                    overlay={overlay}
                    onStart={vi.fn().mockResolvedValue(undefined)}
                    onClose={vi.fn()}
                    speed={1.5}
                    onSpeedChange={onSpeedChange}
                />,
            );
        });

        const chip15 = host.querySelector('button[aria-label="Speed 1.5x"]') as HTMLButtonElement;
        expect(chip15.getAttribute("aria-pressed")).toBe("true");
        const chip2 = host.querySelector('button[aria-label="Speed 2x"]') as HTMLButtonElement;
        act(() => chip2.click());
        expect(setRate).toHaveBeenCalledWith(2);
        expect(onSpeedChange).toHaveBeenCalledWith(2);
    });

    it("does not invoke tts_speak if stop() runs while bindPlatformEvents awaits", async () => {
        let releaseBind!: () => void;
        eventMocks.listen.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    releaseBind = () => resolve(() => {});
                }),
        );
        coreMocks.invoke.mockImplementation((cmd: string) => {
            if (cmd === "tts_neural_status") {
                return Promise.resolve({
                    runtimeReady: false,
                    modelsReady: false,
                    engineLoaded: false,
                    available: false,
                    supported: true,
                });
            }
            return Promise.resolve(null);
        });

        const speakPromise = immersionPlayer.speak("Cancelled before speak");
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await immersionPlayer.stop();
        releaseBind?.();
        await speakPromise;

        expect(coreMocks.invoke).not.toHaveBeenCalledWith("tts_speak", expect.anything());
    });
});
