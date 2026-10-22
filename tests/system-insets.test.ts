// @vitest-environment jsdom
/**
 * Android's WebView reports only the camera cutout through env(safe-area-inset-*), so the
 * app reads the real system-bar insets and exposes them as --system-inset-*. The layout uses
 * the --safe-area-* tokens, which take the larger of the two.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { applySystemInsets, startSystemInsets, type SystemInsets } from "../src/core/lib/system-insets";

const ANDROID = "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36";
const DESKTOP = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const css = (side: string) => document.documentElement.style.getPropertyValue(`--system-inset-${side}`);
const settle = () => new Promise((r) => setTimeout(r, 0));

let stop: (() => void) | null = null;
beforeEach(() => {
    document.documentElement.removeAttribute("style");
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
});
afterEach(() => {
    stop?.();
    stop = null;
    vi.restoreAllMocks();
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe("applySystemInsets", () => {
    it("writes each edge in CSS pixels", () => {
        applySystemInsets({ top: 24.5714, right: 0, bottom: 48, left: 0 });
        expect([css("top"), css("right"), css("bottom"), css("left")]).toEqual(["24.57px", "0px", "48px", "0px"]);
    });

    it.each([
        ["missing", undefined],
        ["null", null],
        ["empty", {}],
    ])("treats %s insets as none", (_name, insets) => {
        applySystemInsets(insets as never);
        expect(css("top")).toBe("0px");
        expect(css("bottom")).toBe("0px");
    });

    it("never writes a negative, infinite or absurd value", () => {
        applySystemInsets({ top: -10, right: Number.NaN, bottom: Number.POSITIVE_INFINITY, left: 99999 } as SystemInsets);
        expect([css("top"), css("right"), css("bottom"), css("left")]).toEqual(["0px", "0px", "0px", "512px"]);
    });
});

describe("startSystemInsets", () => {
    it("does nothing off Android: env() is right there", async () => {
        vi.spyOn(navigator, "userAgent", "get").mockReturnValue(DESKTOP);
        const read = vi.fn();
        stop = startSystemInsets(read);
        await settle();
        expect(read).not.toHaveBeenCalled();
        expect(css("top")).toBe("");
    });

    it("reads the insets at start, and again on resize, rotation and return to the app", async () => {
        vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ANDROID);
        const read = vi.fn(async () => ({ top: 32, right: 0, bottom: 24, left: 0 }));
        stop = startSystemInsets(read);
        await settle();
        expect(css("top")).toBe("32px");
        expect(css("bottom")).toBe("24px");

        read.mockResolvedValueOnce({ top: 0, right: 48, bottom: 0, left: 32 });
        window.dispatchEvent(new Event("orientationchange"));
        await settle();
        expect([css("top"), css("right"), css("left")]).toEqual(["0px", "48px", "32px"]);

        window.dispatchEvent(new Event("resize"));
        Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
        document.dispatchEvent(new Event("visibilitychange"));
        await settle();
        expect(read).toHaveBeenCalledTimes(4);
    });

    it("keeps the newest answer when an older one arrives late", async () => {
        vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ANDROID);
        let releaseFirst: (v: SystemInsets) => void = () => undefined;
        const read = vi
            .fn<() => Promise<SystemInsets>>()
            .mockImplementationOnce(() => new Promise((r) => (releaseFirst = r)))
            .mockResolvedValueOnce({ top: 0, right: 0, bottom: 16, left: 0 });
        stop = startSystemInsets(read);
        window.dispatchEvent(new Event("resize"));
        await settle();
        releaseFirst({ top: 99, right: 0, bottom: 99, left: 0 });
        await settle();
        expect(css("bottom")).toBe("16px");
        expect(css("top")).toBe("0px");
    });

    it("survives a failed read and stops listening once stopped", async () => {
        vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ANDROID);
        const read = vi.fn(async () => {
            throw new Error("plugin not ready");
        });
        stop = startSystemInsets(read);
        await settle();
        expect(css("top")).toBe("");
        stop();
        stop = null;
        window.dispatchEvent(new Event("resize"));
        await settle();
        expect(read).toHaveBeenCalledTimes(1);
    });
});

describe("layout uses the safe-area tokens", () => {
    const root = resolve(__dirname, "..");

    it("defines each token as the larger of env() and Android's inset", () => {
        const tokens = readFileSync(resolve(root, "src/core/styles/design-tokens.css"), "utf-8");
        for (const side of ["top", "right", "bottom", "left"]) {
            expect(tokens).toContain(`--safe-area-${side}: max(env(safe-area-inset-${side}, 0px), var(--system-inset-${side}, 0px));`);
        }
    });

    it("never reads env(safe-area-inset-*) anywhere else", () => {
        const hits = execFileSync("grep", ["-rnE", "env\\(safe-area-inset-", "src", "--include=*.ts", "--include=*.tsx", "--include=*.css"], { cwd: root })
            .toString()
            .trim()
            .split("\n")
            .filter((line) => !/design-tokens\.css:\d+:\s+(--safe-area-|\s*env\(safe-area-inset-\*\) directly)/.test(line));
        expect(hits).toEqual([]);
    });

    it("pads the bottom bar and onboarding's Skip and footer", () => {
        const nav = readFileSync(resolve(root, "src/shell/layout/BottomNav.tsx"), "utf-8");
        expect(nav).toContain("pb-[var(--safe-area-bottom)]");
        const onboarding = readFileSync(resolve(root, "src/features/onboarding/OnboardingFlow.tsx"), "utf-8");
        expect(onboarding).toContain("pt-[calc(var(--safe-area-top)+1rem)]");
        expect(onboarding).toContain("pb-[calc(var(--safe-area-bottom)+1.25rem)]");
    });
});
