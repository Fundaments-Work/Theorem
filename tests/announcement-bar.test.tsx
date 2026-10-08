// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { AnnouncementBar, AnnouncementBody } from "../src/ui/AnnouncementBar";
import { Announcement } from "../src/core/lib/announcements";

// @ts-expect-error React 19 act environment flag
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../src/core/lib/open-external-url", () => ({
    openExternalUrl: vi.fn(),
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

describe("AnnouncementBar Component", () => {
    beforeEach(() => {
        localStorage.clear();
        vi.clearAllMocks();
    });

    afterEach(() => {
        while (mounted.length) {
            const root = mounted.pop()!;
            act(() => root.unmount());
        }
        document.body.innerHTML = "";
    });

    const mockAnnouncement: Announcement = {
        id: "anno-test",
        severity: "info",
        title: "Test Notice",
        body: "Announcement **bold** text and https://example.com/learn",
        link: "https://example.com/details",
        linkLabel: "Details",
        publishedAt: "2026-10-08T00:00:00Z",
    };

    it("renders nothing when announcement is null", () => {
        const container = render(<AnnouncementBar announcement={null} />);
        expect(container.querySelector("aside")).toBeNull();
    });

    it("renders announcement title, body, bold text, and link", () => {
        const container = render(<AnnouncementBar announcement={mockAnnouncement} />);

        expect(container.textContent).toContain("Test Notice");
        expect(container.textContent).toContain("bold");
        expect(container.textContent).toContain("Details →");

        const link = container.querySelector('a[href="https://example.com/learn"]');
        expect(link).not.toBeNull();
        expect(link?.getAttribute("target")).toBe("_blank");
        expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
    });

    it("dismisses announcement when close button is clicked", () => {
        const onDismiss = vi.fn();
        const container = render(
            <AnnouncementBar announcement={mockAnnouncement} onDismiss={onDismiss} />
        );

        const dismissBtn = container.querySelector('button[aria-label="Dismiss announcement"]');
        expect(dismissBtn).not.toBeNull();

        act(() => {
            dismissBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });

        expect(onDismiss).toHaveBeenCalledWith("anno-test");
        expect(container.querySelector("aside")).toBeNull();
    });

    it("applies critical severity styles", () => {
        const criticalAnno: Announcement = {
            ...mockAnnouncement,
            id: "critical-1",
            severity: "critical",
        };

        const container = render(<AnnouncementBar announcement={criticalAnno} />);
        const aside = container.querySelector("aside");
        expect(aside?.className).toContain("var(--color-error)");
    });

    describe("AnnouncementBody", () => {
        it("renders empty body cleanly", () => {
            const container = render(<AnnouncementBody body="" />);
            expect(container.textContent).toBe("");
        });

        it("renders bold segments and plain text segments", () => {
            const container = render(<AnnouncementBody body="Hello **World** from Theorem" />);
            const strong = container.querySelector("strong");
            expect(strong?.textContent).toBe("World");
            expect(container.textContent).toBe("Hello World from Theorem");
        });
    });
});
