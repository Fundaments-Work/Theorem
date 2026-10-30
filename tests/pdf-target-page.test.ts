import { describe, expect, it } from "vitest";
import { resolvePdfTargetPage } from "../src/features/reader/Reader";

describe("resolvePdfTargetPage", () => {
    it("resolves a target page from plain numbers and page-reference formats", () => {
        expect(resolvePdfTargetPage("5")).toBe(5);
        expect(resolvePdfTargetPage("pdf:page:12")).toBe(12);
        expect(resolvePdfTargetPage("?page=7")).toBe(7);
        expect(resolvePdfTargetPage("#page=9")).toBe(9);
    });

    it("returns null for empty or unrecognised locations", () => {
        expect(resolvePdfTargetPage("")).toBeNull();
        expect(resolvePdfTargetPage("invalid")).toBeNull();
    });
});
