/**
 * Books the native startup maintenance found on disk although they were
 * flagged `syncedWithoutFile` (`db_maintenance.rs`, event
 * `library-books-healed`). It runs on a background thread after the window is
 * up, so the library has usually loaded the old flag already: clear it here,
 * or the books show as not downloaded (and a later edit writes the stale flag
 * back) until the next launch.
 */

import type { Book } from "../types";

export const HEALED_BOOKS_EVENT = "library-books-healed";
/** How long to wait for books the library has not loaded yet. */
export const HEALED_BOOKS_WAIT_MS = 30_000;

export interface HealedBook {
    id: string;
    storagePath: string;
}

export interface HealedBooksDeps {
    getBook: (id: string) => Book | undefined;
    updateBook: (id: string, updates: Partial<Book>) => void;
}

function isHealedBook(value: unknown): value is HealedBook {
    if (!value || typeof value !== "object") return false;
    const { id, storagePath } = value as Record<string, unknown>;
    return typeof id === "string" && id.length > 0 && typeof storagePath === "string" && storagePath.length > 0;
}

export function parseHealedBooks(payload: unknown): HealedBook[] {
    return Array.isArray(payload) ? payload.filter(isHealedBook) : [];
}

/**
 * Clear the flag on every listed book the library holds. Books that already
 * have it cleared are left alone (no write, no sync). Returns the books the
 * library does not hold (yet).
 */
export function applyHealedBooks(healed: HealedBook[], deps: HealedBooksDeps): HealedBook[] {
    const missing: HealedBook[] = [];
    for (const entry of healed) {
        const book = deps.getBook(entry.id);
        if (!book) {
            missing.push(entry);
            continue;
        }
        if (book.syncedWithoutFile === true) {
            deps.updateBook(entry.id, { syncedWithoutFile: false, storagePath: entry.storagePath });
        }
    }
    return missing;
}

export interface HealedBooksWatchDeps extends HealedBooksDeps {
    /** Called whenever the library may have loaded more books. */
    subscribeBooks: (listener: () => void) => () => void;
    setTimer?: (fn: () => void, ms: number) => unknown;
    clearTimer?: (handle: unknown) => void;
}

/**
 * Apply now, then again as the library loads, for books it did not hold
 * yet; stop when all are applied or after HEALED_BOOKS_WAIT_MS. Returns the
 * cleanup.
 */
export function applyHealedBooksWhenLoaded(healed: HealedBook[], deps: HealedBooksWatchDeps): () => void {
    let pending = applyHealedBooks(healed, deps);
    if (pending.length === 0) return () => {};
    const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
    const clearTimer = deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    let unsubscribe: (() => void) | null = null;
    let timer: unknown = null;
    const stop = () => {
        unsubscribe?.();
        unsubscribe = null;
        if (timer !== null) clearTimer(timer);
        timer = null;
    };
    unsubscribe = deps.subscribeBooks(() => {
        pending = applyHealedBooks(pending, deps);
        if (pending.length === 0) stop();
    });
    timer = setTimer(stop, HEALED_BOOKS_WAIT_MS);
    return stop;
}
