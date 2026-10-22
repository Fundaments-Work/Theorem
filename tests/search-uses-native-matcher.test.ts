/**
 * Search boxes rank with the Rust nucleo matcher (native command or its
 * WebAssembly build), never a JavaScript matcher (AGENTS.md: "No JS matchers").
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");

const PAGES = [
    "src/features/library/Annotations.tsx",
    "src/features/library/Bookmarks.tsx",
    "src/features/library/Shelves.tsx",
    "src/features/catalogs/opds/OpdsBrowser.tsx",
];

function sourceFiles(dir: string): string[] {
    return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
        const rel = path.join(dir, entry.name);
        if (entry.isDirectory()) return entry.name === "wasm" || entry.name === "foliate-js" ? [] : sourceFiles(rel);
        return /\.(ts|tsx)$/.test(entry.name) ? [rel] : [];
    });
}

describe("in-app search uses the native matcher", () => {
    it.each(PAGES)("%s ranks through useFuzzyRank", (file) => {
        const src = read(file);
        expect(src).toMatch(/import \{ useFuzzyRank \} from "[./]+\/core\/lib\/search\/useFuzzyRank"/);
        expect(src).toMatch(/useFuzzyRank\(/);
    });

    it("the vocabulary search in Annotations no longer scans definitions with includes()", () => {
        const src = read("src/features/library/Annotations.tsx");
        expect(src).not.toMatch(/d\.toLowerCase\(\)\.includes\(query\)/);
        expect(src).not.toMatch(/term\.term\.toLowerCase\(\)\.includes/);
    });

    it("the JavaScript matcher is gone from the app", () => {
        expect(fs.existsSync(path.join(root, "src/core/lib/search/fuzzy.ts"))).toBe(false);
        const offenders = sourceFiles("src").filter((file) => /rankByFuzzyQuery|search\/fuzzy["']/.test(read(file)));
        expect(offenders).toEqual([]);
    });

    it("the library's last fallback is the WebAssembly matcher, not a JS one", () => {
        const src = read("src/features/library/filtering.ts");
        expect(src).toContain("wasmFuzzyRank");
        expect(src).not.toContain("rankByFuzzyQuery");
    });
});
