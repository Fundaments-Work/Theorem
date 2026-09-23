import type { VocabularyTerm } from "../types";

/**
 * What the SQLite `vocabulary` table needs after the in-memory term list
 * changed from `before` to `after`: only new/changed terms are written, and
 * terms that disappeared (deleted on another device) are removed, so the next
 * launch's SQLite→store rehydrate cannot bring them back.
 */
export function diffVocabularyForSqlite(
    before: ReadonlyArray<VocabularyTerm>,
    after: ReadonlyArray<VocabularyTerm>,
): { upserts: VocabularyTerm[]; deletes: string[] } {
    const previous = new Map<string, string>();
    for (const term of before) previous.set(term.id, JSON.stringify(term));
    const upserts: VocabularyTerm[] = [];
    const kept = new Set<string>();
    for (const term of after) {
        kept.add(term.id);
        if (previous.get(term.id) !== JSON.stringify(term)) upserts.push(term);
    }
    const deletes: string[] = [];
    for (const id of previous.keys()) if (!kept.has(id)) deletes.push(id);
    return { upserts, deletes };
}
