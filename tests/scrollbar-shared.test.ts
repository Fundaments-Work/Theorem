import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

// ─── Shared solid scrollbar on every list surface ───

describe("scrollbar-solid shared by all list scrollers", () => {
    it("defines a solid gutter-seated thumb utility", () => {
        const css = readFileSync(resolve("src/index.css"), "utf-8");
        expect(css).toContain(".scrollbar-solid");
        expect(css).toContain("scrollbar-gutter: stable");
    });

    const surfaces: Array<[string, string[]]> = [
        ["src/App.tsx", ["scrollbar-solid"]],
        [
            "src/features/library/Library.tsx",
            ["overflow-y-auto overscroll-contain scroll-smooth scrollbar-solid"],
        ],
        [
            "src/features/library/Shelves.tsx",
            ["overflow-y-auto overscroll-contain scroll-smooth scrollbar-solid"],
        ],
        [
            "src/features/feeds/FeedsPage.tsx",
            ["scrollbar-solid"],
        ],
        [
            "src/features/catalogs/DiscoverPage.tsx",
            ["scrollbar-solid"],
        ],
    ];

    for (const [file, markers] of surfaces) {
        it(`${file} uses the shared scrollbar`, () => {
            const src = readFileSync(resolve(file), "utf-8");
            for (const marker of markers) {
                expect(src).toContain(marker);
            }
        });
    }
});
