import { describe, it, expect } from "vitest";
import {
    initTheoremCoreWasm,
    isWasmCoreReady,
    wasmFuzzyRank,
    wasmMarkdownToHtml,
    normalizeSpeechText,
    safeVaultFilename,
    buildFrontmatter,
    type FuzzyRankCandidate,
} from "../src/core/lib/theorem-core";

describe("R9: theorem-core shared computational utilities", () => {
    it("safeVaultFilename sanitizes unsafe characters", () => {
        expect(safeVaultFilename("Dune: Part One?")).toBe("Dune- Part One");
        expect(safeVaultFilename("Book / Title \\ With * Invalid < Characters >")).toBe(
            "Book - Title - With - Invalid - Characters"
        );
        expect(safeVaultFilename("   ")).toBe("Untitled Note");
    });

    it("buildFrontmatter generates valid YAML frontmatter", () => {
        const fm = buildFrontmatter("My Title", "John Doe", ["tag1", "tag2"]);
        expect(fm).toBe(
            '---\ntitle: "My Title"\nauthor: "John Doe"\ntags:\n  - "tag1"\n  - "tag2"\n---\n'
        );
    });

    it("normalizeSpeechText trims text", () => {
        expect(normalizeSpeechText("  hello world  ")).toBe("hello world");
    });

    it("initializes WASM and runs SIMD nucleo-matcher fuzzy ranking (W2)", async () => {
        const ready = await initTheoremCoreWasm();
        expect(ready).toBe(true);
        expect(isWasmCoreReady()).toBe(true);

        const candidates: FuzzyRankCandidate[] = [
            { id: "1", title: "The Lord of the Rings", author: "J.R.R. Tolkien" },
            { id: "2", title: "Dune", author: "Frank Herbert" },
            { id: "3", title: "Foundation", author: "Isaac Asimov" },
        ];

        const results = wasmFuzzyRank(candidates, "lotr");
        expect(results.length).toBeGreaterThanOrEqual(1);
        expect(results[0].id).toBe("1");
        expect(results[0].score).toBeGreaterThan(0);
        expect(results[0].titleIndices.length).toBeGreaterThan(0);

        const duneResults = wasmFuzzyRank(candidates, "frank");
        expect(duneResults.length).toBeGreaterThanOrEqual(1);
        expect(duneResults[0].id).toBe("2");
    });

    it("renders markdown via WASM pulldown-cmark (W2)", async () => {
        await initTheoremCoreWasm();
        const html = wasmMarkdownToHtml("# Chapter 1\n\nThis is **bold** and *italic* text.");
        expect(html).toContain("<h1>Chapter 1</h1>");
        expect(html).toContain("<strong>bold</strong>");
        expect(html).toContain("<em>italic</em>");
    });
});
