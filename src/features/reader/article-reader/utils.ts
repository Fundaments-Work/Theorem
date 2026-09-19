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
    const decoded = decodeDoubleEscapedHtml(raw);
    if (looksLikeMarkdown(decoded) && !/<[a-zA-Z][^>]*>/.test(decoded)) {
        try {
            return md.render(decoded);
        } catch {
            return decoded;
        }
    }
    return decoded;
}

// Conservative detector: tag-shaped `&lt;...&gt;` escapes with no genuine
// markup present. Used for diagnostics; the decoder below handles more.
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

function decodeEntitiesOnce(value: string): string {
    return value
        .replace(/&#(\d+);/g, (_, digits: string) => {
            const code = Number(digits);
            return Number.isFinite(code) ? String.fromCharCode(code) : _;
        })
        .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&quot;/gi, '"')
        .replace(/&#39;|&apos;/gi, "'")
        .replace(/&amp;/gi, "&");
}

// Feeds arrive entity-escaped anywhere from zero to two times depending on
// transport (CDATA vs escaped text vs aggregator re-encoding), using named,
// decimal, or hex entities, sometimes mixed with genuine markup. Decode
// iteratively so `&amp;lt;` and `&#60;` converge to real tags; when genuine
// markup is already present, decode only tag-shaped entities so prose
// entities (`&amp;`) survive untouched.
export function decodeDoubleEscapedHtml(value: string): string {
    if (!value) {
        return value;
    }
    let prev = value;
    for (let i = 0; i < 3; i++) {
        let next: string;
        if (/<[a-zA-Z][^>]*>/.test(prev)) {
            next = prev
                .replace(/&lt;(\s*\/?\s*[a-zA-Z][^;]*?)&gt;/gi, "<$1>")
                .replace(/&#60;(\s*\/?\s*[a-zA-Z][^;]*?)&#62;/gi, "<$1>")
                .replace(/&amp;(lt|gt|quot|amp);/gi, "&$1;");
        } else {
            next = decodeEntitiesOnce(prev);
        }
        if (next === prev) {
            return next;
        }
        prev = next;
    }
    return prev;
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
    if (looksLikeMarkdown(processed) && !/<[a-zA-Z][^>]*>/.test(processed)) {
        try {
            processed = md.render(processed);
        } catch {
            // Keep the decoded markup on renderer failure.
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
