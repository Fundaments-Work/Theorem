// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ShelvesPage } from "../src/features/library/Shelves";
import { SELECT_ALL_EVENT } from "../src/core/lib/keyboard-shortcuts";
import { useLibraryStore, useUIStore } from "../src/core/store";
import type { Book } from "../src/core/types";

// @ts-expect-error React 19 act environment flag
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const book = (id: string): Book => ({ id, title: id, author: "Author", filePath: id, format: "epub",
    fileSize: 1, addedAt: new Date(), progress: 0, readingTime: 0, tags: [], isFavorite: false });

let host: HTMLDivElement;
let root: Root;

function openShelf(bookIds: string[]) {
    useLibraryStore.setState({
        books: bookIds.map(book),
        collections: [{ id: "s1", name: "Shelf", description: "", bookIds, kind: "general" as const, createdAt: new Date() }],
    });
    act(() => root.render(<ShelvesPage />));
    const card = host.querySelector("button.block.w-full");
    act(() => { card?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
}
const fire = () => act(() => { window.dispatchEvent(new Event(SELECT_ALL_EVENT)); });

describe("Ctrl/Cmd+A select all", () => {
    beforeEach(() => {
        useUIStore.setState({ currentRoute: "shelves", searchQuery: "" });
        useUIStore.getState().clearSelection();
        host = document.createElement("div");
        document.body.append(host);
        root = createRoot(host);
    });
    afterEach(() => { act(() => root.unmount()); host.remove(); });

    it("enters selection mode and selects every book on the shelf", () => {
        openShelf(["a", "b", "c"]);
        fire();
        expect([...useUIStore.getState().selectedBooks].sort()).toEqual(["a", "b", "c"]);
        expect(host.querySelector('button[data-action="toggle-select-mode"]')?.getAttribute("title")).toBe("Cancel Selection");
    });

    it("is idempotent when everything is already selected", () => {
        openShelf(["a", "b"]);
        fire(); fire();
        expect(useUIStore.getState().selectedBooks).toHaveLength(2);
    });

    it("does nothing on an empty shelf", () => {
        openShelf([]);
        fire();
        expect(useUIStore.getState().selectedBooks).toEqual([]);
        expect(host.querySelector('button[data-action="toggle-select-mode"]')?.getAttribute("title")).toBe("Select Books");
    });

    it("ignores the shortcut when another page is visible", () => {
        openShelf(["a", "b"]);
        useUIStore.setState({ currentRoute: "feeds" });
        fire();
        expect(useUIStore.getState().selectedBooks).toEqual([]);
    });

    it("stops listening after unmount", () => {
        openShelf(["a"]);
        act(() => root.unmount());
        root = createRoot(host);
        useUIStore.getState().clearSelection();
        fire();
        expect(useUIStore.getState().selectedBooks).toEqual([]);
    });
});
