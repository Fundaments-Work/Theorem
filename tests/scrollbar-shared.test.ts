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
        [
            "src/features/reader/engines/pdfjs-engine.tsx",
            ["overflow-auto bg-[var(--color-surface)] scrollbar-solid"],
        ],
        [
            "src/features/reader/article-reader/ArticleReaderContent.tsx",
            ["overflow-y-auto scrollbar-solid overscroll-contain"],
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

    it("foliate viewport uses the shared scrollbar only in scroll flow", () => {
        const src = readFileSync(
            resolve("src/features/reader/components/ReaderViewport.tsx"),
            "utf-8",
        );
        expect(src).toContain("settings.flow === 'scroll' ? 'scrollbar-solid' : 'custom-scrollbar'");
    });
});
