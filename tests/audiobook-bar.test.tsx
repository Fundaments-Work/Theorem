// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
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

function mediaSession(unsupported?: MediaSessionAction) {
    const actions = new Map<MediaSessionAction, MediaSessionActionHandler | null>();
    const session = {
        metadata: null as MediaMetadata | null,
        playbackState: "none",
        setPositionState: vi.fn(),
        setActionHandler: vi.fn((action: MediaSessionAction, handler: MediaSessionActionHandler | null) => {
            if (action === unsupported) throw new Error("Unsupported action");
            actions.set(action, handler);
        }),
    };
    vi.stubGlobal("navigator", Object.assign(Object.create(navigator), { mediaSession: session }));
    vi.stubGlobal("MediaMetadata", class {
        constructor(init: MediaMetadataInit) { Object.assign(this, init); }
    });
    return { session, actions };
}

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
    it("reports playback state and finite, clamped position to system controls", () => {
        const { session } = mediaSession();
        mount();
        expect(session.playbackState).toBe("none");
        expect(session.setPositionState).not.toHaveBeenCalled();
        act(() => audio().load(600));
        expect(session.playbackState).toBe("paused");
        expect(session.setPositionState).toHaveBeenLastCalledWith({ duration: 600, position: 120, playbackRate: 1 });
        act(() => { void audio().play(); audio().tick(900); });
        expect(session.playbackState).toBe("playing");
        expect(session.setPositionState).toHaveBeenLastCalledWith({ duration: 600, position: 600, playbackRate: 1 });
        act(() => audio().pause());
        expect(session.playbackState).toBe("paused");
        act(() => root.unmount());
        root = createRoot(host);
        expect(session.playbackState).toBe("none");
    });

    it("system chapter controls use the current chapter and playback position", () => {
        const { actions } = mediaSession();
        mount();
        act(() => audio().load(600));
        act(() => actions.get("nexttrack")?.({ action: "nexttrack" }));
        expect(audio().currentTime).toBe(200);
        act(() => actions.get("nexttrack")?.({ action: "nexttrack" }));
        expect(audio().currentTime).toBe(200);
        act(() => audio().tick(250));
        act(() => actions.get("previoustrack")?.({ action: "previoustrack" }));
        expect(audio().currentTime).toBe(200);
        act(() => actions.get("previoustrack")?.({ action: "previoustrack" }));
        expect(audio().currentTime).toBe(0);
    });

    it("an unsupported media action does not prevent the remaining actions", () => {
        const { actions } = mediaSession("seekbackward");
        mount();
        expect(actions.get("seekforward")).toBeTypeOf("function");
        expect(actions.get("seekto")).toBeTypeOf("function");
        act(() => root.unmount());
        root = createRoot(host);
        expect([...actions.values()].every((handler) => handler === null)).toBe(true);
    });

    it("publishes book artwork and clears system metadata when closed", () => {
        const { session } = mediaSession();
        const t = track();
        useLibraryStore.setState({ books: [{ ...book(t), coverPath: "data:image/png;base64,AA==" }], collections: [] });
        act(() => root.render(<AudiobookBar bookId="b1" bookTitle="Book" bookAuthor="Author" audioTrack={t} onClose={() => {}} />));
        expect(session.metadata).toMatchObject({ title: "Book", artist: "Author", artwork: [{ src: "data:image/png;base64,AA==" }] });
        act(() => root.unmount());
        root = createRoot(host);
        expect(session.metadata).toBeNull();
    });

    it("ignores unavailable duration and non-finite system seeks", () => {
        const { session, actions } = mediaSession();
        mount(track({ chapters: [] }));
        expect(actions.get("nexttrack")).toBeUndefined();
        expect(actions.get("previoustrack")).toBeUndefined();
        act(() => audio().load(NaN));
        expect(session.setPositionState).not.toHaveBeenCalled();
        act(() => actions.get("seekto")?.({ action: "seekto", seekTime: NaN }));
        expect(audio().currentTime).toBe(0);
        act(() => audio().load(600));
        act(() => actions.get("nexttrack")?.({ action: "nexttrack" }));
        expect(audio().currentTime).toBe(120);
        session.setPositionState.mockClear();
        act(() => audio().tick(Infinity));
        expect(session.setPositionState).not.toHaveBeenCalled();
        act(() => actions.get("previoustrack")?.({ action: "previoustrack" }));
        expect(audio().currentTime).toBe(Infinity);
    });

    it("system seeks honor valid offsets and position follows rate and seek events", () => {
        const { session, actions } = mediaSession();
        mount();
        act(() => audio().load(600));
        act(() => actions.get("seekforward")?.({ action: "seekforward", seekOffset: 30 }));
        expect(audio().currentTime).toBe(150);
        act(() => actions.get("seekbackward")?.({ action: "seekbackward", seekOffset: -2 }));
        expect(audio().currentTime).toBe(135);
        act(() => { audio().playbackRate = 2; audio().dispatchEvent(new Event("ratechange")); });
        expect(session.setPositionState).toHaveBeenLastCalledWith({ duration: 600, position: 135, playbackRate: 2 });
        act(() => { audio().currentTime = 400; audio().dispatchEvent(new Event("seeked")); });
        expect(session.setPositionState).toHaveBeenLastCalledWith({ duration: 600, position: 400, playbackRate: 2 });
        session.setPositionState.mockImplementation(() => { throw new Error("Unsupported position state"); });
        act(() => { void audio().play(); audio().tick(401); });
        expect(session.playbackState).toBe("playing");
    });

    it("rejects unsafe artwork and resets media state after a playback error", () => {
        const { session } = mediaSession();
        const t = track();
        useLibraryStore.setState({ books: [{ ...book(t), coverPath: "javascript:alert(1)" }], collections: [] });
        act(() => root.render(<AudiobookBar bookId="b1" audioTrack={t} onClose={() => {}} />));
        expect(session.metadata).toMatchObject({ artwork: [] });
        act(() => { audio().load(600); void audio().play(); });
        expect(session.playbackState).toBe("playing");
        act(() => audio().dispatchEvent(new Event("error")));
        expect(session.playbackState).toBe("none");
    });

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
