// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LibraryFoldersSection } from "../src/features/settings/LibraryFoldersSection";
import { useLibraryStore } from "../src/core/store";
import type { Book } from "../src/core/types";

vi.mock("../src/core/lib/env", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../src/core/lib/env")>();
    return {
        ...actual,
        isTauri: () => true,
        isMobile: () => false,
    };
});

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    useLibraryStore.setState({ books: [] });
});

afterEach(() => {
    act(() => root.unmount());
    host.remove();
    useLibraryStore.setState({ books: [] });
});

describe("LibraryFoldersSection in Settings", () => {
    it("renders empty state when no folders are connected", () => {
        act(() => {
            root.render(<LibraryFoldersSection />);
        });
        expect(host.textContent).toContain("Add Library Folder…");
    });

    it("renders connected folders with book count and actions", () => {
        const fakeBook: Book = {
            id: "b1",
            title: "Test Book",
            author: "Author",
            sourceFolders: [
                {
                    root: "/home/sapiens/Documents/epub/pdf-epub",
                    name: "pdf-epub",
                    relativePath: "book.epub",
                },
            ],
            fileSize: 1024,
            progress: 0,
            dateAdded: "2026-01-01",
            metadataUpdatedAt: "2026-01-01",
        };

        act(() => {
            useLibraryStore.setState({ books: [fakeBook] });
            root.render(<LibraryFoldersSection />);
        });

        // Folder name and book count
        expect(host.textContent).toContain("pdf-epub");
        expect(host.textContent).toContain("1 book");
        expect(host.textContent).toContain("/home/sapiens/Documents/epub/pdf-epub");

        // Action buttons exist
        const rescanBtn = host.querySelector<HTMLButtonElement>('button[aria-label="Rescan pdf-epub"]');
        expect(rescanBtn).toBeTruthy();

        const removeBtn = host.querySelector<HTMLButtonElement>('button[aria-label="Remove pdf-epub folder"]');
        expect(removeBtn).toBeTruthy();

        // Clicking Remove opens the modal (portaled to document.body)
        act(() => {
            removeBtn?.click();
        });

        expect(document.body.textContent).toContain('Remove “pdf-epub” from your library?');
        expect(document.body.textContent).toContain("Also remove 1 book from Theorem library");
    });
});
