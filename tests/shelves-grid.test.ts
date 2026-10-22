/**
 * The shelf overview sizes its columns from the content area (min 14rem), not
 * from window breakpoints: the content is capped in width, so breakpoint
 * columns made six narrow cards on wide screens and cut shelf names short.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const shelves = readFileSync(resolve("src/features/library/Shelves.tsx"), "utf-8");

describe("shelf overview grid", () => {
    it("fills the content width with cards of at least 14rem", () => {
        expect(shelves).toContain("grid-cols-[repeat(auto-fill,minmax(min(100%,14rem),1fr))]");
        expect(shelves).not.toContain("2xl:grid-cols-6");
    });
});
