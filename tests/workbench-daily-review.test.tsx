// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { render, unmountAll } from "./helpers/opds-browser-harness";
import { AnnotationsPage } from "../src/features/library/Annotations";
import { useLibraryStore, useUIStore } from "../src/core/store";
import type { Annotation, Book } from "../src/core/types";

describe("Workbench in-page Daily Review & Card View", () => {
    beforeEach(() => {
        window.localStorage.clear();
        window.sessionStorage.clear();
        useUIStore.setState({ currentRoute: "annotations", searchQuery: "" });
    });

    afterEach(() => {
        unmountAll();
        useLibraryStore.setState({ annotations: [], books: [] });
    });

    const mockBook: Book = {
        id: "book-1",
        title: "Letters from a Stoic",
        author: "Seneca",
        format: "epub",
        filePath: "/books/seneca.epub",
        fileSize: 1000,
        createdAt: new Date(),
        updatedAt: new Date(),
    };

    const mockAnnotations: Annotation[] = [
        {
            id: "anno-1",
            bookId: "book-1",
            type: "highlight",
            location: "loc-1",
            selectedText: "True happiness is to enjoy the present.",
            createdAt: new Date("2026-10-28"),
        },
        {
            id: "anno-2",
            bookId: "book-1",
            type: "highlight",
            location: "loc-2",
            selectedText: "We suffer more often in imagination than in reality.",
            createdAt: new Date("2026-10-27"),
        },
    ];

    it("displays in-page Daily Review when unreviewed cards exist", () => {
        useLibraryStore.setState({
            books: [mockBook],
            annotations: mockAnnotations,
        });

        const root = render(<AnnotationsPage />);

        // Should render in-page Daily Review header and deck
        expect(root.textContent).toContain("Daily Review");
        expect(root.textContent).toContain("Skip to Workbench");
        expect(root.textContent).toContain("True happiness is to enjoy the present.");
        expect(root.textContent).toContain("Letters from a Stoic");
        expect(root.textContent).toContain("Seneca");
    });

    it("skips in-page Daily Review to Workbench when clicking Skip to Workbench", () => {
        useLibraryStore.setState({
            books: [mockBook],
            annotations: mockAnnotations,
        });

        const root = render(<AnnotationsPage />);
        expect(root.textContent).toContain("Skip to Workbench");

        const skipBtn = root.querySelector('button[aria-label="Skip daily review to workbench"]') as HTMLButtonElement;
        expect(skipBtn).toBeDefined();

        act(() => {
            skipBtn.click();
        });

        // Now session storage is set and standard Workbench page is shown
        expect(window.sessionStorage.getItem("theorem:daily-review-dismissed-session")).toBe("true");
        expect(root.textContent).toContain("Workbench");
        expect(root.textContent).not.toContain("Skip to Workbench");
    });

    it("renders inline Daily Review link in subtitle and opens daily review when clicked", () => {
        window.sessionStorage.setItem("theorem:daily-review-dismissed-session", "true");
        useLibraryStore.setState({
            books: [mockBook],
            annotations: mockAnnotations,
        });

        const root = render(<AnnotationsPage />);
        expect(root.textContent).toContain("Workbench");

        // Inline Daily Review link exists in subtitle
        const reviewBtn = root.querySelector('button[aria-label="Open Daily Review"]') as HTMLButtonElement;
        expect(reviewBtn).not.toBeNull();
        expect(reviewBtn.textContent).toContain("Daily Review (2)");

        act(() => {
            reviewBtn.click();
        });

        expect(root.textContent).toContain("Daily Review");
        expect(root.textContent).toContain("Skip to Workbench");
    });

    it("renders unified ReviewCardStack in Workbench card view mode", () => {
        window.sessionStorage.setItem("theorem:daily-review-dismissed-session", "true");
        useLibraryStore.setState({
            books: [mockBook],
            annotations: mockAnnotations,
        });

        const root = render(<AnnotationsPage />);

        // Switch to cards mode
        const cardViewBtn = root.querySelector('button[aria-label="Cards view"]') as HTMLButtonElement;
        expect(cardViewBtn).not.toBeNull();

        act(() => {
            cardViewBtn.click();
        });

        // Now renders ReviewCardStack with deck title
        expect(root.textContent).toContain("Deck 1 of 1: Letters from a Stoic");
        expect(root.textContent).toContain("Book Deck");
        expect(root.textContent).toContain("1 of 2");
        expect(root.textContent).toContain("True happiness is to enjoy the present.");

        // Switch back to list mode
        const listViewBtn = root.querySelector('button[aria-label="List view"]') as HTMLButtonElement;
        expect(listViewBtn).not.toBeNull();

        act(() => {
            listViewBtn.click();
        });

        // ReviewCardStack is replaced with list view
        expect(root.textContent).not.toContain("Deck 1 of 1");
    });

    it("renders sort dropdown with expected sorting options", () => {
        window.sessionStorage.setItem("theorem:daily-review-dismissed-session", "true");
        useLibraryStore.setState({
            books: [mockBook],
            annotations: mockAnnotations,
        });

        const root = render(<AnnotationsPage />);

        // The sort dropdown should be present in the workbench toolbar
        const sortButton = root.querySelector('button[aria-haspopup="menu"]') as HTMLButtonElement;
        expect(sortButton).not.toBeNull();
        expect(sortButton.textContent).toContain("Newest First");

        // Open dropdown options via pointerdown or Enter key
        act(() => {
            sortButton.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
        });

        expect(document.body.textContent).toContain("Newest First");
        expect(document.body.textContent).toContain("Oldest First");
        expect(document.body.textContent).toContain("By Book");
    });
});
