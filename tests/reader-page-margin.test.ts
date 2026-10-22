// @vitest-environment jsdom
/**
 * On desktop the reader toolbar overlays the top of the page, so the page band
 * above the text must be taller than the toolbar plus breathing room; the
 * paginator's default 48px left the first line almost touching the toolbar.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { FoliateEngine } from "../src/features/reader/engines/foliate-engine";

function applyWith(isPhone: boolean): Map<string, string> {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: isPhone && q.includes("max-width: 768px"), media: q, addEventListener() {}, removeEventListener() {} }));
    const attrs = new Map<string, string>();
    const renderer = { setAttribute: (k: string, v: string) => attrs.set(k, v), removeAttribute: (k: string) => attrs.delete(k) };
    const engine = Object.create(FoliateEngine.prototype) as { view: unknown; flow: string; layout: string };
    engine.view = { renderer };
    engine.flow = "paged";
    engine.layout = "auto";
    (engine as unknown as { applySettingsSync(): void }).applySettingsSync();
    return attrs;
}

afterEach(() => vi.unstubAllGlobals());

describe("reader page margin", () => {
    it("clears the overlaid toolbar on desktop", () => {
        expect(parseInt(applyWith(false).get("margin") ?? "0", 10)).toBeGreaterThanOrEqual(64);
    });

    it("keeps the paginator default on phones", () => {
        expect(applyWith(true).get("margin")).toBe("48px");
    });
});
