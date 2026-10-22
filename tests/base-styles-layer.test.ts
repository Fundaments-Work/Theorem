/**
 * Element defaults (headings, links, form controls) live in Tailwind's base
 * layer. Unlayered CSS beats every layer, so an unlayered `:where(button, …)
 * { font: inherit }` silently overrode `text-xs`, `font-light` and
 * `leading-*` on every button and input in the app (and `a { color }` beat
 * every text colour utility on links).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const css = readFileSync(resolve("src/index.css"), "utf-8");

/** The CSS outside any `@layer { … }` block. */
function unlayered(source: string): string {
    let out = "";
    let i = 0;
    while (i < source.length) {
        const at = source.indexOf("@layer", i);
        if (at === -1) { out += source.slice(i); break; }
        out += source.slice(i, at);
        const open = source.indexOf("{", at);
        const semi = source.indexOf(";", at);
        if (semi !== -1 && semi < open) { i = semi + 1; continue; } // `@layer a, b;` statement
        let depth = 0;
        let j = open;
        for (; j < source.length; j++) {
            if (source[j] === "{") depth++;
            else if (source[j] === "}" && --depth === 0) break;
        }
        i = j + 1;
    }
    return out;
}

describe("base element styles", () => {
    const outside = unlayered(css);

    it("form controls inherit their font only from the base layer", () => {
        expect(css).toMatch(/@layer base\s*\{[\s\S]*:where\(button, input, textarea, select\)/);
        expect(outside).not.toMatch(/:where\(button, input, textarea, select\)/);
    });

    it("no unlayered element rule for buttons, links or headings", () => {
        for (const selector of [/^\s*button\s*\{/m, /^\s*button:disabled\s*\{/m, /^\s*a\s*\{/m, /^\s*a:hover\s*\{/m, /^\s*h1\s*\{/m, /^\s*h2,\s*\n?\s*h3\s*\{/m]) {
            expect(outside, String(selector)).not.toMatch(selector);
        }
    });
});
