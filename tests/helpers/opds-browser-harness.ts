/**
 * Shared harness for OPDS browser component tests.
 *
 * Two things jsdom cannot give us on its own, both of which `@tanstack/react-virtual`
 * depends on:
 *
 * 1. **Layout.** It reads the scroll viewport via `offsetWidth`/`offsetHeight`
 *    (`getRect` in virtual-core), both hard 0 in jsdom. `outerSize === 0` sets the
 *    range to `null`, so the grid mounts *zero* rows — overscan does not rescue it.
 * 2. **`ResizeObserver`.** Not implemented at all; every container-based view
 *    constructs one.
 *
 * Worth remembering about production too: routes stay mounted inside a
 * `display:none` wrapper until first visited, so the real scroll element really
 * does measure 0×0 until the route becomes visible.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// @ts-expect-error React 19 act environment flag
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Root[] = [];

/** Give elements a fixed viewport. Returns a restore function. */
export function stubLayout(width = 1200, height = 800): () => void {
    const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
    const keys = ["offsetWidth", "offsetHeight", "clientWidth", "clientHeight"] as const;
    const before = keys.map(
        (key) => [key, Object.getOwnPropertyDescriptor(proto, key)] as const,
    );

    for (const key of keys) {
        Object.defineProperty(proto, key, { get: () => width, configurable: true });
    }

    return () => {
        for (const [key, descriptor] of before) {
            if (descriptor) Object.defineProperty(proto, key, descriptor);
        }
    };
}

export function render(ui: React.ReactElement): HTMLElement {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push(root);
    act(() => {
        root.render(ui);
    });
    return container;
}

export function unmountAll(): void {
    while (mounted.length) {
        const root = mounted.pop()!;
        act(() => root.unmount());
    }
    document.body.innerHTML = "";
}

/** Settle promises, effects and any timer the component scheduled. */
export async function flush(times = 5): Promise<void> {
    for (let i = 0; i < times; i++) {
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
    }
}

/** Wait past the search debounce so a network search actually fires. */
export async function flushDebounce(ms = 400): Promise<void> {
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, ms));
    });
    await flush();
}

/** Set a controlled input's value the way React's onChange actually sees it. */
export function setInputValue(container: HTMLElement, selector: string, value: string) {
    const input = container.querySelector(selector) as HTMLInputElement;
    if (!input) throw new Error(`No input matching ${selector}`);
    const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
    )!.set!;
    act(() => {
        setter.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    return input;
}

/** Click a button by its exact visible text, so tests do not depend on markup shape. */
export function clickButton(container: HTMLElement, text: string): HTMLElement {
    const button = Array.from(container.querySelectorAll("button")).find(
        (b) => b.textContent?.trim() === text,
    );
    if (!button) throw new Error(`No button with text "${text}"`);
    act(() => button.click());
    return button;
}

/** Click by aria-label. */
export function clickAriaLabel(container: HTMLElement, label: string): HTMLElement {
    const node = container.querySelector(`[aria-label="${label}"]`);
    if (!node) throw new Error(`No element with aria-label "${label}"`);
    act(() => (node as HTMLElement).click());
    return node as HTMLElement;
}

/**
 * Titles of the OPDS cards currently mounted in the grid.
 *
 * Targets the card's metadata block, not any `h3`: the clothbound fallback cover
 * renders the title in its own `h3`, so a bare selector matches twice for every
 * coverless entry.
 */
export function shownTitles(container: HTMLElement): string[] {
    return Array.from(container.querySelectorAll("[data-opds-card] [data-opds-card-title]")).map(
        (el) => el.textContent ?? "",
    );
}

export function cardCount(container: HTMLElement): number {
    return container.querySelectorAll("[data-opds-card]").length;
}