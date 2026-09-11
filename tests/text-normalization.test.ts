import { describe, expect, it } from "vitest";
import {
    integerToWords,
    ordinalToWords,
    yearToWords,
    romanToNumber,
    normalizeTextForAudio,
} from "../src/features/reader/audio/text-normalization";

describe("Text Normalization for Speech Synthesis (Issue #76)", () => {
    describe("integerToWords", () => {
        it("converts single digits", () => {
            expect(integerToWords(0)).toBe("zero");
            expect(integerToWords(1)).toBe("one");
            expect(integerToWords(7)).toBe("seven");
        });

        it("converts teens and tens", () => {
            expect(integerToWords(13)).toBe("thirteen");
            expect(integerToWords(42)).toBe("forty-two");
            expect(integerToWords(99)).toBe("ninety-nine");
        });

        it("converts hundreds and thousands", () => {
            expect(integerToWords(100)).toBe("one hundred");
            expect(integerToWords(105)).toBe("one hundred five");
            expect(integerToWords(1234)).toBe("one thousand two hundred thirty-four");
            expect(integerToWords(100000)).toBe("one hundred thousand");
            expect(integerToWords(1250000)).toBe("one million two hundred fifty thousand");
        });
    });

    describe("ordinalToWords", () => {
        it("converts basic ordinals", () => {
            expect(ordinalToWords(1)).toBe("first");
            expect(ordinalToWords(2)).toBe("second");
            expect(ordinalToWords(3)).toBe("third");
            expect(ordinalToWords(4)).toBe("fourth");
            expect(ordinalToWords(21)).toBe("twenty-first");
            expect(ordinalToWords(22)).toBe("twenty-second");
            expect(ordinalToWords(100)).toBe("one hundredth");
        });
    });

    describe("yearToWords", () => {
        it("converts historical and contemporary years", () => {
            expect(yearToWords(1984)).toBe("nineteen eighty-four");
            expect(yearToWords(1776)).toBe("seventeen seventy-six");
            expect(yearToWords(2000)).toBe("two thousand");
            expect(yearToWords(2005)).toBe("two thousand five");
            expect(yearToWords(2024)).toBe("twenty twenty-four");
            expect(yearToWords(1900)).toBe("nineteen hundred");
        });
    });

    describe("romanToNumber", () => {
        it("parses Roman numerals accurately", () => {
            expect(romanToNumber("I")).toBe(1);
            expect(romanToNumber("IV")).toBe(4);
            expect(romanToNumber("IX")).toBe(9);
            expect(romanToNumber("XIV")).toBe(14);
            expect(romanToNumber("XXIV")).toBe(24);
            expect(romanToNumber("MCMLXXXIV")).toBe(1984);
            expect(romanToNumber("INVALID")).toBeNull();
        });
    });

    describe("normalizeTextForAudio", () => {
        it("normalizes standalone numbers and numbers with commas", () => {
            expect(normalizeTextForAudio("There were 42 apples.")).toBe(
                "There were forty-two apples."
            );
            expect(normalizeTextForAudio("Over 1,234 people attended.")).toBe(
                "Over one thousand two hundred thirty-four people attended."
            );
        });

        it("normalizes Chapter headings with Roman numerals", () => {
            expect(normalizeTextForAudio("Chapter IV: The Beginning")).toBe(
                "Chapter four: The Beginning"
            );
            expect(normalizeTextForAudio("Part XII of the story")).toBe(
                "Part twelve of the story"
            );
        });

        it("normalizes Monarchs and Popes with Roman numerals", () => {
            expect(normalizeTextForAudio("King Henry VIII ruled England.")).toBe(
                "King Henry the eighth ruled England."
            );
            expect(normalizeTextForAudio("During World War II")).toBe(
                "During World War two"
            );
        });

        it("normalizes currencies and percentages", () => {
            expect(normalizeTextForAudio("It costs $50 in total.")).toBe(
                "It costs fifty dollars in total."
            );
            expect(normalizeTextForAudio("Only $12.50 left.")).toBe(
                "Only twelve dollars and fifty cents left."
            );
            expect(normalizeTextForAudio("A 75% discount was offered.")).toBe(
                "A seventy-five percent discount was offered."
            );
        });

        it("normalizes ordinals in text", () => {
            expect(normalizeTextForAudio("He finished in 1st place on his 21st birthday.")).toBe(
                "He finished in first place on his twenty-first birthday."
            );
        });

        it("normalizes common abbreviations and honorifics", () => {
            expect(normalizeTextForAudio("Dr. Watson met Mr. Holmes.")).toBe(
                "Doctor Watson met Mister Holmes."
            );
            expect(normalizeTextForAudio("Eat fruits, e.g., apples, oranges, etc.")).toBe(
                "Eat fruits, for example, apples, oranges, et cetera,"
            );
        });

        it("normalizes years in context", () => {
            expect(normalizeTextForAudio("Published in 1984 by Secker & Warburg.")).toBe(
                "Published in nineteen eighty-four by Secker and Warburg."
            );
        });

        it("normalizes fractions", () => {
            expect(normalizeTextForAudio("Add 1/2 cup of milk.")).toBe(
                "Add one half cup of milk."
            );
        });
    });
});
