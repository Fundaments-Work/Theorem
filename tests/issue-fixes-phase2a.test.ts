import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

// ─── #103: route keep-alive (no unmount/remount on navigation) ───

describe("App route keep-alive", () => {
    const app = readFileSync(resolve("src/App.tsx"), "utf-8");

    it("keeps non-reader pages mounted with hidden toggles", () => {
        for (const page of [
            "<LibraryPage />",
            "<ShelvesPage />",
            "<AnnotationsPage />",
            "<BookmarksPage />",
            "<SettingsPage />",
            "<StatisticsPage />",
            "<FeedsPage />",
        ]) {
            expect(app).toContain(page);
        }
        expect(app).toContain('"hidden"');
    });

    it("does not remount pages through a route switch", () => {
        expect(app).not.toContain("const renderPage");
    });

    it("does not reset scroll position on route change", () => {
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
