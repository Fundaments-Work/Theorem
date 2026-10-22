// @vitest-environment jsdom
/**
 * An empty library says what can be added and offers every way in:
 * importing files, scanning a folder (where available) and Discover.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EmptyLibrary } from "../src/features/library/Library";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

function render(props: Partial<Parameters<typeof EmptyLibrary>[0]> = {}) {
    const all = {
        onAddBooks: vi.fn(),
        onBrowseDiscover: vi.fn(),
        isImporting: false,
        isScanning: false,
        ...props,
    };
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(<EmptyLibrary {...all} />));
    return all;
}

function button(text: RegExp): HTMLButtonElement {
    const found = Array.from(document.querySelectorAll("button")).find((b) => text.test(b.textContent ?? ""));
    if (!found) throw new Error(`no button ${text}`);
    return found;
}

afterEach(() => {
    act(() => root?.unmount());
    root = null;
    document.body.innerHTML = "";
});

describe("empty library", () => {
    it("names the formats it takes and leads to Discover", () => {
        const props = render();
        expect(document.body.textContent).toContain("No Books Yet");
        expect(document.body.textContent).toMatch(/EPUB, PDF/);
        act(() => button(/Discover/).click());
        expect(props.onBrowseDiscover).toHaveBeenCalledTimes(1);
        act(() => button(/Import Books/).click());
        expect(props.onAddBooks).toHaveBeenCalledTimes(1);
    });

    it("offers Scan Folder only where it exists", () => {
        render();
        expect(() => button(/Scan Folder/)).toThrow();
        act(() => root!.unmount());
        const onScanFolder = vi.fn();
        render({ onScanFolder });
        act(() => button(/Scan Folder/).click());
        expect(onScanFolder).toHaveBeenCalledTimes(1);
    });
});
