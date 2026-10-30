// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Neural narration speed must be applied exactly once: the audio is synthesized at
// normal speed and the native player time-stretches it. Applying it in synthesis
// as well made 1.5x play at about 2.25x until the app restarted (the player keeps
// its speed between pages), then at 1.5x again.

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

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const neuralOn = { runtimeReady: true, modelsReady: true, engineLoaded: true, available: true, supported: true };

async function freshPlayer() {
    vi.resetModules();
    return (await import("../src/features/reader/audio/ImmersionPlayer")).immersionPlayer;
}

beforeEach(() => {
    calls.length = 0;
    handlers = {
        tts_neural_status: () => neuralOn,
        tts_text_chunks: () => ["One.", "Two."],
        tts_synthesize: (args) => ({ path: `/cache/${String(args.text)}.wav`, duration_sec: 3, cached: false }),
    };
    (window as unknown as { __TAURI_INTERNALS__: object }).__TAURI_INTERNALS__ = {};
});
afterEach(() => {
    delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
});

describe("ImmersionPlayer neural speed", () => {
    it("synthesizes at normal speed and lets the player apply the chosen speed once", async () => {
        const player = await freshPlayer();
        await player.speak("One. Two.", { speed: 1.5 });
        await flush();

        const synth = calls.filter((c) => c.cmd === "tts_synthesize");
        expect(synth.length).toBe(2);
        expect(synth.every((c) => c.args.speed === 1)).toBe(true);

        const setSpeed = calls.findIndex((c) => c.cmd === "tts_audio_set_speed");
        const play = calls.findIndex((c) => c.cmd === "tts_audio_play");
        expect(setSpeed).toBeGreaterThanOrEqual(0);
        expect(calls[setSpeed].args.speed).toBe(1.5);
        // The player's speed is set before the page starts, never left from the last page.
        expect(setSpeed).toBeLessThan(play);
        await player.stop();
    });

    it("resets the player to normal speed when the setting is back at 1x", async () => {
        const player = await freshPlayer();
        await player.speak("One. Two.", { speed: 1.5 });
        await flush();
        await player.stop();
        calls.length = 0;

        await player.speak("One. Two.", { speed: 1 });
        await flush();
        const setSpeed = calls.filter((c) => c.cmd === "tts_audio_set_speed");
        expect(setSpeed.map((c) => c.args.speed)).toEqual([1]);
        expect(calls.filter((c) => c.cmd === "tts_synthesize").every((c) => c.args.speed === 1)).toBe(true);
        await player.stop();
    });

    it("prefetches the next page at normal speed so it hits the same cache entry", async () => {
        const player = await freshPlayer();
        await player.prefetch("Next page.", { speed: 1.25 });
        const prefetch = calls.filter((c) => c.cmd === "tts_prefetch");
        expect(prefetch.length).toBe(1);
        expect(prefetch[0].args.speed).toBe(1);
    });

    it("reports progress in listening time at the current speed", async () => {
        vi.useFakeTimers();
        try {
            const player = await freshPlayer();
            const onProgress = vi.fn();
            player.init({ onProgress });
            handlers.tts_audio_status = () => ({ position: 1, duration: 4, chunk_index: 0, finished: false });
            await player.speak("One. Two.", { speed: 1.5 });
            await flush();
            await vi.advanceTimersByTimeAsync(150);
            // Two chunks of 3 s of audio at 1.5x last 4 s.
            expect(onProgress).toHaveBeenLastCalledWith(1, 4);
            await player.stop();
        } finally {
            vi.useRealTimers();
        }
    });

    it("changing speed mid-page goes to the player only, without new synthesis", async () => {
        const player = await freshPlayer();
        await player.speak("One. Two.", { speed: 1 });
        await flush();
        const synthBefore = calls.filter((c) => c.cmd === "tts_synthesize").length;
        await player.setSpeed(2);
        expect(calls.filter((c) => c.cmd === "tts_synthesize").length).toBe(synthBefore);
        expect(calls.filter((c) => c.cmd === "tts_audio_set_speed").at(-1)?.args.speed).toBe(2);
        await player.stop();
    });
});
