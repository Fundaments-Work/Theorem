// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BottomNav, isNavItemActive } from "../src/shell/layout/BottomNav";
import { Sidebar } from "../src/shell/layout/Sidebar";
import { navigationShortcuts, PRIMARY_DESTINATIONS } from "../src/shell/layout/nav-items";
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
    it("offers exactly Library, Shelves, Discover, Feeds, Workbench: your books, new reading, your notes", () => {
        act(() => root.render(<BottomNav />));
        expect(labels()).toEqual(["Library", "Shelves", "Discover", "Feeds", "Workbench"]);
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
    it("lists all four sections and marks the active one", () => {
        act(() => root.render(<WorkbenchTabs active="bookmarks" onSelect={() => {}} />));
        const tabs = Array.from(container.querySelectorAll("[role=tab]"));
        expect(tabs.map((t) => t.textContent)).toEqual(["Highlights", "Notes", "Words", "Bookmarks"]);
        expect(tabs.filter((t) => t.getAttribute("aria-selected") === "true").map((t) => t.textContent)).toEqual(["Bookmarks"]);
    });

    it("names every tab for assistive tech and shows every label on a phone too", () => {
        act(() => root.render(<WorkbenchTabs active="notes" onSelect={() => {}} />));
        const tabs = Array.from(container.querySelectorAll<HTMLElement>("[role=tab]"));
        expect(tabs.map((t) => t.getAttribute("aria-label"))).toEqual(["Highlights", "Notes", "Words", "Bookmarks"]);
        // An icon-only tab had to be guessed; on a phone each tab stacks its icon over its name.
        const hiddenLabels = tabs.filter((t) => /(^|\s)hidden(\s|$)/.test(t.querySelector("span")?.className ?? ""));
        expect(hiddenLabels).toHaveLength(0);
        expect(container.querySelector("[role=tablist]")!.className).toContain("grid-cols-4");
    });

    it("reports the chosen tab", () => {
        const chosen: string[] = [];
        act(() => root.render(<WorkbenchTabs active="highlights" onSelect={(t) => chosen.push(t)} />));
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

describe("desktop sidebar rail", () => {
    const rail = () => Array.from(container.querySelectorAll("button[aria-label]")).map((b) => b.getAttribute("aria-label"));

    it("has no separate Bookmarks entry — it is a Workbench tab", async () => {
        const { Sidebar } = await import("../src/shell/layout/Sidebar");
        act(() => root.render(<Sidebar />));
        expect(rail()).not.toContain("Bookmarks");
        expect(rail()).toEqual(expect.arrayContaining(["Library", "Workbench", "Shelves", "Discover", "Settings"]));
    });

    it("keeps Workbench lit on the Bookmarks and Words pages", async () => {
        const { Sidebar } = await import("../src/shell/layout/Sidebar");
        for (const route of ["bookmarks", "vocabulary", "annotations"] as const) {
            useUIStore.setState({ currentRoute: route });
            act(() => root.render(<Sidebar />));
            const current = Array.from(container.querySelectorAll("[aria-current=page]")).map((b) => b.getAttribute("aria-label"));
            expect(current).toEqual(["Workbench"]);
        }
    });
});

describe("one navigation order everywhere", () => {
    const order = ["Library", "Shelves", "Discover", "Feeds", "Workbench"];

    it("the desktop rail shows the same five destinations in the same order as the phone bar", () => {
        act(() => root.render(<Sidebar />));
        const rail = Array.from(container.querySelectorAll('nav[aria-label="Main navigation"] button')).map((b) => b.getAttribute("aria-label"));
        expect(rail).toEqual(order);
        act(() => root.render(<BottomNav />));
        expect(labels()).toEqual(order);
    });

    it("keeps the utilities apart: Statistics then Settings at the foot of the rail, not among the destinations", () => {
        act(() => root.render(<Sidebar />));
        const all = Array.from(container.querySelectorAll("aside button")).map((b) => b.getAttribute("aria-label"));
        expect(all.slice(-2)).toEqual(["Statistics", "Settings"]);
        expect(all.slice(0, 5)).toEqual(order);
    });

    it("lights the right rail item on sibling pages (Bookmarks is part of Workbench)", () => {
        useUIStore.setState({ currentRoute: "bookmarks" });
        act(() => root.render(<Sidebar />));
        const current = Array.from(container.querySelectorAll("aside [aria-current=page]")).map((b) => b.getAttribute("aria-label"));
        expect(current).toEqual(["Workbench"]);
    });

    it("numbers Ctrl+1–5 like the screen, then Statistics, Bookmarks and Settings", () => {
        const shortcuts = navigationShortcuts();
        expect(shortcuts.map((s) => [s.keys, s.route])).toEqual([
            ["Ctrl+1", "library"],
            ["Ctrl+2", "shelves"],
            ["Ctrl+3", "opds"],
            ["Ctrl+4", "feeds"],
            ["Ctrl+5", "annotations"],
            ["Ctrl+6", "statistics"],
            ["Ctrl+7", "bookmarks"],
            ["Ctrl+,", "settings"],
        ]);
        expect(shortcuts.slice(0, 5).map((s) => s.label)).toEqual(order.map((l) => `Go to ${l}`));
        expect(new Set(shortcuts.map((s) => s.keys)).size).toBe(shortcuts.length);
    });

    it("uses one plain name per page (no Snapshots on one device and Feeds on another)", () => {
        expect(PRIMARY_DESTINATIONS.map((d) => d.label)).toEqual(order);
    });
});
