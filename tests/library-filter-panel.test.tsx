// @vitest-environment jsdom
/**
 * The Library's sort and filter panel speaks the reader's language: order
 * reads "A to Z" or "Newest first" depending on what is sorted, statuses are
 * "Not started / Reading / Finished", and one panel serves the phone sheet and
 * the desktop popover.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { LibraryFilterPanel, type LibraryFilterPanelProps } from "../src/features/library/LibraryFilterPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

function render(overrides: Partial<LibraryFilterPanelProps> = {}) {
    const props: LibraryFilterPanelProps = {
        variant: "popover",
        sortBy: "title",
        sortOrder: "asc",
        statusFilter: "all",
        favoritesOnly: false,
        unshelvedOnly: false,
        onSortBy: vi.fn(),
        onSortOrder: vi.fn(),
        onStatusFilter: vi.fn(),
        onFavoritesOnly: vi.fn(),
        onUnshelvedOnly: vi.fn(),
        ...overrides,
    };
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(<LibraryFilterPanel {...props} />));
    return props;
}

function button(label: string): HTMLButtonElement {
    const found = Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim() === label);
    if (!found) throw new Error(`no button "${label}"`);
    return found;
}

function labels(): string[] {
    return Array.from(document.querySelectorAll("button")).map((b) => b.textContent?.trim() ?? "");
}

afterEach(() => {
    act(() => root?.unmount());
    root = null;
    document.body.innerHTML = "";
});

describe("library filter panel", () => {
    it("uses plain words, never ASC/DESC or a second 'Read'", () => {
        render();
        const all = labels();
        expect(all).toEqual(expect.arrayContaining(["Title", "Author", "Date added", "Last read"]));
        expect(all).toEqual(expect.arrayContaining(["All", "Not started", "Reading", "Finished"]));
        expect(all).toEqual(expect.arrayContaining(["Favorites", "Not on a shelf"]));
        expect(all).not.toContain("ASC");
        expect(all).not.toContain("DESC");
        expect(all.filter((l) => l === "Read")).toHaveLength(0);
    });

    it("names the order after what is sorted", () => {
        render({ sortBy: "author" });
        expect(labels()).toEqual(expect.arrayContaining(["A to Z", "Z to A"]));
        act(() => root!.unmount());
        render({ sortBy: "dateAdded" });
        expect(labels()).toEqual(expect.arrayContaining(["Newest first", "Oldest first"]));
    });

    it("maps choices to the stored values", () => {
        const props = render({ sortBy: "lastRead" });
        act(() => button("Newest first").click());
        expect(props.onSortOrder).toHaveBeenCalledWith("desc");
        act(() => button("Date added").click());
        expect(props.onSortBy).toHaveBeenCalledWith("dateAdded");
        act(() => button("Not started").click());
        expect(props.onStatusFilter).toHaveBeenCalledWith("unread");
        act(() => button("Finished").click());
        expect(props.onStatusFilter).toHaveBeenCalledWith("completed");
        act(() => button("Not on a shelf").click());
        expect(props.onUnshelvedOnly).toHaveBeenCalledWith(true);
    });

    it("marks the current choices as pressed", () => {
        render({ sortBy: "author", sortOrder: "desc", statusFilter: "reading", favoritesOnly: true });
        for (const label of ["Author", "Z to A", "Reading", "Favorites"]) {
            expect(button(label).getAttribute("aria-pressed"), label).toBe("true");
        }
        expect(button("Title").getAttribute("aria-pressed")).toBe("false");
    });
});
