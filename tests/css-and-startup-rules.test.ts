import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

// ─── CSS Performance Rules ───

describe("CSS: no snap-x snap-mandatory in our code", () => {
    it("no snap-x in application source files", () => {
        const indexCss = readFileSync(resolve("src/index.css"), "utf-8");
        // snap-x should NOT exist in our CSS sources
        expect(indexCss).not.toContain("snap-x");
        // But it SHOULD exist in vendored foliate-js (no check here)
    });
});

describe("CSS: no GPU compositing layers on desktop", () => {
    it("#app-main should NOT have content-visibility: auto (creates compositing layer, 500MB+ GPU memory on desktop)", () => {
        const indexCss = readFileSync(resolve("src/index.css"), "utf-8");
        expect(indexCss).not.toContain("#app-main");
    });

    it("#app-main should NOT have overscroll-behavior: contain (creates containment boundary on desktop)", () => {
        const indexCss = readFileSync(resolve("src/index.css"), "utf-8");
        expect(indexCss).not.toContain("overscroll-behavior: contain");
    });

    it("#app-main should NOT have -webkit-overflow-scrolling: touch (creates GPU compositing layer on desktop)", () => {
        const indexCss = readFileSync(resolve("src/index.css"), "utf-8");
        expect(indexCss).not.toContain("-webkit-overflow-scrolling: touch");
    });

    it("content-visibility: auto should NOT be on scroll containers (creates compositing layers on desktop)", () => {
        const indexCss = readFileSync(resolve("src/index.css"), "utf-8");
        expect(indexCss).not.toContain("content-visibility: auto");
    });
});

describe("CSS: animate-fade-in guarded by prefers-reduced-motion", () => {
    it("animate-fade-in inside prefers-reduced-motion media query", () => {
        const indexCss = readFileSync(resolve("src/index.css"), "utf-8");

        // The keyframes and class should be inside a @media block
        const afterMedia = indexCss.split("prefers-reduced-motion: no-preference")[1] || "";
        expect(afterMedia).toContain("fade-in");
    });
});

describe("Statistics progress bar does not use transition-all", () => {
    it("progress bar atomic transition", () => {
        const statisticsTsx = readFileSync(
            resolve("src/features/statistics/Statistics.tsx"),
            "utf-8",
        );
        // ProgressBar fill uses an explicit transition property, not transition-all
        expect(statisticsTsx).toContain('style={{ width: `${percentage}%` }}');
        // The ProgressBar's inner fill must not use transition-all
        const progressBar = statisticsTsx.split("function ProgressBar")[1]?.split("function getDateTimestamp")[0] || "";
        expect(progressBar).not.toContain("transition-all");
    });
});

// ─── Startup ───

describe("Startup: loader HTML", () => {
    it("index.html has app title", () => {
        const html = readFileSync(resolve("index.html"), "utf-8");
        expect(html).toContain("Theorem");
    });
    it("src/index.css has spinner and root:empty", () => {
        const css = readFileSync(resolve("src/index.css"), "utf-8");
        expect(css).toContain("root:empty");
        expect(css).toContain("theorem-loader-spin");
    });
});

describe("Startup: tauri.conf.json window visibility", () => {
    it("window config does not have visible: false (reverted — show() failed silently)", () => {
        const conf = readFileSync(resolve("src-tauri/tauri.conf.json"), "utf-8");
        expect(conf).not.toContain('"visible": false');
    });
});
