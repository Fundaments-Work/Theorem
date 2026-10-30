// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LibraryPage } from "../src/features/library/Library";
import { useLibraryStore } from "../src/core/store";
import type { Book } from "../src/core/types";

vi.mock("../src/core/lib/env", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../src/core/lib/env")>();
    return {
        ...actual,
        isTauri: () => false,
        isTauriMobile: () => false,
        useAndroidBackButton: () => {},
    };
});

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

const sampleBook: Book = {
    id: "book-test-1",
    title: "Meditations",
    author: "Marcus Aurelius",
    coverPath: "",
    filePath: "/books/meditations.epub",
    fileSize: 1024,
    format: "epub",
    dateAdded: new Date().toISOString(),
    progress: 0.5,
    tags: [],
};

describe("Library Filter & Sort Button", () => {
    it("renders as a square icon button matching View and toggles filter panel", () => {
        useLibraryStore.setState({
            books: [sampleBook],
            collections: [],
        });

        act(() => {
            root.render(<LibraryPage />);
        });

        const filterBtn = host.querySelector('button[aria-label="Filter and sort"]') as HTMLButtonElement;
        expect(filterBtn).not.toBeNull();
        expect(filterBtn.getAttribute("aria-expanded")).toBe("false");
        expect(filterBtn.getAttribute("title")).toBe("Filter and sort");

        // Add button is compact and does not stretch across full width
        const addBtn = host.querySelector("button.ui-btn-primary");
        expect(addBtn).not.toBeNull();
        expect(addBtn?.className).not.toContain("flex-1");

        // Uses standard square toolbar button styling matching View
        expect(filterBtn.className).toContain("h-11");
        expect(filterBtn.className).toContain("w-11");
        expect(filterBtn.className).toContain("sm:h-10");
        expect(filterBtn.className).toContain("sm:w-10");

        // Toggle open
        act(() => {
            filterBtn.click();
        });
        expect(filterBtn.getAttribute("aria-expanded")).toBe("true");

        // Filter panel content is visible
        expect(host.textContent).toContain("Sort by");
        expect(host.textContent).toContain("Show");
        expect(host.textContent).toContain("Unread");

        // Click Unread to activate a filter
        const unreadBtn = Array.from(host.querySelectorAll("button")).find(
            (b) => b.textContent?.trim() === "Unread"
        );
        expect(unreadBtn).toBeDefined();
        act(() => {
            unreadBtn?.click();
        });

        // Close dropdown
        act(() => {
            filterBtn.click();
        });
        expect(filterBtn.getAttribute("aria-expanded")).toBe("false");

        // Filter button now has active title and indicator dot
        expect(filterBtn.getAttribute("title")).toBe("Filter and sort (active filters applied)");
        expect(filterBtn.querySelector("span.bg-\\[color\\:var\\(--color-accent\\)\\]")).not.toBeNull();
    });
});
