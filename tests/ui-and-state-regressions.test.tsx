// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Modal, ModalBody } from "../src/ui/Modal";
import { useImportStore, useSettingsStore, useUIStore } from "../src/core/store";
import ImportProgressPanel from "../src/features/library/components/ImportProgressPanel";
import { ShareCard } from "../src/features/share/ShareCard";
import { localDateKey } from "../src/core/lib/date-keys";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
});

afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = "";
});

describe("Modal showCloseButton", () => {
    it("renders an accessible close button when showCloseButton is set without ModalHeader", async () => {
        const onClose = vi.fn();
        act(() => {
            root.render(
                <Modal isOpen={true} onClose={onClose} showCloseButton={true} ariaLabel="Custom dialog">
                    <ModalBody>Body content</ModalBody>
                </Modal>,
            );
        });
        await act(async () => {
            await Promise.resolve();
        });
        const closeBtn = document.body.querySelector<HTMLButtonElement>('[role="dialog"] button[aria-label="Close"]');
        expect(closeBtn).not.toBeNull();
        act(() => closeBtn!.click());
        expect(onClose).toHaveBeenCalledOnce();
    });
});

describe("uiStore selection scope across routes", () => {
    it("clears selectedBooks when switching between different routes", () => {
        useUIStore.setState({ currentRoute: "library", selectedBooks: ["b1", "b2"] });
        useUIStore.getState().setRoute("shelves", undefined, false);
        expect(useUIStore.getState().selectedBooks).toEqual([]);
    });
});

describe("importStore dismissal persistence", () => {
    it("keeps a dismissed finished job hidden across ImportProgressPanel remounts and clears on a new active job", () => {
        const errSnapshot = {
            id: "job-1",
            active: false,
            resumable: false,
            total: 1,
            completed: 1,
            imported: 0,
            duplicates: 0,
            errors: [{ source: "bad.epub", message: "corrupt" }],
            current: { name: "", stage: null, completedBytes: 0, totalBytes: null },
        };
        useImportStore.setState({ snapshot: errSnapshot, error: null, dismissedJobId: null });
        act(() => root.render(<ImportProgressPanel />));
        const dismissBtn = [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Dismiss");
        expect(dismissBtn).toBeDefined();
        act(() => dismissBtn!.click());
        expect(host.textContent).toBe("");

        // Unmount and remount panel (e.g. entering and exiting Reader or Shelves).
        act(() => root.unmount());
        root = createRoot(host);
        act(() => root.render(<ImportProgressPanel />));
        expect(host.textContent).toBe("");

        // A new active snapshot for the same or new job clears dismissal.
        act(() => {
            useImportStore.getState().setSnapshot({ ...errSnapshot, id: "job-2", active: true });
        });
        act(() => root.render(<ImportProgressPanel />));
        expect(host.textContent).toContain("1 import error");
    });
});

describe("settingsStore resetSettings", () => {
    it("re-applies default theme CSS classes and contrast tokens on resetSettings", () => {
        useSettingsStore.getState().updateSettings({ theme: "light", accentColor: "#2d6a6e" });
        expect(document.body.classList.contains("theme-light")).toBe(true);
        useSettingsStore.getState().resetSettings();
        expect(useSettingsStore.getState().settings.theme).toBe("dark");
        expect(document.body.classList.contains("theme-dark")).toBe(true);
    });
});

describe("ShareCard local date heatmap", () => {
    it("renders dailyActivity minutes keyed by localDateKey rather than UTC", () => {
        const todayKey = localDateKey(new Date());
        act(() => {
            root.render(
                <ShareCard
                    kind="stats"
                    format="square"
                    theme="dark"
                    showNote={false}
                    statsData={{
                        totalBooks: 5,
                        completedBooks: 2,
                        totalReadingTime: 120,
                        currentStreak: 3,
                        longestStreak: 4,
                        booksReadThisYear: 2,
                        yearlyBookGoal: 12,
                        totalHighlights: 10,
                        dailyActivity: [{ date: todayKey, minutes: 45 }],
                    }}
                />,
            );
        });
        expect(host.textContent).toContain("Streak3d");
        expect(host.textContent).toContain("2h");
        const todayCell = host.querySelector(`[data-date="${todayKey}"]`);
        expect(todayCell?.getAttribute("data-level")).toBe("3");
    });
});
