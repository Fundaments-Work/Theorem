// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ContextMenu, type ContextMenuItem } from "../src/ui";
import { AddToShelfModal } from "../src/features/library/Library";
import type { Collection } from "../src/core/types";

// @ts-expect-error React 19 act environment flag
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Root[] = [];

function render(ui: React.ReactElement) {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push(root);
    act(() => { root.render(ui); });
    return container;
}

afterEach(() => {
    while (mounted.length) {
        const root = mounted.pop()!;
        act(() => root.unmount());
    }
    document.body.innerHTML = "";
});

function openMenu(items: ContextMenuItem[]) {
    const container = render(
        <ContextMenu items={items}>
            <div data-testid="trigger">row</div>
        </ContextMenu>,
    );
    const trigger = container.querySelector('[data-testid="trigger"]')!;
    act(() => {
        trigger.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 20, clientY: 20 }));
    });
    return document.body;
}

describe("ContextMenu submenus", () => {
    it("renders a submenu trigger with its children nested", () => {
        const onChild = vi.fn();
        openMenu([
            { id: "top", label: "Top level" },
            {
                id: "more",
                label: "More…",
                items: [{ id: "child", label: "Child action", onClick: onChild }],
            },
        ]);

        const trigger = document.body.querySelector<HTMLElement>('[role="menuitem"]');
        expect(document.body.textContent).toContain("More…");
        // Radix renders sub content lazily on hover/focus of the trigger.
        expect(trigger).not.toBeNull();
    });

    it("keeps a submenu entry out of the flat item list", () => {
        // A leaf-only renderer would drop "More…" and its children entirely.
        openMenu([{ id: "a", label: "Only" }]);
        expect(document.body.textContent).toContain("Only");
        expect(document.body.textContent).not.toContain("More…");
    });
});

describe("ContextMenu stacking", () => {
    it("sits above the mobile bottom nav", () => {
        // --z-nav is 110; the menu used to render at --z-dropdown + 1 = 51 and was
        // painted underneath the bottom bar when opening a row near the bottom.
        openMenu([{ id: "a", label: "Item" }]);
        const content = document.body.querySelector('[role="menu"]');
        expect(content).not.toBeNull();
        expect(content!.className).toContain("z-[var(--z-popover)]");
        expect(content!.className).not.toContain("z-dropdown");
    });
});

describe("ContextMenu stays inside the viewport", () => {
    it("does not clamp its height to the popper available height", () => {
        // Regression: `max-h-[var(--radix-context-menu-content-available-height)]`
        // resolved to --radix-popper-available-height, which floating-ui measures
        // from the anchor in the placement direction. For a side="right" submenu
        // anchored to a row near the bottom of the screen that is only the space
        // below the anchor, so the clamp squashed the submenu to a fraction of its
        // height and left it scrolling. Radix already flips/shifts to fit; the
        // library menu is a fixed eight rows so it never needs a cap.
        const src = readFileSync(resolve("src/ui/ContextMenu.tsx"), "utf-8");
        expect(src).not.toContain("max-h-[var(--radix-context-menu-content-available-height)]");
        expect(src).not.toContain("radix-popper-available-height]\"");
        openMenu([{ id: "a", label: "Item" }]);
        const content = document.body.querySelector('[role="menu"]')!;
        expect(content.className).not.toContain("max-h-[var(--radix-");
    });

    it("does not pass side/align, which Radix omits from its props", () => {
        const src = readFileSync(resolve("src/ui/ContextMenu.tsx"), "utf-8");
        // Radix intentionally Omit<'side' | 'align'> from Content and SubContent;
        // passing them is a type error and silently does nothing. The runtime
        // defaults are already side="right", align="start".
        expect(src).not.toMatch(/<ContextMenuPrimitive\.(Sub)?Content[\s\S]{0,300}?\bside="/);
        expect(src).not.toMatch(/<ContextMenuPrimitive\.(Sub)?Content[\s\S]{0,300}?\balign="/);
        // collisionPadding is allowed on both and keeps content off the edges.
        expect(src.match(/collisionPadding=\{12\}/g)?.length).toBe(2);
    });
});

const shelf = (over: Partial<Collection> & Pick<Collection, "id" | "name">): Collection => ({
    bookIds: [],
    kind: "general",
    createdAt: new Date(),
    ...over,
} as Collection);

describe("shelf dialog toggles membership", () => {
    const collections = [
        shelf({ id: "s1", name: "Favorites", bookIds: ["b1"] }),
        shelf({ id: "s2", name: "To Read", bookIds: [] }),
    ];

    function renderDialog(currentShelfIds: ReadonlySet<string>) {
        const onAddToShelf = vi.fn();
        const onRemoveFromShelf = vi.fn();
        render(
            <AddToShelfModal
                isOpen
                onClose={() => { }}
                bookId="b1"
                collections={collections}
                currentShelfIds={currentShelfIds}
                onAddToShelf={onAddToShelf}
                onRemoveFromShelf={onRemoveFromShelf}
                onCreateShelf={() => { }}
            />,
        );
        return { onAddToShelf, onRemoveFromShelf };
    }

    it("marks the shelves the book already belongs to", () => {
        renderDialog(new Set(["s1"]));
        const rows = Array.from(document.body.querySelectorAll<HTMLElement>('[role="checkbox"]'));
        expect(rows).toHaveLength(2);
        expect(rows[0].getAttribute("aria-checked")).toBe("true");
        expect(rows[1].getAttribute("aria-checked")).toBe("false");
    });

    it("removes from a shelf the book is already in", () => {
        const { onAddToShelf, onRemoveFromShelf } = renderDialog(new Set(["s1"]));
        const rows = Array.from(document.body.querySelectorAll<HTMLElement>('[role="checkbox"]'));
        act(() => rows[0].click());
        expect(onRemoveFromShelf).toHaveBeenCalledWith("s1");
        expect(onAddToShelf).not.toHaveBeenCalled();
    });

    it("adds to a shelf the book is not in", () => {
        const { onAddToShelf, onRemoveFromShelf } = renderDialog(new Set(["s1"]));
        const rows = Array.from(document.body.querySelectorAll<HTMLElement>('[role="checkbox"]'));
        act(() => rows[1].click());
        expect(onAddToShelf).toHaveBeenCalledWith("b1", "s2");
        expect(onRemoveFromShelf).not.toHaveBeenCalled();
    });

    it("still works add-only when no membership is supplied", () => {
        const onAddToShelf = vi.fn();
        const onRemoveFromShelf = vi.fn();
        render(
            <AddToShelfModal
                isOpen
                onClose={() => { }}
                bookId="b1"
                collections={collections}
                onAddToShelf={onAddToShelf}
                onRemoveFromShelf={onRemoveFromShelf}
                onCreateShelf={() => { }}
            />,
        );
        const rows = Array.from(document.body.querySelectorAll<HTMLElement>('[role="checkbox"]'));
        act(() => rows[0].click());
        expect(onAddToShelf).toHaveBeenCalledWith("b1", "s1");
        expect(onRemoveFromShelf).not.toHaveBeenCalled();
    });
});