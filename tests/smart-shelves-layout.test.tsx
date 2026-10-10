import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ShelvesPage } from "../src/features/library/Shelves";
import { useLibraryStore, useUIStore } from "../src/core/store";
import type { Collection } from "../src/core/types";

vi.mock("../src/core/lib/useSmartShelves", () => ({
    useSmartShelves: (_books: unknown, collections: Collection[]) => ({ collections, ready: true }),
}));
vi.mock("../src/features/library/components/modals/ShelfModal", () => ({
    ShelfModal: ({ isOpen, shelf }: { isOpen: boolean; shelf?: Collection }) =>
        isOpen ? <div role="dialog"><output>{JSON.stringify(shelf?.smartRules)}</output></div> : null,
}));

let root: Root;
let host: HTMLDivElement;
const shelf: Collection = {
    id: "smart-empty", name: "Unread fiction", kind: "general", bookIds: [], createdAt: new Date(),
    smartRules: { mode: "all", conditions: [{ field: "status", operator: "equals", value: "unread" }] },
};
beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    sessionStorage.clear();
    useUIStore.setState({ searchQuery: "" });
    useLibraryStore.setState({ books: [], collections: [shelf] });
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    act(() => root.render(<ShelvesPage />));
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe("smart shelves with the upstream shelves layout", () => {
    it("keeps the header and back control when no books match and prevents manual membership", () => {
        const open = host.querySelector<HTMLButtonElement>("button.block.w-full");
        expect(open).not.toBeNull();
        act(() => open!.click());
        expect(host.querySelector("h1")?.textContent).toBe(shelf.name);
        expect(host.querySelector('button[aria-label="Back to shelves"]')).not.toBeNull();
        expect(host.textContent).toContain("No books match this smart shelf.");
        expect(host.textContent).not.toContain("Go to Library");
        expect(host.querySelector<HTMLButtonElement>('button[title="Membership is managed by this shelf\'s rules"]')?.disabled).toBe(true);
    });

    it("preserves the full rule definition when editing from the updated shelf-card menu", () => {
        const menu = host.querySelector<HTMLButtonElement>('button[aria-label="Actions for Unread fiction"]');
        expect(menu).not.toBeNull();
        act(() => menu!.click());
        const edit = Array.from(host.querySelectorAll("button")).find((button) => button.textContent?.trim() === "Edit");
        expect(edit).toBeDefined();
        act(() => edit!.click());
        const output = host.querySelector('[role="dialog"] output');
        expect(output).not.toBeNull();
        expect(JSON.parse(output!.textContent!)).toEqual(shelf.smartRules);
    });
});
