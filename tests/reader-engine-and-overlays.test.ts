// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { search } from "../src/features/reader/foliate-js-runtime/search.js";
import * as CFI from "../src/features/reader/foliate-js-runtime/epubcfi.js";
import "../src/features/reader/foliate-js-runtime/fixed-layout.js";
import "../src/features/reader/foliate-js-runtime/view.js";

describe("Reader runtime, search, CFI, and MediaOverlay regressions", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        document.body.innerHTML = "";
    });

    it("search makeExcerpt keeps middle nodes when match spans multiple strings", () => {
        const results = Array.from(
            search(["Hello ", "bright ", "world"], "Hello bright world", {}),
        ) as Array<{ excerpt: { pre: string; match: string; post: string } }>;
        expect(results).toHaveLength(1);
        expect(results[0].excerpt.match).toBe("Hello bright world");
    });

    it("epubcfi compare distinguishes element CFIs from character-offset CFIs", () => {
        expect(CFI.compare("/6/4!/4/2", "/6/4!/4/2:5")).toBe(-1);
        expect(CFI.compare("/6/4!/4/2:5", "/6/4!/4/2")).toBe(1);
        expect(CFI.compare("/6/4!/4/2", "/6/4!/4/2:0")).toBe(-1);
        expect(CFI.compare("/6/4!/4/2", "/6/4!/4/2")).toBe(0);
    });

    it("FixedLayout.getContents includes the numeric section index on loaded frames", async () => {
        class StubResizeObserver {
            observe() {}
            unobserve() {}
            disconnect() {}
        }
        vi.stubGlobal("ResizeObserver", StubResizeObserver);

        const fxl = document.createElement("foliate-fxl") as HTMLElement & {
            open(book: unknown): void;
            goTo(target: unknown): Promise<void>;
            getContents(): Array<{ doc: Document | null; index?: number }>;
            destroy(): void;
        };
        fxl.getBoundingClientRect = () => ({ width: 800, height: 600, top: 0, left: 0, right: 800, bottom: 600, x: 0, y: 0, toJSON() {} });
        document.body.appendChild(fxl);

        fxl.open({
            dir: "ltr",
            rendition: { spread: "none", viewport: { width: 800, height: 600 } },
            sections: [
                { id: "p0", load: async () => "about:blank", unload: () => {}, pageSpread: "center" },
                { id: "p1", load: async () => "about:blank", unload: () => {}, pageSpread: "center" },
            ],
        });

        await fxl.goTo(Promise.resolve({ index: 1 }));
        await new Promise((r) => setTimeout(r, 0));

        const contents = fxl.getContents();
        expect(contents).toHaveLength(1);
        expect(contents[0].index).toBe(1);

        fxl.destroy();
    });

    it("MediaOverlay rejects non-numeric SMIL clock values and seeks paused audio on loadedmetadata", async () => {
        class FakeAudio extends EventTarget {
            static instances: FakeAudio[] = [];
            currentTime = 0;
            paused = true;
            readyState = 0;
            volume = 1;
            playbackRate = 1;
            constructor(public src: string) {
                super();
                FakeAudio.instances.push(this);
            }
            play() {
                this.paused = false;
                return Promise.resolve();
            }
            pause() {
                this.paused = true;
            }
            removeAttribute() {}
            load() {}
        }
        vi.stubGlobal("Audio", FakeAudio);
        URL.createObjectURL = vi.fn(() => "blob:smil-test");
        URL.revokeObjectURL = vi.fn();

        const { EPUB } = await import("../src/features/reader/foliate-js-runtime/epub.js");
        const content: Record<string, string> = {
            "META-INF/container.xml":
                '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
            "book.opf":
                '<?xml version="1.0"?><package xmlns="http://www.idpf.org/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">id1</dc:identifier><dc:title>Test</dc:title><dc:language>en</dc:language></metadata><manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml" media-overlay="s1"/><item id="s1" href="c1.smil" media-type="application/smil+xml"/></manifest><spine><itemref idref="c1"/></spine></package>',
            "c1.smil":
                '<?xml version="1.0"?><smil xmlns="http://www.w3.org/ns/SMIL" version="3.0"><body><par><text src="c1.xhtml#p1"/><audio src="a1.mp3" clipBegin="bogus" clipEnd="1s"/></par><par><text src="c1.xhtml#p2"/><audio src="a2.mp3" clipBegin="5s" clipEnd="8s"/></par></body></smil>',
        };
        const book = await new EPUB({
            loadText: async (uri: string) => content[uri] ?? null,
            loadBlob: async (uri: string) => new Blob([uri]),
            getSize: () => 0,
            sha1: undefined,
        }).init();

        const overlay = book.getMediaOverlay()!;
        const highlights: Array<{ text: string; begin?: number }> = [];
        overlay.addEventListener("highlight", (e) => highlights.push((e as CustomEvent).detail));

        await overlay.start(0);
        const firstAudio = FakeAudio.instances[0];
        firstAudio.readyState = 4;
        firstAudio.dispatchEvent(new Event("canplaythrough"));
        firstAudio.dispatchEvent(new Event("playing"));
        await new Promise((r) => setTimeout(r, 0));

        // clipBegin="bogus" must yield undefined rather than NaN
        expect(highlights[0].begin).toBeUndefined();

        // Pause, skip to next audio clip at readyState === 0, then fire loadedmetadata
        overlay.pause();
        overlay.next();
        await new Promise((r) => setTimeout(r, 0));
        const secondAudio = FakeAudio.instances[1];
        expect(secondAudio).toBeDefined();
        // Reset currentTime to simulate browser ignoring writes while readyState === 0
        secondAudio.currentTime = 0;
        secondAudio.readyState = 1;
        secondAudio.dispatchEvent(new Event("loadedmetadata"));
        expect(secondAudio.currentTime).toBe(5);
    });

    it("excludes blank spread slots (-1 index) from FixedLayout.getContents and clears comic URLs on destroy", async () => {
        const fakeIframeDocs = new WeakMap<HTMLIFrameElement, Document>();
        const origCreateElement = document.createElement.bind(document);
        vi.spyOn(document, "createElement").mockImplementation(((tag: string, options?: ElementCreationOptions) => {
            const el = origCreateElement(tag, options);
            if (tag.toLowerCase() === "iframe") {
                const blankDoc = document.implementation.createHTMLDocument("blank");
                Object.defineProperty(el, "contentDocument", {
                    get: () => fakeIframeDocs.get(el as HTMLIFrameElement) ?? blankDoc,
                    configurable: true,
                });
                queueMicrotask(() => {
                    if ((el as HTMLIFrameElement).src) {
                        fakeIframeDocs.set(el as HTMLIFrameElement, document.implementation.createHTMLDocument("page"));
                        el.dispatchEvent(new Event("load"));
                    }
                });
            }
            return el;
        }) as typeof document.createElement);

        await import("../src/features/reader/foliate-js-runtime/fixed-layout.js");
        const { makeComicBook } = await import("../src/features/reader/foliate-js-runtime/comic-book.js");

        const fxl = document.createElement("foliate-fxl") as HTMLElement & {
            open(book: unknown): void;
            goTo(target: unknown): Promise<void>;
            getContents(): Array<{ doc: Document | null; index?: number }>;
            destroy(): void;
        };
        fxl.getBoundingClientRect = () => ({ width: 800, height: 600, top: 0, left: 0, right: 800, bottom: 600, x: 0, y: 0, toJSON() {} });
        document.body.appendChild(fxl);
        fxl.open({
            dir: "ltr",
            rendition: { viewport: { width: 800, height: 600 } },
            sections: [
                { id: "p0", load: async () => "about:blank", unload: vi.fn() },
                { id: "p1", load: async () => "about:blank", unload: vi.fn() },
            ],
        });
        await fxl.goTo(Promise.resolve({ index: 0 }));
        await new Promise((r) => setTimeout(r, 0));
        const contents = fxl.getContents();
        expect(contents).toHaveLength(1);
        expect(contents[0].index).toBe(0);
        fxl.destroy();
        fxl.remove();
        vi.restoreAllMocks();

        URL.createObjectURL = vi.fn(() => "blob:comic-1");
        const revokeSpy = vi.fn();
        URL.revokeObjectURL = revokeSpy;
        const comic = await makeComicBook(
            {
                entries: [{ filename: "01.jpg" }],
                loadBlob: async () => new Blob(["x"]),
                getSize: () => 1,
                getLazyZip: undefined,
            },
            { name: "comic.cbz" },
        ) as { sections: Array<{ load: () => Promise<string> }>; destroy: () => void };
        await comic.sections[0].load();
        comic.destroy();
        comic.destroy();
        expect(revokeSpy).toHaveBeenCalledTimes(2);
    });
});
