// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Gallery } from "../src/dev/ui-gallery";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The gallery is the first thing a contributor opens, so it must (a) render every shared
 * component and (b) pass the accessibility rules we hold screens to. These checks are
 * structural — accessible names, labels, roles, duplicate ids — which is what a review would
 * catch by hand. They do not replace a real browser audit (see docs/design-system.md).
 */
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root.render(<Gallery />));
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = "";
});

/** The text a screen reader would announce for a control. */
function accessibleName(el: Element): string {
    const labelled = el.getAttribute("aria-labelledby");
    if (labelled) {
        return labelled
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent ?? "")
            .join(" ")
            .trim();
    }
    const label = el.getAttribute("aria-label");
    if (label) return label.trim();
    const id = el.getAttribute("id");
    if (id) {
        const forLabel = document.querySelector(`label[for="${CSS.escape(id)}"]`);
        if (forLabel?.textContent) return forLabel.textContent.trim();
    }
    const wrapping = el.closest("label");
    if (wrapping?.textContent) return wrapping.textContent.trim();
    return (el.textContent ?? "").trim();
}

describe("gallery", () => {
    it("shows every shared primitive", () => {
        const text = host.textContent ?? "";
        for (const section of [
            "Colour tokens",
            "Button",
            "IconButton",
            "Chip",
            "TextInput",
            "Select",
            "Checkbox and Switch",
            "Tabs",
            "Card",
            "Dropdown",
            "Dialogs",
            "Spinner",
            "TheoremBookCover",
        ]) {
            expect(text, section).toContain(section);
        }
    });

    it("gives every button an accessible name", () => {
        const unnamed = [...host.querySelectorAll("button")]
            .filter((b) => accessibleName(b) === "")
            .map((b) => b.outerHTML.slice(0, 120));
        expect(unnamed).toEqual([]);
    });

    it("labels every form control", () => {
        const unlabelled = [...host.querySelectorAll("input, select, textarea")]
            .filter((el) => {
                if (el.getAttribute("type") === "hidden") return false;
                if (el.getAttribute("aria-label") || el.getAttribute("aria-labelledby")) return false;
                const id = el.getAttribute("id");
                if (id && document.querySelector(`label[for="${CSS.escape(id)}"]`)) return false;
                return !el.closest("label");
            })
            .map((el) => el.outerHTML.slice(0, 120));
        expect(unlabelled).toEqual([]);
    });

    it("names every dialog and keeps ids unique", () => {
        const ids = [...document.querySelectorAll("[id]")].map((el) => el.id);
        expect(ids).toHaveLength(new Set(ids).size);
        for (const dialog of document.querySelectorAll('[role="dialog"]')) {
            expect(accessibleName(dialog)).not.toBe("");
        }
    });

    it("marks up tabs and switches with their ARIA state", () => {
        const tabs = [...host.querySelectorAll('[role="tab"]')];
        expect(tabs.length).toBeGreaterThan(0);
        expect(tabs.filter((t) => t.getAttribute("aria-selected") === "true")).toHaveLength(1);
        for (const tab of tabs) {
            expect(tab.getAttribute("aria-controls")).toBeTruthy();
        }
        const switches = [...host.querySelectorAll('[role="switch"]')];
        expect(switches.length).toBeGreaterThan(0);
        for (const sw of switches) expect(sw.getAttribute("aria-checked")).toMatch(/^(true|false)$/);
    });

    // A structural regression guard: this markup is the contract every screen builds on.
    it("matches the shared-component markup snapshot", () => {
        const normalised = host.innerHTML
            .replace(/radix-[a-z0-9-]+/gi, "radix")
            .replace(/id="[^"]*"/g, 'id="x"')
            .replace(/aria-controls="[^"]*"/g, 'aria-controls="x"')
            .replace(/aria-labelledby="[^"]*"/g, 'aria-labelledby="x"')
            .replace(/for="[^"]*"/g, 'for="x"');
        expect(normalised).toMatchSnapshot();
    });
});
