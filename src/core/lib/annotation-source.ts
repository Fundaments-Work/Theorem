import type { Book, RssArticle, RssFeed } from "../types";
import { getRssArticleById, getRssFeedById } from "../store";

export interface ResolvedAnnotationSource {
    id: string;
    title: string;
    author: string;
    coverPath?: string;
    isArticle: boolean;
    rawArticle?: RssArticle;
}

export function parseAnnotationSourceId(sourceId: string): { isArticle: boolean; cleanId: string } {
    if (sourceId.startsWith("rss:")) {
        return { isArticle: true, cleanId: sourceId.slice(4) };
    }
    return { isArticle: false, cleanId: sourceId };
}

export function resolveAnnotationSource(
    sourceId: string,
    getBook: (id: string) => Book | undefined,
    articles: RssArticle[],
    feeds: RssFeed[],
    fallbackTitle?: string,
): ResolvedAnnotationSource | undefined {
    if (sourceId.startsWith("rss:")) {
        const articleId = sourceId.slice(4);
        const article = getRssArticleById(articles, articleId);
        if (article) {
            const feed = getRssFeedById(feeds, article.feedId);
            return {
                id: sourceId,
                title: article.title || fallbackTitle || "Untitled Article",
                author: article.author || feed?.title || "RSS Feed",
                coverPath: article.imageUrl || feed?.iconUrl,
                isArticle: true,
                rawArticle: article,
            };
        }
        return {
            id: sourceId,
            title: fallbackTitle || "RSS Article",
            author: "RSS Feed",
            isArticle: true,
        };
    }

    const book = getBook(sourceId);
    if (book) {
        return {
            id: sourceId,
            title: book.title || fallbackTitle || "Untitled",
            author: book.author || "Unknown Author",
            coverPath: book.coverPath,
            isArticle: false,
        };
    }

    // Fallback: check if the id directly matches an RSS article ID
    const article = getRssArticleById(articles, sourceId);
    if (article) {
        const feed = getRssFeedById(feeds, article.feedId);
        return {
            id: sourceId,
            title: article.title || fallbackTitle || "Untitled Article",
            author: article.author || feed?.title || "RSS Feed",
            coverPath: article.imageUrl || feed?.iconUrl,
            isArticle: true,
            rawArticle: article,
        };
    }

    // If sourceId is not a book, but fallbackTitle exists, resolve as article
    if (fallbackTitle) {
        return {
            id: sourceId,
            title: fallbackTitle,
            author: "RSS Feed",
            isArticle: true,
        };
    }

    return undefined;
}

export async function navigateToAnnotationSource(
    sourceId: string,
    location: string | undefined,
    actions: {
        setPendingReaderLocation: (loc: string | undefined) => void;
        setRoute: (route: "reader", bookId?: string) => void;
        openArticleInReader: (article: RssArticle) => void;
        getArticle: (id: string) => RssArticle | undefined;
        loadArticle?: (id: string) => Promise<RssArticle | undefined>;
        hasBook: (id: string) => boolean;
        fallbackTitle?: string;
    },
): Promise<void> {
    if (location) actions.setPendingReaderLocation(location);

    const { isArticle, cleanId } = parseAnnotationSourceId(sourceId);
    if (isArticle) {
        let article = actions.getArticle(cleanId);
        if (!article && actions.loadArticle) {
            article = await actions.loadArticle(cleanId);
        }
        if (article) {
            actions.openArticleInReader(article);
            return;
        }
        // Fallback stub article so Reader doesn't fail with "Book not found in library"
        const stubArticle: RssArticle = {
            id: cleanId,
            feedId: "",
            title: actions.fallbackTitle || "RSS Article",
            url: "",
            content: "",
            fetchedAt: new Date(),
            isRead: true,
            isFavorite: false,
            isSaved: false,
        };
        actions.openArticleInReader(stubArticle);
        return;
    }

    if (!actions.hasBook(sourceId)) {
        let article = actions.getArticle(cleanId);
        if (!article && actions.loadArticle) {
            article = await actions.loadArticle(cleanId);
        }
        if (article) {
            actions.openArticleInReader(article);
            return;
        }
        if (actions.fallbackTitle) {
            const stubArticle: RssArticle = {
                id: cleanId,
                feedId: "",
                title: actions.fallbackTitle,
                url: "",
                content: "",
                fetchedAt: new Date(),
                isRead: true,
                isFavorite: false,
                isSaved: false,
            };
            actions.openArticleInReader(stubArticle);
            return;
        }
    }

    actions.setRoute("reader", sourceId);
}
