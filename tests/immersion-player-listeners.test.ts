import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (args: Record<string, unknown>) => unknown;
let handlers: Record<string, Handler> = {};

// Plain records (not vi.fn) so the global mock reset cannot clear them mid-test.
const { listeners } = vi.hoisted(() => ({
    listeners: {
        bound: [] as string[],
        unbound: [] as string[],
        /** When set, listen() waits for it before resolving. */
        gate: null as Promise<void> | null,
    },
}));

vi.mock("@tauri-apps/api/core", () => ({
    invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
        const handler = handlers[cmd];
        return handler ? handler(args) : undefined;
    },
}));
vi.mock("@tauri-apps/api/event", () => ({
    listen: async (event: string) => {
        if (listeners.gate) await listeners.gate;
        listeners.bound.push(event);
        return () => listeners.unbound.push(event);
    },
}));

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

async function freshPlayer() {
    vi.resetModules();
    return (await import("../src/features/reader/audio/ImmersionPlayer")).immersionPlayer;
}

const platformOnly = { runtimeReady: false, modelsReady: false, engineLoaded: false, available: false, supported: true };
const EVENTS = ["tts-utterance-done", "tts-utterance-error", "tts-utterance-range"];

beforeEach(() => {
    handlers = { tts_neural_status: () => platformOnly };
    listeners.bound.length = 0;
    listeners.unbound.length = 0;
    listeners.gate = null;
    (window as unknown as { __TAURI_INTERNALS__: object }).__TAURI_INTERNALS__ = {};
});
afterEach(() => {
    delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
});

describe("ImmersionPlayer platform event listeners", () => {
    it("binds the three utterance listeners once and destroy() removes them", async () => {
        const player = await freshPlayer();
        await player.speak("One sentence.");
        await player.stop();
        await player.speak("Another sentence.");
        await flush();
        expect(listeners.bound.sort()).toEqual([...EVENTS].sort());

        player.destroy();
        expect(listeners.unbound.sort()).toEqual([...EVENTS].sort());
    });

    it("binds again after destroy, without duplicates", async () => {
        const player = await freshPlayer();
        await player.speak("One sentence.");
        player.destroy();
        await player.speak("Again.");
        await flush();
        expect(listeners.bound).toHaveLength(6);
        player.destroy();
        expect(listeners.unbound).toHaveLength(6);
    });

    it("a listener that finishes binding after destroy() is removed at once", async () => {
        const player = await freshPlayer();
        let open!: () => void;
        listeners.gate = new Promise<void>((resolve) => { open = resolve; });
        const speaking = player.speak("One sentence.");
        await flush();
        player.destroy();
        open();
        await speaking;
        await flush();
        expect(listeners.unbound.sort()).toEqual([...listeners.bound].sort());
        expect(listeners.bound.length).toBeGreaterThan(0);
    });

    it("destroy() before any playback is a no-op for listeners", async () => {
        const player = await freshPlayer();
        player.destroy();
        expect(listeners.unbound).toEqual([]);
    });
});
