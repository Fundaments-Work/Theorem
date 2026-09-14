const DEFAULT_FUZZY_THRESHOLD = 0.34;
const DEFAULT_MIN_MATCH_CHAR_LENGTH = 2;

export type FuseOptionKey<T> =
    | keyof T
    | string
    | { name: string; weight?: number }
    | string[];

export interface RankByFuzzyQueryOptions<T> {
    keys: Array<FuseOptionKey<T>>;
    threshold?: number;
    minMatchCharLength?: number;
    ignoreLocation?: boolean;
    limit?: number;
}

export interface RankedFuzzyItem<T> {
    item: T;
    score: number;
}

interface ParsedKey {
    name: string;
    weight: number;
}

function parseKeys<T>(keys: Array<FuseOptionKey<T>>): ParsedKey[] {
    return keys.map((k) => {
        if (typeof k === "string") {
            return { name: k, weight: 1.0 };
        }
        if (typeof k === "object" && k !== null) {
            if ("name" in k && typeof (k as { name?: unknown }).name === "string") {
                const weightedKey = k as { name: string; weight?: number };
                return {
                    name: weightedKey.name,
                    weight: typeof weightedKey.weight === "number" && weightedKey.weight > 0 ? weightedKey.weight : 1.0,
                };
            }
            if (Array.isArray(k) && typeof k[0] === "string") {
                return { name: k.join("."), weight: 1.0 };
            }
        }
        return { name: String(k), weight: 1.0 };
    });
}

function extractFieldValue(item: unknown, keyPath: string): string {
    if (item == null) return "";
    if (typeof item !== "object") return String(item);

    const parts = keyPath.split(".");
    let current: unknown = item;
    for (const part of parts) {
        if (current == null || typeof current !== "object") return "";
        current = (current as Record<string, unknown>)[part];
    }

    if (current == null) return "";
    if (typeof current === "string") return current;
    if (typeof current === "number" || typeof current === "boolean") return String(current);
    if (Array.isArray(current)) {
        return current
            .map((elem) => {
                if (elem == null) return "";
                if (typeof elem === "object") {
                    if ("name" in elem && typeof (elem as { name?: unknown }).name === "string") {
                        return (elem as { name: string }).name;
                    }
                    return JSON.stringify(elem);
                }
                return String(elem);
            })
            .join(" ");
    }
    if (typeof current === "object") {
        if ("name" in current && typeof (current as { name?: unknown }).name === "string") {
            return (current as { name: string }).name;
        }
    }
    return String(current);
}

function escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function scoreFieldMatch(fieldVal: string, query: string): number | null {
    const text = fieldVal.toLowerCase();
    const q = query.toLowerCase();

    if (!text || !q) return null;

    // 1. Exact match
    if (text === q) {
        return 0.001;
    }

    // 2. Prefix match
    if (text.startsWith(q)) {
        return 0.03 + 0.03 * (1 - q.length / text.length);
    }

    // 3. Word boundary match
    const wordBoundaryRegex = new RegExp(`(?:^|\\s|[-_/])${escapeRegex(q)}`);
    const wordBoundaryIdx = text.search(wordBoundaryRegex);
    if (wordBoundaryIdx !== -1) {
        return 0.06 + 0.04 * Math.min(1, wordBoundaryIdx / 50);
    }

    // 4. Substring match
    const subIdx = text.indexOf(q);
    if (subIdx !== -1) {
        return 0.10 + 0.08 * Math.min(1, subIdx / 50);
    }

    // 5. Multi-token match
    const tokens = q.split(/\s+/).filter(Boolean);
    if (tokens.length > 1) {
        let allMatched = true;
        let tokenScoreSum = 0;
        for (const token of tokens) {
            const tokenScore = scoreFieldMatch(text, token);
            if (tokenScore === null) {
                allMatched = false;
                break;
            }
            tokenScoreSum += tokenScore;
        }
        if (allMatched) {
            return Math.min(0.25, 0.10 + (tokenScoreSum / tokens.length) * 0.5);
        }
    }

    // 6. Fuzzy subsequence match
    if (q.length >= 3) {
        let qi = 0;
        let ti = 0;
        const matchedIndices: number[] = [];
        while (qi < q.length && ti < text.length) {
            if (q[qi] === text[ti]) {
                matchedIndices.push(ti);
                qi++;
            }
            ti++;
        }
        if (qi === q.length) {
            const span = matchedIndices[matchedIndices.length - 1] - matchedIndices[0] + 1;
            const density = q.length / span;
            return 0.18 + 0.12 * (1 - density);
        }
    }

    return null;
}

export function rankByFuzzyQuery<T>(
    items: T[],
    query: string,
    options: RankByFuzzyQueryOptions<T>,
): RankedFuzzyItem<T>[] {
    const normalizedQuery = query.trim();
    if (!normalizedQuery || items.length === 0) {
        return items.map((item) => ({ item, score: 0 }));
    }

    const minMatchCharLength = options.minMatchCharLength ?? DEFAULT_MIN_MATCH_CHAR_LENGTH;
    if (normalizedQuery.length < minMatchCharLength) {
        return items.map((item) => ({ item, score: 0 }));
    }

    const threshold = options.threshold ?? DEFAULT_FUZZY_THRESHOLD;
    const parsedKeys = parseKeys(options.keys);

    const scoredItems: RankedFuzzyItem<T>[] = [];

    for (const item of items) {
        let bestScore: number | null = null;

        for (const { name, weight } of parsedKeys) {
            const fieldValue = extractFieldValue(item, name);
            if (!fieldValue) continue;

            const fieldScore = scoreFieldMatch(fieldValue, normalizedQuery);
            if (fieldScore !== null && fieldScore <= threshold) {
                const weightedScore = fieldScore / (1 + weight);
                if (bestScore === null || weightedScore < bestScore) {
                    bestScore = weightedScore;
                }
            }
        }

        if (bestScore !== null) {
            scoredItems.push({
                item,
                score: bestScore,
            });
        }
    }

    scoredItems.sort((a, b) => a.score - b.score);

    if (typeof options.limit === "number" && options.limit > 0) {
        return scoredItems.slice(0, options.limit);
    }

    return scoredItems;
}
