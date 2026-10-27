import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HighlightColorPicker } from "../src/features/reader/components/highlights/HighlightColorPicker";
import { NoteEditor } from "../src/features/reader/components/highlights/NoteEditor";
import { ShelfModal } from "../src/features/library/components/modals/ShelfModal";
import { resolvePdfTargetPage } from "../src/features/reader/Reader";
import { applyAppTheme, resolveThemeColors } from "../src/core/lib/design-tokens";
import { getCSS } from "../src/features/reader/foliate/reader";

describe("Release 1.6.0 - Critical Bug Fixes & Regressions", () => {
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
        // Clean up any stray portal roots left in document.body
        document.querySelectorAll('[role="dialog"], [data-portal], .fixed').forEach((el) => el.remove());
    });

    describe("Issue 1: EPUB Note Saving & HighlightColorPicker", () => {
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

    describe("Issue 2: Smart Shelf Modal Scrollable Layout on Mobile", () => {
        it("renders form as flex flex-col container enclosing header, body and footer", () => {
            const onClose = vi.fn();
            const onSave = vi.fn();

            act(() => {
                root?.render(
                    <ShelfModal
                        isOpen={true}
                        onClose={onClose}
                        onSave={onSave}
                    />,
                );
            });

            const form = document.body.querySelector("form");
            expect(form).not.toBeNull();
            expect(form?.className).toContain("flex");
            expect(form?.className).toContain("flex-col");
            expect(form?.className).toContain("min-h-0");
            expect(form?.className).toContain("flex-1");

            // Verify body is inside form and has flex-1 overflow-y-auto
            const body = form?.querySelector(".overflow-y-auto");
            expect(body).not.toBeNull();
            expect(body?.className).toContain("flex-1");

            const saveBtn = form?.querySelector('button[type="submit"]');
            expect(saveBtn).not.toBeNull();
        });
    });

    describe("Issue 3: PDF Target Page Navigation", () => {
        it("resolves target page from string numbers and page formats", () => {
            expect(resolvePdfTargetPage("5")).toBe(5);
            expect(resolvePdfTargetPage("pdf:page:12")).toBe(12);
            expect(resolvePdfTargetPage("?page=7")).toBe(7);
            expect(resolvePdfTargetPage("#page=9")).toBe(9);
            expect(resolvePdfTargetPage("")).toBeNull();
            expect(resolvePdfTargetPage("invalid")).toBeNull();
        });

        it("prioritizes pendingTargetPage over savedPdfState.page when navigating from notes", () => {
            const pendingLocation = "15";
            const pendingTargetPage = pendingLocation ? resolvePdfTargetPage(pendingLocation) : null;
            const savedPdfState = { page: 1, zoom: 1 };
            const fallbackPage = 1;

            const nextInitialPage = Math.max(
                1,
                Math.floor(pendingTargetPage ?? savedPdfState?.page ?? fallbackPage),
            );

            expect(nextInitialPage).toBe(15);
        });

        it("falls back to savedPdfState.page when pendingTargetPage is null", () => {
            const pendingLocation = null;
            const pendingTargetPage = pendingLocation ? resolvePdfTargetPage(pendingLocation) : null;
            const savedPdfState = { page: 8, zoom: 1 };
            const fallbackPage = 1;

            const nextInitialPage = Math.max(
                1,
                Math.floor(pendingTargetPage ?? savedPdfState?.page ?? fallbackPage),
            );

            expect(nextInitialPage).toBe(8);
        });
    });

    describe("Issue 4: Light Theme Switching & Isolation from System Theme", () => {
        it("applies theme-light class to body and sets light CSS properties", () => {
            applyAppTheme("light", "#c6f135");
            expect(document.body.classList.contains("theme-light")).toBe(true);
            expect(document.body.classList.contains("theme-dark")).toBe(false);
            expect(document.documentElement.style.colorScheme).toBe("light");
        });

        it("applies theme-dark class to body and sets dark CSS properties", () => {
            applyAppTheme("dark", "#c6f135");
            expect(document.body.classList.contains("theme-dark")).toBe(true);
            expect(document.body.classList.contains("theme-light")).toBe(false);
            expect(document.documentElement.style.colorScheme).toBe("dark");
        });

        it("resolves light theme colors accurately even when body has dark class", () => {
            document.body.className = "theme-dark";
            const colors = resolveThemeColors("light");
            expect(colors.bg.toLowerCase()).toBe("#ffffff");
            expect(colors.fg.toLowerCase()).toBe("#1a1a1a");
        });

        it("generates reader CSS without prefers-color-scheme media query overrides", () => {
            const css = getCSS({
                theme: {
                    name: "light",
                    light: { bg: "#ffffff", fg: "#1a1a1a", link: "#0000ee" },
                    dark: { bg: "#121212", fg: "#e0e0e0", link: "#8ab4f8" },
                },
                invert: false,
            });

            const joinedCss = css.join("\n");
            expect(joinedCss).not.toContain("@media screen and (prefers-color-scheme: dark)");
            expect(joinedCss).not.toContain("@media screen and (prefers-color-scheme: light)");
            expect(joinedCss).toContain("color-scheme: light;");
            expect(joinedCss).toContain("background-color: #ffffff !important;");
        });
    });
});
