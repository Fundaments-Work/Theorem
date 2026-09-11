import { describe, expect, it } from "vitest";
import {
    segmentSentences,
    resolveNeuralVoice,
    NEURAL_VOICES,
} from "../src/features/reader/audio/ImmersionPlayer";

describe("Immersion Reading - Sentence Segmentation (Issue #76)", () => {
    describe("segmentSentences", () => {
        it("returns empty array for empty or whitespace-only text", () => {
            expect(segmentSentences("")).toEqual([]);
            expect(segmentSentences("   \n\t  ")).toEqual([]);
        });

        it("segments basic multi-sentence text with periods and question marks", () => {
            const text = "Call me Ishmael. Some years ago—never mind how long precisely. Did it matter?";
            const sentences = segmentSentences(text);

            expect(sentences.length).toBe(3);
            expect(sentences[0].text).toBe("Call me Ishmael.");
            expect(sentences[0].index).toBe(0);
            expect(sentences[1].text).toBe("Some years ago—never mind how long precisely.");
            expect(sentences[1].index).toBe(1);
            expect(sentences[2].text).toBe("Did it matter?");
            expect(sentences[2].index).toBe(2);

            // Verify offsets correspond to text positions
            for (const s of sentences) {
                expect(text.slice(s.startChar, s.endChar).trim()).toBe(s.text);
            }
        });

        it("handles text with quotes and dialogue punctuation", () => {
            const text = '"It is a truth universally acknowledged," he said. "Are you certain?"';
            const sentences = segmentSentences(text);

            expect(sentences.length).toBeGreaterThanOrEqual(1);
            expect(sentences[0].text.length).toBeGreaterThan(0);
            expect(sentences[0].index).toBe(0);
        });

        it("handles single sentence without trailing punctuation", () => {
            const text = "A sentence without punctuation";
            const sentences = segmentSentences(text);

            expect(sentences.length).toBe(1);
            expect(sentences[0].text).toBe(text);
            expect(sentences[0].index).toBe(0);
            expect(sentences[0].startChar).toBe(0);
            expect(sentences[0].endChar).toBe(text.length);
        });

        it("correctly tracks sequential index values", () => {
            const text = "First sentence. Second sentence. Third sentence. Fourth sentence.";
            const sentences = segmentSentences(text);

            expect(sentences.length).toBe(4);
            sentences.forEach((s, idx) => {
                expect(s.index).toBe(idx);
            });
        });
    });

    describe("resolveNeuralVoice", () => {
        it("resolves valid neural voices accurately", () => {
            for (const v of NEURAL_VOICES) {
                expect(resolveNeuralVoice(v)).toBe(v);
            }
        });

        it("falls back to F1 for invalid or null voices", () => {
            expect(resolveNeuralVoice(null)).toBe("F1");
            expect(resolveNeuralVoice(undefined)).toBe("F1");
            expect(resolveNeuralVoice("NonExistentVoice")).toBe("F1");
        });
    });
});

