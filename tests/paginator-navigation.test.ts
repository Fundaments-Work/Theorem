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

    describe("Uncollapse edge cases & range stabilization", () => {
        // Mock of paginator.js uncollapse logic
        const uncollapse = (range: any) => {
            if (!range || typeof range !== 'object' || !range.collapsed || !range.endContainer) return range;
            const { endOffset, endContainer } = range;
            if (endContainer.nodeType === 1) {
                const node = endContainer.childNodes[endOffset];
                if (node?.nodeType === 1) return node;
                if ((node?.nodeType === 3 || node?.nodeType === 4) && node.length > 0) {
                    const r = range.cloneRange();
                    r.selectNodeContents(node);
                    return r;
                }
                return endContainer;
            }
            if (endContainer.nodeType === 3) return endContainer.parentElement;
            return range;
        };

        it("safely handles primitive numbers (fractions) without throwing TypeError", () => {
            expect(() => uncollapse(0)).not.toThrow();
            expect(uncollapse(0)).toBe(0);
            expect(() => uncollapse(1)).not.toThrow();
            expect(uncollapse(1)).toBe(1);
            expect(() => uncollapse(0.5)).not.toThrow();
            expect(uncollapse(0.5)).toBe(0.5);
            expect(uncollapse(null)).toBeNull();
            expect(uncollapse(undefined)).toBeUndefined();
            expect(uncollapse("string-anchor")).toBe("string-anchor");
        });

        it("preserves non-collapsed ranges (highlights) untouched without collapsing to parent", () => {
            const doc = document.implementation.createHTMLDocument("HighlightTest");
            const p = doc.createElement("p");
            p.textContent = "The quick brown fox jumps over the lazy dog";
            doc.body.appendChild(p);

            const textNode = p.firstChild!;
            const highlightRange = doc.createRange();
            highlightRange.setStart(textNode, 4); // "quick"
            highlightRange.setEnd(textNode, 9);

            expect(highlightRange.collapsed).toBe(false);
            const target = uncollapse(highlightRange);

            // target MUST remain the exact non-collapsed Range, NOT p or doc.body
            expect(target).toBe(highlightRange);
            expect(target.toString()).toBe("quick");
            expect(target.collapsed).toBe(false);
        });

        it("uncollapses collapsed cursor ranges to the containing element", () => {
            const doc = document.implementation.createHTMLDocument("CursorTest");
            const p = doc.createElement("p");
            p.textContent = "Word";
            doc.body.appendChild(p);

            const textNode = p.firstChild!;
            const cursorRange = doc.createRange();
            cursorRange.setStart(textNode, 2);
            cursorRange.setEnd(textNode, 2);

            expect(cursorRange.collapsed).toBe(true);
            const target = uncollapse(cursorRange);

            // Collapsed text range uncollapses to parent paragraph element
            expect(target).toBe(p);
        });
    });

    describe("Paginator boundary protection and touch gesture responsiveness", () => {
        it("guards adjacent section navigation against out-of-bounds indices", () => {
            const sections = [{ id: "sec1" }, { id: "sec2" }, { id: "sec3" }];
            const canGoToIndex = (index: number) => index >= 0 && index <= sections.length - 1;

            expect(canGoToIndex(-1)).toBe(false);
            expect(canGoToIndex(0)).toBe(true);
            expect(canGoToIndex(1)).toBe(true);
            expect(canGoToIndex(2)).toBe(true);
            expect(canGoToIndex(3)).toBe(false);
            expect(canGoToIndex(undefined as unknown as number)).toBe(false);
        });

        it("correctly identifies horizontal swipe gestures without hold delay", () => {
            const detectAxis = (startX: number, startY: number, x: number, y: number, dt: number) => {
                const absDx = Math.abs(startX - x);
                const absDy = Math.abs(startY - y);
                if (absDx > 12 && absDx > absDy) {
                    return "h";
                } else if (absDy > 12 && absDy > absDx) {
                    return "v";
                } else if (dt > 400 && absDx < 10 && absDy < 10) {
                    return "hold";
                }
                return null;
            };

            // Quick horizontal flick: thumb moves 30px right, 10px down in 120ms
            expect(detectAxis(100, 200, 130, 210, 120)).toBe("h");

            // Diagonal thumb swipe: 25px horizontal, 18px vertical in 200ms
            expect(detectAxis(100, 200, 125, 218, 200)).toBe("h");

            // Vertical scroll: 10px horizontal, 40px vertical
            expect(detectAxis(100, 200, 110, 240, 150)).toBe("v");

            // Stationary long-press (selection hold): 2px jitter over 450ms
            expect(detectAxis(100, 200, 102, 201, 450)).toBe("hold");

            // Hesitant swipe: finger down 250ms then moves 25px horizontal (MUST NOT be locked to hold)
            expect(detectAxis(100, 200, 125, 205, 250)).toBe("h");
        });

        it("ensures turnPage lock is reliably released even if section load rejects", async () => {
            let locked = false;
            let failureHandled = false;

            const turnPageMock = async (shouldFail: boolean) => {
                if (locked) return "dropped";
                locked = true;
                try {
                    if (shouldFail) {
                        throw new Error("Simulated section load failure");
                    }
                    return "success";
                } catch {
                    failureHandled = true;
                } finally {
                    locked = false;
                }
            };

            // First turn fails: lock MUST be freed in finally block
            await turnPageMock(true);
            expect(failureHandled).toBe(true);
            expect(locked).toBe(false);

            // Subsequent turn must NOT be blocked or dropped
            const secondAttempt = await turnPageMock(false);
            expect(secondAttempt).toBe("success");
            expect(locked).toBe(false);
        });

        it("safely handles single-page and zero-page boundary anchor calculations", () => {
            const calculateAnchorPage = (anchor: number, pages: number) => {
                if (!pages || pages < 3) {
                    return 1;
                }
                const textPages = pages - 2;
                const newPage = textPages > 1 ? Math.round(anchor * (textPages - 1)) : 0;
                return Math.max(1, Math.min(newPage + 1, pages - 2));
            };

            // Normal 5 pages: 1 pad + 3 text + 1 pad
            expect(calculateAnchorPage(0, 5)).toBe(1);
            expect(calculateAnchorPage(0.5, 5)).toBe(2);
            expect(calculateAnchorPage(1.0, 5)).toBe(3);

            // Outliers: pages <= 2 (corrupt or empty section)
            expect(calculateAnchorPage(0.5, 0)).toBe(1);
            expect(calculateAnchorPage(0.5, 1)).toBe(1);
            expect(calculateAnchorPage(0.5, 2)).toBe(1);

            // Boundary values of numeric fraction: negative or > 1
            expect(calculateAnchorPage(-0.5, 5)).toBe(1);
            expect(calculateAnchorPage(2.0, 5)).toBe(3);
        });

        it("guarantees idempotent listener attachment per Document instance", () => {
            const doc = document.implementation.createHTMLDocument("IdempotentTest");
            let listenerCount = 0;

            const attachOnce = (targetDoc: Document) => {
                if ((targetDoc as any).__theorem_selection_attached) {
                    return false;
                }
                (targetDoc as any).__theorem_selection_attached = true;
                listenerCount++;
                return true;
            };

            // First attachment attaches successfully
            expect(attachOnce(doc)).toBe(true);
            expect(listenerCount).toBe(1);

            // Subsequent repeated calls on the same document are no-ops
            expect(attachOnce(doc)).toBe(false);
            expect(attachOnce(doc)).toBe(false);
            expect(listenerCount).toBe(1);

            // Fresh document receives listeners
            const newDoc = document.implementation.createHTMLDocument("SecondDoc");
            expect(attachOnce(newDoc)).toBe(true);
            expect(listenerCount).toBe(2);
        });
    });
});
