
import DOMPurify from "dompurify";
import type { Config } from "dompurify";
import { isSafeAttributeUrl } from "./url-safety";

const PURIFY_CONFIG: Config = {
    ALLOWED_TAGS: [
        "p", "br", "b", "i", "em", "strong", "a", "ul", "ol", "li",
        "blockquote", "pre", "code", "hr", "h1", "h2", "h3", "h4", "h5", "h6",
        "img", "span", "div", "table", "thead", "tbody", "tr", "th", "td",
        "dl", "dt", "dd", "q", "cite", "abbr", "sup", "sub",
    ],
    ALLOWED_ATTR: [
        "href", "target", "rel", "src", "alt", "title", "class",
        "id", "style", "width", "height", "lang",
    ],
    ALLOW_DATA_ATTR: false,
};

const UNSAFE_CSS_VALUE_RE = /url\s*\(|expression\s*\(|@import|-moz-binding|behavior\s*:/i;

let hooksRegistered = false;

function ensureSanitizeHooks(): void {
    if (hooksRegistered || typeof DOMPurify.addHook !== "function") {
        return;
    }
    hooksRegistered = true;
    DOMPurify.addHook("uponSanitizeAttribute", (_node, data) => {
        const attrName = data.attrName.toLowerCase();
        if (attrName === "href" || attrName === "src") {
            if (!isSafeAttributeUrl(attrName, data.attrValue)) {
                data.keepAttr = false;
            }
            return;
        }
        if (attrName === "style" && UNSAFE_CSS_VALUE_RE.test(data.attrValue)) {
            data.keepAttr = false;
        }
    });
}

function purify(html: string): string {
    ensureSanitizeHooks();
    return DOMPurify.sanitize(html, PURIFY_CONFIG) as string;
}

export function sanitizeHtml(html: string): string {
    return purify(html);
}

export function sanitizeHtmlForDisplay(html: string): { __html: string } {
    return { __html: purify(html) };
}

export function setElementHtml(el: HTMLElement, html: string): void {
    el.innerHTML = purify(html);
}
