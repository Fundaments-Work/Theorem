import { useEffect, useMemo, useRef, useState } from "react";
import { isTauri } from "../env";
import { createFuzzyRanker, type RankFields, type RankedMatch } from "./native-rank";

export interface UseFuzzyRankOptions {
    limit?: number;
    /**
     * Wait this long after the last change before ranking. Defaults to 100 ms
     * on desktop/Android (each ranking is an IPC round trip) and 0 in the
     * browser (the WebAssembly matcher runs in-process).
     */
    debounceMs?: number;
}

interface Settled<T> {
    items: readonly T[];
    query: string;
    /** `null` when no matcher could run: show the list unfiltered. */
    ranked: RankedMatch<T>[] | null;
}

/**
 * Ranks `items` for a search box with the native (Rust) matcher.
 *
 * Returns `null` when there is nothing to rank by (empty query), when the
 * first answer for a query has not arrived yet, or when no matcher could run:
 * callers then show their usual, unfiltered list. While a newer query is in
 * flight the previous ranking stays, minus items no longer in `items`.
 *
 * `fields` may be a fresh function on every render; only `items`, `query`
 * and the options trigger a new ranking.
 */
export function useFuzzyRank<T>(
    items: readonly T[],
    query: string,
    fields: (item: T) => RankFields,
    options: UseFuzzyRankOptions = {},
): RankedMatch<T>[] | null {
    const fieldsRef = useRef(fields);
    fieldsRef.current = fields;
    const rankerRef = useRef<ReturnType<typeof createFuzzyRanker> | null>(null);
    if (!rankerRef.current) rankerRef.current = createFuzzyRanker();
    const [settled, setSettled] = useState<Settled<T> | null>(null);

    const trimmed = query.trim();
    const { limit } = options;
    const debounceMs = options.debounceMs ?? (isTauri() ? 100 : 0);

    useEffect(() => {
        const ranker = rankerRef.current!;
        if (!trimmed) {
            ranker.cancel();
            setSettled(null);
            return;
        }
        const run = () => {
            ranker.rank(items, trimmed, fieldsRef.current, limit).then(
                (ranked) => {
                    if (ranked) setSettled({ items, query: trimmed, ranked });
                },
                () => setSettled({ items, query: trimmed, ranked: null }),
            );
        };
        if (debounceMs <= 0) {
            run();
            return;
        }
        const timer = setTimeout(run, debounceMs);
        return () => clearTimeout(timer);
    }, [items, trimmed, limit, debounceMs]);

    useEffect(() => () => rankerRef.current?.cancel(), []);

    return useMemo(() => {
        if (!trimmed || !settled || !settled.ranked) return null;
        if (settled.items === items) return settled.ranked;
        // An older ranking while the new one is on its way: keep only items that still exist.
        const present = new Set<T>(items);
        return settled.ranked.filter((match) => present.has(match.item));
    }, [trimmed, settled, items]);
}
