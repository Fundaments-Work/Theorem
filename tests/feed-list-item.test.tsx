// @vitest-environment jsdom
/**
 * A feed in the Feeds sidebar opens from the keyboard (it was a click-only
 * div), and on desktop its refresh/remove actions take no room until the row
 * is hovered or focused, so the feed name is not cut short.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FeedListItem, deduplicateFeedTitle } from "../src/features/feeds/FeedsPage";
import type { RssFeed } from "../src/core/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
const feed = { id: "f", title: "The Public Domain Review", url: "https://x", unreadCount: 3 } as RssFeed;

function render(showTouchActions: boolean) {
    const props = { feed, isSelected: false, onSelect: vi.fn(), onDelete: vi.fn(), onRefresh: vi.fn(), showTouchActions };
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(<FeedListItem {...props} />));
    return props;
}

afterEach(() => {
    act(() => root?.unmount());
    root = null;
    document.body.innerHTML = "";
});

describe("feed list item", () => {
    it("is a focusable button that opens with Enter or Space", () => {
        const props = render(false);
        const row = document.querySelector<HTMLElement>('[role="button"]')!;
        expect(row.tabIndex).toBe(0);
        act(() => row.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
        act(() => row.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true })));
        expect(props.onSelect).toHaveBeenCalledTimes(2);
    });

    it("hides its actions without reserving room until hovered or focused (desktop)", () => {
        render(false);
        for (const label of ["Refresh The Public Domain Review", "Remove The Public Domain Review"]) {
            const button = document.querySelector<HTMLElement>(`[aria-label="${label}"]`)!;
            expect(button.className).toMatch(/(^|\s)hidden(\s|$)/);
            expect(button.className).toContain("group-hover:flex");
            expect(button.className).toContain("group-focus-within:flex");
            expect(button.className).not.toContain("opacity-0");
        }
    });

    it("keeps actions visible on touch screens", () => {
        render(true);
        const button = document.querySelector<HTMLElement>('[aria-label="Remove The Public Domain Review"]')!;
        expect(button.className).not.toMatch(/(^|\s)hidden(\s|$)/);
    });

    it("an action does not also open the feed", () => {
        const props = render(true);
        act(() => document.querySelector<HTMLElement>('[aria-label="Remove The Public Domain Review"]')!.click());
        expect(props.onDelete).toHaveBeenCalledTimes(1);
        expect(props.onSelect).not.toHaveBeenCalled();
    });

    it("deduplicates doubled feed titles while leaving normal titles intact", () => {
        expect(deduplicateFeedTitle("The MarginalianThe Marginalian")).toBe("The Marginalian");
        expect(deduplicateFeedTitle("Quanta MagazineQuanta Magazine")).toBe("Quanta Magazine");
        expect(deduplicateFeedTitle("The Public Domain Review")).toBe("The Public Domain Review");
        expect(deduplicateFeedTitle("Short")).toBe("Short");
    });

    it("renders deduplicated title in FeedListItem", () => {
        const doubledFeed = { id: "f2", title: "The MarginalianThe Marginalian", url: "https://x", unreadCount: 1 } as RssFeed;
        const host = document.createElement("div");
        document.body.appendChild(host);
        const customRoot = createRoot(host);
        act(() => customRoot.render(
            <FeedListItem
                feed={doubledFeed}
                isSelected={false}
                onSelect={vi.fn()}
                onDelete={vi.fn()}
                showTouchActions={false}
            />
        ));
        expect(host.querySelector("p")?.textContent?.trim()).toBe("The Marginalian");
        act(() => customRoot.unmount());
        host.remove();
    });
});
