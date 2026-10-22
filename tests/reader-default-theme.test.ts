// @vitest-environment jsdom
/**
 * A new install opens books in the dark reading theme, matching the app's
 * dark interface, instead of flashing a white page out of a dark app. A
 * theme the reader already chose is kept (it is persisted).
 */
import { describe, it, expect } from "vitest";
import { useSettingsStore } from "../src/core/store";

describe("default reader theme", () => {
    it("matches the app's default dark theme", () => {
        const { settings } = useSettingsStore.getState();
        expect(settings.theme).toBe("dark");
        expect(settings.readerSettings.theme).toBe("dark");
    });
});
