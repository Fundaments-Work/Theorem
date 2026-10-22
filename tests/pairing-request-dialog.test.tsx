// @vitest-environment jsdom
/**
 * The device whose QR code was scanned must approve the pairing. It shows who
 * is asking and the six digits to compare; only Accept pairs, and every other
 * way out of the dialog declines.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PairingRequestDialog, type PairingRequest } from "../src/features/settings/PairingRequestDialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

const REQUEST: PairingRequest = { requestId: "r1", deviceName: "Pixel 8", code: "042917" };

function render(request: PairingRequest | null, onAnswer: (accept: boolean) => void) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(<PairingRequestDialog request={request} onAnswer={onAnswer} />));
}

function button(label: string): HTMLButtonElement {
    const found = Array.from(document.body.querySelectorAll("button")).find(
        (b) => b.textContent?.trim() === label,
    );
    if (!found) throw new Error(`no ${label} button`);
    return found as HTMLButtonElement;
}

afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
});

describe("PairingRequestDialog", () => {
    it("shows nothing without a request", () => {
        render(null, () => {});
        expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    });

    it("names the device and shows the code, leading zeros kept", () => {
        render(REQUEST, () => {});
        const dialog = document.body.querySelector('[role="dialog"]') as HTMLElement;
        expect(dialog.textContent).toContain("Pixel 8");
        expect(dialog.querySelector("[data-pairing-code]")?.textContent).toBe("042917");
    });

    it("falls back to a neutral name when the device sends none", () => {
        render({ ...REQUEST, deviceName: "" }, () => {});
        expect(document.body.textContent).toContain("A device");
    });

    it("pairs only on Accept", () => {
        const onAnswer = vi.fn();
        render(REQUEST, onAnswer);
        act(() => button("Accept").click());
        expect(onAnswer).toHaveBeenCalledExactlyOnceWith(true);
    });

    it("declines on Decline", () => {
        const onAnswer = vi.fn();
        render(REQUEST, onAnswer);
        act(() => button("Decline").click());
        expect(onAnswer).toHaveBeenCalledExactlyOnceWith(false);
    });

    it("declines when the dialog is dismissed with Escape", () => {
        const onAnswer = vi.fn();
        render(REQUEST, onAnswer);
        act(() => {
            document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        });
        expect(onAnswer).toHaveBeenCalled();
        expect(onAnswer.mock.calls.every(([accept]) => accept === false)).toBe(true);
    });
});
