import type { DocMetadata } from '../../../core/types';
import { normalizeAuthor } from '../../../core/lib/utils';

/**
 * Flattens a foliate metadata value into display text. EPUB packages give
 * contributors as `{ name, sortAs, role, … }` objects, names and titles as
 * language maps (`{ ne: "…", en: "…" }`) and languages as arrays, none of
 * which React can render directly.
 */
export function metadataText(value: unknown, seen: Set<object> = new Set()): string | undefined {
    if (value == null) return undefined;
    if (typeof value === 'string') {
        const text = value.replace(/\s+/g, ' ').trim();
        return text || undefined;
    }
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : undefined;
    if (typeof value !== 'object' || seen.has(value)) return undefined;
    seen.add(value);

    if (Array.isArray(value)) {
        const parts = value
            .map((item) => metadataText(item, seen))
            .filter((item): item is string => Boolean(item));
        return parts.length > 0 ? parts.join(', ') : undefined;
    }

    const record = value as Record<string, unknown>;
    if ('name' in record) return metadataText(record.name, seen);
    // Language map: the first non-empty script wins, matching the title.
    for (const entry of Object.values(record)) {
        if (typeof entry === 'string') {
            const text = metadataText(entry, seen);
            if (text) return text;
        }
    }
    return undefined;
}

/** Converts raw foliate `book.metadata` into the reader's string-only DocMetadata. */
export function toDocMetadata(meta: Record<string, unknown> | undefined | null): DocMetadata {
    const source = meta ?? {};
    const doc: DocMetadata = {
        title: metadataText(source.title) || 'Unknown Title',
        author: normalizeAuthor(source.author) || 'Unknown Author',
    };
    const optional = {
        description: metadataText(source.description),
        publisher: metadataText(source.publisher),
        language: metadataText(source.language),
        pubdate: metadataText(source.published),
        identifier: metadataText(source.identifier),
    };
    for (const [key, value] of Object.entries(optional)) {
        if (value) doc[key as keyof typeof optional] = value;
    }
    return doc;
}
