import { describe, expect, it } from "vitest";
import { addLocalDays, localDateKey } from "../src/core/lib/date-keys";

describe("localDateKey", () => {
    it("uses the local calendar day, even one minute before midnight", () => {
        expect(localDateKey(new Date(2026, 8, 23, 23, 59))).toBe("2026-09-23");
        expect(localDateKey(new Date(2026, 8, 24, 0, 1))).toBe("2026-09-24");
    });

    it("zero-pads month and day", () => {
        expect(localDateKey(new Date(2026, 0, 5, 12))).toBe("2026-01-05");
    });
});

describe("addLocalDays", () => {
    it("crosses month, year and leap-day boundaries", () => {
        expect(localDateKey(addLocalDays(new Date(2026, 0, 1, 12), -1))).toBe("2025-12-31");
        expect(localDateKey(addLocalDays(new Date(2028, 1, 28, 12), 1))).toBe("2028-02-29");
        expect(localDateKey(addLocalDays(new Date(2026, 2, 31, 12), 1))).toBe("2026-04-01");
    });

    it("keeps the wall-clock time across DST changes (no 24h drift)", () => {
        const before = new Date(2026, 2, 28, 0, 30);
        const after = addLocalDays(before, 2);
        expect(after.getHours()).toBe(0);
        expect(after.getMinutes()).toBe(30);
        expect(localDateKey(after)).toBe("2026-03-30");
    });

    it("does not mutate its input", () => {
        const d = new Date(2026, 5, 1);
        addLocalDays(d, 10);
        expect(localDateKey(d)).toBe("2026-06-01");
    });
});
