import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BookCard } from "../src/features/library/Library";
import type { Book } from "../src/core/types";

describe("BookCard list view (#159)", () => {
    let root: Root | null = null;
    let host: HTMLDivElement | null = null;

    beforeEach(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        host = document.createElement("div");
        document.body.append(host);
        root = createRoot(host);
    });

    afterEach(() => {
        if (root && host) {
            act(() => root?.unmount());
            host?.remove();
        }
        root = null;
        host = null;
        document.body.className = "";
        document.querySelectorAll('[role="dialog"], [data-portal], .fixed').forEach((el) => el.remove());
    });

        const sampleBook: Book = {
            id: "book-159",
            title: "Children of Dune",
            author: "Frank Herbert",
            filePath: "/books/children-of-dune.epub",
            format: "epub",
            progress: 0.65,
            fileSize: 2.5 * 1024 * 1024,
            series: "Dune",
            seriesIndex: 3,
            addedAt: new Date(Date.now() - 86400000 * 10).toISOString(),
            lastReadAt: new Date(Date.now() - 3600000 * 2).toISOString(),
            isFavorite: true,
        };

        it("renders format badge, series info, progress bar, and relative dates in list view", () => {
            act(() => {
                root?.render(
                    <BookCard
                        book={sampleBook}
                        viewMode="list"
                        onOpenBook={vi.fn()}
                        onToggleFavorite={vi.fn()}
                        onDeleteBook={vi.fn()}
                        onShowInfo={vi.fn()}
                        onAddToShelf={vi.fn()}
                        onRename={vi.fn()}
                        onExport={vi.fn()}
                        onMarkAsRead={vi.fn()}
                        onMarkAsUnread={vi.fn()}
                    />,
                );
            });

            const content = host?.textContent ?? "";

            // Title & Author
            expect(content).toContain("Children of Dune");
            expect(content).toContain("Frank Herbert");

            // Series & Index
            expect(content).toContain("Dune #3");

            // Format badge (rendered in both mobile pill and tablet/desktop column)
            expect(content).toContain("epub");

            // Progress percentage & Progress bar element
            expect(content).toContain("65%");
            const progressBar = host?.querySelector(".bg-\\[var\\(--color-accent\\)\\]");
            expect(progressBar).not.toBeNull();
            expect((progressBar as HTMLElement)?.style.width).toBe("65%");

            // Relative date: 2 hours ago -> '2h ago'
            expect(content).toContain("2h ago");
        });
});
