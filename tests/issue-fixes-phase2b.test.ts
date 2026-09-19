import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

// ─── #104: library scrolling / batch shelf assignment ───

describe("library batch shelf assignment", () => {
    const store = readFileSync(
        resolve("src/core/store/libraryStore.ts"),
        "utf-8",
    );
    const library = readFileSync(
        resolve("src/features/library/Library.tsx"),
        "utf-8",
    );

    it("store exposes a single-set batch action", () => {
        expect(store).toContain("addBooksToCollection");
        expect(store).toContain("if (changed) scheduleMutationSync();");
    });

    it("shelf assignment uses one batch update, not a per-book loop", () => {
        const block = library.split("const handleAddBookToShelf")[1]?.split("const handleCreateShelf")[0] || "";
        expect(block).toContain("addBooksToCollection(selectedBooks, shelfId)");
        expect(block).not.toContain("for (const id of selectedBooks)");
    });
});

describe("library/shelf virtualizer uses absolute rows", () => {
    for (const file of [
        "src/features/library/Library.tsx",
        "src/features/library/Shelves.tsx",
    ]) {
        const src = readFileSync(resolve(file), "utf-8");
        it(`${file}: rows are absolutely positioned, no per-row measure`, () => {
            expect(src).toContain("translateY(${virtualRow.start}px)");
            expect(src).not.toContain("measureElement");
            expect(src).not.toContain("paddingTop");
        });
    }
});

// ─── #108: reader viewport bounded between chrome ───

describe("reader layout bounds viewport between chrome", () => {
    const reader = readFileSync(
        resolve("src/features/reader/Reader.tsx"),
        "utf-8",
    );
    const viewport = readFileSync(
        resolve("src/features/reader/components/ReaderViewport.tsx"),
        "utf-8",
    );

    it("content layer is in-flow flex, not full-bleed absolute", () => {
        expect(reader).toContain("relative z-0 isolate flex min-h-0 flex-1 flex-col overflow-hidden");
        expect(reader).not.toContain("absolute inset-0 overflow-hidden z-0 isolate");
    });

    it("chrome collapses in-flow instead of overlaying content", () => {
        expect(reader).not.toContain("-translate-y-full");
        expect(reader).not.toContain("fixed bottom-0 left-0 right-0 z-[140]");
    });

    it("scroll container avoids per-frame filter repaints and chains", () => {
        expect(viewport).toContain("overscrollBehavior: 'contain'");
        // brightness lives on the non-scrolling wrapper, not the scroller
        const scrollerBlock = viewport.split("ref={containerRef}")[1] || "";
        expect(scrollerBlock).not.toContain("brightness(");
    });
});
