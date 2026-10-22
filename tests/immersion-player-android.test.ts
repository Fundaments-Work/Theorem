import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Android platform narration: speed and the book's language reach the engine,
// every speak is tagged with an utterance id, and events from an earlier
// utterance (a page that was stopped or replaced) are ignored.

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
const originalUA = navigator.userAgent;

async function freshPlayer() {
    vi.resetModules();
    return (await import("../src/features/reader/audio/ImmersionPlayer")).immersionPlayer;
}

const speakCalls = () => calls.filter((c) => c.cmd === "tts_speak");
const fire = (event: string, payload: Record<string, unknown>) => events[event]?.({ payload });

beforeEach(() => {
    calls.length = 0;
    handlers = { tts_neural_status: () => platformOnly };
    for (const key of Object.keys(events)) delete events[key];
    Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 (Linux; Android 15) Theorem", configurable: true });
    (window as unknown as { __TAURI_INTERNALS__: object }).__TAURI_INTERNALS__ = {};
});
afterEach(() => {
    Object.defineProperty(navigator, "userAgent", { value: originalUA, configurable: true });
    delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
});

describe("ImmersionPlayer on Android", () => {
    it("passes speed, the book language and a fresh utterance id on every speak", async () => {
        const player = await freshPlayer();
        await player.speak("Bonjour à tous.", { speed: 1.5, lang: "fr" });
        await player.speak("Encore.", { speed: 0.75, lang: "fr" });
        const [first, second] = speakCalls();
        expect(first.args).toMatchObject({ text: "Bonjour à tous.", speed: 1.5, lang: "fr" });
        expect(second.args).toMatchObject({ speed: 0.75, lang: "fr" });
        expect(typeof first.args.utteranceId).toBe("string");
        expect(first.args.utteranceId).not.toBe("");
        expect(first.args.utteranceId).not.toBe(second.args.utteranceId);
        await player.stop();
    });

    it("ignores done, error and range events from an earlier utterance", async () => {
        const player = await freshPlayer();
        const onComplete = vi.fn();
        const onError = vi.fn();
        const onSentenceChange = vi.fn();
        player.init({ onComplete, onError, onSentenceChange });

        await player.speak("Old page. Still old.");
        const stale = speakCalls()[0].args.utteranceId;
        await player.speak("New page. Second sentence here.");
        const current = speakCalls()[1].args.utteranceId;
        await flush();
        onSentenceChange.mockClear();

        fire("tts-utterance-range", { utteranceId: stale, id: `${stale}#0`, start: 10, end: 15 });
        fire("tts-utterance-error", { utteranceId: stale, id: `${stale}#0` });
        fire("tts-utterance-done", { utteranceId: stale, id: `${stale}#0` });
        await flush();
        expect(onComplete).not.toHaveBeenCalled();
        expect(onError).not.toHaveBeenCalled();
        expect(onSentenceChange).not.toHaveBeenCalled();
        expect(player.state).toBe("playing");

        fire("tts-utterance-range", { utteranceId: current, id: `${current}#0`, start: 10, end: 16 });
        expect(onSentenceChange).toHaveBeenCalledWith(expect.objectContaining({ text: "Second sentence here." }), 2);
        fire("tts-utterance-done", { utteranceId: current, id: `${current}#0` });
        await flush();
        expect(onComplete).toHaveBeenCalledTimes(1);
    });

    it("ignores events that arrive after stop", async () => {
        const player = await freshPlayer();
        const onComplete = vi.fn();
        player.init({ onComplete });
        await player.speak("A page.");
        const id = speakCalls()[0].args.utteranceId;
        await player.stop();
        fire("tts-utterance-done", { utteranceId: id, id: `${id}#0` });
        await flush();
        expect(onComplete).not.toHaveBeenCalled();
    });

    it("reports an engine error for the current utterance", async () => {
        const player = await freshPlayer();
        const onError = vi.fn();
        player.init({ onError });
        await player.speak("A page.");
        const id = speakCalls()[0].args.utteranceId;
        fire("tts-utterance-error", { utteranceId: id, id: `${id}#0` });
        await flush();
        expect(onError).toHaveBeenCalledWith("Speech engine error", "platform");
    });

    it("tells the listener when the engine has no voice for the book's language", async () => {
        const player = await freshPlayer();
        const onWarning = vi.fn();
        player.init({ onWarning });
        handlers.tts_speak = () => ({ languageWarning: "No Icelandic voice is installed; reading in English." });
        await player.speak("Góðan daginn.", { lang: "is" });
        expect(onWarning).toHaveBeenCalledWith("No Icelandic voice is installed; reading in English.");
        handlers.tts_speak = () => null;
        await player.speak("Góðan daginn.", { lang: "is" });
        expect(onWarning).toHaveBeenCalledTimes(1);
        await player.stop();
    });
});
