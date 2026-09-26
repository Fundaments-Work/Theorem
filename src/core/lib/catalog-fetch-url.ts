import { isTauri } from "./env";

/** Route Gutenberg requests through the same-origin Pages Function in web builds. */
export function browserCatalogUrl(url: string): string {
    if (isTauri()) return url;
    try {
        const parsed = new URL(url);
        if (
            parsed.protocol === "https:" &&
            (parsed.hostname === "www.gutenberg.org" || parsed.hostname === "gutenberg.org" || parsed.hostname === "m.gutenberg.org")
        ) {
            return `/api/gutenberg?url=${encodeURIComponent(parsed.href)}`;
        }
    } catch {
        // Let fetch report an invalid URL as it normally would.
    }
    return url;
}
