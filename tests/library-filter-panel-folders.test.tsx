import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LibraryFilterPanel } from "../src/features/library/LibraryFilterPanel";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
});

afterEach(() => {
    act(() => root.unmount());
    host.remove();
});

describe("LibraryFilterPanel folder section", () => {
    const fakeIndex = new Map([
        [
            "/home/sapiens/Documents/epub/pdf-epub",
            {
                name: "pdf-epub",
                folders: new Map([
                    ["", new Set(["book-1", "book-2"])],
                ]),
            },
        ],
    ]);

    it("renders clean display name, book count, and prevents overflow", () => {
        const onSelectSourceFolder = vi.fn();
        const onRemoveSourceFolder = vi.fn();

        act(() => {
            root.render(
                <LibraryFilterPanel
                    variant="popover"
                    sortBy="title"
                    sortOrder="asc"
                    statusFilter="all"
                    favoritesOnly={false}
                    unshelvedOnly={false}
                    onSortBy={vi.fn()}
                    onSortOrder={vi.fn()}
                    onStatusFilter={vi.fn()}
                    onFavoritesOnly={vi.fn()}
                    onUnshelvedOnly={vi.fn()}
                    sourceFolderIndex={fakeIndex}
                    selectedSourceFolder={null}
                    onSelectSourceFolder={onSelectSourceFolder}
                    onRemoveSourceFolder={onRemoveSourceFolder}
                />
            );
        });

        // "All library books" button is rendered
        const allButton = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("All library books"));
        expect(allButton).toBeTruthy();

        // The folder button renders "pdf-epub" and "2 books"
        const folderButton = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("pdf-epub"));
        expect(folderButton).toBeTruthy();
        expect(folderButton?.textContent).toContain("2 books");
        expect(folderButton?.getAttribute("title")).toBe("/home/sapiens/Documents/epub/pdf-epub");
        expect(folderButton?.className).toContain("overflow-hidden");

        // Clicking the folder calls onSelectSourceFolder
        act(() => {
            folderButton?.click();
        });
        expect(onSelectSourceFolder).toHaveBeenCalledWith({
            root: "/home/sapiens/Documents/epub/pdf-epub",
            path: "",
        });

        // The remove button exists and clicking it calls onRemoveSourceFolder
        const removeButton = host.querySelector<HTMLButtonElement>('button[aria-label="Remove pdf-epub folder"]');
        expect(removeButton).toBeTruthy();
        act(() => {
            removeButton?.click();
        });
        expect(onRemoveSourceFolder).toHaveBeenCalledWith("/home/sapiens/Documents/epub/pdf-epub");
    });
});
