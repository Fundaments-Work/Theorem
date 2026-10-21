// @vitest-environment jsdom
/**
 * Accessibility regressions found by running axe-core over the app: dialogs must be named,
 * every page must have a heading and landmarks, and icon-only or unlabeled controls need names.
 */
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Modal, ModalBody, ModalHeader } from "../src/ui";
import { flush, render, unmountAll } from "./helpers/opds-browser-harness";

const dialog = () => document.body.querySelector('[role="dialog"]') as HTMLElement;
const nameOf = (el: HTMLElement) => {
    const id = el.getAttribute("aria-labelledby");
    return id ? document.getElementById(id)?.textContent?.trim() : el.getAttribute("aria-label");
};

describe("dialog names", () => {
    afterEach(() => unmountAll());

    it("a dialog with a ModalHeader is named by its visible title, and has no empty heading", async () => {
        render(
            <Modal isOpen onClose={() => {}}>
                <ModalHeader title="Add a catalog" onClose={() => {}} />
                <ModalBody>body</ModalBody>
            </Modal>,
        );
        await flush();
        expect(nameOf(dialog())).toBe("Add a catalog");
        const headings = Array.from(dialog().querySelectorAll("h1,h2,h3")).map((h) => h.textContent?.trim());
        expect(headings.every(Boolean)).toBe(true);
        expect(headings).toEqual(["Add a catalog"]);
    });

    it("a dialog without a header still has a name", async () => {
        render(
            <Modal isOpen onClose={() => {}} ariaLabel="Book details">
                <ModalBody>body</ModalBody>
            </Modal>,
        );
        await flush();
        expect(nameOf(dialog())).toBe("Book details");
    });

    it("falls back to a generic name rather than none", async () => {
        render(
            <Modal isOpen onClose={() => {}}>
                <ModalBody>body</ModalBody>
            </Modal>,
        );
        await flush();
        expect(nameOf(dialog())).toBeTruthy();
    });

    it("an explicit aria-labelledby is respected", async () => {
        render(
            <Modal isOpen onClose={() => {}} ariaLabelledby="custom-title">
                <h2 id="custom-title">Custom</h2>
                <ModalBody>body</ModalBody>
            </Modal>,
        );
        await flush();
        expect(dialog().getAttribute("aria-labelledby")).toBe("custom-title");
    });

    it("the header's close button is named", async () => {
        render(
            <Modal isOpen onClose={() => {}}>
                <ModalHeader title="T" onClose={() => {}} />
            </Modal>,
        );
        await flush();
        expect(dialog().querySelector('button[aria-label="Close"]')).not.toBeNull();
    });
});

describe("page structure", () => {
    const src = (f: string) => readFileSync(resolve(f), "utf-8");

    it("the title bar is a header landmark and its page title stays in the accessibility tree on phones", () => {
        const titlebar = src("src/shell/AppTitlebar.tsx");
        expect(titlebar).toContain("<header");
        expect(titlebar).not.toMatch(/<h1 className="hidden sm:block/);
        expect(titlebar).toContain("sr-only sm:not-sr-only");
    });

    it("selects have accessible names", () => {
        expect(src("src/features/settings/Settings.tsx")).toContain('aria-label="Article retention period"');
        expect(src("src/features/settings/NeuralVoiceSection.tsx")).toContain('aria-label="Voice engine"');
    });

    it("long values in a setting's description wrap instead of widening the page", () => {
        // A folder path or URL has no spaces to break at (the neural voice 'N MB at /home/…/tts' line).
        for (const f of ["src/features/settings/Settings.tsx", "src/features/settings/NeuralVoiceSection.tsx"]) {
            expect(src(f)).toContain("[overflow-wrap:anywhere]");
        }
    });
});

describe("state is exposed, not only painted", () => {
    const settings = readFileSync(resolve("src/features/settings/Settings.tsx"), "utf-8");

    it("the On/Off toggle and option buttons report which choice is selected", () => {
        expect(settings).toContain("aria-pressed={checked}");
        expect(settings).toContain("aria-pressed={!checked}");
        expect(settings).toContain("aria-pressed={value === opt.value}");
    });
});

describe("floating reader panels", () => {
    it("are named and inert while closed, so hidden controls are neither announced nor tabbable", async () => {
        const { FloatingPanel } = await import("../src/ui");
        const host = document.createElement("div");
        document.body.appendChild(host);
        const { createRoot } = await import("react-dom/client");
        const { act } = await import("react");
        const root = createRoot(host);
        act(() => root.render(<FloatingPanel visible={false} label="Reading settings"><button>inside</button></FloatingPanel>));
        const panel = host.querySelector('[role="dialog"]') as HTMLElement;
        expect(panel.getAttribute("aria-label")).toBe("Reading settings");
        expect(panel.hasAttribute("inert")).toBe(true);
        expect(panel.getAttribute("aria-hidden")).toBe("true");
        expect(panel.hasAttribute("aria-modal")).toBe(false);
        act(() => root.render(<FloatingPanel visible label="Reading settings"><button>inside</button></FloatingPanel>));
        expect(panel.hasAttribute("inert")).toBe(false);
        expect(panel.hasAttribute("aria-hidden")).toBe(false);
        expect(panel.getAttribute("aria-modal")).toBe("true");
        act(() => root.unmount());
        host.remove();
    });

    it("every FloatingPanel in the app passes a label", () => {
        const files = [
            "src/features/reader/components/ReaderSettings.tsx",
            "src/features/reader/components/ReaderSearch.tsx",
            "src/features/reader/components/ReaderBookmarks.tsx",
            "src/features/reader/components/ReaderAnnotationsPanel.tsx",
            "src/features/reader/components/BookInfoPopover.tsx",
            "src/features/reader/components/PDFViewSettingsPanel.tsx",
            "src/features/reader/article-reader/ArticleReaderInfoPanel.tsx",
        ];
        for (const f of files) expect(readFileSync(resolve(f), "utf-8")).toMatch(/<FloatingPanel\s+(?:visible=\{[^}]*\}\s+)?label="/);
    });

    it("reader sliders are named", () => {
        const s = readFileSync(resolve("src/features/reader/components/ReaderSettings.tsx"), "utf-8");
        for (const name of ["Brightness", "Font size", "Line spacing", "Zoom"]) expect(s).toContain(`aria-label="${name}"`);
    });

    it("annotation cards no longer nest controls inside a role=button", () => {
        const s = readFileSync(resolve("src/features/reader/components/ReaderAnnotationsPanel.tsx"), "utf-8");
        expect(s).not.toMatch(/role="button"\s+tabIndex=\{0\}/);
        expect(s).toContain('aria-label="More actions"');
        expect(s).toContain("aria-label=\"Jump to this highlight in the book\"");
    });
});
