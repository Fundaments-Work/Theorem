// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { PDFFloatingToolbar } from "../src/features/reader/components/PDFFloatingToolbar";
import type { HighlightColor } from "../src/core/types";

// @ts-expect-error React 19 act environment flag
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Root[] = [];

function render(ui: React.ReactElement) {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push(root);
    act(() => { root.render(ui); });
    return container;
}

function swatches(container: HTMLElement): HTMLButtonElement[] {
    return Array.from(container.querySelectorAll<HTMLButtonElement>(
        'button[aria-label$="colour"]',
    ));
}

describe("PDFFloatingToolbar colour swatches", () => {
    afterEach(() => {
        while (mounted.length) {
            const root = mounted.pop()!;
            act(() => { root.unmount(); });
        }
        document.body.innerHTML = "";
    });

    function setup(mode: 'highlight' | 'pen') {
        const onHighlightColorChange = vi.fn();
        const onPenColorChange = vi.fn();
        const container = render(
            <PDFFloatingToolbar
                annotationMode={mode}
                highlightColor="yellow"
                penColor="blue"
                onAnnotationModeChange={() => { }}
                onHighlightColorChange={onHighlightColorChange}
                onPenColorChange={onPenColorChange}
            />,
        );
        // Open the panel so the swatch row is mounted.
        act(() => {
            container.querySelector<HTMLButtonElement>('button[title^="Open"]')
                ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        return { container, onHighlightColorChange, onPenColorChange };
    }

    it("renders the six colour swatches in both modes", () => {
        expect(swatches(setup("highlight").container)).toHaveLength(6);
        expect(swatches(setup("pen").container)).toHaveLength(6);
    });

    it("routes pen swatches to the pen colour, not the highlight colour", () => {
        // The bug: every swatch called onHighlightColorChange, so pdfBrushColor
        // never changed and the pen stayed on its default blue.
        const { container, onHighlightColorChange, onPenColorChange } = setup("pen");
        const red = swatches(container).find(b => b.getAttribute("aria-label") === "Red colour")!;
        act(() => { red.dispatchEvent(new MouseEvent("click", { bubbles: true })); });

        expect(onPenColorChange).toHaveBeenCalledWith("red");
        expect(onHighlightColorChange).not.toHaveBeenCalled();
    });

    it("routes highlight swatches to the highlight colour", () => {
        const { container, onHighlightColorChange, onPenColorChange } = setup("highlight");
        const green = swatches(container).find(b => b.getAttribute("aria-label") === "Green colour")!;
        act(() => { green.dispatchEvent(new MouseEvent("click", { bubbles: true })); });

        expect(onHighlightColorChange).toHaveBeenCalledWith("green");
        expect(onPenColorChange).not.toHaveBeenCalled();
    });

    it("marks a newly chosen pen colour as selected", () => {
        // The swatch must re-render as selected, otherwise the pick looks ignored
        // even though the stroke colour did change.
        const onPenColorChange = vi.fn();
        // Wrapper owns the pen colour, so the swatch selection is driven the way
        // it is in the reader: click updates state, state flows back down.
        function PenPanel() {
            const [penColor, setPenColor] = React.useState<HighlightColor>("blue");
            return (
                <PDFFloatingToolbar
                    annotationMode="pen"
                    highlightColor="yellow"
                    penColor={penColor}
                    onAnnotationModeChange={() => { }}
                    onHighlightColorChange={() => { }}
                    onPenColorChange={(c) => { onPenColorChange(c); setPenColor(c); }}
                />
            );
        }

        const container = render(<PenPanel />);
        act(() => {
            container.querySelector<HTMLButtonElement>('button[title^="Open"]')
                ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });

        const redBefore = swatches(container).find(b => b.getAttribute("aria-label") === "Red colour")!;
        expect(redBefore.getAttribute("aria-pressed")).toBe("false");

        act(() => { redBefore.dispatchEvent(new MouseEvent("click", { bubbles: true })); });

        expect(onPenColorChange).toHaveBeenCalledWith("red");
        const redAfter = swatches(container).find(b => b.getAttribute("aria-label") === "Red colour")!;
        expect(redAfter.getAttribute("aria-pressed")).toBe("true");
        const blueAfter = swatches(container).find(b => b.getAttribute("aria-label") === "Blue colour")!;
        expect(blueAfter.getAttribute("aria-pressed")).toBe("false");
    });

    it("marks the pen's own colour as selected while in pen mode", () => {
        const { container } = setup("pen");
        const blue = swatches(container).find(b => b.getAttribute("aria-label") === "Blue colour")!;
        const yellow = swatches(container).find(b => b.getAttribute("aria-label") === "Yellow colour")!;
        expect(blue.getAttribute("aria-pressed")).toBe("true");
        expect(yellow.getAttribute("aria-pressed")).toBe("false");
    });

    it("marks the highlight's own colour as selected while highlighting", () => {
        const { container } = setup("highlight");
        const yellow = swatches(container).find(b => b.getAttribute("aria-label") === "Yellow colour")!;
        const blue = swatches(container).find(b => b.getAttribute("aria-label") === "Blue colour")!;
        expect(yellow.getAttribute("aria-pressed")).toBe("true");
        expect(blue.getAttribute("aria-pressed")).toBe("false");
    });

    it("does not leak the pen colour into the highlight selection", () => {
        // Regression guard: a shared `activeColor` would make this fail.
        const { container } = setup("pen");
        const pressed = swatches(container)
            .filter(b => b.getAttribute("aria-pressed") === "true")
            .map(b => b.getAttribute("aria-label"));
        expect(pressed).toEqual(["Blue colour"]);
    });
});

describe("pen colour reaches the annotation layer", () => {
    beforeEach(() => { document.body.innerHTML = ""; });

    it("Reader keeps pen colour and highlight colour in separate state", () => {
        const src = require("fs").readFileSync(
            require("path").resolve("src/features/reader/Reader.tsx"), "utf-8",
        ) as string;
        expect(src).toContain("const [pdfBrushColor, setPdfBrushColor] = useState<HighlightColor>(\"blue\")");
        expect(src).toContain("onPenColorChange={setPdfBrushColor}");
        expect(src).toContain("onHighlightColorChange={setPdfHighlightColor}");
    });

    it("the toolbar no longer discards its pen colour props", () => {
        const src = require("fs").readFileSync(
            require("path").resolve("src/features/reader/components/PDFFloatingToolbar.tsx"), "utf-8",
        ) as string;
        expect(src).not.toContain("_penColor");
        expect(src).not.toContain("_onPenColorChange");
        // No unconditional handler on any swatch.
        expect(src).not.toContain("onClick={() => onHighlightColorChange(swatch.color)}");
    });
});

describe("freehand strokes use the selected colour", () => {
    it("strokes and persists the annotation with the pen colour", () => {
        const src = require("fs").readFileSync(
            require("path").resolve("src/features/reader/components/PDFAnnotationLayer.tsx"), "utf-8",
        ) as string;
        // Live stroke colour.
        expect(src).toMatch(/context\.strokeStyle = getHighlightSolidColor\(penColor\);/);
        // Persisted colour, so the stroke survives a reload in the right colour.
        expect(src).toMatch(/color: penColor,/);
        // Re-render of stored drawings falls back to the pen colour.
        expect(src).toContain("getHighlightSolidColor(annotation.color || penColor)");
    });
});

export type { HighlightColor };