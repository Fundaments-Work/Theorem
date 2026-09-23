import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { PDF_HISTORY_LIMIT, pushPdfHistory, stepPdfHistory } from "../src/features/reader/engines/pdf-history";
import { PDFLinkLayer, PdfLinkHandlersContext, type PdfLinkHandlers } from "../src/features/reader/components/PDFLinkLayer";

// @ts-expect-error React act environment flag
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe("pdf history", () => {
    const empty = { back: [], forward: [] };

    it("push records the location and clears forward", () => {
        const state = pushPdfHistory({ back: [], forward: [{ page: 9, ratio: 0 }] }, { page: 3, ratio: 0.5 });
        expect(state).toEqual({ back: [{ page: 3, ratio: 0.5 }], forward: [] });
    });

    it("push does not duplicate the same location", () => {
        const once = pushPdfHistory(empty, { page: 3, ratio: 0.5 });
        expect(pushPdfHistory(once, { page: 3, ratio: 0.505 }).back).toHaveLength(1);
        expect(pushPdfHistory(once, { page: 3, ratio: 0.6 }).back).toHaveLength(2);
    });

    it("caps the stack", () => {
        let state: { back: { page: number; ratio: number }[]; forward: { page: number; ratio: number }[] } = empty;
        for (let i = 1; i <= PDF_HISTORY_LIMIT + 10; i++) state = pushPdfHistory(state, { page: i, ratio: 0 });
        expect(state.back).toHaveLength(PDF_HISTORY_LIMIT);
        expect(state.back[0].page).toBe(11);
    });

    it("back then forward round-trips exactly", () => {
        // Reading p.3 → follow link to p.40 → back → forward.
        const afterJump = pushPdfHistory(empty, { page: 3, ratio: 0.25 });
        const back = stepPdfHistory(afterJump, { page: 40, ratio: 0.1 }, "back");
        expect(back?.target).toEqual({ page: 3, ratio: 0.25 });
        expect(back?.history).toEqual({ back: [], forward: [{ page: 40, ratio: 0.1 }] });
        const forward = stepPdfHistory(back!.history, { page: 3, ratio: 0.25 }, "forward");
        expect(forward?.target).toEqual({ page: 40, ratio: 0.1 });
        expect(forward?.history).toEqual({ back: [{ page: 3, ratio: 0.25 }], forward: [] });
    });

    it("returns null at either end", () => {
        expect(stepPdfHistory(empty, { page: 1, ratio: 0 }, "back")).toBeNull();
        expect(stepPdfHistory(empty, { page: 1, ratio: 0 }, "forward")).toBeNull();
    });

    it("rapid repeated back presses walk the whole stack", () => {
        let state = empty as ReturnType<typeof pushPdfHistory>;
        for (const page of [1, 5, 9]) state = pushPdfHistory(state, { page, ratio: 0 });
        let current = { page: 20, ratio: 0 };
        const visited: number[] = [];
        for (;;) {
            const step = stepPdfHistory(state, current, "back");
            if (!step) break;
            state = step.history;
            current = step.target;
            visited.push(current.page);
        }
        expect(visited).toEqual([9, 5, 1]);
        expect(state.forward.map((e) => e.page)).toEqual([20, 9, 5]);
    });
});

