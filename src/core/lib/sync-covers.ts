import { deleteCoverImage, getCoverImage, INLINE_COVER_MAX_CHARS, saveCoverDataUrl } from "./storage";
import type { Book } from "../types";

/**
 * Covers travel as their own `cover:<bookId>` docs entries, written only when
 * a cover changes. They used to be embedded (base64) in every `book:<id>`
 * entry, so each reading-progress update re-serialized and re-sent tens of KB
 * of cover per book.
 */
export const COVER_KEY_PREFIX = "cover:";
const MAX_COVER_DATA_URL_CHARS = 8_000_000;

export function coverEntryKey(bookId: string): string {
    return COVER_KEY_PREFIX + bookId;
}

function isInlineCover(coverPath?: string | null): coverPath is string {
    return typeof coverPath === "string" && coverPath.startsWith("data:") && coverPath.length < INLINE_COVER_MAX_CHARS;
}

/** What a `book:` entry may still embed: tiny inline covers (older peers show them). */
export function coverPathForBookEntry(coverPath?: string | null): string | undefined {
    return isInlineCover(coverPath) ? coverPath : undefined;
}

/** Whether this cover must travel as a separate `cover:` entry. */
export function needsCoverEntry(coverPath?: string | null, updatedAt?: string): boolean {
    return !!updatedAt || (typeof coverPath === "string" && coverPath.length > 0 && !isInlineCover(coverPath));
}

export interface CoverEntry {
    id: string;
    dataUrl: string;
    updatedAt?: string;
    removed?: boolean;
}

export function coverMarker(book: Pick<Book, "coverPath" | "coverUpdatedAt">): string {
    return book.coverUpdatedAt ? `${book.coverUpdatedAt}:${book.coverPath ?? ""}` : book.coverPath ?? "";
}

export async function buildCoverEntry(bookId: string, book?: Pick<Book, "coverPath" | "coverUpdatedAt" | "title" | "author">): Promise<string | null> {
    const removed = !!book?.coverUpdatedAt && !book.coverPath;
    let dataUrl = removed ? null : await getCoverImage(bookId);
    if (removed) {
        // Older peers understand only image data URLs. Give them the same
        // fallback appearance while new peers keep the explicit removal.
        const { buildFallbackCoverSvg } = await import("./cover-extractor");
        dataUrl = `data:image/svg+xml;utf8,${encodeURIComponent(buildFallbackCoverSvg(book!.title, book!.author))}`;
    }
    if (!dataUrl || !dataUrl.startsWith("data:image/")) return null;
    return JSON.stringify({ id: bookId, dataUrl, ...(book?.coverUpdatedAt ? { updatedAt: book.coverUpdatedAt } : {}), ...(removed ? { removed: true } : {}) });
}

export function parseCoverEntry(value: string): CoverEntry | null {
    try {
        const parsed = JSON.parse(value) as { id?: unknown; dataUrl?: unknown; updatedAt?: unknown; removed?: unknown };
        if (typeof parsed.id !== "string" || parsed.id.length === 0) return null;
        if (typeof parsed.dataUrl !== "string" || !parsed.dataUrl.startsWith("data:image/")) return null;
        if (parsed.dataUrl.length > MAX_COVER_DATA_URL_CHARS) return null;
        if (parsed.updatedAt !== undefined && (typeof parsed.updatedAt !== "string" || !Number.isFinite(Date.parse(parsed.updatedAt)))) return null;
        if (parsed.removed === true && !parsed.updatedAt) return null;
        return { id: parsed.id, dataUrl: parsed.dataUrl, ...(parsed.updatedAt ? { updatedAt: parsed.updatedAt as string } : {}), ...(parsed.removed === true ? { removed: true } : {}) };
    } catch {
        return null;
    }
}

/**
 * Store a peer's cover verbatim. Returns the new display path, or null when
 * the local cover is already identical (no write, no echo).
 */
export async function applyIncomingCover(bookId: string, dataUrl: string, removed = false): Promise<string | null> {
    if (removed) {
        await deleteCoverImage(bookId);
        return "";
    }
    const local = await getCoverImage(bookId);
    if (local === dataUrl) return null;
    return saveCoverDataUrl(bookId, dataUrl);
}
