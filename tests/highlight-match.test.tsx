import { describe, it, expect, beforeEach } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { HighlightMatch } from "../src/ui/HighlightMatch";

// @ts-expect-error React act environment flag
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe("HighlightMatch component", () => {
    let container: HTMLDivElement;

    beforeEach(() => {
        container = document.createElement("div");
        document.body.appendChild(container);
        return () => {
            container.remove();
        };
    });

    it("renders plain text when indices are empty or undefined", () => {
        act(() => {
            createRoot(container).render(<HighlightMatch text="Dune" />);
        });
        expect(container.textContent).toBe("Dune");
        expect(container.querySelectorAll("span").length).toBe(1);
    });

    it("renders highlighted characters when indices match", () => {
        // Highlighting 'D' (0) and 'n' (2) in "Dune"
        act(() => {
            createRoot(container).render(
                <HighlightMatch text="Dune" indices={[0, 2]} />
            );
        });
        expect(container.textContent).toBe("Dune");

        const spans = container.querySelectorAll("span > span");
        expect(spans.length).toBe(4); // D (match), u, n (match), e
        expect(spans[0].textContent).toBe("D");
        expect(spans[0].className).toContain("font-bold text-[color:var(--color-accent)]");
        expect(spans[1].textContent).toBe("u");
        expect(spans[2].textContent).toBe("n");
        expect(spans[2].className).toContain("font-bold text-[color:var(--color-accent)]");
        expect(spans[3].textContent).toBe("e");
    });

    it("groups contiguous matched character indices into single spans", () => {
        // Highlighting "Du" (0, 1) in "Dune"
        act(() => {
            createRoot(container).render(
                <HighlightMatch text="Dune" indices={[0, 1]} />
            );
        });
        const spans = container.querySelectorAll("span > span");
        expect(spans.length).toBe(2); // "Du" (match), "ne"
        expect(spans[0].textContent).toBe("Du");
        expect(spans[0].className).toContain("font-bold");
        expect(spans[1].textContent).toBe("ne");
    });

    it("handles non-ASCII and accented characters", () => {
        // "Les Misérables" - highlight 'M' (4)
        act(() => {
            createRoot(container).render(
                <HighlightMatch text="Les Misérables" indices={[4]} />
            );
        });
        expect(container.textContent).toBe("Les Misérables");
        const spans = container.querySelectorAll("span > span");
        expect(spans[1].textContent).toBe("M");
        expect(spans[1].className).toContain("font-bold");
    });
});
