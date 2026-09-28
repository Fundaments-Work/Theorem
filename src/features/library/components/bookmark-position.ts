const PDF_PAGE_PREFIX = "pdf:page:";
const ARTICLE_BOOKMARK_PREFIX = "article-bookmark:";

/**
 * Human-readable position of a bookmark, when its location encodes one:
 * PDF bookmarks carry a page, article bookmarks a 0–1 scroll fraction. EPUB
 * CFIs have no readable position (their chapter label is the bookmark text).
 */
export function bookmarkPositionLabel(bookmark: { location: string; pageNumber?: number }): string | undefined {
    if (typeof bookmark.pageNumber === "number" && bookmark.pageNumber > 0) {
        return `Page ${bookmark.pageNumber}`;
    }
    const location = bookmark.location ?? "";
    if (location.startsWith(PDF_PAGE_PREFIX)) {
        const page = Number.parseInt(location.slice(PDF_PAGE_PREFIX.length), 10);
        return Number.isFinite(page) && page > 0 ? `Page ${page}` : undefined;
    }
    if (location.startsWith(ARTICLE_BOOKMARK_PREFIX)) {
        const fraction = Number.parseFloat(location.slice(ARTICLE_BOOKMARK_PREFIX.length));
        if (!Number.isFinite(fraction)) return undefined;
        const percent = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
        return `${percent}% through`;
    }
    return undefined;
}