describe("PDFLinkLayer", () => {
    let container: HTMLDivElement;
    let root: Root;

    const links = [
        { annotationType: 2, rect: [100, 700, 150, 712], dest: "cite.a" },
        { annotationType: 2, rect: [100, 600, 200, 612], url: "https://example.org/x" },
    ];
    const fakePage = {
        getAnnotations: vi.fn(async () => links),
        // Identity-ish viewport: scale s, page height 800, y flipped.
        getViewport: ({ scale }: { scale: number }) => ({
            convertToViewportPoint: (x: number, y: number) => [x * scale, (800 - y) * scale],
        }),
    };

    function handlers(overrides: Partial<PdfLinkHandlers> = {}): PdfLinkHandlers {
        return { enabled: true, onActivate: vi.fn(), onHoverStart: vi.fn(), onHoverEnd: vi.fn(), ...overrides };
    }

    async function mount(value: PdfLinkHandlers, page: object = fakePage, scale = 2) {
        await act(async () => {
            root.render(
                <PdfLinkHandlersContext.Provider value={value}>
                    <PDFLinkLayer page={page as never} cssScale={scale} rotation={0} />
                </PdfLinkHandlersContext.Provider>,
            );
        });
        await act(async () => { await Promise.resolve(); });
    }

    beforeEach(() => {
        container = document.createElement("div");
        document.body.appendChild(container);
        root = createRoot(container);
    });
    afterEach(() => {
        act(() => root.unmount());
        container.remove();
    });

    it("positions link boxes in CSS pixels from PDF rects", async () => {
        await mount(handlers());
        const anchors = container.querySelectorAll<HTMLAnchorElement>("a.pdf-link");
        expect(anchors).toHaveLength(2);
        expect(anchors[0].style.left).toBe("200px");
        expect(anchors[0].style.top).toBe("176px");
        expect(anchors[0].style.width).toBe("100px");
        expect(anchors[0].style.height).toBe("24px");
        expect(anchors[1].getAttribute("href")).toBe("https://example.org/x");
        expect(anchors[1].title).toBe("https://example.org/x");
        // Internal links never expose a navigable href.
        expect(anchors[0].getAttribute("href")).toBe("#");
    });

    it("marks links so the viewport tap handler ignores them", async () => {
        await mount(handlers());
        expect(container.querySelector("a.pdf-link")?.hasAttribute("data-no-viewport-tap")).toBe(true);
    });

    it("reports the pointer type that started the activation", async () => {
        const value = handlers();
        await mount(value);
        const anchor = container.querySelector<HTMLAnchorElement>("a.pdf-link")!;
        act(() => {
            anchor.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }));
            anchor.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        });
        expect(value.onActivate).toHaveBeenCalledWith(expect.objectContaining({ kind: "internal" }), anchor, "touch");

        act(() => {
            anchor.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse" }));
            anchor.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        });
        expect(value.onActivate).toHaveBeenLastCalledWith(expect.anything(), anchor, "mouse");
    });

    it("does not let a link click bubble to the viewport or navigate the webview", async () => {
        const value = handlers();
        // The engine's viewport tap handler is a React onClick on an ancestor.
        const outer = vi.fn();
        await act(async () => {
            root.render(
                <div onClick={outer}>
                    <PdfLinkHandlersContext.Provider value={value}>
                        <PDFLinkLayer page={fakePage as never} cssScale={2} rotation={0} />
                    </PdfLinkHandlersContext.Provider>
                </div>,
            );
        });
        await act(async () => { await Promise.resolve(); });
        const anchor = container.querySelectorAll<HTMLAnchorElement>("a.pdf-link")[1];
        const event = new MouseEvent("click", { bubbles: true, cancelable: true });
        act(() => { anchor.dispatchEvent(event); });
        expect(event.defaultPrevented).toBe(true);
        expect(outer).not.toHaveBeenCalled();
        expect(value.onActivate).toHaveBeenCalledWith(expect.objectContaining({ kind: "external", url: "https://example.org/x" }), anchor, "mouse");
    });

    it("renders nothing while an annotation tool is active", async () => {
        await mount(handlers({ enabled: false }));
        expect(container.querySelectorAll("a.pdf-link")).toHaveLength(0);
    });

    it("renders nothing for a page without links or when annotations fail to load", async () => {
        await mount(handlers(), { ...fakePage, getAnnotations: async () => [] });
        expect(container.querySelectorAll("a.pdf-link")).toHaveLength(0);
        await mount(handlers(), { ...fakePage, getAnnotations: async () => { throw new Error("corrupt"); } });
        expect(container.querySelectorAll("a.pdf-link")).toHaveLength(0);
    });

    it("fetches annotations once per page proxy across re-renders and zoom changes", async () => {
        const page = { ...fakePage, getAnnotations: vi.fn(async () => links) };
        await mount(handlers(), page, 1);
        await mount(handlers(), page, 3);
        expect(page.getAnnotations).toHaveBeenCalledTimes(1);
        expect(container.querySelector<HTMLAnchorElement>("a.pdf-link")!.style.left).toBe("300px");
    });
});
