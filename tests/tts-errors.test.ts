// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Narration errors used to be swallowed (the reader only went back to idle).
// They now reach the listener as a toast with a plain explanation, and a
// neural-voice failure offers to continue with the system voice.

const toastError = vi.fn();
vi.mock("sonner", () => ({ toast: { error: (...args: unknown[]) => toastError(...args) } }));

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
    handlers = {};
    toastError.mockReset();
    (window as unknown as { __TAURI_INTERNALS__: object }).__TAURI_INTERNALS__ = {};
});
afterEach(() => {
    delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
});

describe("describeTtsError", () => {
    it("explains common failures in plain words", async () => {
        const { describeTtsError } = await import("../src/features/reader/audio/tts-errors");
        expect(describeTtsError("spd-say: No such file or directory (os error 2)", "platform").title)
            .toBe("No system voice is installed");
        expect(describeTtsError("Model file missing: vocoder.onnx", "neural").title)
            .toBe("The neural voice is not fully installed");
        expect(describeTtsError("ONNX Runtime library is not downloaded yet", "neural").title)
            .toBe("The neural voice is not fully installed");
        expect(describeTtsError("No audio output device: none", "neural").title).toBe("No audio output");
        expect(describeTtsError("vector estimator failed: bad shape", "neural").title)
            .toBe("The neural voice could not read this page");
        expect(describeTtsError("Speech engine error", "platform").title).toBe("The speech engine stopped");
        expect(describeTtsError("TTS speak failed", "platform").title).toBe("The speech engine stopped");
    });

    it("always has something to say, even for an empty or huge message", async () => {
        const { describeTtsError } = await import("../src/features/reader/audio/tts-errors");
        const empty = describeTtsError("", "platform");
        expect(empty.title).toBe("Narration stopped");
        expect(empty.description.length).toBeGreaterThan(0);
        const huge = describeTtsError("x".repeat(5000), "neural");
        expect(huge.description.length).toBeLessThan(400);
    });
});

describe("showTtsError", () => {
    it("offers the system voice when the neural voice fails", async () => {
        const { showTtsError } = await import("../src/features/reader/audio/tts-errors");
        const retry = vi.fn();
        showTtsError("vocoder failed: oom", "neural", retry);
        expect(toastError).toHaveBeenCalledTimes(1);
        const [title, options] = toastError.mock.calls[0] as [string, { description: string; action?: { label: string; onClick: () => void } }];
        expect(title).toBe("The neural voice could not read this page");
        expect(options.description).toMatch(/system voice/);
        expect(options.action?.label).toBe("Use system voice");
        options.action?.onClick();
        expect(retry).toHaveBeenCalledTimes(1);
    });

    it("has no retry action when the system voice itself failed", async () => {
        const { showTtsError } = await import("../src/features/reader/audio/tts-errors");
        showTtsError("spd-say: No such file or directory (os error 2)", "platform", vi.fn());
        const [, options] = toastError.mock.calls[0] as [string, { action?: unknown }];
        expect(options.action).toBeUndefined();
    });
});

describe("ImmersionPlayer error reporting", () => {
    it("reports a failing neural synthesis with its message and engine", async () => {
        const player = await freshPlayer();
        const onError = vi.fn();
        player.init({ onError });
        handlers.tts_neural_status = () => neuralOn;
        handlers.tts_text_chunks = () => ["One."];
        handlers.tts_synthesize = () => { throw new Error("Model file missing: vocoder.onnx"); };

        await player.speak("One.");
        await flush();
        expect(onError).toHaveBeenCalledWith("Model file missing: vocoder.onnx", "neural");
        expect(player.state).toBe("idle");
    });

    it("reports a failing system voice as a platform error", async () => {
        const player = await freshPlayer();
        const onError = vi.fn();
        player.init({ onError });
        handlers.tts_neural_status = () => ({ ...neuralOn, available: false });
        handlers.tts_speak = () => { throw "spd-say: No such file or directory (os error 2)"; };

        await player.speak("One.");
        await flush();
        expect(onError).toHaveBeenCalledWith("spd-say: No such file or directory (os error 2)", "platform");
    });

    it("a page can be retried with the system voice even when the neural voice is installed", async () => {
        const player = await freshPlayer();
        handlers.tts_neural_status = () => neuralOn;
        await player.speak("One.", { engine: "platform", speed: 1.25 });
        await flush();
        expect(calls.some((c) => c.cmd === "tts_synthesize" || c.cmd === "tts_text_chunks")).toBe(false);
        const speak = calls.find((c) => c.cmd === "tts_speak");
        expect(speak?.args.text).toBe("One.");
        expect(speak?.args.speed).toBe(1.25);
        await player.stop();
    });
});
