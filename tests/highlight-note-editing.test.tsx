// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HighlightColorPicker } from "../src/features/reader/components/highlights/HighlightColorPicker";
import { NoteEditor } from "../src/features/reader/components/highlights/NoteEditor";

describe("highlight note editing", () => {
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

        it("does not call onClose when clicking 'Add Note' so selection context is retained", () => {
            const onClose = vi.fn();
            const onAddNote = vi.fn();
            const onSelectColor = vi.fn();

            act(() => {
                root?.render(
                    <HighlightColorPicker
                        isOpen={true}
                        position={{ x: 100, y: 100 }}
                        currentColor="yellow"
                        onSelectColor={onSelectColor}
                        onClose={onClose}
                        onAddNote={onAddNote}
                        onBookmark={() => {}}
                    />,
                );
            });

            const addNoteBtn = Array.from(document.body.querySelectorAll("button")).find(
                (btn) => btn.textContent?.includes("Add Note"),
            );
            expect(addNoteBtn).toBeDefined();

            act(() => {
                addNoteBtn?.click();
            });

            expect(onAddNote).toHaveBeenCalledTimes(1);
            expect(onClose).not.toHaveBeenCalled();
        });

        it("allows saving notes in NoteEditor and does not close on internal textarea scrolling", () => {
            const onSave = vi.fn();
            const onClose = vi.fn();

            act(() => {
                root?.render(
                    <NoteEditor
                        isOpen={true}
                        position={{ x: 100, y: 100 }}
                        initialNote="Initial text"
                        selectedText="Selected text excerpt"
                        onSave={onSave}
                        onClose={onClose}
                    />,
                );
            });

            const textarea = document.body.querySelector("textarea");
            expect(textarea).not.toBeNull();
            expect(textarea?.value).toBe("Initial text");

            // Change note content
            act(() => {
                if (textarea) {
                    const nativeSetter = Object.getOwnPropertyDescriptor(
                        window.HTMLTextAreaElement.prototype,
                        "value",
                    )?.set;
                    nativeSetter?.call(textarea, "Updated note text");
                    textarea.dispatchEvent(new Event("input", { bubbles: true }));
                }
            });

            // Dispatch scroll event inside the note editor
            act(() => {
                textarea?.dispatchEvent(new Event("scroll", { bubbles: true }));
            });
            expect(onClose).not.toHaveBeenCalled();

            // Click save button
            const saveBtn = Array.from(document.body.querySelectorAll("button")).find(
                (btn) => btn.textContent?.includes("Save"),
            );
            expect(saveBtn).toBeDefined();

            act(() => {
                saveBtn?.click();
            });

            expect(onSave).toHaveBeenCalledWith("Updated note text");
        });
});
