import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

// Regression guards for fixes that have no cheaper behavioural test. Each reads
// source text, so when the code moves, point the assertion at the new file.

describe("App route keep-alive (#103)", () => {
    const app = readFileSync(resolve("src/App.tsx"), "utf-8");

    it("keeps non-reader pages mounted with hidden toggles", () => {
        for (const page of [
            "<LibraryPage />",
            "<ShelvesPage />",
            "<AnnotationsPage />",
            "<SettingsPage />",
            "<StatisticsPage />",
            "<FeedsPage />",
        ]) {
            expect(app).toContain(page);
        }
        expect(app).toContain('"hidden"');
    });

    it("opens Bookmarks as a tab of the kept-alive Workbench page, not a page of its own", () => {
        expect(app).not.toContain("BookmarksPage");
        expect(app).toMatch(/showAnnotationsRoute = [^;]*currentRoute === "bookmarks"/);
    });

    it("does not remount pages through a route switch or reset scroll on route change", () => {
        expect(app).not.toContain("const renderPage");
        expect(app).not.toContain("mainScrollRef.current?.scrollTo");
    });

    it("keeps the reader exclusive so engines unmount on exit", () => {
        expect(app).toContain("isReaderMode");
        expect(app).toContain("<ReaderPage />");
    });

    it("mounts pages on first visit instead of all upfront", () => {
        expect(app).toContain("visitedRoutes");
        expect(app).toContain('visitedRoutes.has("statistics")');
        expect(app).toContain('visitedRoutes.has("shelves")');
    });
});

describe("library scrolling and batch shelf assignment (#104)", () => {
    const store = readFileSync(resolve("src/core/store/libraryStore.ts"), "utf-8");
    const library = readFileSync(resolve("src/features/library/Library.tsx"), "utf-8");

    it("assigns a selection to a shelf with one batch update, not a per-book loop", () => {
        expect(store).toContain("addBooksToCollection");
        const block = library.split("const handleAddBookToShelf")[1]?.split("const handleCreateShelf")[0] || "";
        expect(block).toContain("addBooksToCollection(selectedBooks, shelfId)");
        expect(block).not.toContain("for (const id of selectedBooks)");
    });

    for (const file of [
        "src/features/library/Library.tsx",
        "src/features/library/Shelves.tsx",
        "src/features/library/Bookmarks.tsx",
        "src/features/library/Annotations.tsx",
    ]) {
        it(`${file}: virtualized rows are absolutely positioned, with no per-row measure`, () => {
            const src = readFileSync(resolve(file), "utf-8");
            expect(src).toContain("translateY(${virtualRow.start}px)");
            expect(src).not.toContain("measureElement");
            expect(src).not.toContain("paddingTop");
        });
    }
});

describe("foliate engine initial navigation (#105)", () => {
    const engine = readFileSync(resolve("src/features/reader/engines/foliate-engine.ts"), "utf-8");

    it("uses a generous initial-navigation budget and retries before surfacing a timeout", () => {
        expect(engine).toContain("READER_INITIAL_NAVIGATION_TIMEOUT_MS = 15000");
        expect(engine).toContain("READER_INITIAL_NAVIGATION_RETRIES");
        expect(engine).toContain("goToWithRetry");
    });

    it("opens through the retry helper on every path, with an outer open timeout", () => {
        const retryCalls = engine.match(/await this\.goToWithRetry\(/g) || [];
        // restore-saved-location + fallback-to-start + plain-start
        expect(retryCalls.length).toBeGreaterThanOrEqual(3);
        expect(engine).not.toContain("READER_NAVIGATION_TIMEOUT_MS");
        expect(engine).toContain("READER_OPEN_TIMEOUT_MS = 20000");
    });
});
