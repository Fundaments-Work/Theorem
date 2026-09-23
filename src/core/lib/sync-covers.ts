import { getCoverImage, INLINE_COVER_MAX_CHARS, saveCoverDataUrl } from "./storage";

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
export function needsCoverEntry(coverPath?: string | null): boolean {
    return typeof coverPath === "string" && coverPath.length > 0 && !isInlineCover(coverPath);
}

export async function buildCoverEntry(bookId: string): Promise<string | null> {
    const dataUrl = await getCoverImage(bookId);
    if (!dataUrl || !dataUrl.startsWith("data:image/")) return null;
    return JSON.stringify({ id: bookId, dataUrl });
}

export function parseCoverEntry(value: string): { id: string; dataUrl: string } | null {
    try {
        const parsed = JSON.parse(value) as { id?: unknown; dataUrl?: unknown };
        if (typeof parsed.id !== "string" || parsed.id.length === 0) return null;
        if (typeof parsed.dataUrl !== "string" || !parsed.dataUrl.startsWith("data:image/")) return null;
        if (parsed.dataUrl.length > MAX_COVER_DATA_URL_CHARS) return null;
        return { id: parsed.id, dataUrl: parsed.dataUrl };
    } catch {
        return null;
    }
}

/**
 * Store a peer's cover verbatim. Returns the new display path, or null when
 * the local cover is already identical (no write, no echo).
 */
export async function applyIncomingCover(bookId: string, dataUrl: string): Promise<string | null> {
    const local = await getCoverImage(bookId);
    if (local === dataUrl) return null;
    return saveCoverDataUrl(bookId, dataUrl);
}
