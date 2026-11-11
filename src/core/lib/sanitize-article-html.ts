import { setElementHtml } from "./sanitize";
import { isSafeAttributeUrl } from "./url-safety";
import { needsMarkdownRender, plainTextToHtml } from "./article-markdown";

export function processArticleHtml(raw: string): string {
    if (!raw) return "";
    const decoded = decodeDoubleEscapedHtml(raw);
    if (needsMarkdownRender(decoded)) {
        return plainTextToHtml(decoded);
    }
    return decoded;
}

export function looksLikeDoubleEscapedHtml(value: string): boolean {
    if (!/&lt;\s*\/?\s*[a-zA-Z][^;]*?&gt;/.test(value)) {
        return false;
    }
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
    if (needsMarkdownRender(processed)) {
        processed = plainTextToHtml(processed);
    }

    const temp = document.createElement("div");
    setElementHtml(temp, processed);

    temp
        .querySelectorAll("script, style, link[rel='stylesheet'], iframe, object, embed, form")
        .forEach((el) => el.remove());

    temp.querySelectorAll("*").forEach((el) => {
        Array.from(el.attributes).forEach((attr) => {
            const name = attr.name.toLowerCase();
            if (
                name.startsWith("on")
                || !isSafeAttributeUrl(name, attr.value)
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
