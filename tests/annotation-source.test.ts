import { describe, it, expect, vi } from "vitest";
import {
    parseAnnotationSourceId,
    resolveAnnotationSource,
    navigateToAnnotationSource,
} from "../src/core/lib/annotation-source";
import { getRssArticleById, getRssFeedById } from "../src/core/store/rssStore";
import type { Book, RssArticle, RssFeed } from "../src/core/types";

describe("annotation-source (Issue #124)", () => {
    const mockFeeds: RssFeed[] = [
        {
            id: "feed-1",
            title: "Tech News Daily",
            url: "https://example.com/rss",
            iconUrl: "https://example.com/icon.png",
            unreadCount: 5,
        },
    ];

    const mockArticles: RssArticle[] = [
        {
            id: "article-1",
            feedId: "feed-1",
            title: "The Future of Computing",
            author: "Ada Lovelace",
            url: "https://example.com/article-1",
            content: "<p>Deep thoughts...</p>",
            summary: "Deep thoughts",
            imageUrl: "https://example.com/cover.jpg",
            publishedAt: new Date("2026-01-01"),
            isRead: false,
            isFavorite: false,
        },
        {
            id: "article-no-author",
            feedId: "feed-1",
            title: "Anonymous Dispatch",
            url: "https://example.com/article-2",
            content: "<p>No author</p>",
            summary: "No author",
            publishedAt: new Date("2026-01-02"),
            isRead: false,
            isFavorite: false,
        },
    ];

    const mockBooks: Book[] = [
        {
            id: "book-1",
            title: "Structure and Interpretation of Computer Programs",
            author: "Harold Abelson",
            coverPath: "/covers/sicp.jpg",
            filePath: "/books/sicp.epub",
            storagePath: "/books/sicp.epub",
            format: "epub",
            createdAt: new Date("2025-01-01"),
            updatedAt: new Date("2025-01-01"),
        } as Book,
    ];

    const getBook = (id: string) => mockBooks.find((b) => b.id === id);

    describe("parseAnnotationSourceId", () => {
        it("identifies RSS articles and extracts clean ID", () => {
            expect(parseAnnotationSourceId("rss:art-42")).toEqual({
                isArticle: true,
                cleanId: "art-42",
            });
        });

        it("identifies standard books", () => {
            expect(parseAnnotationSourceId("book-123")).toEqual({
                isArticle: false,
                cleanId: "book-123",
            });
        });

        it("handles empty or boundary strings", () => {
            expect(parseAnnotationSourceId("")).toEqual({
                isArticle: false,
                cleanId: "",
            });
            expect(parseAnnotationSourceId("rss:")).toEqual({
                isArticle: true,
                cleanId: "",
            });
        });
    });

    describe("resolveAnnotationSource", () => {
        it("resolves an RSS article with author and cover", () => {
            const resolved = resolveAnnotationSource("rss:article-1", getBook, mockArticles, mockFeeds);
            expect(resolved).toBeDefined();
            expect(resolved?.id).toBe("rss:article-1");
            expect(resolved?.title).toBe("The Future of Computing");
            expect(resolved?.author).toBe("Ada Lovelace");
            expect(resolved?.coverPath).toBe("https://example.com/cover.jpg");
            expect(resolved?.isArticle).toBe(true);
            expect(resolved?.rawArticle?.id).toBe("article-1");
        });

        it("falls back to feed title and icon if article author and image are missing", () => {
            const resolved = resolveAnnotationSource("rss:article-no-author", getBook, mockArticles, mockFeeds);
            expect(resolved).toBeDefined();
            expect(resolved?.title).toBe("Anonymous Dispatch");
            expect(resolved?.author).toBe("Tech News Daily");
            expect(resolved?.coverPath).toBe("https://example.com/icon.png");
            expect(resolved?.isArticle).toBe(true);
        });

        it("gracefully falls back for pruned/missing RSS articles", () => {
            const resolved = resolveAnnotationSource("rss:deleted-article", getBook, mockArticles, mockFeeds);
            expect(resolved).toBeDefined();
            expect(resolved?.title).toBe("RSS Article");
            expect(resolved?.author).toBe("RSS Feed");
            expect(resolved?.isArticle).toBe(true);
        });

        it("resolves a regular library book", () => {
            const resolved = resolveAnnotationSource("book-1", getBook, mockArticles, mockFeeds);
            expect(resolved).toBeDefined();
            expect(resolved?.id).toBe("book-1");
            expect(resolved?.title).toBe("Structure and Interpretation of Computer Programs");
            expect(resolved?.author).toBe("Harold Abelson");
            expect(resolved?.coverPath).toBe("/covers/sicp.jpg");
            expect(resolved?.isArticle).toBe(false);
        });

        it("falls back to RSS article lookup if source ID lacks 'rss:' prefix but matches article ID", () => {
            const resolved = resolveAnnotationSource("article-1", getBook, mockArticles, mockFeeds);
            expect(resolved).toBeDefined();
            expect(resolved?.title).toBe("The Future of Computing");
            expect(resolved?.isArticle).toBe(true);
        });

        it("returns undefined when source ID does not match any book or article", () => {
            const resolved = resolveAnnotationSource("non-existent-id", getBook, mockArticles, mockFeeds);
            expect(resolved).toBeUndefined();
        });
    });

    describe("navigateToAnnotationSource", () => {
        it("sets pendingReaderLocation and opens article in reader for RSS source", () => {
            const setPendingReaderLocation = vi.fn();
            const setRoute = vi.fn();
            const openArticleInReader = vi.fn();
            const getArticle = vi.fn((id: string) => mockArticles.find((a) => a.id === id));
            const hasBook = vi.fn(() => false);

            navigateToAnnotationSource("rss:article-1", "epubcfi(/6/2[chap1]!/4/2)", {
                setPendingReaderLocation,
                setRoute,
                openArticleInReader,
                getArticle,
                hasBook,
            });

            expect(setPendingReaderLocation).toHaveBeenCalledWith("epubcfi(/6/2[chap1]!/4/2)");
            expect(openArticleInReader).toHaveBeenCalledWith(mockArticles[0]);
            expect(setRoute).not.toHaveBeenCalled();
        });

        it("sets pendingReaderLocation and sets route for standard book", () => {
            const setPendingReaderLocation = vi.fn();
            const setRoute = vi.fn();
            const openArticleInReader = vi.fn();
            const getArticle = vi.fn(() => undefined);
            const hasBook = vi.fn((id: string) => id === "book-1");

            navigateToAnnotationSource("book-1", "epubcfi(/6/4!/4/10)", {
                setPendingReaderLocation,
                setRoute,
                openArticleInReader,
                getArticle,
                hasBook,
            });

            expect(setPendingReaderLocation).toHaveBeenCalledWith("epubcfi(/6/4!/4/10)");
            expect(setRoute).toHaveBeenCalledWith("reader", "book-1");
            expect(openArticleInReader).not.toHaveBeenCalled();
        });

        it("does not call setPendingReaderLocation if location is undefined", () => {
            const setPendingReaderLocation = vi.fn();
            const setRoute = vi.fn();
            const openArticleInReader = vi.fn();
            const getArticle = vi.fn(() => undefined);
            const hasBook = vi.fn(() => true);

            navigateToAnnotationSource("book-1", undefined, {
                setPendingReaderLocation,
                setRoute,
                openArticleInReader,
                getArticle,
                hasBook,
            });

            expect(setPendingReaderLocation).not.toHaveBeenCalled();
            expect(setRoute).toHaveBeenCalledWith("reader", "book-1");
        });
    });

    describe("getRssArticleById & getRssFeedById (O(1) WeakMap lookup cache)", () => {
        it("returns article by ID and caches the lookup map", () => {
            const first = getRssArticleById(mockArticles, "article-1");
            const second = getRssArticleById(mockArticles, "article-1");
            expect(first).toBe(mockArticles[0]);
            expect(second).toBe(mockArticles[0]);
            expect(getRssArticleById(mockArticles, "unknown")).toBeUndefined();
        });

        it("returns feed by ID and caches the lookup map", () => {
            const first = getRssFeedById(mockFeeds, "feed-1");
            const second = getRssFeedById(mockFeeds, "feed-1");
            expect(first).toBe(mockFeeds[0]);
            expect(second).toBe(mockFeeds[0]);
            expect(getRssFeedById(mockFeeds, "unknown")).toBeUndefined();
        });
    });
});
