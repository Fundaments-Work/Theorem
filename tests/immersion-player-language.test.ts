import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The book's language reaches text normalisation: English number and
// abbreviation rules must not be applied to other languages.

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
const neuralOff = { ...neuralOn, available: false };

async function freshPlayer() {
    vi.resetModules();
    return (await import("../src/features/reader/audio/ImmersionPlayer")).immersionPlayer;
}

beforeEach(() => {
    calls.length = 0;
    handlers = {
        tts_text_chunks: (args) => [String(args.text)],
        tts_synthesize: () => ({ path: "/cache/x.wav", duration_sec: 1, cached: false }),
    };
    (window as unknown as { __TAURI_INTERNALS__: object }).__TAURI_INTERNALS__ = {};
});
afterEach(() => {
    delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
});

describe("ImmersionPlayer language", () => {
    it("neural narration of a French page keeps French numbers", async () => {
        handlers.tts_neural_status = () => neuralOn;
        const player = await freshPlayer();
        await player.speak("En 1984, il avait 25 ans.\n\nFin.", { lang: "fr" });
        await flush();
        const chunks = calls.find((c) => c.cmd === "tts_text_chunks");
        expect(chunks?.args.text).toBe("En 1984, il avait 25 ans.\n\nFin.");
        expect(chunks?.args.lang).toBe("fr");
        await player.stop();
    });

    it("an English page is still expanded", async () => {
        handlers.tts_neural_status = () => neuralOn;
        const player = await freshPlayer();
        await player.speak("He was 25.", { lang: "en" });
        await flush();
        expect(calls.find((c) => c.cmd === "tts_text_chunks")?.args.text).toBe("He was twenty-five.");
        await player.stop();
    });

    it("platform voices get the untouched French text too", async () => {
        handlers.tts_neural_status = () => neuralOff;
        const player = await freshPlayer();
        await player.speak("Il avait 25 ans.", { lang: "fr" });
        await flush();
        expect(calls.find((c) => c.cmd === "tts_speak")?.args.text).toBe("Il avait 25 ans.");
        await player.stop();
    });

    it("prefetch normalises with the book language", async () => {
        handlers.tts_neural_status = () => neuralOn;
        const player = await freshPlayer();
        await player.prefetch("Er kaufte 2 Äpfel für 3,50 €.", { lang: "de" });
        expect(calls.find((c) => c.cmd === "tts_text_chunks")?.args.text).toBe("Er kaufte 2 Äpfel für 3,50 €.");
    });
});
