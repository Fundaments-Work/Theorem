// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { FoliateEngine } from "../src/features/reader/engines/foliate-engine";
import type { DocLocation } from "../src/core/types";

describe("FoliateEngine paginated page numbers", () => {
    it("reports monotonic sequential page numbers across page turns in multi-section books without skipping", () => {
        const locations: DocLocation[] = [];
        const engine = new FoliateEngine({
            onLocationChange: (loc) => locations.push(loc),
        });

        const renderer = {
            page: 1,
            pages: 6, // 4 content pages + 2 pad pages
            scrolled: false,
        };
        const view = {
            renderer,
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            history: { addEventListener: vi.fn() },
            getCFI: vi.fn(),
        };
        const book = {
            sections: [
                { linear: "yes", size: 7454 },
                { linear: "yes", size: 7395 },
                { linear: "yes", size: 7395 },
                { linear: "yes", size: 7395 },
            ],
        };
        Object.assign(engine as object, { view, book, flow: "paged" });

        // Trigger setupEventListeners
        (engine as unknown as { setupEventListeners(): void }).setupEventListeners();

        // Extract the relocate listener that was registered on view
        const relocateHandler = view.addEventListener.mock.calls.find(
            ([event]) => event === "relocate",
        )?.[1];
        expect(relocateHandler).toBeDefined();

        // Simulate page 1 of section 0
        renderer.page = 1;
        relocateHandler({
            detail: {
                index: 0,
                section: { current: 0, total: 4 },
                fraction: 0,
            },
        });

        // Simulate page 2 of section 0
        renderer.page = 2;
        relocateHandler({
            detail: {
                index: 0,
                section: { current: 0, total: 4 },
                fraction: 1 / 3,
            },
        });

        // Simulate page 3 of section 0
        renderer.page = 3;
        relocateHandler({
            detail: {
                index: 0,
                section: { current: 0, total: 4 },
                fraction: 2 / 3,
            },
        });

        // Simulate page 4 of section 0
        renderer.page = 4;
        relocateHandler({
            detail: {
                index: 0,
                section: { current: 0, total: 4 },
                fraction: 1,
            },
        });

        const currentPages = locations.map((loc) => loc.pageInfo?.currentPage);
        // Must be sequential 1, 2, 3, 4 without skipping (e.g. not 1, 2, 4, 5)
        expect(currentPages).toEqual([1, 2, 3, 4]);
        expect(locations[0].pageInfo?.totalPages).toBeGreaterThanOrEqual(16);

        // Simulate moving to section 1, page 1
        renderer.page = 1;
        relocateHandler({
            detail: {
                index: 1,
                section: { current: 1, total: 4 },
                fraction: 0,
            },
        });
        expect(locations[4].pageInfo?.currentPage).toBe(5);
    });
});
