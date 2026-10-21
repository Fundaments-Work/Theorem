import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BottomNav, isNavItemActive } from "../src/shell/layout/BottomNav";
import { WorkbenchTabs } from "../src/features/library/components/WorkbenchTabs";
import { useUIStore } from "../src/core/store";
import "./test-utils/render-hook";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useUIStore.setState({ currentRoute: "library", workbenchFilterRequest: undefined });
});
afterEach(() => {
    act(() => root.unmount());
    container.remove();
});

const labels = () => Array.from(container.querySelectorAll("nav button")).map((b) => b.textContent?.trim());

describe("phone bottom navigation", () => {
    it("offers exactly Library, Shelves, Discover, Workbench, Feeds", () => {
        act(() => root.render(<BottomNav />));
        expect(labels()).toEqual(["Library", "Shelves", "Discover", "Workbench", "Feeds"]);
    });

    it("every destination a phone user needs is reachable: Discover directly, Bookmarks via Workbench", () => {
        act(() => root.render(<BottomNav />));
        const discover = Array.from(container.querySelectorAll("nav button")).find((b) => b.textContent?.includes("Discover"))!;
        act(() => (discover as HTMLButtonElement).click());
        expect(useUIStore.getState().currentRoute).toBe("opds");
    });

    it("the Workbench tab stays lit on its sibling pages", () => {
        const item = { id: "annotations" as const, label: "Workbench", icon: null, alsoActiveOn: ["bookmarks", "vocabulary"] as const };
        expect(isNavItemActive(item, "annotations")).toBe(true);
        expect(isNavItemActive(item, "bookmarks")).toBe(true);
        expect(isNavItemActive(item, "vocabulary")).toBe(true);
        expect(isNavItemActive(item, "library")).toBe(false);
        expect(isNavItemActive(item, "settings")).toBe(false);
    });

    it("marks the current route and only that one with aria-current", () => {
        useUIStore.setState({ currentRoute: "bookmarks" });
        act(() => root.render(<BottomNav />));
        const current = Array.from(container.querySelectorAll("[aria-current=page]")).map((b) => b.textContent?.trim());
        expect(current).toEqual(["Workbench"]);
    });
});

describe("Workbench tabs (the shared row that keeps Bookmarks reachable)", () => {
    it("lists all five sections and marks the active one", () => {
        act(() => root.render(<WorkbenchTabs active="bookmarks" onSelect={() => {}} />));
        const tabs = Array.from(container.querySelectorAll("[role=tab]"));
        expect(tabs.map((t) => t.textContent)).toEqual(["All", "Highlights", "Notes", "Words", "Bookmarks"]);
        expect(tabs.filter((t) => t.getAttribute("aria-selected") === "true").map((t) => t.textContent)).toEqual(["Bookmarks"]);
    });

    it("keeps every tab nameable for assistive tech even when a phone shows only the active label", () => {
        act(() => root.render(<WorkbenchTabs active="notes" onSelect={() => {}} />));
        const tabs = Array.from(container.querySelectorAll<HTMLElement>("[role=tab]"));
        expect(tabs.map((t) => t.getAttribute("aria-label"))).toEqual(["All", "Highlights", "Notes", "Words", "Bookmarks"]);
        // Inactive tabs hide their text below `sm` (icon only); the active one never does.
        const hiddenBelowSm = tabs.filter((t) => t.querySelector("span")?.className.includes("hidden"));
        expect(hiddenBelowSm.map((t) => t.getAttribute("aria-label"))).toEqual(["All", "Highlights", "Words", "Bookmarks"]);
    });

    it("reports the chosen tab", () => {
        const chosen: string[] = [];
        act(() => root.render(<WorkbenchTabs active="all" onSelect={(t) => chosen.push(t)} />));
        const byName = (n: string) => Array.from(container.querySelectorAll("[role=tab]")).find((t) => t.textContent === n) as HTMLButtonElement;
        act(() => byName("Bookmarks").click());
        act(() => byName("Words").click());
        expect(chosen).toEqual(["bookmarks", "vocabulary"]);
    });

    it("a Workbench filter request is one-shot state in the UI store", () => {
        useUIStore.getState().requestWorkbenchFilter("notes");
        expect(useUIStore.getState().workbenchFilterRequest).toBe("notes");
        useUIStore.getState().requestWorkbenchFilter(undefined);
        expect(useUIStore.getState().workbenchFilterRequest).toBeUndefined();
    });
});
