import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { LIBRARY_LIST_ROW_HEIGHT } from "../src/features/library/Library";

/**
 * List view collided on phones because the row virtualizer estimated a flat 70px
 * per row while the rendered row was ~92–111px tall. Rows are positioned
 * absolutely from that estimate, so every row overlapped the next one.
 *
 * The repo forbids per-row measurement (`measureElement`), so the fix is to pin
 * the row to a fixed height that the estimate shares.
 */

describe("list row height matches the virtualizer estimate", () => {
    it("is large enough for the row's own content", () => {
        // 24px of p-3 padding + a 64px h-16 cover = 88px minimum.
        expect(LIBRARY_LIST_ROW_HEIGHT).toBeGreaterThanOrEqual(88);
    });

    it("Library estimates rows with the shared constant", () => {
        const src = readFileSync(resolve("src/features/library/Library.tsx"), "utf-8");
        expect(src).toMatch(
            /const getEstimateSize = useCallback\(\(\) => \{\s*if \(isListView\) return LIBRARY_LIST_ROW_HEIGHT;/,
        );
        expect(src).not.toMatch(/if \(isListView\) return 70;/);
    });

    it("Shelves estimates rows with the same constant", () => {
        const src = readFileSync(resolve("src/features/library/Shelves.tsx"), "utf-8");
        expect(src).toMatch(
            /const getEstimateSize = useCallback\(\(\) => \{[\s\S]*?if \(isListView\) return LIBRARY_LIST_ROW_HEIGHT;/,
        );
        expect(src).not.toMatch(/if \(isListView\) return 70;/);
        // Imported from Library so the two estimates cannot drift apart.
        expect(src).toContain("LIBRARY_LIST_ROW_HEIGHT } from \"./Library\"");
    });

    it("renders the row at exactly that height", () => {
        const src = readFileSync(resolve("src/features/library/Library.tsx"), "utf-8");
        expect(src).toMatch(
            /style=\{\{ height: `\$\{LIBRARY_LIST_ROW_HEIGHT\}px` \}\}/,
        );
    });
});

describe("list rows are the same height at every breakpoint", () => {
    const src = readFileSync(resolve("src/features/library/Library.tsx"), "utf-8");

    it("renders progress in one column, not a second mobile-only line", () => {
        // The `sm:hidden` progress line under the title made phone rows taller
        // than desktop rows, so one flat estimate could not fit both.
        expect(src).not.toContain('text-[color:var(--color-text-muted)] sm:hidden">\n');
        expect(src).not.toMatch(/text-\[0\.6875rem\][^"]*" sm:hidden/);
        // The right-hand progress column is no longer desktop-only.
        expect(src).not.toContain('className="hidden text-right sm:block"');
        expect(src).toContain('className="shrink-0 text-right"');
    });
});