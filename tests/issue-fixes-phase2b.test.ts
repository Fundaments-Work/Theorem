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
        "src/features/library/Bookmarks.tsx",
        "src/features/library/Annotations.tsx",
    ]) {
        const src = readFileSync(resolve(file), "utf-8");
        it(`${file}: rows are absolutely positioned, no per-row measure`, () => {
            expect(src).toContain("translateY(${virtualRow.start}px)");
            expect(src).not.toContain("measureElement");
            expect(src).not.toContain("paddingTop");
        });
    }
});

// ─── #108: reader chrome untouched (tap-toggle preserved exactly) ───

describe("reader tap-toggle chrome preserved", () => {
    const reader = readFileSync(
        resolve("src/features/reader/Reader.tsx"),
        "utf-8",
    );

    it("keeps original overlay chrome and full-bleed viewport", () => {
        // Any change here alters tap-to-hide feel; keep byte-stable.
        expect(reader).toContain("absolute inset-0 overflow-hidden z-0 isolate");
        expect(reader).toContain("-translate-y-full");
        expect(reader).toContain("fixed bottom-0 left-0 right-0 z-[140]");
        expect(reader).not.toContain("navbarHeight");
    });
});
