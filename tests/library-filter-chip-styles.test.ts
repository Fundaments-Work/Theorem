import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * The filter panel's chips were copy-pasted per button, which let the hover
 * treatment drift between sections: the mobile panel gave Sort and Status a
 * `hover:bg`, while Order and all three Quick buttons only changed their border,
 * so hovering Quick looked nothing like hovering Sort.
 *
 * All sections now share one selected/unselected pair.
 */

const library = readFileSync(resolve("src/features/library/Library.tsx"), "utf-8");

describe("filter panel chip styles are shared", () => {
    it("defines one selected and two unselected chip styles", () => {
        expect(library).toContain("const FILTER_CHIP_SELECTED =");
        expect(library).toContain("const FILTER_CHIP_UNSELECTED =");
        expect(library).toContain("const FILTER_CHIP_UNSELECTED_ON_SURFACE =");
    });

    it("the constants are not self-referential", () => {
        // A careless find-and-replace turns the definitions into `X = X`.
        expect(library).not.toMatch(/const FILTER_CHIP_\w+ =\s*\n?\s*FILTER_CHIP_\w+;/);
        expect(library).not.toMatch(/=\s*FILTER_CHIP_SELECTED\s*;/);
        expect(library).not.toMatch(/=\s*FILTER_CHIP_UNSELECTED\s*;/);
        expect(library).not.toMatch(/=\s*FILTER_CHIP_UNSELECTED_ON_SURFACE\s*;/);
    });

    it("the selected style still paints the accent fill", () => {
        const selected = library.match(/const FILTER_CHIP_SELECTED =\s*\n?\s*"([^"]+)"/)?.[1] ?? "";
        expect(selected).toContain("bg-[var(--color-accent)]");
        expect(selected).toContain("text-[color:var(--color-accent-contrast)]");
    });

    it("the mobile unselected style hovers with a background", () => {
        // This is the hover that Quick and Order were missing.
        const unselected = library.match(/const FILTER_CHIP_UNSELECTED =\s*\n?\s*"([^"]+)"/)?.[1] ?? "";
        expect(unselected).toContain("hover:bg-[var(--color-surface)]");
        expect(unselected).toContain("hover:border-[var(--color-border)]");
    });

    it("the desktop unselected style keeps its resting surface fill", () => {
        const onSurface = library.match(
            /const FILTER_CHIP_UNSELECTED_ON_SURFACE =\s*\n?\s*"([^"]+)"/,
        )?.[1] ?? "";
        expect(onSurface).toContain("bg-[var(--color-surface)]");
        expect(onSurface).toContain("hover:border-[var(--color-border)]");
    });

    it("no chip button still inlines its own chip classes", () => {
        // Any remaining copy-pasted chip literal is drift waiting to happen.
        const inlineChips = library.match(
            /className="[^"]*hover:border-\[var\(--color-border\)\][^"]*"/g,
        ) ?? [];
        expect(inlineChips).toHaveLength(0);
    });

    it("every section uses the shared constants", () => {
        // Sort, Status, Order and Quick across both panels.
        expect(library).toContain("settings.librarySortOrder === id ? FILTER_CHIP_SELECTED : FILTER_CHIP_UNSELECTED");
        expect(library).toContain("showFavoritesOnly ? FILTER_CHIP_SELECTED : FILTER_CHIP_UNSELECTED");
        expect(library).toContain("showUnshelvedOnly ? FILTER_CHIP_SELECTED : FILTER_CHIP_UNSELECTED");
        // Mobile "Recent" and desktop "Recent".
        expect(library.match(/FILTER_CHIP_UNSELECTED\)/g)?.length).toBeGreaterThanOrEqual(1);
        expect(library.match(/FILTER_CHIP_UNSELECTED_ON_SURFACE\)/g)?.length).toBeGreaterThanOrEqual(1);
    });
});