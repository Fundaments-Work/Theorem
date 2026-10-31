/**
 * URL scheme policy for untrusted content.
 *
 * Feed links, extracted article markup and book metadata all originate
 * off-device. Those strings end up in `href`/`src` attributes, where a
 * `javascript:` (or `vbscript:`) scheme executes code and a non-image
 * `data:` URI can smuggle an HTML payload. Every such value is filtered
 * through these predicates before it reaches the DOM.
 *
 * Relative URLs carry no scheme and are resolved against the document base
 * (or the article's own base URL) by the caller.
 */

/** Schemes a rendered link may use. */
const SAFE_LINK_SCHEMES = new Set(["http:", "https:", "mailto:", "tel:"]);

/** Schemes an image source may use. */
const SAFE_IMAGE_SCHEMES = new Set(["http:", "https:", "blob:", "theorem-cover:"]);

/**
 * `data:` URIs are inert inside `<img>` but execute when navigated to, so
 * only image payloads are allowed, and only as image sources.
 */
const DATA_IMAGE_RE =
    /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon|svg\+xml)(?:;[^,]*)?,/i;

/**
 * Reads the scheme, ignoring the control characters and spaces browsers
 * strip before parsing (`java\tscript:` is still a script URL).
 */
function schemeOf(value: string): string | null {
    const normalized = value.replace(/[\u0000-\u0020\u007f]+/g, "");
    const match = /^([a-z][a-z0-9+.-]*):/i.exec(normalized);
    return match ? `${match[1].toLowerCase()}:` : null;
}

function normalize(value: string | null | undefined): string | null {
    if (typeof value !== "string") {
        return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

/** True when `value` can be rendered as a link target without executing code. */
export function isSafeLinkUrl(value: string | null | undefined): boolean {
    const trimmed = normalize(value);
    if (trimmed === null) {
        return false;
    }
    const scheme = schemeOf(trimmed);
    return scheme === null || SAFE_LINK_SCHEMES.has(scheme);
}

/** True when `value` can be rendered as an image source. */
export function isSafeImageUrl(value: string | null | undefined): boolean {
    const trimmed = normalize(value);
    if (trimmed === null) {
        return false;
    }
    const scheme = schemeOf(trimmed);
    if (scheme === null) {
        return true;
    }
    if (scheme === "data:") {
        return DATA_IMAGE_RE.test(trimmed);
    }
    return SAFE_IMAGE_SCHEMES.has(scheme);
}

/** Attribute-aware wrapper for markup sanitizers that walk `href`/`src`. */
export function isSafeAttributeUrl(name: string, value: string | null | undefined): boolean {
    switch (name.toLowerCase()) {
        case "href":
            return isSafeLinkUrl(value);
        case "src":
            return isSafeImageUrl(value);
        default:
            return true;
    }
}

/** A cover download must use an absolute HTTP(S) URL, not an app-local scheme. */
export function remoteImageUrl(value: string): string | null {
    if (!isSafeImageUrl(value)) return null;
    try {
        const parsed = new URL(value.trim());
        return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
    } catch { return null; }
}
