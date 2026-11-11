import type { RssArticle } from "../../../core/types";
import { stripHtml } from "../../../core/lib/sanitize-article-html";

export {
    decodeDoubleEscapedHtml,
    looksLikeDoubleEscapedHtml,
    processArticleHtml,
    sanitizeArticleHtml,
    selectArticleBody,
    stripHtml,
    type ArticleBodySource,
} from "../../../core/lib/sanitize-article-html";

export function formatArticleDate(date: Date | string | undefined): string {
    if (!date) {
        return "";
    }

    const parsed = date instanceof Date ? date : new Date(date);
    if (Number.isNaN(parsed.getTime())) {
        return "";
    }

    return parsed.toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
    });
}

export function buildArticleDescription(article: RssArticle): string {
    const content = article.summary || article.content;
    const plain = stripHtml(content).trim();
    if (!plain) {
        return "";
    }
    if (plain.length <= 320) {
        return plain;
    }
    return `${plain.slice(0, 317)}...`;
}
