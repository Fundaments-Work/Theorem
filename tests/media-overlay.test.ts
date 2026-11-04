// @vitest-environment jsdom
/**
 * EPUB 3 Media Overlays (#154): `MediaOverlay` in the reader runtime, driven
 * through a small in-memory book and a fake `Audio`, so no decoding happens.
 * Chapter 1 has two audio files; chapter 2 has one.
 */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCSS } from "../src/features/reader/foliate/reader";

const CONTAINER = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

const opf = (activeClass: string) => `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="id">overlay-fixture</dc:identifier>
    <dc:title>Overlay</dc:title>
    <dc:language>en</dc:language>
    ${activeClass}
  </metadata>
  <manifest>
    <item id="c1" href="c1.xhtml" media-type="application/xhtml+xml" media-overlay="s1"/>
    <item id="c2" href="c2.xhtml" media-type="application/xhtml+xml" media-overlay="s2"/>
    <item id="s1" href="c1.smil" media-type="application/smil+xml"/>
    <item id="s2" href="c2.smil" media-type="application/smil+xml"/>
  </manifest>
  <spine><itemref idref="c1"/><itemref idref="c2"/></spine>
</package>`;

const par = (text: string, audio: string, begin: string, end: string) =>
    `<par><text src="${text}"/><audio src="${audio}" clipBegin="${begin}" clipEnd="${end}"/></par>`;
const smil = (pars: string) =>
    `<?xml version="1.0"?><smil xmlns="http://www.w3.org/ns/SMIL" version="3.0"><body>${pars}</body></smil>`;

const files = (activeClass: string): Record<string, string> => ({
    "META-INF/container.xml": CONTAINER,
    "book.opf": opf(activeClass),
    "c1.smil": smil(
        par("c1.xhtml#p1", "a1.mp3", "0s", "1s")
        + par("c1.xhtml#p2", "a1.mp3", "1s", "2s")
        + par("c1.xhtml#p3", "a2.mp3", "0s", "1s"),
    ),
    "c2.smil": smil(par("c2.xhtml#p1", "a3.mp3", "0s", "1s")),
});

class FakeAudio extends EventTarget {
    static last: FakeAudio | null = null;
    static all: FakeAudio[] = [];
    playResult: Promise<void> = Promise.resolve();
    currentTime = 0;
    paused = true;
    readyState = 4;
    volume = 1;
    playbackRate = 1;
    constructor(public src: string) {
        super();
        FakeAudio.last = this;
        FakeAudio.all.push(this);
    }
    play() {
        this.paused = false;
        return this.playResult;
    }
    pause() {
        this.paused = true;
    }
    released = false;
    removeAttribute() {
        this.released = true;
    }
    load() {}
}

type Overlay = EventTarget & {
    start(index: number): Promise<void>;
    next(): void;
    prev(): void;
    pause(): void;
    resume(): void;
    setRate(rate: number): void;
};

async function openOverlay(
    activeClass = "<meta property=\"media:active-class\">active</meta>",
    overrides: Record<string, string> = {},
) {
    const { EPUB } = await import("../src/features/reader/foliate-js-runtime/epub.js");
    const content = { ...files(activeClass), ...overrides };
    const played: string[] = [];
    const failingBlobs = new Set<string>();
    const book = await new EPUB({
        loadText: async (uri: string) => content[uri] ?? null,
        loadBlob: async (uri: string) => {
            if (failingBlobs.has(uri)) throw new Error(`cannot read ${uri}`);
            played.push(uri);
            return new Blob([uri]);
        },
        getSize: () => 0,
    }).init();
    const overlay = book.getMediaOverlay() as Overlay;
    const events: string[] = [];
    const dispatch = overlay.dispatchEvent.bind(overlay);
    overlay.dispatchEvent = (e: Event) => {
        events.push(e.type);
        return dispatch(e);
    };
    return { book, overlay, played, events, failingBlobs };
}

const themeSheet = (mediaActiveClass?: string) => getCSS({
    lineHeight: 1.4, justify: false, hyphenate: false, invert: false, overrideFont: false,
    theme: { name: "light", light: { fg: "#000", bg: "#fff", link: "#00f" }, dark: { fg: "#fff", bg: "#000", link: "#00f" } },
    mediaActiveClass,
} as Parameters<typeof getCSS>[0])[1];

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

