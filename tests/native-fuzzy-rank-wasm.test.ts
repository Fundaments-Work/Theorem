/**
 * The browser path of in-app search, against the real WebAssembly build of the
 * Rust nucleo matcher (no mocks).
 */
import { describe, expect, it } from "vitest";
import { rankByNativeFuzzy } from "../src/core/lib/search/native-rank";

type Item = { name: string; note?: string };
const items: Item[] = [
    { name: "The Lord of the Rings", note: "Tolkien" },
    { name: "Dune", note: "desert planet" },
    { name: "Theory of Computation and Linear Algebra" },
    { name: "Dune Messiah", note: "sequel" },
    { name: "Leviathan Wakes" },
    { name: "Clash of the Hackers: A Rational Account of Cybercrime Techniques" },
    { name: "Character and Culture" },
];
const fields = (i: Item) => ({ primary: i.name, secondary: i.note });
const names = async (q: string) => (await rankByNativeFuzzy(items, q, fields)).map((m) => m.item.name);

describe("in-app search with the WebAssembly matcher", () => {
    it("matches words in the primary or secondary field, ignoring case", async () => {
        expect(await names("DUNE")).toEqual(["Dune", "Dune Messiah"]);
        expect(await names("sequel")).toEqual(["Dune Messiah"]);
        expect(await names("lord tolkien")).toEqual(["The Lord of the Rings"]);
    });

    it("tolerates a dropped letter but not letters scattered across a title", async () => {
        expect(await names("levthan")).toEqual(["Leviathan Wakes"]);
        // Every letter of "character" occurs in order in the Hackers title, spread over unrelated words.
        expect(await names("character")).toEqual(["Character and Culture"]);
        // Word starts are a deliberate acronym match, as in the Library ("lotr").
        expect(await names("toc")).toEqual(["Theory of Computation and Linear Algebra"]);
        expect(await names("zzzqqq")).toEqual([]);
    });

    it("returns match positions for highlighting", async () => {
        const [first] = await rankByNativeFuzzy(items, "sequel", fields);
        expect(first.primaryIndices).toEqual([]);
        expect(first.secondaryIndices).toEqual([0, 1, 2, 3, 4, 5]);
    });
});
