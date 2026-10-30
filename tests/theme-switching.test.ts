// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { applyAppTheme, resolveThemeColors } from "../src/core/lib/design-tokens";
import { getCSS } from "../src/features/reader/foliate/reader";

afterEach(() => {
    document.body.className = "";
});

describe("light and dark theme switching, isolated from the system theme", () => {
    it("applies theme-light to the body and sets the light color scheme", () => {
        applyAppTheme("light", "#c6f135");
        expect(document.body.classList.contains("theme-light")).toBe(true);
        expect(document.body.classList.contains("theme-dark")).toBe(false);
        expect(document.documentElement.style.colorScheme).toBe("light");
    });

    it("applies theme-dark to the body and sets the dark color scheme", () => {
        applyAppTheme("dark", "#c6f135");
        expect(document.body.classList.contains("theme-dark")).toBe(true);
        expect(document.body.classList.contains("theme-light")).toBe(false);
        expect(document.documentElement.style.colorScheme).toBe("dark");
    });

    it("resolves light theme colors even when the body carries the dark class", () => {
        document.body.className = "theme-dark";
        const colors = resolveThemeColors("light");
        expect(colors.bg.toLowerCase()).toBe("#ffffff");
        expect(colors.fg.toLowerCase()).toBe("#1a1a1a");
    });

    it("generates reader CSS without prefers-color-scheme media query overrides", () => {
        const css = getCSS({
            theme: {
                name: "light",
                light: { bg: "#ffffff", fg: "#1a1a1a", link: "#0000ee" },
                dark: { bg: "#121212", fg: "#e0e0e0", link: "#8ab4f8" },
            },
            invert: false,
        }).join("\n");

        expect(css).not.toContain("@media screen and (prefers-color-scheme: dark)");
        expect(css).not.toContain("@media screen and (prefers-color-scheme: light)");
        expect(css).toContain("color-scheme: light;");
        expect(css).toContain("background-color: #ffffff !important;");
    });
});
