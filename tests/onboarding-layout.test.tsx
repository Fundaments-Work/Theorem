// @vitest-environment jsdom
/**
 * Onboarding keeps one card height and one layout on every step, so Back and
 * Next do not move under the pointer, and it describes sync as it works
 * (directly between devices on any network, not "over LAN").
 */
import { describe, it, expect, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { OnboardingFlow } from "../src/features/onboarding/OnboardingFlow";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

function render() {
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(<OnboardingFlow onComplete={() => {}} />));
}

function button(label: string): HTMLButtonElement {
    const found = Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim() === label);
    if (!found) throw new Error(`no button "${label}"`);
    return found;
}

afterEach(() => {
    act(() => root?.unmount());
    root = null;
    document.body.innerHTML = "";
});

describe("onboarding", () => {
    it("keeps the Skip row on the last step, hidden, so the content does not shift", () => {
        render();
        expect(button("Skip").className).not.toContain("invisible");
        for (let i = 0; i < 4; i++) act(() => button("Next").click());
        const skip = button("Skip");
        expect(skip.className).toContain("invisible");
        expect(skip.tabIndex).toBe(-1);
    });

    it("uses one fixed card height on desktop", () => {
        render();
        const card = document.querySelector(".fixed > div")!;
        expect(card.className).toContain("md:h-[660px]");
        expect(card.className).not.toContain("md:h-auto");
    });

    it("does not describe sync as LAN-only", () => {
        render();
        for (let i = 0; i < 4; i++) act(() => button("Next").click());
        const text = document.body.textContent ?? "";
        expect(text).toContain("Sync Across Devices");
        expect(text).not.toMatch(/\bLAN\b/);
        expect(text).toContain("at home or away");
    });
});
