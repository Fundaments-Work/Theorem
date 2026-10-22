// @vitest-environment jsdom
/**
 * Reading settings change the page behind them (font, size, theme), so their
 * backdrop closes the panel on click but does not dim the page: the reader
 * sees each change as it is made. Other panels still dim.
 */
import { describe, it, expect, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "fs";
import { resolve } from "path";
import { Backdrop } from "../src/ui/Backdrop";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

function render(el: React.ReactElement): HTMLElement {
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(el));
    return host.firstElementChild as HTMLElement;
}

afterEach(() => {
    act(() => root?.unmount());
    root = null;
    document.body.innerHTML = "";
});

describe("panel backdrops", () => {
    it("dim by default", () => {
        const el = render(<Backdrop visible onClick={() => {}} blur />);
        expect(el.className).toContain("bg-[var(--color-overlay-medium)]");
        expect(el.className).toContain("backdrop-blur");
    });

    it("can stay clear while still closing the panel on click", () => {
        let closed = 0;
        const el = render(<Backdrop visible onClick={() => { closed++; }} dim={false} blur />);
        expect(el.className).not.toContain("color-overlay");
        expect(el.className).not.toContain("backdrop-blur");
        act(() => el.click());
        expect(closed).toBe(1);
    });

    it("reading settings and PDF view settings keep the page visible", () => {
        for (const file of ["src/features/reader/components/ReaderSettings.tsx", "src/features/reader/components/PDFViewSettingsPanel.tsx"]) {
            expect(readFileSync(resolve(file), "utf-8"), file).toMatch(/<Backdrop [^>]*dim=\{false\}/);
        }
    });
});
