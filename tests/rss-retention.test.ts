import { describe, expect, it } from "vitest";
import { selectPersistedRssArticles } from "../src/core/store/rssStore";
import type { RssArticle } from "../src/core/types";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 23, 12);

function article(id: string, ageDays: number | null, extra: Partial<RssArticle> = {}): RssArticle {
    const date = ageDays === null ? undefined : new Date(NOW - ageDays * DAY);
    return {
        id,
        feedId: "f",
        title: id,
        url: `https://x/${id}`,
        content: "",
        publishedAt: date,
        fetchedAt: date ?? new Date(Number.NaN),
        isRead: false,
        isFavorite: false,
        ...extra,
    } as RssArticle;
}

describe("selectPersistedRssArticles", () => {
    it("keeps favorites older than 30 days", () => {
        const fav = article("fav", 400, { isFavorite: true });
        const old = article("old", 400);
        expect(selectPersistedRssArticles([fav, old], NOW).map((a) => a.id)).toEqual(["fav"]);
    });

    it("keeps favorites even when non-favorites fill the 500 cap", () => {
        const recent = Array.from({ length: 600 }, (_, i) => article(`r${i}`, i / 100));
        const favs = [article("fav-new", 0, { isFavorite: true }), article("fav-old", 90, { isFavorite: true })];
        const kept = selectPersistedRssArticles([...recent, ...favs], NOW);
        expect(kept.filter((a) => !a.isFavorite)).toHaveLength(500);
        expect(kept.map((a) => a.id)).toEqual(expect.arrayContaining(["fav-new", "fav-old"]));
    });

    it("caps by recency, not by array position", () => {
        // Newest articles appended at the end (addFeed path) must win the cap.
        const oldFirst = Array.from({ length: 500 }, (_, i) => article(`old${i}`, 20));
        const newLast = Array.from({ length: 10 }, (_, i) => article(`new${i}`, 1));
        const kept = selectPersistedRssArticles([...oldFirst, ...newLast], NOW);
        expect(kept).toHaveLength(500);
        for (let i = 0; i < 10; i++) expect(kept.some((a) => a.id === `new${i}`)).toBe(true);
    });

    it("preserves original order of kept articles", () => {
        const input = [article("b", 5), article("a", 1), article("c", 3)];
        expect(selectPersistedRssArticles(input, NOW).map((a) => a.id)).toEqual(["b", "a", "c"]);
    });

    it("keeps articles with no usable date instead of dropping them", () => {
        const undated = article("undated", null);
        expect(selectPersistedRssArticles([undated], NOW).map((a) => a.id)).toEqual(["undated"]);
    });

    it("uses fetchedAt when publishedAt is missing", () => {
        const a = article("a", null, { fetchedAt: new Date(NOW - 45 * DAY) });
        const b = article("b", null, { fetchedAt: new Date(NOW - 2 * DAY) });
        expect(selectPersistedRssArticles([a, b], NOW).map((x) => x.id)).toEqual(["b"]);
    });

    it("handles dates rehydrated as ISO strings", () => {
        const a = { ...article("a", 0), publishedAt: new Date(NOW - 40 * DAY).toISOString() } as unknown as RssArticle;
        const b = { ...article("b", 0), publishedAt: new Date(NOW - 1 * DAY).toISOString() } as unknown as RssArticle;
        expect(selectPersistedRssArticles([a, b], NOW).map((x) => x.id)).toEqual(["b"]);
    });

    it("keeps an article exactly at the 30-day boundary", () => {
        expect(selectPersistedRssArticles([article("edge", 30)], NOW)).toHaveLength(1);
    });

    it("returns an empty list for empty input", () => {
        expect(selectPersistedRssArticles([], NOW)).toEqual([]);
    });
});
