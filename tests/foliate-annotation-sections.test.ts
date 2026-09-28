import { describe, expect, it, vi } from "vitest";
import { FoliateEngine } from "../src/features/reader/engines/foliate-engine";
import type { Annotation } from "../src/core/types";

// 1,000 highlights spread over 100 chapters. Locations encode their chapter.
const SECTIONS = 100;
const PER_SECTION = 10;
const annotations: Annotation[] = [];
for (let s = 0; s < SECTIONS; s++) {
    for (let k = 0; k < PER_SECTION; k++) {
        annotations.push({
            id: `a-${s}-${k}`,
            bookId: "b",
            type: k % 3 === 0 ? "note" : "highlight",
            location: `epubcfi(/6/${(s + 1) * 2}!/4/2/${k * 2 + 2},/1:0,/1:5)`,
            selectedText: "x",
            color: "yellow",
            createdAt: new Date(0),
        } as Annotation);
    }
}
// A bookmark must never be drawn; an unresolvable CFI keeps legacy behaviour.
annotations.push({ id: "bm", bookId: "b", type: "bookmark", location: "epubcfi(/6/4!/4/2)", createdAt: new Date(0) } as Annotation);
annotations.push({ id: "weird", bookId: "b", type: "highlight", location: "not-a-cfi", color: "yellow", createdAt: new Date(0) } as Annotation);

