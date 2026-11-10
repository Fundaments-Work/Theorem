import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
import { NativeAudiobookAudio } from "../src/features/reader/audio/native-audiobook";

const ready = { ready: true, playing: false, finished: false, position: 0, duration: 120 };

beforeEach(() => {
    vi.useFakeTimers();
    native.invoke.mockReset();
    native.invoke.mockImplementation(async (command: string) => {
        if (command === "linux_audiobook_open") return 7;
        if (command === "linux_audiobook_snapshot") return ready;
        return undefined;
    });
});
afterEach(() => vi.useRealTimers());

describe("native audiobook transport", () => {
    it("loads metadata and serializes the initial speed and resume seek", async () => {
        const audio = new NativeAudiobookAudio("/books/a.mp3");
        audio.playbackRate = 1.25;
        const loaded = vi.fn(() => { audio.currentTime = 42; });
        audio.addEventListener("loadedmetadata", loaded);
        await vi.advanceTimersByTimeAsync(0);
        expect(loaded).toHaveBeenCalledOnce();
        expect(audio.duration).toBe(120);
        expect(native.invoke.mock.calls.map(([command]) => command)).toEqual([
            "linux_audiobook_open", "linux_audiobook_snapshot", "linux_audiobook_set_rate", "linux_audiobook_seek",
        ]);
        audio.src = "";
        await vi.advanceTimersByTimeAsync(0);
        expect(native.invoke).toHaveBeenCalledWith("linux_audiobook_close", { id: 7 });
    });

    it("closes a session that opens after the player is disposed", async () => {
        let finish!: (id: number) => void;
        native.invoke.mockImplementation((command: string) => command === "linux_audiobook_open"
            ? new Promise<number>(resolve => { finish = resolve; })
            : Promise.resolve());
        const audio = new NativeAudiobookAudio("/books/a.mp3");
        const loaded = vi.fn();
        audio.addEventListener("loadedmetadata", loaded);
        audio.src = "";
        finish(9);
        await vi.advanceTimersByTimeAsync(0);
        expect(native.invoke).toHaveBeenCalledWith("linux_audiobook_close", { id: 9 });
        expect(loaded).not.toHaveBeenCalled();
    });

    it("does not resume when pause arrives while play is in flight", async () => {
        let finish!: () => void;
        native.invoke.mockImplementation((command: string) => {
            if (command === "linux_audiobook_open") return Promise.resolve(7);
            if (command === "linux_audiobook_snapshot") return Promise.resolve(ready);
            if (command === "linux_audiobook_play") return new Promise<void>(resolve => { finish = resolve; });
            return Promise.resolve();
        });
        const audio = new NativeAudiobookAudio("/books/a.mp3");
        const played = vi.fn();
        audio.addEventListener("play", played);
        await vi.advanceTimersByTimeAsync(0);
        const playing = audio.play();
        await vi.advanceTimersByTimeAsync(0);
        audio.pause();
        finish();
        await playing;
        await vi.advanceTimersByTimeAsync(0);
        expect(played).not.toHaveBeenCalled();
        expect(audio.paused).toBe(true);
        const commands = native.invoke.mock.calls.map(([command]) => command);
        expect(commands.indexOf("linux_audiobook_pause")).toBeGreaterThan(commands.indexOf("linux_audiobook_play"));
        audio.src = "";
    });

    it("does not overwrite a seek with a snapshot that was already in flight", async () => {
        let finish!: (status: typeof ready) => void;
        let snapshots = 0;
        native.invoke.mockImplementation((command: string) => {
            if (command === "linux_audiobook_open") return Promise.resolve(7);
            if (command === "linux_audiobook_snapshot") {
                snapshots += 1;
                return snapshots === 1 ? Promise.resolve(ready) : new Promise<typeof ready>(resolve => { finish = resolve; });
            }
            return Promise.resolve();
        });
        const audio = new NativeAudiobookAudio("/books/a.mp3");
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(250);
        audio.currentTime = 60;
        finish(ready);
        await vi.advanceTimersByTimeAsync(0);
        expect(audio.currentTime).toBe(60);
        expect(native.invoke).toHaveBeenCalledWith("linux_audiobook_seek", { id: 7, seconds: 60 });
        audio.src = "";
    });

    it("keeps the latest request when play, pause and play overlap", async () => {
        let finish!: () => void;
        let plays = 0;
        native.invoke.mockImplementation((command: string) => {
            if (command === "linux_audiobook_open") return Promise.resolve(7);
            if (command === "linux_audiobook_snapshot") return Promise.resolve(ready);
            if (command === "linux_audiobook_play" && ++plays === 1) return new Promise<void>(resolve => { finish = resolve; });
            return Promise.resolve();
        });
        const audio = new NativeAudiobookAudio("/books/a.mp3");
        const played = vi.fn();
        const paused = vi.fn();
        audio.addEventListener("play", played);
        audio.addEventListener("pause", paused);
        await vi.advanceTimersByTimeAsync(0);
        const first = audio.play();
        await vi.advanceTimersByTimeAsync(0);
        audio.pause();
        const last = audio.play();
        finish();
        await Promise.all([first, last]);
        expect(audio.paused).toBe(false);
        expect(played).toHaveBeenCalledOnce();
        expect(paused).not.toHaveBeenCalled();
        audio.src = "";
    });

    it("does not end a new play request using an older snapshot", async () => {
        let finish!: (status: typeof ready) => void;
        let snapshots = 0;
        native.invoke.mockImplementation((command: string) => {
            if (command === "linux_audiobook_open") return Promise.resolve(7);
            if (command === "linux_audiobook_snapshot") {
                snapshots += 1;
                return snapshots === 1 ? Promise.resolve(ready) : new Promise<typeof ready>(resolve => { finish = resolve; });
            }
            return Promise.resolve();
        });
        const audio = new NativeAudiobookAudio("/books/a.mp3");
        const ended = vi.fn();
        audio.addEventListener("ended", ended);
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(250);
        const playing = audio.play();
        finish({ ...ready, finished: true });
        await playing;
        expect(ended).not.toHaveBeenCalled();
        expect(audio.paused).toBe(false);
        audio.src = "";
    });

    it("reports a native error and stops polling", async () => {
        native.invoke.mockImplementation(async (command: string) => {
            if (command === "linux_audiobook_open") return 7;
            throw new Error("decoder failed");
        });
        const audio = new NativeAudiobookAudio("/books/broken.mp3");
        const errors = vi.fn();
        audio.addEventListener("error", errors);
        await vi.advanceTimersByTimeAsync(1000);
        expect(errors).toHaveBeenCalledOnce();
        expect(audio.error?.code).toBe(4);
        expect(native.invoke.mock.calls.filter(([command]) => command === "linux_audiobook_snapshot")).toHaveLength(1);
        audio.src = "";
    });
});
