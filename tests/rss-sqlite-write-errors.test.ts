import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/core/lib/env", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../src/core/lib/env")>();
    return { ...actual, isTauri: () => true };
});

vi.mock("../src/core/lib/sync-orchestrator", () => ({ scheduleMutationSync: () => {} }));

// Plain recording functions keep call logs independent of the global
// clearMocks/restoreMocks settings.
const { failure, calls, failing, sqliteMock } = vi.hoisted(() => {
    const failure = new Error("disk I/O error");
    const calls: Array<{ fn: string; args: unknown[] }> = [];
    /** Names (or `name:id`) of writes that should reject. */
    const failing = new Set<string>();
    const write = (fn: string) => (...args: unknown[]) => {
        calls.push({ fn, args });
        const first = args[0] as { id?: string } | string | undefined;
        const id = typeof first === "string" ? first : first?.id;
        return failing.has(fn) || failing.has(`${fn}:${id}`) ? Promise.reject(failure) : Promise.resolve();
    };
    const sqliteMock = {
        sqliteMarkArticleRead: write("sqliteMarkArticleRead"),
        sqliteMarkArticleFavorite: write("sqliteMarkArticleFavorite"),
        sqliteDeleteRssFeed: write("sqliteDeleteRssFeed"),
        sqliteDeleteRssArticle: write("sqliteDeleteRssArticle"),
        sqliteMarkArticleSaved: write("sqliteMarkArticleSaved"),
        sqliteSaveRssArticle: write("sqliteSaveRssArticle"),
        sqliteSaveRssFeed: write("sqliteSaveRssFeed"),
        sqliteGetRssFeeds: () => Promise.resolve([]),
        sqliteGetRssArticles: () => Promise.resolve([]),
        sqliteCleanupOldRssArticles: () => Promise.resolve(0),
        sqliteGetRssArticleContent: () => Promise.resolve(null),
        sqliteGetRssArticle: () => Promise.resolve(null),
    };
    return { failure, calls, failing, sqliteMock };
});
vi.mock("../src/core/lib/sqlite-storage", () => sqliteMock);

import { useRssStore } from "../src/core/store/rssStore";

const article = {
    id: "a1",
    feedId: "f1",
    title: "A",
    url: "https://example.com/a",
    content: "",
    fetchedAt: new Date(),
    isRead: false,
    isFavorite: false,
};

async function flush() {
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}

function callsTo(fn: string) {
    return calls.filter((c) => c.fn === fn);
}

describe("RSS SQLite writes", () => {
    let errorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(async () => {
        await flush();
        calls.length = 0;
        failing.clear();
        errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        useRssStore.setState({
            feeds: [{ id: "f1", title: "F", url: "https://example.com/feed", addedAt: new Date(), unreadCount: 1 }],
            articles: [article],
        } as never);
    });

    afterEach(() => {
        errorSpy.mockRestore();
    });

    it("reports a failed write instead of swallowing it", async () => {
        failing.add("sqliteMarkArticleRead");
        useRssStore.getState().markArticleRead("a1");
        await flush();
        expect(callsTo("sqliteMarkArticleRead").map((c) => c.args)).toEqual([["a1", true]]);
        expect(errorSpy).toHaveBeenCalledTimes(1);
        const [message, err] = errorSpy.mock.calls[0];
        expect(String(message)).toContain("RssStore");
        expect(err).toBe(failure);
        // The in-memory change still applies.
        expect(useRssStore.getState().articles[0].isRead).toBe(true);
    });

    it("reports a failed feed delete", async () => {
        failing.add("sqliteDeleteRssFeed");
        useRssStore.getState().removeFeed("f1");
        await flush();
        expect(callsTo("sqliteDeleteRssFeed").map((c) => c.args)).toEqual([["f1"]]);
        expect(errorSpy).toHaveBeenCalledTimes(1);
    });

    it("stays quiet when the write succeeds", async () => {
        useRssStore.getState().toggleArticleFavorite("a1");
        await flush();
        expect(callsTo("sqliteMarkArticleFavorite").map((c) => c.args)).toEqual([["a1", true]]);
        expect(errorSpy).not.toHaveBeenCalled();
    });

    it("reports each failed article save, not just the first", async () => {
        failing.add("sqliteSaveRssArticle:a1");
        failing.add("sqliteSaveRssArticle:a3");
        useRssStore.setState({
            articles: [article, { ...article, id: "a2" }, { ...article, id: "a3" }],
        } as never);
        useRssStore.getState().updateArticleProgress("a1", 0.5);
        useRssStore.getState().updateArticleProgress("a2", 0.5);
        useRssStore.getState().updateArticleProgress("a3", 0.5);
        await flush();
        expect(callsTo("sqliteSaveRssArticle")).toHaveLength(3);
        expect(errorSpy).toHaveBeenCalledTimes(2);
    });

    it("reports both writes when a completed article fails to save", async () => {
        failing.add("sqliteMarkArticleRead");
        failing.add("sqliteSaveRssArticle");
        useRssStore.getState().updateArticleProgress("a1", 1);
        await flush();
        expect(errorSpy).toHaveBeenCalledTimes(2);
    });
});
