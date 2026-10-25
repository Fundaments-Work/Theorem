// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { FoliateEngine } from "../src/features/reader/engines/foliate-engine";

// The reader re-applies its styles many times per open (settings, zoom, the
// first relocation). The paginator keeps whatever it was last given and
// applies it to every section document it loads afterwards, so a re-apply
// must hand over foliate's base sheet too, not only the second sheet. When it
// did not, sections loaded after a re-apply lost line height and
// orphans/widows, pages broke elsewhere and a saved position reopened one
// page early.
describe("FoliateEngine style re-application", () => {
    it("re-applies the same pair of sheets, base sheet included", async () => {
        const engine = new FoliateEngine({});
        const setStyles = vi.fn();
        const view = { renderer: { setStyles, setAttribute: vi.fn(), removeAttribute: vi.fn() }, style: { setProperty: vi.fn() } };
        Object.assign(engine as object, { view, book: {} });
        const apply = () => (engine as unknown as { applySettingsAsync(): Promise<void> }).applySettingsAsync();

        await apply();
        await apply();
        await apply();

        expect(setStyles).toHaveBeenCalledTimes(3);
        const [first, second, third] = setStyles.mock.calls.map(([styles]) => styles);
        expect(Array.isArray(first)).toBe(true);
        expect(first[0]).toMatch(/orphans/);
        expect(second).toEqual(first);
        expect(third).toEqual(first);
    });
});
