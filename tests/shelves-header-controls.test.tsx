// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { ShelvesPage } from "../src/features/library/Shelves";
import { useLibraryStore, useUIStore } from "../src/core/store";

// @ts-expect-error React 19 act environment flag
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

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

describe("Shelves Header and Controls Integration", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        useUIStore.setState({ searchQuery: "" });
        useLibraryStore.setState({
            collections: [],
            books: [],
        });
    });

    afterEach(() => {
        while (mounted.length) {
            const root = mounted.pop()!;
            act(() => root.unmount());
        }
        document.body.innerHTML = "";
    });

    it("renders page title, description, and New Shelf button even when shelves are empty", () => {
        const container = render(<ShelvesPage />);

        // Page title
        const titleEl = container.querySelector("h1");
        expect(titleEl).not.toBeNull();
        expect(titleEl?.textContent?.trim()).toBe("Shelves");

        // Description count
        expect(container.textContent).toContain("0 shelves • 0 books");

        // Action button
        const newShelfBtn = Array.from(container.querySelectorAll("button")).find(
            (btn) => btn.textContent?.includes("New Shelf")
        );
        expect(newShelfBtn).toBeDefined();

        // Empty state in body
        expect(container.textContent).toContain("No Shelves Yet");
        expect(container.textContent).toContain("Create shelves to organize your books your way.");
    });

    it("renders full header, back button, title, and controls when viewing an empty shelf", () => {
        // Setup an empty shelf in store
        const testShelf = {
            id: "shelf-empty-1",
            name: "Favorites Fiction",
            description: "My fiction books",
            bookIds: [],
            kind: "general" as const,
            createdAt: new Date(),
        };

        useLibraryStore.setState({
            collections: [testShelf],
            books: [],
        });

        const container = render(<ShelvesPage />);

        // Click the shelf card to enter ShelfDetail
        const shelfCardBtn = container.querySelector("button.block.w-full");
        expect(shelfCardBtn).not.toBeNull();

        act(() => {
            shelfCardBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });

        // ShelfDetail Header must be present:
        // 1. Back button
        const backBtn = container.querySelector('button[aria-label="Back to shelves"]');
        expect(backBtn).not.toBeNull();

        // 2. Shelf title in header
        const shelfTitle = container.querySelector("h1");
        expect(shelfTitle?.textContent?.trim()).toBe("Favorites Fiction");

        // 3. Book count in header
        expect(container.textContent).toContain("0 books");

        // 4. Header action buttons
        const addBooksBtn = container.querySelector('button[title="Add books from library"]');
        expect(addBooksBtn).not.toBeNull();

        const groupBySeriesBtn = container.querySelector('button[title="Group by Series"]');
        expect(groupBySeriesBtn).not.toBeNull();

        const manageSeriesBtn = container.querySelector('button[title="Create / Manage Series from Shelf"]');
        expect(manageSeriesBtn).not.toBeNull();

        const selectModeBtn = container.querySelector('button[data-action="toggle-select-mode"]');
        expect(selectModeBtn).not.toBeNull();

        const viewModeBtn = Array.from(container.querySelectorAll("button")).find(
            (b) => b.getAttribute("title")?.startsWith("View:")
        );
        expect(viewModeBtn).toBeDefined();

        // 5. Body empty state
        expect(container.textContent).toContain('"Favorites Fiction" is Empty');
        expect(container.textContent).toContain("Go to Library");

        // 6. Clicking back button returns back to ShelvesPage
        act(() => {
            backBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });

        const mainTitle = container.querySelector("h1");
        expect(mainTitle?.textContent?.trim()).toBe("Shelves");
        expect(container.textContent).toContain("1 shelf • 0 books");
    });
});
