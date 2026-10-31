import { describe, expect, it } from "vitest";
import { formatReadingTime } from "../src/core/lib/utils";
describe("reading duration presentation", () => {
    it.each([
        [0,"0m"], [0.006,"<1m"], [0.99,"<1m"], [1,"1m"],
        [1.8,"1m"], [59.99,"59m"], [60,"1h"], [60.5,"1h"],
        [61.9,"1h 1m"], [120,"2h"], [-1,"0m"], [NaN,"0m"], [Infinity,"0m"],
    ])("formats %s minutes without exposing decimals", (minutes,label) => {
        expect(formatReadingTime(minutes)).toBe(label);
    });
});
