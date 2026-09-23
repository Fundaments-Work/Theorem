import { describe, expect, it } from "vitest";
import { rankByFuzzyQuery } from "../src/core/lib/search/fuzzy";

const books = [
    { title: "The Lord of the Rings" },
    { title: "Dune" },
    { title: "Theory of Computation and Linear Algebra" },
    { title: "Leviathan Wakes" },
];
const titles = (query: string) =>
    rankByFuzzyQuery(books, query, { keys: ["title"] }).map((r) => r.item.title);

describe("fuzzy ranking stays literal enough to be predictable", () => {
    it("does not match letters scattered across a title", () => {
        // t…o…c spread over "The Lord of the Rings" / "Theory of Computation".
        expect(titles("toc")).toEqual([]);
        expect(titles("dle")).toEqual([]);
    });

    it("still tolerates a dropped letter inside a word", () => {
        expect(titles("lrd")).toEqual(["The Lord of the Rings"]);
        expect(titles("levthan")).toEqual(["Leviathan Wakes"]);
    });

    it("ranks substring and word matches as before", () => {
        expect(titles("dune")).toEqual(["Dune"]);
        expect(titles("lord rings")).toEqual(["The Lord of the Rings"]);
        expect(titles("comput")[0]).toBe("Theory of Computation and Linear Algebra");
    });
});
