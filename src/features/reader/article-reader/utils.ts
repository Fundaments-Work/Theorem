import type { RssArticle } from "../../../core/types";
import MarkdownIt from "markdown-it";
import { setElementHtml } from "../../../core/lib/sanitize";

const md = new MarkdownIt({ html: true, linkify: true, breaks: true });

function looksLikeMarkdown(text: string): boolean {
    if (!text || text.length < 3) return false;
    return /^#{1,6}\s/m.test(text)
        || /^\s*[-*+]\s/m.test(text)
        || /\*\*[^*]+\*\*/.test(text)
        || /\[.+?\]\(.+?\)/.test(text)
        || /^>\s/m.test(text)
        || /`{3}[\s\S]*?`{3}/.test(text)
        || /^\s*\d+[.)]\s/m.test(text)
        || /~~.+?~~/.test(text);
}

export function processArticleHtml(raw: string): string {
    if (!raw) return "";
    if (looksLikeMarkdown(raw) && !/<[a-zA-Z][^>]*>/.test(raw)) {
        try {
            return md.render(raw);
        } catch {
            return raw;
        }
    }
    return raw;
}

export function looksLikeDoubleEscapedHtml(value: string): boolean {
    if (!/&lt;\s*\/?\s*[a-zA-Z][^;]*?&gt;/.test(value)) {
        return false;
    }
    // Genuine markup present → not double-escaped, leave entities alone.
    if (/<[a-zA-Z][^>]*>/.test(value)) {
        return false;
    }
    return true;
}

export function decodeDoubleEscapedHtml(value: string): string {
    if (!value || !looksLikeDoubleEscapedHtml(value)) {
        return value;
    }
    return value
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, "&");
}

export interface ArticleBodySource {
    fullContent?: string | null;
    content?: string | null;
    summary?: string | null;
}

export function selectArticleBody(article: ArticleBodySource | null | undefined): string {
    if (!article) return "";
    return article.fullContent || article.content || article.summary || "";
}

export function sanitizeArticleHtml(html: string): string {
    if (!html) {
        return "";
    }

    let processed = decodeDoubleEscapedHtml(html);
    if (looksLikeMarkdown(html) && !/<[a-zA-Z][^>]*>/.test(html)) {
        try {
            processed = md.render(html);
        } catch {
            processed = html;
        }
    }

    const temp = document.createElement("div");
    setElementHtml(temp, processed);

    temp
        .querySelectorAll("script, style, link[rel='stylesheet'], iframe, object, embed, form")
        .forEach((el) => el.remove());

    temp.querySelectorAll("*").forEach((el) => {
        Array.from(el.attributes).forEach((attr) => {
            const name = attr.name.toLowerCase();
            const value = attr.value.toLowerCase();
            if (
                name.startsWith("on")
                || (name === "href" && value.startsWith("javascript:"))
                || (name === "src" && value.startsWith("javascript:"))
                || name === "style"
                || name === "class"
                || name === "width"
                || name === "height"
                || name === "bgcolor"
                || name === "color"
                || name === "face"
            ) {
                el.removeAttribute(attr.name);
            }
        });
    });

    temp.querySelectorAll("a").forEach((link) => {
        link.setAttribute("target", "_blank");
        link.setAttribute("rel", "noopener noreferrer");
    });

    temp.querySelectorAll("img").forEach((img) => {
        img.setAttribute("loading", "lazy");
    });

    return temp.innerHTML;
}

export function stripHtml(value: string): string {
    const temp = document.createElement("div");
    setElementHtml(temp, value);
    return temp.textContent || temp.innerText || "";
}

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
