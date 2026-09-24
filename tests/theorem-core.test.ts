import { describe, it, expect } from "vitest";
import {
    normalizeSpeechText,
    safeVaultFilename,
    buildFrontmatter,
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
});
