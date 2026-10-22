// @vitest-environment jsdom
/**
 * Dialogs on a phone keep the page's 16px side gutter instead of running edge to edge; the
 * fullscreen size is the one exception and still covers the whole screen.
 */
import { describe, it, expect, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Modal, ModalHeader, ModalBody } from "../src/ui/Modal";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

function open(size?: "sm" | "md" | "lg" | "xl" | "fullscreen") {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
        root!.render(
            <Modal isOpen onClose={() => {}} size={size}>
                <ModalHeader title="New shelf" />
                <ModalBody>Body</ModalBody>
            </Modal>,
        );
    });
    return document.body.querySelector('[role="dialog"]') as HTMLElement;
}

const classes = (el: HTMLElement) => el.className.split(/\s+/);

afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
});

describe("Modal width on small screens", () => {
    it.each(["sm", "md", "lg", "xl"] as const)("size %s leaves a 16px gutter on each side and never uses the full width", (size) => {
        const c = classes(open(size));
        expect(c).toContain("w-[calc(100%-2rem)]");
        expect(c).not.toContain("w-full");
        expect(c).not.toContain("w-screen");
        expect(c.some((k) => k.startsWith("max-w-["))).toBe(true);
    });

    it("keeps the default size gutter too", () => {
        expect(classes(open())).toContain("w-[calc(100%-2rem)]");
    });

    it("fullscreen still covers the whole screen, with no gutter left over", () => {
        const c = classes(open("fullscreen"));
        expect(c).toContain("w-screen");
        expect(c).toContain("max-w-none");
        expect(c).not.toContain("w-[calc(100%-2rem)]");
    });

    it("caps the height so a tall dialog never runs under the status or navigation bar", () => {
        expect(classes(open("md"))).toContain("max-h-[var(--layout-modal-max-height)]");
    });

    it("lets fullscreen take the whole height", () => {
        expect(classes(open("fullscreen"))).toContain("max-h-none");
    });
});
