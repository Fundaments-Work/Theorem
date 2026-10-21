import type { OpdsAcquisition, OpdsEntry } from "../../../core/types";
import { formatLabel } from "../catalog-facets";

export function formatBytes(bytes?: number): string {
    if (!bytes || bytes <= 0) return "";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function entryAuthor(entry: Pick<OpdsEntry, "authors">): string {
    // `?? []`: an entry from an older cache or a misbehaving source must never take the page down.
    return (entry.authors ?? []).filter(Boolean).join(", ");
}

/** What tapping the main button of a book should do. */
export type EntryAction =
    /** A direct, DRM-free file Theorem can import. */
    | { kind: "download"; acquisition: OpdsAcquisition }
    /** The listing is partial; the downloads are on the detail page and are loaded on demand. */
    | { kind: "partial" }
    /** Can't be fetched in-app (purchase, loan, DRM, subscription), but the website can. */
    | { kind: "website"; url?: string; reason: "buy" | "borrow" | "drm" | "subscribe" | "other" }
    /** Nothing to do: an informational entry. */
    | { kind: "none" };

export function entryAction(entry: OpdsEntry): EntryAction {
    const acquisitions = entry.acquisitions ?? [];
    if (entry.primary !== undefined) {
        const acquisition = acquisitions[entry.primary];
        if (acquisition) return { kind: "download", acquisition };
    }
    if (acquisitions.length === 0 && entry.detailHref) return { kind: "partial" };

    const first = acquisitions.find((a) => a.kind !== "sample") ?? acquisitions[0];
    if (first) {
        const reason = first.drm
            ? "drm"
            : first.kind === "buy"
              ? "buy"
              : first.kind === "borrow"
                ? "borrow"
                : first.kind === "subscribe"
                  ? "subscribe"
                  : "other";
        // The catalog's own web page is the one useful place to send someone. An acquisition link is
        // only worth following when it is itself a web page (a shop page); a DRM token or a loan
        // request is not something a browser can do anything with.
        const isPage = /^text\/html|^application\/xhtml/i.test(first.mime);
        return { kind: "website", url: entry.webUrl ?? (isPage && !first.drm ? first.href : undefined), reason };
    }
    return entry.webUrl ? { kind: "website", url: entry.webUrl, reason: "other" } : { kind: "none" };
}

export const WEBSITE_REASON_LABEL: Record<"buy" | "borrow" | "drm" | "subscribe" | "other", string> = {
    buy: "This book is for sale. Open the catalog's website to buy it.",
    borrow: "This book is a loan. Open the catalog's website to borrow it.",
    drm: "This file is protected by DRM, which Theorem cannot open.",
    subscribe: "This book needs a subscription. Open the catalog's website.",
    other: "This book is available on the catalog's website.",
};

/** "EPUB · 1.1 MB", "EPUB (Kobo) · 1 MB", "Sample · EPUB". */
export function acquisitionLabel(a: OpdsAcquisition): string {
    const parts: string[] = [];
    if (a.kind === "sample") parts.push("Sample");
    parts.push(a.format ? formatLabel(a.format) : a.mime.split("/").pop()?.toUpperCase() || "File");
    const title = a.title?.trim();
    // Titles like "EPUB (older e-readers, no images)" carry useful differences between editions.
    if (title && !/^(epub|pdf|mobi|cbz|cbr|fb2)$/i.test(title) && !parts.join(" ").toLowerCase().includes(title.toLowerCase())) {
        parts.push(title);
    }
    const size = formatBytes(a.size);
    return size ? `${parts.join(" · ")} · ${size}` : parts.join(" · ");
}

export function priceLabel(a: OpdsAcquisition): string {
    if (!a.price?.value) return "";
    const v = a.price.value;
    return a.price.currency ? `${v} ${a.price.currency}` : v;
}

/** Short badge for a card/sheet describing the entry's best format ("EPUB"), if any. */
export function entryFormatBadge(entry: OpdsEntry): string | undefined {
    const best = entry.primary !== undefined ? entry.acquisitions[entry.primary] : undefined;
    return best?.format ? formatLabel(best.format) : undefined;
}

/** A readable language name for a BCP-47 tag, falling back to the tag. */
export function languageName(tag?: string): string | undefined {
    if (!tag) return undefined;
    try {
        const name = new Intl.DisplayNames(undefined, { type: "language" }).of(tag.split(/[-_]/)[0]);
        return name || tag;
    } catch {
        return tag;
    }
}
