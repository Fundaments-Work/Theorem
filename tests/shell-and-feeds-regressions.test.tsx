// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { applyAppTheme } from "../src/core/lib/design-tokens";
import { formatUpdatedDomainsMessage } from "../src/core/lib/sync-domain-labels";
import { useFilteredSelection } from "../src/features/library/useFilteredSelection";
import { useCatalogDownload } from "../src/features/catalogs/opds/useCatalogDownload";
import { OpdsService } from "../src/core/services/OpdsService";
import { SwipeableArticleItem } from "../src/features/feeds/components/SwipeableArticleItem";
import { FeedsPage } from "../src/features/feeds/FeedsPage";
import { useLibraryStore, useRssStore, useUIStore } from "../src/core/store";
import type { Book, OpdsEntry, RssArticle, RssFeed } from "../src/core/types";

function makeBook(id: string): Book {
    return {
        id,
        title: `Title ${id}`,
        author: "Author",
        format: "epub",
        filePath: `/books/${id}.epub`,
        fileSize: 1024,
        addedAt: new Date("2026-10-01T00:00:00Z"),
        progress: 0,
        tags: [],
        isFavorite: false,
        readingTime: 0,
    };
}

function makeFeed(id: string): RssFeed {
    return {
        id,
        title: "Test Feed",
        url: "https://example.com/feed.xml",
        unreadCount: 1,
        addedAt: new Date("2026-10-01T00:00:00Z"),
    };
}

function makeArticle(id: string, feedId: string): RssArticle {
    return {
        id,
        feedId,
        title: `Article ${id}`,
        url: `https://example.com/${id}`,
        content: "<p>Hello world</p>",
        publishedAt: new Date("2026-10-02T00:00:00Z"),
        fetchedAt: new Date("2026-10-02T00:00:00Z"),
        isRead: false,
        isFavorite: false,
        isSaved: false,
    };
}

function stubVirtualizerBox(): () => void {
    const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
    const keys = ["offsetWidth", "offsetHeight", "clientWidth", "clientHeight"] as const;
    const prevDescriptors = keys.map((k) => [k, Object.getOwnPropertyDescriptor(proto, k)] as const);
    for (const k of keys) {
        Object.defineProperty(proto, k, {
            configurable: true,
            get: () => (k.includes("Width") ? 960 : 720),
        });
    }
    const prevResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class ResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
    };
    return () => {
        for (const [k, desc] of prevDescriptors) {
            if (desc) Object.defineProperty(proto, k, desc);
            else delete proto[k];
        }
        globalThis.ResizeObserver = prevResizeObserver;
    };
}

