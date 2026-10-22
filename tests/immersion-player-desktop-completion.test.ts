import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Desktop OS voices (`say`, `spd-say -w`, PowerShell) report the real end of
// speech: the backend answers `tts_speak` with `completionEvents: true` and emits
// `tts-utterance-done` when the narration process exits. The page then ends on
// that event, not on a duration estimate that cut speech off or left silence.
// The estimate stays only as a late fallback in case no event ever arrives.

type Handler = (args: Record<string, unknown>) => unknown;
const calls: { cmd: string; args: Record<string, unknown> }[] = [];
let handlers: Record<string, Handler> = {};

const { events } = vi.hoisted(() => ({
    events: {} as Record<string, (event: { payload: Record<string, unknown> }) => void>,
}));

vi.mock("@tauri-apps/api/core", () => ({
    invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
        calls.push({ cmd, args });
        const handler = handlers[cmd];
        return handler ? handler(args) : undefined;
    },
}));
vi.mock("@tauri-apps/api/event", () => ({
    listen: async (event: string, cb: (event: { payload: Record<string, unknown> }) => void) => {
        events[event] = cb;
        return () => { delete events[event]; };
    },
}));

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const platformOnly = { runtimeReady: false, modelsReady: false, engineLoaded: false, available: false, supported: false };

async function freshPlayer() {
    vi.resetModules();
    return (await import("../src/features/reader/audio/ImmersionPlayer")).immersionPlayer;
}

const speakCalls = () => calls.filter((c) => c.cmd === "tts_speak");
const fire = (event: string, payload: Record<string, unknown>) => events[event]?.({ payload });

// About 13.4 characters per second at 1x: 200 characters are estimated at ~15 s.
const PAGE = "A sentence of narration. ".repeat(8);

beforeEach(() => {
    vi.useFakeTimers();
    calls.length = 0;
    handlers = {
        tts_neural_status: () => platformOnly,
        tts_speak: () => ({ completionEvents: true }),
    };
    for (const key of Object.keys(events)) delete events[key];
    (window as unknown as { __TAURI_INTERNALS__: object }).__TAURI_INTERNALS__ = {};
});
afterEach(() => {
    vi.useRealTimers();
    delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
});

describe("ImmersionPlayer with desktop OS voices", () => {
    it("ends the page on the real end of speech, not on the estimate", async () => {
        const player = await freshPlayer();
        const onComplete = vi.fn();
        player.init({ onComplete });
        await player.speak(PAGE, { lang: "en" });
        await flush();

        // Speech runs longer than estimated: the page must not be cut off.
        await vi.advanceTimersByTimeAsync(20_000);
        expect(onComplete).not.toHaveBeenCalled();
        expect(player.state).toBe("playing");

        fire("tts-utterance-done", { utteranceId: speakCalls()[0].args.utteranceId });
        expect(onComplete).toHaveBeenCalledTimes(1);
        expect(player.state).toBe("idle");

        // The fallback timer was cleared with the page.
        await vi.advanceTimersByTimeAsync(120_000);
        expect(onComplete).toHaveBeenCalledTimes(1);
    });

    it("ends early when speech finishes before the estimate", async () => {
        const player = await freshPlayer();
        const onComplete = vi.fn();
        player.init({ onComplete });
        await player.speak(PAGE);
        await flush();
        await vi.advanceTimersByTimeAsync(1_000);
        fire("tts-utterance-done", { utteranceId: speakCalls()[0].args.utteranceId });
        expect(onComplete).toHaveBeenCalledTimes(1);
    });

    it("ignores the end of an earlier utterance", async () => {
        const player = await freshPlayer();
        const onComplete = vi.fn();
        player.init({ onComplete });
        await player.speak("Old page.");
        const stale = speakCalls()[0].args.utteranceId;
        await player.speak(PAGE);
        await flush();
        fire("tts-utterance-done", { utteranceId: stale });
        expect(onComplete).not.toHaveBeenCalled();
        expect(player.state).toBe("playing");
        await player.stop();
    });

    it("reports a failed narration process as an error", async () => {
        const player = await freshPlayer();
        const onError = vi.fn();
        const onComplete = vi.fn();
        player.init({ onError, onComplete });
        await player.speak(PAGE);
        await flush();
        fire("tts-utterance-error", { utteranceId: speakCalls()[0].args.utteranceId });
        expect(onError).toHaveBeenCalledWith(expect.any(String), "platform");
        expect(onComplete).not.toHaveBeenCalled();
    });

    it("still finishes on a late fallback when no event ever arrives", async () => {
        const player = await freshPlayer();
        const onComplete = vi.fn();
        player.init({ onComplete });
        await player.speak(PAGE);
        await flush();
        await vi.advanceTimersByTimeAsync(20_000);
        expect(onComplete).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(onComplete).toHaveBeenCalledTimes(1);
    });

    it("keeps the estimate when the backend promises no completion event", async () => {
        handlers.tts_speak = () => null;
        const player = await freshPlayer();
        const onComplete = vi.fn();
        player.init({ onComplete });
        await player.speak(PAGE);
        await flush();
        await vi.advanceTimersByTimeAsync(16_000);
        expect(onComplete).toHaveBeenCalledTimes(1);
    });
});
