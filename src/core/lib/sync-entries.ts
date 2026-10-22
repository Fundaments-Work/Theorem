/**
 * Parse one per-item sync doc entry (`book:`, `anno:`, `collection:` ...).
 *
 * An empty value is a deletion and returns `null` quietly. Anything else that
 * is not a JSON object (or has no `id` when `requireId` is set) is reported
 * by key only, never by contents (entries carry the user's notes and
 * highlights), and returns `null`.
 */
export function parseSyncEntityEntry(
    key: string,
    value: string,
    options: { requireId?: boolean } = {},
): Record<string, unknown> | null {
    if (!value) return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(value);
    } catch {
        reportMalformedSyncEntry(key, "not valid JSON");
        return null;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        reportMalformedSyncEntry(key, "not an object");
        return null;
    }
    const entity = parsed as Record<string, unknown>;
    if (options.requireId && !entity.id) {
        reportMalformedSyncEntry(key, "no id");
        return null;
    }
    return entity;
}

/** Report a sync entry that was dropped, by key only. */
export function reportMalformedSyncEntry(key: string, reason: string): void {
    console.warn(`[sync] Ignored sync entry ${key}: ${reason}`);
}
