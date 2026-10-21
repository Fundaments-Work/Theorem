import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (args: Record<string, unknown>) => unknown;
const calls: { cmd: string; args: Record<string, unknown> }[] = [];
let handlers: Record<string, Handler> = {};

vi.mock("@tauri-apps/api/core", () => ({
    invoke: vi.fn(async (cmd: string, args: Record<string, unknown> = {}) => {
        calls.push({ cmd, args });
        const handler = handlers[cmd];
        return handler ? handler(args) : undefined;
    }),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

const count = (cmd: string) => calls.filter((c) => c.cmd === cmd).length;
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => { resolve = r; });
    return { promise, resolve };
}

const neuralOn = { runtimeReady: true, modelsReady: true, engineLoaded: true, available: true, supported: true };
const wav = (path: string) => ({ path, duration_sec: 1, cached: false });

async function freshPlayer() {
    vi.resetModules();
    return (await import("../src/features/reader/audio/ImmersionPlayer")).immersionPlayer;
}

beforeEach(() => {
    calls.length = 0;
    handlers = {};
    (window as unknown as { __TAURI_INTERNALS__: object }).__TAURI_INTERNALS__ = {};
});
afterEach(() => {
    delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
    vi.useRealTimers();
});

describe("ImmersionPlayer sessions", () => {
    it("a stale run for the same page cannot take over playback after stop + replay", async () => {
        const player = await freshPlayer();
        const first = deferred<ReturnType<typeof wav>>();
        const second = deferred<ReturnType<typeof wav>>();
        let synthCalls = 0;
        handlers.tts_neural_status = () => neuralOn;
        handlers.tts_text_chunks = () => ["One.", "Two."];
        handlers.tts_synthesize = (args) => {
            synthCalls += 1;
            if (synthCalls === 1) return first.promise;
            if (synthCalls === 2) return second.promise;
            return wav(`/cache/${String(args.text)}-run2.wav`);
        };

        void player.speak("One. Two.");
        await flush();
        await player.stop();
        void player.speak("One. Two."); // the very same page, started again
        await flush();
        // The stale run resolves while the new one is still loading — the window
        // in which comparing page text (identical here) would let it through.
        first.resolve(wav("/cache/One-run1.wav"));
        await flush();
        expect(count("tts_audio_play")).toBe(0);
        second.resolve(wav("/cache/One-run2.wav"));
        await flush();

        expect(calls.filter((c) => c.cmd === "tts_audio_play").map((c) => c.args.path)).toEqual(["/cache/One-run2.wav"]);
        expect(calls.filter((c) => c.cmd === "tts_audio_append").map((c) => c.args.path)).toEqual(["/cache/Two.-run2.wav"]);
        await player.stop();
    });

    it("stopping while the native player is starting does not leave audio running", async () => {
        const player = await freshPlayer();
        const play = deferred<void>();
        handlers.tts_neural_status = () => neuralOn;
        handlers.tts_text_chunks = () => ["Only."];
        handlers.tts_synthesize = () => wav("/cache/only.wav");
        handlers.tts_audio_play = () => play.promise;

        void player.speak("Only.");
        await flush();
        await player.stop();
        const stopsBefore = count("tts_audio_stop");
        play.resolve();
        await flush();

        expect(count("tts_audio_stop")).toBeGreaterThan(stopsBefore);
        expect(player.state).toBe("idle");
    });

    it("a page with nothing speakable completes instead of erroring", async () => {
        const player = await freshPlayer();
        const onComplete = vi.fn();
        const onError = vi.fn();
        player.init({ onComplete, onError });
        handlers.tts_neural_status = () => neuralOn;
        handlers.tts_text_chunks = () => [];

        await player.speak("* * *");
        await flush();

        expect(onComplete).toHaveBeenCalledTimes(1);
        expect(onError).not.toHaveBeenCalled();
        expect(count("tts_synthesize")).toBe(0);
        expect(player.state).toBe("idle");
    });

    it("treats blank chunks from the engine like an empty page", async () => {
        const player = await freshPlayer();
        const onComplete = vi.fn();
        player.init({ onComplete });
        handlers.tts_neural_status = () => neuralOn;
        handlers.tts_text_chunks = () => ["", "   "];
        await player.speak("...");
        await flush();
        expect(onComplete).toHaveBeenCalledTimes(1);
        expect(count("tts_synthesize")).toBe(0);
    });

    it("passes the chosen speed to OS voices and keeps it across pause/resume", async () => {
        vi.useFakeTimers();
        const player = await freshPlayer();
        handlers.tts_neural_status = () => ({ ...neuralOn, available: false });

        await player.speak("A page of text to narrate aloud.", { speed: 1.5 });
        expect(calls.find((c) => c.cmd === "tts_speak")?.args.speed).toBe(1.5);

        await player.pause();
        await player.resume();
        const speaks = calls.filter((c) => c.cmd === "tts_speak");
        expect(speaks).toHaveLength(2);
        expect(speaks[1].args.speed).toBe(1.5);
        await player.stop();
    });

    it("ignores everything when not running inside Tauri", async () => {
        delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
        const player = await freshPlayer();
        await player.speak("Hello there.");
        expect(calls).toHaveLength(0);
        expect(player.state).toBe("idle");
    });
});
