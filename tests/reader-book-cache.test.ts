// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

const createdBooks: Array<{ name: string; destroy: ReturnType<typeof vi.fn> }> = [];

vi.mock("../src/features/reader/foliate-js-runtime/view.js", () => {
    class FakeFoliateView extends HTMLElement {
        renderer = {
            setAttribute: vi.fn(),
            removeAttribute: vi.fn(),
            setStyles: vi.fn(),
            getContents: () => [],
            addEventListener: vi.fn(),
        };
        history = { canGoBack: false, canGoForward: false, addEventListener: vi.fn() };
        getSectionFractions = () => [0, 1];
        open = vi.fn(async () => {});
        goTo = vi.fn(async () => {});
        close = vi.fn();
    }
    if (!customElements.get("foliate-view")) {
        customElements.define("foliate-view", FakeFoliateView);
    }
    return {
        makeBook: vi.fn(async (file: File) => {
            const destroy = vi.fn();
            const entry = { name: file.name, destroy };
            createdBooks.push(entry);
            return {
                metadata: { title: file.name, author: "Author" },
                toc: [],
                sections: [{ id: "s0", linear: "yes", size: 100 }],
                destroy,
            };
        }),
        Overlayer: class {},
    };
});

describe("FoliateEngine bookModelCache ownership", () => {
    afterEach(() => {
        createdBooks.length = 0;
        vi.clearAllMocks();
        document.body.innerHTML = "";
    });

    it("does not destroy a cached book model while it remains in bookModelCache", async () => {
        const { FoliateEngine } = await import("../src/features/reader/engines/foliate-engine");

        const mount = async (filename: string, size: number) => {
            const container = document.createElement("div");
            document.body.appendChild(container);
            const engine = new FoliateEngine({});
            await engine.init(container);
            const source = new Uint8Array(size).buffer;
            await engine.open(source, filename);
            return engine;
        };

        const engine1 = await mount("cached-reopen.epub", 128);
        const firstBook = createdBooks[0];
        expect(firstBook).toBeDefined();

        // Closing engine1 must keep the cached model intact for subsequent opens
        engine1.destroy();
        expect(firstBook.destroy).not.toHaveBeenCalled();

        // Opening two different books pushes the LRU cache past capacity (2), evicting and destroying firstBook
        const engine2 = await mount("evictor-1.epub", 129);
        engine2.destroy();
        expect(firstBook.destroy).not.toHaveBeenCalled();

        const engine3 = await mount("evictor-2.epub", 130);
        expect(firstBook.destroy).toHaveBeenCalledTimes(1);
        engine3.destroy();
    });
});
