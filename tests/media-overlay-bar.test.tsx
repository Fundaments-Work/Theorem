// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MediaOverlayBar } from "../src/features/reader/audio/MediaOverlayBar";

// @ts-expect-error React 19 act environment flag
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

class FakeOverlay extends EventTarget {
    pause = vi.fn();
    resume = vi.fn();
    stop = vi.fn();
    prev = vi.fn();
    next = vi.fn();
    setVolume = vi.fn();
    setRate = vi.fn();
    fire(type: string) { this.dispatchEvent(new CustomEvent(type)); }
}

let host: HTMLDivElement;
let root: Root;
let overlay: FakeOverlay;
let onStart: ReturnType<typeof vi.fn>;
let onClose: ReturnType<typeof vi.fn>;
const handlers = new Map<string, MediaSessionActionHandler | null>();

const mount = async () => {
    await act(async () => {
        root.render(<MediaOverlayBar overlay={overlay} onStart={onStart as () => Promise<void>} bookTitle="B" onClose={onClose as () => void} />);
    });
};
const button = (label: string) => host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
const click = async (label: string) => { await act(async () => { button(label).click(); }); };
const fire = async (type: string) => { await act(async () => { overlay.fire(type); }); };

beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    overlay = new FakeOverlay();
    onStart = vi.fn(() => Promise.resolve());
    onClose = vi.fn();
    handlers.clear();
    vi.stubGlobal("navigator", Object.assign(Object.create(navigator), {
        mediaSession: {
            metadata: null,
            playbackState: "none",
            setActionHandler: (a: string, h: MediaSessionActionHandler | null) => handlers.set(a, h),
        },
    }));
});

afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe("MediaOverlayBar", () => {
    it("starts only when asked, then pauses and resumes", async () => {
        await mount();
        expect(onStart).not.toHaveBeenCalled();
        await click("Play");
        expect(onStart).toHaveBeenCalledOnce();
        await fire("highlight");
        expect(host.textContent).toContain("Reading along");
        await click("Pause");
        expect(overlay.pause).toHaveBeenCalledOnce();
        await click("Play");
        expect(overlay.resume).toHaveBeenCalledOnce();
        expect(onStart).toHaveBeenCalledOnce();
    });

    it("stays paused when skipping while paused", async () => {
        await mount();
        await click("Play");
        await fire("highlight");
        await click("Pause");
        await click("Next phrase");
        expect(overlay.next).toHaveBeenCalledOnce();
        await fire("highlight");
        expect(host.textContent).toContain("Paused");
    });

    it("disables skipping until narration has started", async () => {
        await mount();
        expect(button("Previous phrase").disabled).toBe(true);
        expect(button("Next phrase").disabled).toBe(true);
    });

    it("shows when the book finishes and can start again", async () => {
        await mount();
        await click("Play");
        await fire("highlight");
        await fire("finished");
        expect(host.textContent).toContain("Finished");
        expect(button("Next phrase").disabled).toBe(true);
        await click("Play");
        expect(onStart).toHaveBeenCalledTimes(2);
    });

    it("shows playback errors and allows a retry", async () => {
        await mount();
        await click("Play");
        await fire("error");
        expect(host.querySelector("[role=alert]")?.textContent).toContain("could not be played");
        await click("Play");
        expect(onStart).toHaveBeenCalledTimes(2);
        expect(host.querySelector("[role=alert]")).toBeNull();
    });

    it("changes speed and marks the selected chip", async () => {
        await mount();
        await click("Speed 1.5x");
        expect(overlay.setRate).toHaveBeenCalledWith(1.5);
        expect(button("Speed 1.5x").getAttribute("aria-pressed")).toBe("true");
        expect(button("Speed 1x").getAttribute("aria-pressed")).toBe("false");
    });

    it("wires system media keys, and they ignore skips before starting", async () => {
        await mount();
        act(() => handlers.get("nexttrack")?.({ action: "nexttrack" }));
        expect(overlay.next).not.toHaveBeenCalled();
        await act(async () => { handlers.get("play")?.({ action: "play" }); });
        expect(onStart).toHaveBeenCalledOnce();
        await fire("highlight");
        act(() => handlers.get("nexttrack")?.({ action: "nexttrack" }));
        act(() => handlers.get("previoustrack")?.({ action: "previoustrack" }));
        expect(overlay.next).toHaveBeenCalledOnce();
        expect(overlay.prev).toHaveBeenCalledOnce();
        await act(async () => { handlers.get("pause")?.({ action: "pause" }); });
        expect(overlay.pause).toHaveBeenCalledOnce();
    });

    it("ignores the pause key until narration has started", async () => {
        await mount();
        await act(async () => { handlers.get("pause")?.({ action: "pause" }); });
        expect(overlay.pause).not.toHaveBeenCalled();
        expect(host.textContent).not.toContain("Paused");
        await click("Play");
        expect(onStart).toHaveBeenCalledOnce();
    });

    it("ignores the pause key after the book has finished", async () => {
        await mount();
        await click("Play");
        await fire("highlight");
        await fire("finished");
        await act(async () => { handlers.get("pause")?.({ action: "pause" }); });
        expect(overlay.pause).not.toHaveBeenCalled();
        expect(host.textContent).toContain("Finished");
    });

    it("pauses when the sleep timer runs out", async () => {
        vi.useFakeTimers();
        await mount();
        await click("Play");
        await fire("highlight");
        await click("Sleep timer");
        const chip = [...host.querySelectorAll("button")].find(b => b.textContent === "15 min")!;
        await act(async () => { chip.click(); });
        await act(async () => { vi.advanceTimersByTime(15 * 60_000 + 1000); });
        expect(overlay.pause).toHaveBeenCalledOnce();
    });

    it("stops narration and clears media keys when it goes away", async () => {
        await mount();
        act(() => root.unmount());
        expect(overlay.stop).toHaveBeenCalledOnce();
        expect(handlers.get("play")).toBeNull();
        root = createRoot(host);
    });

    it("closes through the callback", async () => {
        await mount();
        await click("Close player");
        expect(onClose).toHaveBeenCalledOnce();
    });

    it("names the book's narration as the source and says where it starts", async () => {
        await mount();
        expect(host.textContent).toContain("Book narration");
        expect(host.textContent).toContain("Starts at the beginning of this section");
        await click("Play");
        await fire("highlight");
        expect(host.textContent).toContain("Book narration");
        expect(host.textContent).not.toContain("Starts at the beginning");
    });

    it("switching books stops the old narration and starts the new book idle", async () => {
        // Reader keys the bar by book id, so a new book mounts a new bar.
        const first = overlay;
        const second = new FakeOverlay();
        const render = async (key: string, o: FakeOverlay, title: string) => {
            await act(async () => {
                root.render(<MediaOverlayBar key={key} overlay={o} onStart={onStart as () => Promise<void>} bookTitle={title} onClose={onClose as () => void} />);
            });
        };
        await render("b1", first, "First");
        await click("Play");
        await fire("highlight");
        expect(host.textContent).toContain("Reading along");

        await render("b2", second, "Second");
        expect(first.stop).toHaveBeenCalled();
        expect(second.stop).not.toHaveBeenCalled();
        expect(onStart).toHaveBeenCalledOnce(); // the new book does not start on its own
        expect(host.textContent).toContain("Starts at the beginning of this section");
        expect((navigator.mediaSession.metadata as MediaMetadata | null)?.title).not.toBe("First");

        // Late events from the old book's player no longer reach the bar.
        await act(async () => { first.fire("finished"); });
        expect(host.textContent).not.toContain("Finished");
    });

    it("uses a container width, not a named max-w that resolves to spacing", async () => {
        // docs/design-system.md: named max-w-* classes resolve to the spacing scale
        // here, so max-w-2xl squeezed the bar to 3.6rem.
        await mount();
        const classes = Array.from(host.querySelectorAll("[class]")).flatMap(el => Array.from(el.classList));
        expect(classes).toContain("max-w-[var(--container-width-sm)]");
        expect(classes.filter(c => /^max-w-(xs|sm|md|lg|xl|\dxl)$/.test(c))).toEqual([]);
    });
});
