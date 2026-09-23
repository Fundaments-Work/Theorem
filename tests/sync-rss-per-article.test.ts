import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const article = (id: string, title = id) => ({
    id, feedId: "f1", title, url: `https://x/${id}`, content: "", isRead: false, isFavorite: false,
    publishedAt: "2026-01-01T00:00:00.000Z", fetchedAt: "2026-01-01T00:00:00.000Z",
});

type Listener = (state: { feeds: unknown[]; articles: ReturnType<typeof article>[] }) => void;
const rss = {
    state: { feeds: [] as unknown[], articles: [] as ReturnType<typeof article>[] },
    listeners: [] as Listener[],
    set(articles: ReturnType<typeof article>[]) {
        rss.state = { ...rss.state, articles };
        for (const l of rss.listeners) l(rss.state);
    },
};
const setStateCalls: unknown[] = [];
const hydrated = { persist: { hasHydrated: () => true } };
let tauri = false;
vi.mock("../src/core/lib/env", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../src/core/lib/env")>()),
    isTauri: () => tauri,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("../src/core/store", () => ({
    useSettingsStore: { ...hydrated, getState: () => ({ settings: { deviceSync: {} }, stats: {} }), subscribe: () => () => {} },
    useLibraryStore: { ...hydrated, getState: () => ({ books: [], annotations: [], collections: [], deletionTombstones: [] }), setState: () => {}, subscribe: () => () => {} },
    useVocabularyStore: { ...hydrated, getState: () => ({ vocabularyTerms: [] }), setState: () => {}, subscribe: () => () => {} },
    useRssStore: {
        ...hydrated,
        getState: () => rss.state,
        setState: (patch: object) => { setStateCalls.push(patch); rss.state = { ...rss.state, ...patch }; },
        subscribe: (l: Listener) => { rss.listeners.push(l); return () => {}; },
    },
    useUIStore: { getState: () => ({}), setState: () => {} },
}));
const writes: Array<[string, string]> = [];
let docEntries: Record<string, string> = {};
vi.mock("@tauri-apps/api/core", () => ({
    invoke: async (cmd: string, args: { key: string; value: string }) => {
        if (cmd === "docs_set_entry") writes.push([args.key, args.value]);
        if (cmd === "docs_get_all_entries") return docEntries;
        if (cmd === "sqlite_get_kv") return "true"; // already provisioned
        return null;
    },
}));

beforeEach(() => {
    vi.resetModules();
    rss.state = { feeds: [], articles: [article("a"), article("b")] };
    rss.listeners = [];
    writes.length = 0;
    setStateCalls.length = 0;
});
afterEach(() => { vi.useRealTimers(); });

const flush = async () => { await vi.advanceTimersByTimeAsync(5000); };

describe("RSS articles sync per article", () => {
    it("an edit writes only that article's entry; a deletion rewrites the list entry", async () => {
        tauri = true;
        const { ensureResponderSyncReady, subscribeZustandToIrohDocs, RSS_ARTICLE_KEY_PREFIX } = await import("../src/core/lib/sync-orchestrator");
        await ensureResponderSyncReady(); // the bridge only writes once sync is ready
        vi.useFakeTimers();
        subscribeZustandToIrohDocs();
        writes.length = 0;

        rss.set([article("a", "A edited"), rss.state.articles[1]]);
        await flush();
        expect(writes.map(([k]) => k)).toEqual([`${RSS_ARTICLE_KEY_PREFIX}a`]);
        expect(JSON.parse(writes[0][1]).title).toBe("A edited");

        writes.length = 0;
        rss.set([...rss.state.articles, article("c")]);
        await flush();
        expect(writes.map(([k]) => k)).toEqual([`${RSS_ARTICLE_KEY_PREFIX}c`]);

        writes.length = 0;
        rss.set(rss.state.articles.filter((x) => x.id !== "b"));
        await flush();
        expect(writes.map(([k]) => k)).toEqual(["rss_articles"]);
        expect(JSON.parse(writes[0][1]).map((x: { id: string }) => x.id)).toEqual(["a", "c"]);
    });

    it("incoming per-article entries and the legacy list entry are both merged", async () => {
        tauri = false;
        rss.state = { feeds: [], articles: [] };
        docEntries = {
            rss_articles: JSON.stringify([article("old")]),
            "rss_article:new": JSON.stringify(article("new")),
            "rss_article:bad": JSON.stringify({ id: "bad" }), // fails the schema
        };
        const { hydrateFromIrohDocs } = await import("../src/core/lib/sync-orchestrator");
        const updated = await hydrateFromIrohDocs();
        expect(updated).toContain("rss_articles");
        expect(rss.state.articles.map((x) => x.id).sort()).toEqual(["new", "old"]);
    });
});