async function startPlaying(overlay: Overlay, index = 0) {
    await overlay.start(index);
    FakeAudio.last?.dispatchEvent(new Event("canplaythrough"));
    FakeAudio.last?.dispatchEvent(new Event("playing"));
    await flush();
}

beforeEach(() => {
    FakeAudio.last = null;
    FakeAudio.all = [];
    vi.stubGlobal("Audio", FakeAudio);
    URL.createObjectURL = vi.fn(() => "blob:fake");
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("MediaOverlay", () => {
    it("opens the fixture EPUB and finds its narration", async () => {
        const bytes = readFileSync(`${process.cwd()}/tests/fixtures/epub/media-overlay.epub`);
        const { makeBook, getMediaActiveClass, DEFAULT_MEDIA_ACTIVE_CLASS } =
            await import("../src/features/reader/foliate-js-runtime/view.js");
        const book = await makeBook(new File([bytes], "media-overlay.epub", { type: "application/epub+zip" }));
        expect(book.sections.map((s: { mediaOverlay: unknown }) => !!s.mediaOverlay)).toEqual([true, true]);
        expect(getMediaActiveClass(book)).toBe(DEFAULT_MEDIA_ACTIVE_CLASS);

        const played: string[] = [];
        const loadBlob = book.loadBlob.bind(book);
        book.loadBlob = (uri: string) => { played.push(uri); return loadBlob(uri); };
        const overlay = book.getMediaOverlay() as Overlay;
        const highlighted: string[] = [];
        overlay.addEventListener("highlight", e => highlighted.push((e as CustomEvent).detail.text));
        await startPlaying(overlay);
        expect(played).toEqual(["OEBPS/c1.mp3"]);
        expect(highlighted).toEqual(["OEBPS/c1.xhtml#p1"]);

        // The fragment must lead to the phrase's own element, not the whole chapter.
        const doc = new DOMParser().parseFromString(
            '<html xmlns="http://www.w3.org/1999/xhtml"><body><p id="p1">One</p></body></html>', "application/xhtml+xml");
        expect(book.resolveHref(highlighted[0]).anchor(doc)?.id).toBe("p1");
    });

    it("next() before anything has played does nothing", async () => {
        const { overlay, played } = await openOverlay();
        expect(() => overlay.next()).not.toThrow();
        await flush();
        expect(played).toEqual([]);
    });

    it("detects overlays and reads the active class", async () => {
        const { book } = await openOverlay();
        expect(book.sections.every((s: { mediaOverlay: unknown }) => s.mediaOverlay)).toBe(true);
        expect(book.media.activeClass).toBe("active");
    });

    it("has no active class when the book declares none", async () => {
        const { book } = await openOverlay("");
        expect(book.media.activeClass).toBeUndefined();
    });

    it("falls back to the class the reader CSS styles by default", async () => {
        const { book } = await openOverlay("");
        const { getMediaActiveClass } = await import("../src/features/reader/foliate-js-runtime/view.js");
        const activeClass = getMediaActiveClass(book);
        expect(themeSheet()).toContain(`.${activeClass},`);
        expect(activeClass).toBe("media-active");
    });

    it("styles a book's own class over the theme's forced backgrounds", () => {
        const sheet = themeSheet("-epub-media-overlay-active");
        const forced = sheet.indexOf("body *");
        const active = sheet.indexOf(".-epub-media-overlay-active,");
        expect(forced).toBeGreaterThan(-1);
        expect(active).toBeGreaterThan(forced);
        expect(sheet.slice(active)).toMatch(/background: color-mix[^;]*!important/);
    });

    it("keeps the class a book declares", async () => {
        const { book } = await openOverlay();
        const { getMediaActiveClass } = await import("../src/features/reader/foliate-js-runtime/view.js");
        expect(getMediaActiveClass(book)).toBe("active");
    });

    it("stops narration when the view closes", async () => {
        await import("../src/features/reader/foliate-js-runtime/view.js");
        const view = document.createElement("foliate-view") as HTMLElement & {
            mediaOverlay: { stop: () => void } | null;
            close: () => void;
        };
        const stop = vi.fn();
        view.mediaOverlay = { stop };
        view.close();
        expect(stop).toHaveBeenCalledOnce();
        expect(view.mediaOverlay).toBeNull();
    });

    it("next() on a file's last phrase plays the section's next audio file", async () => {
        const { overlay, played } = await openOverlay();
        await startPlaying(overlay);
        overlay.next(); // p1 -> p2, the last phrase in a1.mp3
        await flush();
        overlay.next(); // p2 -> should be p3 in a2.mp3
        await flush();
        expect(played.at(-1)).toBe("a2.mp3");
    });

    it("reports when the book has finished", async () => {
        const { overlay, events } = await openOverlay();
        await startPlaying(overlay, 1); // last chapter, one clip
        FakeAudio.last?.dispatchEvent(new Event("ended"));
        await flush();
        expect(events).toContain("finished");
    });

    it("moves on when a section's narration has no phrase for it", async () => {
        const { overlay, played } = await openOverlay(undefined, {
            "c1.smil": smil(par("c2.xhtml#p9", "a9.mp3", "0s", "1s")),
        });
        await overlay.start(0);
        expect(played).toEqual(["a3.mp3"]);
    });

    it("reports the book as finished when the last section has no phrase for it", async () => {
        const { overlay, events } = await openOverlay(undefined, {
            "c2.smil": smil(par("c1.xhtml#p9", "a9.mp3", "0s", "1s")),
        });
        await overlay.start(1);
        expect(events).toContain("finished");
    });

    it("reports a failed load when skipping forward", async () => {
        const { overlay, events, failingBlobs } = await openOverlay();
        await startPlaying(overlay);
        failingBlobs.add("a1.mp3");
        overlay.next();
        await flush();
        expect(events).toContain("error");
    });

    it("reports a failed load when skipping back", async () => {
        const { overlay, events, failingBlobs } = await openOverlay();
        await startPlaying(overlay);
        overlay.next();
        await flush();
        failingBlobs.add("a1.mp3");
        overlay.prev();
        await flush();
        expect(events).toContain("error");
    });

    describe("skipping quickly", () => {
        const audible = () => FakeAudio.all.filter(a => !a.paused);
        const fireOnAll = (type: string) => FakeAudio.all.forEach(a => {
            a.dispatchEvent(new Event(type));
            a.dispatchEvent(new Event("seeked"));
        });

        it("plays only the last skip when several overlap", async () => {
            const { overlay } = await openOverlay();
            await startPlaying(overlay);
            overlay.next();
            overlay.next();
            overlay.next();
            await flush();
            fireOnAll("canplaythrough");
            await flush();
            expect(audible()).toHaveLength(1);
            expect(audible()[0]).toBe(FakeAudio.last);
        });

        it("does not start an abandoned player once it finishes loading", async () => {
            const { overlay } = await openOverlay();
            await overlay.start(0);
            const abandoned = FakeAudio.last!;
            overlay.next();
            await flush();
            abandoned.dispatchEvent(new Event("canplaythrough"));
            expect(abandoned.paused).toBe(true);
        });

        it("ignores errors from an abandoned player", async () => {
            const { overlay, events } = await openOverlay();
            await startPlaying(overlay);
            const abandoned = FakeAudio.last!;
            overlay.next();
            await flush();
            abandoned.dispatchEvent(new Event("error"));
            await flush();
            expect(events).not.toContain("error");
        });

        it("does not report an interrupted play() as a failure", async () => {
            const { overlay, events } = await openOverlay();
            await overlay.start(0);
            FakeAudio.last!.playResult = Promise.reject(new DOMException("interrupted", "AbortError"));
            FakeAudio.last!.dispatchEvent(new Event("canplaythrough"));
            await flush();
            expect(events).not.toContain("error");
        });

        it("does not start if paused during the seek", async () => {
            const { overlay } = await openOverlay();
            await startPlaying(overlay);
            overlay.next();
            await flush();
            FakeAudio.last!.dispatchEvent(new Event("canplaythrough"));
            overlay.pause();
            FakeAudio.last!.dispatchEvent(new Event("seeked"));
            await flush();
            expect(audible()).toHaveLength(0);
        });

        it("still reports a real playback failure", async () => {
            const { overlay, events } = await openOverlay();
            await startPlaying(overlay);
            FakeAudio.last!.dispatchEvent(new Event("error"));
            await flush();
            expect(events).toContain("error");
        });

        it("stays paused if paused while the next phrase loads", async () => {
            const { overlay } = await openOverlay();
            await startPlaying(overlay);
            overlay.next();
            await flush();
            overlay.pause();
            FakeAudio.last!.dispatchEvent(new Event("canplaythrough"));
            await flush();
            expect(audible()).toHaveLength(0);
        });

        it("a skip made while a chapter loads wins over that chapter", async () => {
            const { overlay } = await openOverlay();
            await startPlaying(overlay);
            const going = overlay.start(1);
            overlay.next();
            await going;
            await flush();
            fireOnAll("canplaythrough");
            await flush();
            expect(audible()).toHaveLength(1);
        });
    });

    describe("changing speed", () => {
        // Changing playbackRate on a playing element silences WebKitGTK for a while.
        it("swaps in a new player at the same position while playing", async () => {
            const { overlay } = await openOverlay();
            await startPlaying(overlay);
            const old = FakeAudio.last!;
            old.currentTime = 0.5;
            overlay.setRate(1.5);
            await flush();
            const next = FakeAudio.last!;
            expect(next).not.toBe(old);
            expect(old.paused).toBe(true);
            expect(old.playbackRate).toBe(1);
            expect(next.playbackRate).toBe(1.5);
            next.dispatchEvent(new Event("canplaythrough"));
            await flush();
            expect(next.currentTime).toBe(0.5);
            expect(next.paused).toBe(true); // playing during a seek can leave WebKitGTK silent
            next.dispatchEvent(new Event("seeked"));
            await flush();
            expect(next.paused).toBe(false);
            expect(old.released).toBe(true);
        });

        it("stays paused at the same position when paused", async () => {
            const { overlay } = await openOverlay();
            await startPlaying(overlay);
            FakeAudio.last!.currentTime = 0.5;
            overlay.pause();
            overlay.setRate(2);
            await flush();
            const next = FakeAudio.last!;
            expect(next.playbackRate).toBe(2);
            expect(next.currentTime).toBe(0.5);
            expect(next.paused).toBe(true);
            overlay.resume();
            expect(next.paused).toBe(false);
        });

        it("does not lose the position when clicked again while the new player loads", async () => {
            const { overlay } = await openOverlay();
            await startPlaying(overlay);
            FakeAudio.last!.currentTime = 0.5;
            overlay.setRate(1.5);
            overlay.setRate(2); // still fetching
            await flush();
            const loading = FakeAudio.last!;
            loading.readyState = 0;
            overlay.setRate(0.75); // created, not ready
            await flush();
            expect(FakeAudio.last).toBe(loading);
            expect(loading.playbackRate).toBe(0.75);
            loading.dispatchEvent(new Event("canplaythrough"));
            loading.dispatchEvent(new Event("seeked"));
            await flush();
            expect(loading.currentTime).toBe(0.5);
            expect(loading.paused).toBe(false);
        });

        it("a skip right after a speed change starts at the new phrase", async () => {
            const { overlay } = await openOverlay();
            await startPlaying(overlay);
            FakeAudio.last!.currentTime = 0.5;
            overlay.setRate(1.5);
            overlay.next();
            await flush();
            FakeAudio.last!.dispatchEvent(new Event("canplaythrough"));
            FakeAudio.last!.dispatchEvent(new Event("seeked"));
            await flush();
            expect(FakeAudio.last!.currentTime).toBe(1); // p2 begins at 1s
            expect(FakeAudio.last!.playbackRate).toBe(1.5);
        });

        it("only remembers the speed before anything has played", async () => {
            const { overlay } = await openOverlay();
            overlay.setRate(1.5);
            await flush();
            expect(FakeAudio.all).toHaveLength(0);
            await startPlaying(overlay);
            expect(FakeAudio.last!.playbackRate).toBe(1.5);
        });
    });
});