describe("Shell, theme tokens, feeds, and selection regressions", () => {
    let host: HTMLDivElement;
    let root: Root;
    let restoreDom: () => void;

    const mount = (ui: ReactElement) => {
        act(() => {
            root.render(ui);
        });
    };

    beforeEach(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        window.localStorage.clear();
        window.sessionStorage.clear();
        restoreDom = stubVirtualizerBox();
        host = document.createElement("div");
        document.body.appendChild(host);
        root = createRoot(host);
        useUIStore.setState({ currentRoute: "library", searchQuery: "", selectedBooks: [] });
        useLibraryStore.setState({ books: [], collections: [] });
        useRssStore.setState({
            feeds: [],
            articles: [],
            isLoading: false,
            error: undefined,
        });
    });

    afterEach(() => {
        act(() => {
            root.unmount();
        });
        host.remove();
        restoreDom();
        vi.useRealTimers();
        vi.restoreAllMocks();
        document.documentElement.style.cssText = "";
        document.body.className = "";
        document.body.innerHTML = "";
    });

    it("light theme warning token is distinct from success and not overloaded with the lime accent", () => {
        applyAppTheme("light", "#c6f135");
        const style = document.documentElement.style;
        const warning = style.getPropertyValue("--app-warning").trim();
        const success = style.getPropertyValue("--app-success").trim();
        const accent = style.getPropertyValue("--app-accent").trim();
        expect(warning).not.toBe("");
        expect(warning).not.toBe(success);
        expect(warning).not.toBe(accent);
    });

    it("disabled keep-alive useFilteredSelection does not clear another route's active selection", () => {
        const shelfSelection = ["shelf-b1", "shelf-b2"];
        useUIStore.setState({ selectedBooks: shelfSelection });

        function InactiveLibraryHarness({ scope, ready }: { scope: string; ready: boolean }) {
            useFilteredSelection([makeBook("lib-b1")], scope, false, ready);
            return null;
        }

        mount(<InactiveLibraryHarness scope="all" ready={false} />);
        // Simulate ready/scope changing while Library is hidden (enabled={false})
        mount(<InactiveLibraryHarness scope="search" ready={true} />);

        expect(useUIStore.getState().selectedBooks).toEqual(shelfSelection);
    });

    it("useCatalogDownload prevents concurrent duplicate downloads from synchronous double clicks", async () => {
        let resolveDownload!: () => void;
        const downloadSpy = vi.spyOn(OpdsService, "download").mockImplementation(
            () =>
                new Promise<void>((resolve) => {
                    resolveDownload = resolve;
                }) as never,
        );
        vi.spyOn(toast, "loading").mockReturnValue("toast-1");
        vi.spyOn(toast, "success").mockReturnValue("toast-1");

        const entry: OpdsEntry = {
            id: "opds-entry-1",
            title: "The Republic",
            authors: ["Plato"],
            categories: [],
            primary: 0,
            acquisitions: [
                {
                    href: "https://catalog.example/republic.epub",
                    kind: "openAccess",
                    mime: "application/epub+zip",
                    format: "epub",
                    drm: false,
                    downloadable: true,
                },
            ],
        };

        let triggerDownload!: (e: OpdsEntry) => Promise<boolean>;
        function Harness() {
            const { download } = useCatalogDownload();
            triggerDownload = download;
            return null;
        }
        mount(<Harness />);

        let firstPromise!: Promise<boolean>;
        let secondPromise!: Promise<boolean>;
        await act(async () => {
            firstPromise = triggerDownload(entry);
            secondPromise = triggerDownload(entry);
        });

        expect(downloadSpy).toHaveBeenCalledTimes(1);
        expect(await secondPromise).toBe(false);

        await act(async () => {
            resolveDownload();
            expect(await firstPromise).toBe(true);
        });
    });

    it("SwipeableArticleItem cancels pending delete callback if unmounted mid-exit", () => {
        vi.useFakeTimers();
        const onSwipeLeft = vi.fn();

        mount(
            <SwipeableArticleItem onSwipeLeft={onSwipeLeft} threshold={40}>
                <div>Article card</div>
            </SwipeableArticleItem>,
        );

        const swipeTarget = host.firstElementChild as HTMLElement;
        expect(swipeTarget).not.toBeNull();

        act(() => {
            swipeTarget.dispatchEvent(
                new PointerEvent("pointerdown", {
                    bubbles: true,
                    isPrimary: true,
                    pointerId: 1,
                    clientX: 200,
                    clientY: 20,
                }),
            );
            swipeTarget.dispatchEvent(
                new PointerEvent("pointermove", {
                    bubbles: true,
                    isPrimary: true,
                    pointerId: 1,
                    clientX: 100,
                    clientY: 20,
                }),
            );
            swipeTarget.dispatchEvent(
                new PointerEvent("pointerup", {
                    bubbles: true,
                    isPrimary: true,
                    pointerId: 1,
                    clientX: 100,
                    clientY: 20,
                }),
            );
        });

        act(() => {
            root.unmount();
        });
        act(() => {
            vi.advanceTimersByTime(300);
        });

        expect(onSwipeLeft).not.toHaveBeenCalled();
    });

    it("FeedsPage refreshes all feeds in virtual views, keeps AddFeedModal mounted while loading, and deletes via Undo", async () => {
        const feed = makeFeed("feed-1");
        const article = makeArticle("art-1", feed.id);
        const refreshAllSpy = vi.fn().mockResolvedValue(undefined);
        const refreshFeedSpy = vi.fn().mockResolvedValue(undefined);
        const toastSuccessSpy = vi.spyOn(toast, "success");

        useRssStore.setState({
            feeds: [feed],
            articles: [article],
            isLoading: false,
            refreshAll: refreshAllSpy,
            refreshFeed: refreshFeedSpy,
        });

        mount(<FeedsPage />);

        const unreadBtn = Array.from(host.querySelectorAll("button")).find((b) =>
            b.textContent?.includes("Unread"),
        );
        expect(unreadBtn).toBeDefined();
        act(() => {
            unreadBtn!.click();
        });

        const refreshAllBtn = host.querySelector<HTMLButtonElement>('button[aria-label="Refresh all feeds"]');
        expect(refreshAllBtn).not.toBeNull();
        await act(async () => {
            refreshAllBtn!.click();
        });

        expect(refreshAllSpy).toHaveBeenCalledTimes(1);
        expect(refreshFeedSpy).not.toHaveBeenCalled();

        // Trigger context menu Delete Article on the rendered card and verify Undo toast fires
        const cardSurface = host.querySelector<HTMLElement>('[data-index="0"] .cursor-pointer');
        expect(cardSurface).not.toBeNull();
        act(() => {
            cardSurface!.dispatchEvent(
                new MouseEvent("contextmenu", { bubbles: true, clientX: 20, clientY: 20 }),
            );
        });
        const deleteItem = Array.from(document.body.querySelectorAll('[role="menuitem"]')).find((el) =>
            el.textContent?.includes("Delete Article"),
        ) as HTMLElement | undefined;
        expect(deleteItem).toBeDefined();
        act(() => {
            deleteItem!.click();
        });
        expect(toastSuccessSpy).toHaveBeenCalledWith(
            "Article deleted",
            expect.objectContaining({
                action: expect.objectContaining({ label: "Undo" }),
            }),
        );

        // Mobile Back to feeds button must carry an accessible name
        const backBtn = Array.from(host.querySelectorAll("header button")).find((b) =>
            b.getAttribute("aria-label")?.includes("feeds") || b.getAttribute("aria-label")?.includes("Back"),
        );
        expect(backBtn).toBeDefined();

        // Empty-state AddFeedModal stays mounted when loading begins during submission
        act(() => {
            useRssStore.setState({ feeds: [], articles: [], isLoading: false });
        });
        const addFeedBtn = Array.from(host.querySelectorAll("button")).find((b) =>
            b.textContent?.includes("Add First Feed"),
        );
        expect(addFeedBtn).toBeDefined();
        act(() => {
            addFeedBtn!.click();
        });
        expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();

        act(() => {
            useRssStore.setState({ isLoading: true });
        });
        expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
    });

    it("formatUpdatedDomainsMessage formats snake_case domains for UI display without internal keys", () => {
        expect(formatUpdatedDomainsMessage(["books", "rss_articles", "reading_rhythm", "deletion_tombstones"])).toBe(
            "Updated: Books, Articles, Reading rhythm",
        );
        expect(formatUpdatedDomainsMessage(["deletion_tombstones"])).toBe("Sync complete");
        expect(formatUpdatedDomainsMessage([])).toBe("Already in sync");
    });
});
