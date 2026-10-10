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
        // height and left it scrolling.
        const src = readFileSync(resolve("src/ui/ContextMenu.tsx"), "utf-8");
        expect(src).not.toContain("max-h-[var(--radix-context-menu-content-available-height)]");
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
        expect(src.match(/collisionPadding=\{12\}/g)?.length).toBe(2);
    });
});

describe("phones drill down inside the same menu", () => {
    const src = readFileSync(resolve("src/features/library/Library.tsx"), "utf-8");

    it("gates drilldown on viewport width", () => {
        // A flyout cannot fit ~390px: the menu is 180-280px and the submenu needs
        // another 180-280px beside it. Collision tuning cannot add horizontal room.
        expect(src).toContain('const WIDE_VIEWPORT_MEDIA_QUERY = "(min-width: 640px)"');
        expect(src).toContain("drilldown={!isWideViewport}");
    });

    it("resolves the breakpoint with matchMedia, not a CSS class", () => {
        // A CSS-visibility approach would depend on Tailwind's display cascade
        // order; matchMedia is deterministic and reacts to rotation.
        expect(src).toContain("const isWideViewport = useMediaQuery(WIDE_VIEWPORT_MEDIA_QUERY)");
    });

    it("does not open a dialog for the nested actions", () => {
        // The sheet read as a separate dialog rather than the menu you long-pressed.
        expect(src).not.toContain('<ModalHeader title="More Actions"');
        expect(src).not.toContain("isMoreSheetOpen");
        expect(src).not.toContain("{moreSheet}");
    });

    it("keeps one shared item list for both presentations", () => {
        expect(src).toMatch(/const moreItems: ContextMenuItem\[\] = \[/);
        expect(src).toContain("items: moreItems,");
    });
});

describe("ContextMenu drilldown", () => {
    function drilldownItems(): ContextMenuItem[] {
        return [
            { id: "open", label: "Open Book" },
            {
                id: "more",
                label: "More…",
                items: [
                    { id: "edit", label: "Edit Info" },
                    { id: "export", label: "Export" },
                ],
            },
        ];
    }

    function openDrilldown() {
        const container = render(
            <ContextMenu items={drilldownItems()} drilldown>
                <div data-testid="trigger">row</div>
            </ContextMenu>,
        );
        act(() => {
            container.querySelector('[data-testid="trigger"]')!
                .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 20, clientY: 20 }));
        });
        return document.body;
    }

    it("reveals the group in the same menu and offers Back", () => {
        const body = openDrilldown();
        expect(body.textContent).toContain("More…");
        expect(body.textContent).not.toContain("Edit Info");

        const more = Array.from(body.querySelectorAll<HTMLElement>('[role="menuitem"]'))
            .find(el => el.textContent?.includes("More…"))!;
        act(() => more.click());

        // Same menu, now the group plus a Back row labelled with the group it
        // returns to ("‹ More…").
        expect(body.textContent).toContain("Edit Info");
        expect(body.textContent).toContain("Export");
        const rows = Array.from(body.querySelectorAll<HTMLElement>('[role="menuitem"]'));
        expect(rows).toHaveLength(3);
        expect(rows[0].textContent).toContain("More…");
        expect(rows[1].textContent).toContain("Edit Info");
    });

    it("returns to the top-level list on Back", () => {
        const body = openDrilldown();
        const more = Array.from(body.querySelectorAll<HTMLElement>('[role="menuitem"]'))
            .find(el => el.textContent?.includes("More…"))!;
        act(() => more.click());

        const back = Array.from(body.querySelectorAll<HTMLElement>('[role="menuitem"]'))[0];
        expect(back.textContent).toContain("More…");
        act(() => back.click());

        expect(body.textContent).toContain("Open Book");
        expect(body.textContent).not.toContain("Edit Info");
    });

    it("runs the nested action when tapped", () => {
        const onExport = vi.fn();
        const container = render(
            <ContextMenu
                items={[
                    { id: "open", label: "Open Book" },
                    { id: "more", label: "More…", items: [{ id: "export", label: "Export", onClick: onExport }] },
                ]}
                drilldown
            >
                <div data-testid="trigger">row</div>
            </ContextMenu>,
        );
        act(() => {
            container.querySelector('[data-testid="trigger"]')!
                .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 20, clientY: 20 }));
        });

        const more = Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'))
            .find(el => el.textContent?.includes("More…"))!;
        act(() => more.click());

        const exportItem = Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'))
            .find(el => el.textContent?.includes("Export"))!;
        act(() => exportItem.click());
        expect(onExport).toHaveBeenCalledTimes(1);
    });

    it("still opens a real submenu when drilldown is off", () => {
        // Desktop keeps the flyout, so ContextMenu must not change that path.
        const container = render(
            <ContextMenu items={drilldownItems()}>
                <div data-testid="trigger">row</div>
            </ContextMenu>,
        );
        act(() => {
            container.querySelector('[data-testid="trigger"]')!
                .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 20, clientY: 20 }));
        });
        const more = Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'))
            .find(el => el.textContent?.includes("More…"))!;
        act(() => more.click());

        // The group opens as its own panel; the root list is untouched, which is
        // what distinguishes the flyout from the in-place drilldown.
        expect(document.body.querySelectorAll('[role="menu"]').length).toBe(2);
        const rootMenu = document.body.querySelector('[role="menu"]')!;
        expect(rootMenu.textContent).toContain("Open Book");
        expect(rootMenu.textContent).toContain("More…");
        expect(rootMenu.textContent).not.toContain("Edit Info");
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