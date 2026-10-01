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
): ResolvedAnnotationSource | undefined {
    if (sourceId.startsWith("rss:")) {
        const articleId = sourceId.slice(4);
        const article = getRssArticleById(articles, articleId);
        if (article) {
            const feed = getRssFeedById(feeds, article.feedId);
            return {
                id: sourceId,
                title: article.title || "Untitled Article",
                author: article.author || feed?.title || "RSS Feed",
                coverPath: article.imageUrl || feed?.iconUrl,
                isArticle: true,
                rawArticle: article,
            };
        }
        return {
            id: sourceId,
            title: "RSS Article",
            author: "RSS Feed",
            isArticle: true,
        };
    }

    const book = getBook(sourceId);
    if (book) {
        return {
            id: sourceId,
            title: book.title || "Untitled",
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
            title: article.title || "Untitled Article",
            author: article.author || feed?.title || "RSS Feed",
            coverPath: article.imageUrl || feed?.iconUrl,
            isArticle: true,
            rawArticle: article,
        };
    }

    return undefined;
}

export function navigateToAnnotationSource(
    sourceId: string,
    location: string | undefined,
    actions: {
        setPendingReaderLocation: (loc: string | undefined) => void;
        setRoute: (route: "reader", bookId?: string) => void;
        openArticleInReader: (article: RssArticle) => void;
        getArticle: (id: string) => RssArticle | undefined;
        hasBook: (id: string) => boolean;
    },
): void {
    if (location) actions.setPendingReaderLocation(location);

    const { isArticle, cleanId } = parseAnnotationSourceId(sourceId);
    if (isArticle) {
        const article = actions.getArticle(cleanId);
        if (article) {
            actions.openArticleInReader(article);
            return;
        }
    } else if (!actions.hasBook(sourceId)) {
        const article = actions.getArticle(cleanId);
        if (article) {
            actions.openArticleInReader(article);
            return;
        }
    }

    actions.setRoute("reader", sourceId);
}
