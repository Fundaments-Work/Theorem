import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./env";
import type { Book, Collection } from "../types";

type Membership = { id: string; bookIds: string[] };
const requests = new WeakMap<Book[], WeakMap<Collection[], Promise<Membership[]>>>();

function evaluate(books: Book[], collections: Collection[]) {
    let byCollections = requests.get(books);
    if (!byCollections) { byCollections = new WeakMap(); requests.set(books, byCollections); }
    let request = byCollections.get(collections);
    if (!request) {
        request = invoke<Membership[]>("evaluate_smart_shelves", {
            books: books.map(({ id, author, series, tags, category, format, progress, completedAt, manualCompletionState, isFavorite }) =>
                ({ id, author, series, tags, category, format, progress, completedAt, manualCompletionState, isFavorite })),
            shelves: collections.filter((shelf) => shelf.smartRules).map((shelf) => ({ id: shelf.id, definition: shelf.smartRules })),
        });
        byCollections.set(collections, request);
        // Failed requests can be retried when the view is reopened.
        void request.catch(() => byCollections?.delete(collections));
    }
    return request;
}

/** Derive native membership without writing transient IDs to persistence or sync. */
export function useSmartShelves(books: Book[], collections: Collection[]) {
    const hasSmart = collections.some((shelf) => shelf.smartRules);
    const [result, setResult] = useState<{ books: Book[]; definitions: Collection[]; memberships: Membership[]; error?: string }>();
    useEffect(() => {
        if (!hasSmart) return;
        let cancelled = false;
        if (!isTauri()) {
            setResult({ books, definitions: collections, memberships: [], error: "Smart shelves are available in the desktop and Android apps." });
            return;
        }
        const timer = setTimeout(() => {
            evaluate(books, collections).then((memberships) => {
                if (!cancelled) setResult({ books, definitions: collections, memberships });
            }, () => {
                if (!cancelled) setResult({ books, definitions: collections, memberships: [], error: "Could not update smart shelves. Reopen Shelves to retry." });
            });
        }, 50);
        return () => { cancelled = true; clearTimeout(timer); };
    }, [books, collections, hasSmart]);
    const current = result?.books === books && result.definitions === collections;
    const ready = !hasSmart || !!(current && !result?.error);
    const resolved = useMemo(() => {
        if (!hasSmart) return collections;
        const byId = new Map(current ? result?.memberships.map((item) => [item.id, item.bookIds]) : []);
        return collections.map((shelf) => shelf.smartRules ? { ...shelf, bookIds: byId.get(shelf.id) ?? [] } : shelf);
    }, [collections, current, result, hasSmart]);
    return { collections: resolved, ready, error: current ? result?.error : undefined };
}
