import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { immersionSource, immersionUsesTts } from "../src/features/reader/lib/immersion-source";

describe("immersion source: which audio plays in immersion mode", () => {
    it("plays an attached audiobook first, even on a book with its own narration", () => {
        expect(immersionSource({ hasAudiobook: true, hasMediaOverlay: true })).toBe("audiobook");
        expect(immersionSource({ hasAudiobook: true, hasMediaOverlay: false })).toBe("audiobook");
    });

    it("plays the book's own narration when no audiobook is attached", () => {
        expect(immersionSource({ hasAudiobook: false, hasMediaOverlay: true })).toBe("book-narration");
    });

    it("falls back to generated speech", () => {
        expect(immersionSource({ hasAudiobook: false, hasMediaOverlay: false })).toBe("tts");
    });

    it("needs the TTS setting for every source except the book's own narration", () => {
        expect(immersionUsesTts("book-narration")).toBe(false);
        expect(immersionUsesTts("tts")).toBe(true);
        // Unchanged behaviour: the audiobook path has always turned TTS on.
        expect(immersionUsesTts("audiobook")).toBe(true);
    });
});

describe("Reader keeps the saved TTS setting for books with their own narration", () => {
    const readerSource = readFileSync(resolve("src/features/reader/Reader.tsx"), "utf-8");

    it("only turns TTS on when the chosen source needs it", () => {
        expect(readerSource).toMatch(/if \(!ttsEnabled && immersionUsesTts\(bookImmersionSource\)\) \{\s*updateTtsSettings\(\{ enabled: true \}\);/);
    });

    it("does not leave immersion over TTS being off while the book's narration plays", () => {
        expect(readerSource).toContain("if (!ttsEnabled && immersionMode && immersionUsesTts(bookImmersionSource))");
    });
});
