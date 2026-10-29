// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import React, { act } from "react";
import { render, unmountAll } from "./helpers/opds-browser-harness";
import { DailyReviewModal } from "../src/features/library/components/DailyReviewModal";
import { useLibraryStore } from "../src/core/store";
import type { Annotation } from "../src/core/types";

describe("DailyReviewModal", () => {
    afterEach(() => {
        unmountAll();
        useLibraryStore.setState({ annotations: [] });
    });

    it("does not render dialog when isOpen is false", () => {
        render(
            <DailyReviewModal
                isOpen={false}
                onClose={vi.fn()}
                onGoToSource={vi.fn()}
            />
        );

        const dialog = document.body.querySelector('[role="dialog"]');
        expect(dialog).toBeNull();
    });

    it("renders Radix Modal dialog with header when isOpen is true", () => {
        const mockAnnotation: Annotation = {
            id: "anno-1",
            bookId: "book-1",
            type: "highlight",
            location: "loc-1",
            selectedText: "A profound thought worthy of daily review.",
            createdAt: new Date(),
        };

        useLibraryStore.setState({ annotations: [mockAnnotation] });

        render(
            <DailyReviewModal
                isOpen={true}
                onClose={vi.fn()}
                onGoToSource={vi.fn()}
            />
        );

        const dialog = document.body.querySelector('[role="dialog"]');
        expect(dialog).not.toBeNull();
        expect(dialog?.textContent).toContain("Daily Review");
        expect(dialog?.textContent).toContain("A profound thought worthy of daily review.");
    });
});
