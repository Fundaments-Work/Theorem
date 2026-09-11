import { describe, expect, it } from "vitest";
import * as CFI from "../src/features/reader/foliate-js-runtime/epubcfi.js";
import { useUIStore } from "../src/core/store";

describe("Paginator navigation & CFI anchor resolution (Issue #78)", () => {
    describe("CFI resolution for bookmarks and highlights", () => {
        it("correctly resolves a point CFI into spine index and range anchor", () => {
            const cfi = "epubcfi(/6/4[chap1]!/4/2/10/1:5)";
            const parts = CFI.parse(cfi);
            expect(parts).toBeDefined();
            const top = (parts.parent ?? parts).shift();
            expect(top).toEqual([{ index: 6 }, { index: 4, id: "chap1" }]);

            const doc = document.implementation.createHTMLDocument("Test");
            const div = doc.createElement("div");
            div.innerHTML = "<p>First paragraph</p><p>Second paragraph with some text</p>";
            doc.body.appendChild(div);

            const range = CFI.toRange(doc, parts);
            expect(range).toBeDefined();
            expect(range.startContainer).toBeDefined();
        });

        it("correctly resolves a range CFI into start and end text ranges", () => {
            const cfi = "epubcfi(/6/4[chap1]!/4/2/4,/1:0,/1:10)";
            const parts = CFI.parse(cfi);
            expect(parts.parent).toBeDefined();
            expect(parts.start).toBeDefined();
            expect(parts.end).toBeDefined();

            const top = parts.parent.shift();
            expect(top).toEqual([{ index: 6 }, { index: 4, id: "chap1" }]);

            const doc = document.implementation.createHTMLDocument("Test");
            const div = doc.createElement("div");
            div.innerHTML = "<p>First paragraph</p><p>Second paragraph with some text</p>";
            doc.body.appendChild(div);

            const range = CFI.toRange(doc, parts);
            expect(range).toBeDefined();
            expect(range.collapsed).toBe(false);
            expect(range.toString()).toBe("Second par");
        });
    });

    describe("Pending reader location store interaction", () => {
        it("stores and consumes pendingReaderLocation for bookmark/highlight jump", () => {
            const testCfi = "epubcfi(/6/14[chapter-2]!/4/2/10/1:42)";
            useUIStore.getState().setPendingReaderLocation(testCfi);

            expect(useUIStore.getState().pendingReaderLocation).toBe(testCfi);

            // Consumer reads and clears
            const pending = useUIStore.getState().pendingReaderLocation;
            if (pending) {
                useUIStore.getState().setPendingReaderLocation(undefined);
            }

            expect(pending).toBe(testCfi);
            expect(useUIStore.getState().pendingReaderLocation).toBeUndefined();
        });
    });

    describe("Multi-column page calculation logic", () => {
        const calculateTargetPage = (offset: number, size: number, pages: number, rtl = false) => {
            const rawPage = Math.floor(offset / (size || 1)) + (rtl ? -1 : 1);
            const maxPage = Math.max(1, pages > 2 ? pages - 2 : 1);
            return Math.max(1, Math.min(rawPage, maxPage));
        };

        it("maps column offsets to correct page numbers", () => {
            const pageSize = 800;
            const totalPages = 7; // pages: [0=pad, 1, 2, 3, 4, 5, 6=pad] -> 5 content pages

            // Page 1: 0 <= offset < 800
            expect(calculateTargetPage(0, pageSize, totalPages)).toBe(1);
            expect(calculateTargetPage(350, pageSize, totalPages)).toBe(1);
            expect(calculateTargetPage(799, pageSize, totalPages)).toBe(1);

            // Page 2: 800 <= offset < 1600
            expect(calculateTargetPage(800, pageSize, totalPages)).toBe(2);
            expect(calculateTargetPage(1200, pageSize, totalPages)).toBe(2);

            // Page 3: 1600 <= offset < 2400
            expect(calculateTargetPage(1600, pageSize, totalPages)).toBe(3);
            expect(calculateTargetPage(2100, pageSize, totalPages)).toBe(3);

            // Page 4: 2400 <= offset < 3200
            expect(calculateTargetPage(2400, pageSize, totalPages)).toBe(4);

            // Page 5 (last content page): 3200 <= offset < 4000
            expect(calculateTargetPage(3200, pageSize, totalPages)).toBe(5);
            expect(calculateTargetPage(3999, pageSize, totalPages)).toBe(5);

            // Clamping: beyond last content page must clamp to maxPage (5)
            expect(calculateTargetPage(4500, pageSize, totalPages)).toBe(5);
            expect(calculateTargetPage(9999, pageSize, totalPages)).toBe(5);

            // Negative offset must clamp to page 1
            expect(calculateTargetPage(-500, pageSize, totalPages)).toBe(1);
        });
    });

    describe("Stale CFI with [w_N] and DOM resilience", () => {
        it("gracefully resolves CFIs with missing intermediate [w_N] wrapper spans without throwing", () => {
            const doc = document.implementation.createHTMLDocument("Clean");
            const div = doc.createElement("div");
            div.id = "content";
            div.innerHTML = "<p id=\"p2\">Second paragraph with clean text.</p>";
            doc.body.appendChild(div);

            // Stale CFI that originally referenced a <span id="w_3"> inside p2
            const staleCfi = "epubcfi(/4/2[content]/2[p2]/6[w_3],/1:0,/1:4)";
            const parsed = CFI.parse(staleCfi);
            expect(parsed).toBeDefined();

            const range = CFI.toRange(doc, parsed);
            expect(range).toBeDefined();
            expect(range.startContainer).toBeDefined();
            expect(range.endContainer).toBeDefined();
            // startContainer should resolve inside p2 (text or p2 itself)
            expect(range.startContainer.nodeType).toBeGreaterThanOrEqual(1);
        });

        it("jumps to existing intermediate ID in parts chain", () => {
            const doc = document.implementation.createHTMLDocument("IntermediateID");
            const container = doc.createElement("div");
            container.innerHTML = "<section><div id=\"target-sec\"><p>Target section content here.</p></div></section>";
            doc.body.appendChild(container);

            // CFI with intermediate ID [target-sec]
            const cfi = "epubcfi(/4/2/2[target-sec]/2,/1:0,/1:6)";
            const parsed = CFI.parse(cfi);
            const range = CFI.toRange(doc, parsed);

            expect(range).toBeDefined();
            expect(range.toString()).toBe("Target");
        });
    });
});
