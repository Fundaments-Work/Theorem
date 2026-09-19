import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

// ─── #105: reader open-path navigation must not false-positive timeout ───

describe("foliate-engine initial navigation reliability", () => {
    const engine = readFileSync(
        resolve("src/features/reader/engines/foliate-engine.ts"),
        "utf-8",
    );

    it("uses a generous initial-navigation budget", () => {
        expect(engine).toContain("READER_INITIAL_NAVIGATION_TIMEOUT_MS = 15000");
    });

    it("retries initial navigation before surfacing a timeout", () => {
        expect(engine).toContain("READER_INITIAL_NAVIGATION_RETRIES");
        expect(engine).toContain("goToWithRetry");
    });

    it("open path navigates via retry helper, not a single short timeout", () => {
        const retryCalls = engine.match(/await this\.goToWithRetry\(/g) || [];
        // restore-saved-location + fallback-to-start + plain-start
        expect(retryCalls.length).toBeGreaterThanOrEqual(3);
        // the old 6s single-shot gate must be gone from the open path
        expect(engine).not.toContain("READER_NAVIGATION_TIMEOUT_MS");
    });

    it("book open still has an outer timeout guard", () => {
        expect(engine).toContain("READER_OPEN_TIMEOUT_MS = 20000");
    });
});
