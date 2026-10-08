// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { Sidebar } from "../src/shell/layout/Sidebar";
import { AppTitlebar } from "../src/shell/AppTitlebar";
import { MomoIcon } from "../src/ui/MomoIcon";
import {
    BUY_ME_MOMO_URL,
    SUPPORT_HIDDEN_UNTIL_KEY,
    SUPPORT_CADENCE_MS,
} from "../src/core/lib/support-prompt";

// @ts-expect-error React 19 act environment flag
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { mockIsMobile, mockOpenExternalUrl } = vi.hoisted(() => ({
    mockIsMobile: vi.fn().mockReturnValue(false),
    mockOpenExternalUrl: vi.fn(),
}));

vi.mock("../src/core/lib/open-external-url", () => ({
    openExternalUrl: (url: string) => mockOpenExternalUrl(url),
}));

vi.mock("../src/core/lib/env", () => ({
    isMobile: () => mockIsMobile(),
    isTauri: () => false,
    isTauriMobile: () => false,
    isTauriDesktop: () => false,
}));

const mounted: Root[] = [];

function render(ui: React.ReactElement) {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push(root);
    act(() => {
        root.render(ui);
    });
    return container;
}

describe("Buy Me Momo Shell Integration", () => {
    beforeEach(() => {
        localStorage.clear();
        vi.clearAllMocks();
        mockIsMobile.mockReturnValue(false);
    });

    afterEach(() => {
        while (mounted.length) {
            const root = mounted.pop()!;
            act(() => root.unmount());
        }
        document.body.innerHTML = "";
    });

    describe("MomoIcon", () => {
        it("renders SVG with currentColor and standard 24x24 viewBox", () => {
            const container = render(<MomoIcon className="w-4 h-4" />);
            const svg = container.querySelector("svg");
            expect(svg).not.toBeNull();
            expect(svg?.getAttribute("viewBox")).toBe("0 0 24 24");
            expect(svg?.getAttribute("stroke")).toBe("currentColor");
            expect(svg?.getAttribute("fill")).toBe("none");
            expect(svg?.classList.contains("w-4")).toBe(true);
        });
    });

    describe("Sidebar Support Placement", () => {
        it("renders Support button when user is eligible", () => {
            const container = render(<Sidebar />);
            const supportBtn = container.querySelector('button[title="Support Theorem on Buy Me Momo"]');
            expect(supportBtn).not.toBeNull();
            expect(supportBtn?.textContent).toContain("Support");
        });

        it("omits Support button when hiddenUntil is in the future", () => {
            const futureTime = Date.now() + SUPPORT_CADENCE_MS;
            localStorage.setItem(SUPPORT_HIDDEN_UNTIL_KEY, String(futureTime));

            const container = render(<Sidebar />);
            const supportBtn = container.querySelector('button[title="Support Theorem on Buy Me Momo"]');
            expect(supportBtn).toBeNull();
        });

        it("dispatches to Buy Me Momo on click and updates cadence in localStorage", () => {
            const container = render(<Sidebar />);
            const supportBtn = container.querySelector('button[title="Support Theorem on Buy Me Momo"]');
            expect(supportBtn).not.toBeNull();

            act(() => {
                supportBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            });

            expect(mockOpenExternalUrl).toHaveBeenCalledWith(BUY_ME_MOMO_URL);
            expect(localStorage.getItem(SUPPORT_HIDDEN_UNTIL_KEY)).not.toBeNull();

            // Button hides immediately after click
            expect(container.querySelector('button[title="Support Theorem on Buy Me Momo"]')).toBeNull();
        });
    });

    describe("AppTitlebar Mobile Support Placement", () => {
        it("renders Momo button in mobile titlebar when eligible", () => {
            mockIsMobile.mockReturnValue(true);

            const container = render(<AppTitlebar title="Theorem" />);
            const mobileSupportBtn = container.querySelector('button[aria-label="Support Theorem on Buy Me Momo"]');
            expect(mobileSupportBtn).not.toBeNull();
        });

        it("does not render mobile Momo button on desktop", () => {
            mockIsMobile.mockReturnValue(false);

            const container = render(<AppTitlebar title="Theorem" />);
            const mobileSupportBtn = container.querySelector('button[aria-label="Support Theorem on Buy Me Momo"]');
            expect(mobileSupportBtn).toBeNull();
        });

        it("dispatches to Buy Me Momo when clicked from mobile titlebar", () => {
            mockIsMobile.mockReturnValue(true);

            const container = render(<AppTitlebar title="Theorem" />);
            const mobileSupportBtn = container.querySelector('button[aria-label="Support Theorem on Buy Me Momo"]');
            expect(mobileSupportBtn).not.toBeNull();

            act(() => {
                mobileSupportBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            });

            expect(mockOpenExternalUrl).toHaveBeenCalledWith(BUY_ME_MOMO_URL);
            expect(localStorage.getItem(SUPPORT_HIDDEN_UNTIL_KEY)).not.toBeNull();
        });
    });
});