function makeEngine(loadedSections: number[]) {
    const engine = new FoliateEngine({});
    const overlayers = new Map(loadedSections.map((index) => [index, { redraw: vi.fn() }]));
    const view = {
        resolveNavigation: vi.fn((cfi: string) => {
            const match = /^epubcfi\(\/6\/(\d+)/.exec(cfi);
            return match ? { index: Number(match[1]) / 2 - 1 } : undefined;
        }),
        goTo: vi.fn(async () => undefined),
        addAnnotation: vi.fn(async () => undefined),
        renderer: {
            getContents: () => [...overlayers].map(([index, overlayer]) => ({ index, overlayer })),
        },
    };
    Object.assign(engine as object, { view, book: {} });
    return { engine, view, overlayers };
}

const drawnSections = (view: ReturnType<typeof makeEngine>["view"]) =>
    new Set(view.addAnnotation.mock.calls.map(([arg]: [{ value: string }]) => arg.value));

describe("FoliateEngine section-scoped annotation rendering", () => {
    it("draws only the loaded chapter's highlights, not the whole book", async () => {
        const { engine, view } = makeEngine([4]);
        await engine.loadAnnotations(annotations);
        // 10 in chapter 4 + the one unresolvable CFI. Never the bookmark.
        expect(view.addAnnotation).toHaveBeenCalledTimes(PER_SECTION + 1);
        const values = drawnSections(view);
        expect([...values].filter((v) => v.startsWith("epubcfi(/6/10!"))).toHaveLength(PER_SECTION);
        expect(values.has("not-a-cfi")).toBe(true);
        expect(values.has("epubcfi(/6/4!/4/2)")).toBe(false);
    });

    it("resolves each CFI once, across repeated chapter loads", async () => {
        const { engine, view, overlayers } = makeEngine([4]);
        await engine.loadAnnotations(annotations);
        const resolutionsAfterLoad = view.resolveNavigation.mock.calls.length;
        expect(resolutionsAfterLoad).toBeLessThanOrEqual(annotations.length);

        // Turn through 20 chapters: each gets a fresh overlayer.
        for (let s = 5; s < 25; s++) {
            overlayers.set(s, { redraw: vi.fn() });
            await engine.renderAnnotationsForSection(s);
        }
        expect(view.resolveNavigation.mock.calls.length).toBe(resolutionsAfterLoad);
        // 11 for chapter 4, then 11 per turned chapter (10 own + unresolvable).
        expect(view.addAnnotation).toHaveBeenCalledTimes((PER_SECTION + 1) * 21);
    });

    it("ignores the duplicate load/create-overlay events for the same overlayer", async () => {
        const { engine, view } = makeEngine([7]);
        (engine as unknown as { annotations: Map<string, Annotation> }).annotations =
            new Map(annotations.map((a) => [a.id, a]));
        await engine.renderAnnotationsForSection(7);
        await engine.renderAnnotationsForSection(7);
        await engine.renderAnnotationsForSection(7);
        expect(view.addAnnotation).toHaveBeenCalledTimes(PER_SECTION + 1);
    });

    it("redraws when forced (annotation set changed) and when the overlayer is recreated", async () => {
        const { engine, view, overlayers } = makeEngine([7]);
        await engine.loadAnnotations(annotations);
        await engine.renderAnnotationsForSection(7, true);
        expect(view.addAnnotation).toHaveBeenCalledTimes((PER_SECTION + 1) * 2);
        overlayers.set(7, { redraw: vi.fn() }); // re-layout creates a new overlayer
        await engine.renderAnnotationsForSection(7);
        expect(view.addAnnotation).toHaveBeenCalledTimes((PER_SECTION + 1) * 3);
    });

    it("does nothing for a section that is not loaded, or before a book is open", async () => {
        const { engine, view } = makeEngine([1]);
        await engine.loadAnnotations(annotations);
        view.addAnnotation.mockClear();
        await engine.renderAnnotationsForSection(50);
        await engine.renderAnnotationsForSection(-1);
        expect(view.addAnnotation).not.toHaveBeenCalled();
        const bare = new FoliateEngine({});
        await expect(bare.renderAnnotationsForSection(1)).resolves.toBeUndefined();
    });

    it("keeps rendering when foliate throws while resolving a CFI", async () => {
        const { engine, view } = makeEngine([2]);
        view.resolveNavigation.mockImplementationOnce(() => { throw new Error("bad cfi"); });
        await engine.loadAnnotations(annotations);
        expect(view.addAnnotation.mock.calls.length).toBeGreaterThanOrEqual(PER_SECTION);
    });

    it("goToAnnotation navigates to the exact CFI and forces overlayer redraw for the target section", async () => {
        const { engine, view, overlayers } = makeEngine([3]);
        const targetAnn: Annotation = {
            id: "a-3-1",
            bookId: "b",
            type: "highlight",
            location: "epubcfi(/6/8!/4/2/4,/1:0,/1:5)",
            selectedText: "exact text",
            color: "yellow",
            createdAt: new Date(0),
        };
        await engine.goToAnnotation(targetAnn);
        expect(view.goTo).toHaveBeenCalledWith(targetAnn.location);
        expect(overlayers.get(3)?.redraw).toHaveBeenCalled();
        expect(view.addAnnotation).toHaveBeenCalledWith(expect.objectContaining({ value: targetAnn.location }));
    });

    it("goToAnnotation falls back to text search and self-heals when direct CFI resolution fails", async () => {
        const { engine, view, overlayers } = makeEngine([4]);
        const staleAnn: Annotation = {
            id: "stale-1",
            bookId: "b",
            type: "highlight",
            location: "epubcfi(/6/99!/4[stale]/2,/1:0,/1:5)",
            selectedText: "Important snippet from the book",
            color: "green",
            createdAt: new Date(0),
        };

        // When navigating to stale CFI, resolveNavigation returns section 99
        view.resolveNavigation.mockReturnValueOnce({ index: 99 });
        view.search = vi.fn().mockReturnValue((async function* () {
            yield { cfi: "epubcfi(/6/10!/4/2/2,/1:0,/1:31)" };
        })());

        await engine.goToAnnotation(staleAnn);

        // Fallback search should have been invoked with the snippet
        expect(view.search).toHaveBeenCalledWith(expect.objectContaining({ query: expect.stringContaining("Important snippet") }));
        // Navigates to the healed CFI
        expect(view.goTo).toHaveBeenCalledWith("epubcfi(/6/10!/4/2/2,/1:0,/1:31)");
        expect(staleAnn.location).toBe("epubcfi(/6/10!/4/2/2,/1:0,/1:31)");
        expect(overlayers.get(4)?.redraw).toHaveBeenCalled();
    });

    it("renderAnnotationsForSection re-anchors and self-heals when section document contains snippet", async () => {
        const { engine, view } = makeEngine([2]);
        const dummyDoc = document.implementation.createHTMLDocument();
        dummyDoc.body.innerHTML = "<p>If you want fans, you have to be a fan first.</p>";
        const overlayerMock = { redraw: vi.fn() };

        view.renderer.getContents = () => [
            { index: 2, doc: dummyDoc, overlayer: overlayerMock },
        ];
        view.getCFI = vi.fn().mockReturnValue("epubcfi(/6/6!/4/2,/1:0,/1:43)");

        const shiftedAnn: Annotation = {
            id: "shifted-1",
            bookId: "b",
            type: "highlight",
            location: "epubcfi(/6/26!/4/2,/1:0,/1:10)", // Points to chapter 12 (/6/26!), not 2 (/6/6!)
            selectedText: "If you want fans, you have to be a fan first.",
            color: "green",
            createdAt: new Date(0),
        };

        await engine.loadAnnotations([shiftedAnn]);
        expect(view.getCFI).toHaveBeenCalled();
        expect(shiftedAnn.location).toBe("epubcfi(/6/6!/4/2,/1:0,/1:43)");
        expect(view.addAnnotation).toHaveBeenCalledWith(expect.objectContaining({
            value: "epubcfi(/6/6!/4/2,/1:0,/1:43)",
        }));
    });
});
