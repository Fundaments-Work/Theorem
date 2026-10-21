// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AudiobookBar } from "../src/features/reader/audio/AudiobookBar";
import { useLibraryStore } from "../src/core/store";
import type { Book, BookAudioTrack } from "../src/core/types";

vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => `asset://${p}` }));

// @ts-expect-error React 19 act environment flag
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

class FakeAudio extends EventTarget {
    static instances: FakeAudio[] = [];
    src: string;
    preload = "";
    playbackRate = 1;
    currentTime = 0;
    duration = NaN;
    paused = true;
    error: { code: number } | null = null;
    constructor(src: string) {
        super();
        this.src = src;
        FakeAudio.instances.push(this);
    }
    play() { this.paused = false; this.dispatchEvent(new Event("play")); return Promise.resolve(); }
    pause() { if (this.paused) return; this.paused = true; this.dispatchEvent(new Event("pause")); }
    load(duration: number) { this.duration = duration; this.dispatchEvent(new Event("loadedmetadata")); }
    tick(time: number) { this.currentTime = time; this.dispatchEvent(new Event("timeupdate")); }
}
const audio = () => FakeAudio.instances[FakeAudio.instances.length - 1];

const track = (over: Partial<BookAudioTrack> = {}): BookAudioTrack => ({
    filePath: "/books/a.m4b", format: "m4b", durationSec: 600, currentPositionSec: 120, playbackSpeed: 1,
    chapters: [
        { id: "c1", title: "One", startSec: 0, endSec: 200 },
        { id: "c2", title: "Two", startSec: 200, endSec: 600 },
    ],
    ...over,
});
const book = (audioTrack: BookAudioTrack): Book => ({ id: "b1", title: "B", author: "A", filePath: "b", format: "epub",
    fileSize: 1, addedAt: new Date(), progress: 0, readingTime: 0, tags: [], isFavorite: false, audioTrack });
const saved = () => useLibraryStore.getState().books[0].audioTrack!;

let host: HTMLDivElement;
let root: Root;
const mount = (t = track()) => {
    useLibraryStore.setState({ books: [book(t)], collections: [] });
    act(() => root.render(<AudiobookBar bookId="b1" audioTrack={t} onClose={() => {}} />));
};
const q = (sel: string) => host.querySelector<HTMLElement>(sel);

beforeEach(() => {
    FakeAudio.instances = [];
    vi.stubGlobal("Audio", FakeAudio);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
});

describe("AudiobookBar", () => {
    it("closing before the file has loaded keeps the saved position", () => {
        mount();
        act(() => root.unmount());
        root = createRoot(host);
        expect(saved().currentPositionSec).toBe(120);
    });

    it("resumes at the saved position and saves where the listener stopped", () => {
        mount();
        act(() => audio().load(600));
        expect(audio().currentTime).toBe(120);
        act(() => audio().tick(250));
        act(() => root.unmount());
        root = createRoot(host);
        expect(saved().currentPositionSec).toBe(250);
    });

    it("restarts a recording that was left within seconds of the end", () => {
        mount(track({ currentPositionSec: 598 }));
        act(() => audio().load(600));
        expect(audio().currentTime).toBe(0);
    });

    it("saves on pause and when the recording ends", () => {
        mount();
        act(() => audio().load(600));
        act(() => { void audio().play(); });
        act(() => audio().tick(300));
        act(() => audio().pause());
        expect(saved().currentPositionSec).toBe(300);
        act(() => audio().dispatchEvent(new Event("ended")));
        expect(saved().currentPositionSec).toBe(600);
    });

    it("explains a file that cannot be played and disables Play", () => {
        mount();
        audio().error = { code: 4 };
        act(() => { audio().dispatchEvent(new Event("error")); });
        expect(q('[role="alert"]')?.textContent).toMatch(/Can't play this file/);
        expect(q('button[aria-label="Play"]')?.hasAttribute("disabled")).toBe(true);
    });

    it("end-of-chapter sleep pauses at the boundary, whatever the speed", () => {
        mount(track({ currentPositionSec: 100, playbackSpeed: 2 }));
        act(() => audio().load(600));
        act(() => { void audio().play(); });
        act(() => { q('button[aria-label="Sleep timer"]')?.click(); });
        const endOfChapter = Array.from(host.querySelectorAll("button")).find((b) => b.textContent === "End of chapter")!;
        act(() => endOfChapter.click());
        act(() => audio().tick(150));
        expect(audio().paused).toBe(false);
        act(() => audio().tick(200));
        expect(audio().paused).toBe(true);
    });

    it("the scrubber is keyboard operable", () => {
        mount();
        act(() => audio().load(600));
        const slider = q('[role="slider"]')!;
        expect(slider.tabIndex).toBe(0);
        act(() => { slider.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); });
        expect(audio().currentTime).toBe(125);
        act(() => { slider.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })); });
        expect(audio().currentTime).toBe(0);
        act(() => { slider.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })); });
        expect(audio().currentTime).toBe(600);
    });

    it("speed buttons report which speed is selected", () => {
        mount(track({ playbackSpeed: 1.5 }));
        const pressed = Array.from(host.querySelectorAll('button[aria-pressed="true"]')).map((b) => b.textContent);
        expect(pressed).toEqual(["1.5×"]);
    });
});
