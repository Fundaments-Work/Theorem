/**
 * Fuzzy ranking for in-app search boxes (annotations, bookmarks, shelves,
 * vocabulary, catalog lists), done by the Rust nucleo matcher rather than in
 * JavaScript:
 *
 * - Desktop/Android: the `fuzzy_rank_candidates` Tauri command.
 * - Browser build (or a failed native call): the same matcher compiled to
 *   WebAssembly (`wasmFuzzyRank` from theorem-core).
 *
 * The matcher knows two fields per item, a primary and a secondary one (it
 * calls them title and author); every query word must match one of them.
 * Callers that search more fields join the lesser ones into `secondary`.
 *
 * Ordering: best match first; equal scores keep the input order.
 *
 * Framework-free on purpose: the React hook in `useFuzzyRank.ts` is a thin
 * wrapper, so the UI rewrite can reuse this as is.
 */

import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "../env";
import { initTheoremCoreWasm, isWasmCoreReady, wasmFuzzyRank } from "../theorem-core";

export interface RankFields {
    /** The field that matters most (a title, a highlight's text, a term). */
    primary: string;
    /** Everything else worth matching, joined (author, note, description...). */
    secondary?: string;
}

export interface RankedMatch<T> {
    item: T;
    /** Higher is better. Only comparable within one query. */
    score: number;
    /** Matched character positions (UTF-32 code points) in `primary`, for highlighting. */
    primaryIndices: number[];
    /** Matched character positions in `secondary`. */
    secondaryIndices: number[];
}

export class FuzzyRankUnavailableError extends Error {
    constructor() {
        super("Neither the native nor the WebAssembly fuzzy matcher is available");
        this.name = "FuzzyRankUnavailableError";
    }
}

interface WireCandidate {
    id: string;
    title: string;
    author?: string;
}

interface WireResult {
    id: string;
    score: number;
    titleIndices: number[];
    authorIndices: number[];
}

/** Separator for joined secondary fields, so a match cannot run from one field into the next. */
export const FIELD_SEPARATOR = " · ";

/** Joins the non-empty parts of several lesser fields into one `secondary` value. */
export function joinFields(...parts: Array<string | null | undefined>): string {
    return parts.filter((p): p is string => !!p && p.trim().length > 0).join(FIELD_SEPARATOR);
}

async function rankNative(candidates: WireCandidate[], query: string, limit: number): Promise<WireResult[]> {
    return (await invoke("fuzzy_rank_candidates", { candidates, query, limit })) as WireResult[];
}

async function rankWasm(candidates: WireCandidate[], query: string): Promise<WireResult[]> {
    if (!isWasmCoreReady() && !(await initTheoremCoreWasm())) {
        throw new FuzzyRankUnavailableError();
    }
    return wasmFuzzyRank(candidates, query);
}

/**
 * Ranks `items` against `query`. An empty query returns every item, in order,
 * with score 0. Rejects with `FuzzyRankUnavailableError` only when neither
 * matcher can run; callers then show the list unfiltered.
 */
export async function rankByNativeFuzzy<T>(
    items: readonly T[],
    query: string,
    fields: (item: T) => RankFields,
    limit?: number,
): Promise<RankedMatch<T>[]> {
    const trimmed = query.trim();
    const max = typeof limit === "number" && limit > 0 ? limit : items.length;
    if (!trimmed) {
        return items.slice(0, max).map((item) => ({ item, score: 0, primaryIndices: [], secondaryIndices: [] }));
    }
    if (items.length === 0) return [];

    // The candidate id is the item's position: no lookup map, and it gives the tie order.
    const candidates: WireCandidate[] = items.map((item, i) => {
        const f = fields(item);
        return f.secondary ? { id: String(i), title: f.primary, author: f.secondary } : { id: String(i), title: f.primary };
    });

    let results: WireResult[];
    if (isTauri()) {
        try {
            results = await rankNative(candidates, trimmed, items.length);
        } catch {
            results = await rankWasm(candidates, trimmed);
        }
    } else {
        results = await rankWasm(candidates, trimmed);
    }

    const ranked: Array<RankedMatch<T> & { index: number }> = [];
    for (const r of results) {
        const index = Number(r.id);
        if (!Number.isInteger(index) || index < 0 || index >= items.length) continue;
        ranked.push({
            item: items[index],
            index,
            score: r.score,
            primaryIndices: r.titleIndices ?? [],
            secondaryIndices: r.authorIndices ?? [],
        });
    }
    // Both matchers sort stably already; sorting here keeps the contract whatever the backend does.
    ranked.sort((a, b) => b.score - a.score || a.index - b.index);
    return ranked.slice(0, max).map(({ index: _index, ...match }) => match);
}

export interface FuzzyRanker {
    /** Resolves with the ranking, or `null` when a newer `rank`/`cancel` call superseded it. */
    rank<T>(items: readonly T[], query: string, fields: (item: T) => RankFields, limit?: number): Promise<RankedMatch<T>[] | null>;
    /** Makes every pending `rank` call resolve to `null`. */
    cancel(): void;
}

/** A ranker whose answers are dropped once a newer query was asked: no stale results on screen. */
export function createFuzzyRanker(): FuzzyRanker {
    let generation = 0;
    return {
        async rank(items, query, fields, limit) {
            const mine = ++generation;
            try {
                const ranked = await rankByNativeFuzzy(items, query, fields, limit);
                return mine === generation ? ranked : null;
            } catch (error) {
                if (mine !== generation) return null;
                throw error;
            }
        },
        cancel() {
            generation++;
        },
    };
}
