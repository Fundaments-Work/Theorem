import type { Annotation } from '../types';
import { sqliteLoadAllAnnotations, type StoredAnnotationsLoad } from './sqlite-storage';

/**
 * Turn the native annotation load into store objects. Rust has already parsed
 * and validated every row (one payload instead of a `JSON.parse` per row);
 * what is left here is reviving the dates. Unreadable rows are reported by id,
 * never by content, instead of disappearing without a trace.
 */
export function reviveStoredAnnotations(load: StoredAnnotationsLoad | null | undefined): Annotation[] {
    const corruptIds = load?.corruptIds ?? [];
    if (corruptIds.length > 0) {
        console.warn(
            `[annotations] ${corruptIds.length} stored annotation(s) could not be read and were skipped: ${corruptIds.join(', ')}`,
        );
    }
    const stored = load?.annotations ?? [];
    const result: Annotation[] = new Array(stored.length);
    for (let index = 0; index < stored.length; index += 1) {
        const obj = stored[index] as Record<string, unknown> & { id: string };
        result[index] = {
            ...obj,
            createdAt: obj.createdAt ? new Date(obj.createdAt as string) : new Date(),
            updatedAt: obj.updatedAt ? new Date(obj.updatedAt as string) : undefined,
        } as unknown as Annotation;
    }
    return result;
}

/** Every annotation stored in SQLite (desktop and mobile). */
export async function loadStoredAnnotations(): Promise<Annotation[]> {
    return reviveStoredAnnotations(await sqliteLoadAllAnnotations());
}
