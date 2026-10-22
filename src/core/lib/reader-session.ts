/**
 * Reopen the book after the phone killed the app in the background.
 *
 * Navigation is session state (`useUIStore` is not persisted, see
 * tests/startup-navigation.test.ts): a launch starts on the Library, and the
 * open book never survives one. Android, though, ends a backgrounded app's
 * process whenever it needs the memory, and the user comes back to what they
 * see as the same session. So on phones a small marker records the book
 * while the reader is on screen; a launch soon after, from a session that
 * ended in the reader, reopens that book (at its saved position, which the
 * library store keeps). Every other launch starts on the Library as before.
 *
 * The marker is in localStorage: it is read synchronously at launch and
 * written when the reader opens and when the app is hidden (the last signal
 * before Android may kill the process).
 */

export const READER_SESSION_STORAGE_KEY = "theorem-reader-session";
/** A launch later than this after the reader was last on screen starts on the Library. */
export const READER_RESUME_WINDOW_MS = 6 * 60 * 60 * 1000;
/** How long a reopened book must stay on screen before a later launch may reopen it again. */
export const READER_RESTORE_SETTLE_MS = 15_000;
/** How long a launch waits for the library to load the book before giving up. */
export const READER_RESTORE_WAIT_MS = 10_000;
/** Clocks move backwards (manual change, time-zone sync): tolerate a little. */
const CLOCK_SKEW_MS = 5 * 60 * 1000;

export interface ReaderSessionMarker {
    bookId: string;
    /** When the reader was last known to be on screen (ms since epoch). */
    at: number;
    /**
     * Set while a launch is reopening the book, cleared once it has stayed on
     * screen. A marker still set at the next launch means that reopen never
     * settled (the reader crashed the app), so it is not tried again.
     */
    restoring?: boolean;
}

export type ReaderResumeDecision =
    | { kind: "resume"; bookId: string }
    | { kind: "library"; reason: "no-session" | "stale" | "restore-failed" };

/** Where a launch should start, given the marker the previous session left. */
export function decideReaderResume(
    marker: ReaderSessionMarker | null,
    now: number,
): ReaderResumeDecision {
    if (!marker) return { kind: "library", reason: "no-session" };
    if (marker.restoring) return { kind: "library", reason: "restore-failed" };
    const age = now - marker.at;
    if (age > READER_RESUME_WINDOW_MS || age < -CLOCK_SKEW_MS) {
        return { kind: "library", reason: "stale" };
    }
    return { kind: "resume", bookId: marker.bookId };
}

type MarkerStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function defaultStorage(): MarkerStorage | null {
    try {
        return typeof localStorage === "undefined" ? null : localStorage;
    } catch {
        return null;
    }
}

export function readReaderSessionMarker(storage: MarkerStorage | null = defaultStorage()): ReaderSessionMarker | null {
    if (!storage) return null;
    try {
        const raw = storage.getItem(READER_SESSION_STORAGE_KEY);
        if (!raw) return null;
        const value = JSON.parse(raw) as Partial<ReaderSessionMarker> | null;
        if (!value || typeof value.bookId !== "string" || value.bookId.length === 0) return null;
        if (typeof value.at !== "number" || !Number.isFinite(value.at)) return null;
        return { bookId: value.bookId, at: value.at, restoring: value.restoring === true };
    } catch {
        return null;
    }
}

export function writeReaderSessionMarker(
    marker: ReaderSessionMarker,
    storage: MarkerStorage | null = defaultStorage(),
): void {
    if (!storage) return;
    try {
        storage.setItem(READER_SESSION_STORAGE_KEY, JSON.stringify(marker));
    } catch {
        // Quota or disabled storage: the next launch simply starts on the Library.
    }
}

export function clearReaderSessionMarker(storage: MarkerStorage | null = defaultStorage()): void {
    if (!storage) return;
    try {
        storage.removeItem(READER_SESSION_STORAGE_KEY);
    } catch {
        // Nothing to clear.
    }
}

interface RouteState {
    currentRoute: string;
    currentBookId?: string;
}

export interface ReaderSessionTrackingDeps {
    getRoute: () => RouteState;
    subscribeRoute: (listener: () => void) => () => void;
    now?: () => number;
    storage?: MarkerStorage | null;
    doc?: Pick<Document, "addEventListener" | "removeEventListener" | "visibilityState"> | null;
}

/**
 * Keep the marker in step with the reader: written while a book is open,
 * refreshed when the app is hidden, removed as soon as the user leaves the
 * reader. Returns the cleanup.
 */
export function startReaderSessionTracking(deps: ReaderSessionTrackingDeps): () => void {
    const now = deps.now ?? Date.now;
    const storage = deps.storage === undefined ? defaultStorage() : deps.storage;
    const doc = deps.doc === undefined ? (typeof document === "undefined" ? null : document) : deps.doc;

    let lastRoute: string | undefined;
    let lastBookId: string | undefined;
    const record = (hidden: boolean) => {
        const { currentRoute, currentBookId } = deps.getRoute();
        if (currentRoute === "reader" && currentBookId) {
            const previous = readReaderSessionMarker(storage);
            // A reopen in progress stays marked until it settles (or the app
            // is hidden, which it only reaches if the reader did not crash it).
            const restoring = !hidden && previous?.bookId === currentBookId && previous.restoring === true;
            writeReaderSessionMarker({ bookId: currentBookId, at: now(), restoring }, storage);
        } else if (lastRoute === "reader") {
            clearReaderSessionMarker(storage);
        }
    };

    const onRouteChange = () => {
        const { currentRoute, currentBookId } = deps.getRoute();
        if (currentRoute === lastRoute && currentBookId === lastBookId) return;
        record(false);
        lastRoute = currentRoute;
        lastBookId = currentBookId;
    };
    const onVisibility = () => {
        if (doc?.visibilityState === "hidden") record(true);
    };

    // The launch route itself is not a user leaving the reader.
    lastRoute = deps.getRoute().currentRoute;
    lastBookId = deps.getRoute().currentBookId;
    if (lastRoute === "reader") record(false);

    const unsubscribe = deps.subscribeRoute(onRouteChange);
    doc?.addEventListener("visibilitychange", onVisibility);
    return () => {
        unsubscribe();
        doc?.removeEventListener("visibilitychange", onVisibility);
    };
}

export interface ReaderRestoreDeps {
    getRoute: () => RouteState;
    openBook: (bookId: string) => void;
    hasBook: (bookId: string) => boolean;
    /** Called whenever the library may have loaded more books. */
    subscribeBooks: (listener: () => void) => () => void;
    now?: () => number;
    storage?: MarkerStorage | null;
    setTimer?: (fn: () => void, ms: number) => unknown;
    clearTimer?: (handle: unknown) => void;
}

/**
 * At launch: reopen the book the previous session was reading when that
 * session ended in the reader recently, once the library has loaded it.
 * Gives up (Library stays) when the book never appears or the user has
 * navigated somewhere in the meantime. Returns the cleanup.
 */
export function restoreReaderSession(deps: ReaderRestoreDeps): () => void {
    const now = deps.now ?? Date.now;
    const storage = deps.storage === undefined ? defaultStorage() : deps.storage;
    const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
    const clearTimer = deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));

    const marker = readReaderSessionMarker(storage);
    const decision = decideReaderResume(marker, now());
    if (decision.kind !== "resume") {
        if (marker) clearReaderSessionMarker(storage);
        return () => {};
    }
    const { bookId } = decision;
    // Marked before the reader opens: if it takes the app down, the next
    // launch sees the flag and starts on the Library.
    writeReaderSessionMarker({ bookId, at: marker!.at, restoring: true }, storage);

    let done = false;
    let unsubscribeBooks: (() => void) | null = null;
    let giveUpTimer: unknown = null;
    let settleTimer: unknown = null;

    const stopWaiting = () => {
        unsubscribeBooks?.();
        unsubscribeBooks = null;
        if (giveUpTimer !== null) clearTimer(giveUpTimer);
        giveUpTimer = null;
    };
    const userMovedOn = () => {
        const { currentRoute, currentBookId } = deps.getRoute();
        return currentRoute !== "library" || currentBookId !== undefined;
    };
    const abandon = () => {
        if (done) return;
        done = true;
        stopWaiting();
        const current = readReaderSessionMarker(storage);
        if (current?.bookId === bookId && current.restoring) clearReaderSessionMarker(storage);
    };
    const tryOpen = () => {
        if (done) return;
        if (userMovedOn()) {
            abandon();
            return;
        }
        if (!deps.hasBook(bookId)) return;
        done = true;
        stopWaiting();
        deps.openBook(bookId);
        settleTimer = setTimer(() => {
            settleTimer = null;
            const { currentRoute, currentBookId } = deps.getRoute();
            const current = readReaderSessionMarker(storage);
            if (currentRoute === "reader" && currentBookId === bookId && current?.bookId === bookId) {
                writeReaderSessionMarker({ bookId, at: now(), restoring: false }, storage);
            }
        }, READER_RESTORE_SETTLE_MS);
    };

    unsubscribeBooks = deps.subscribeBooks(tryOpen);
    giveUpTimer = setTimer(abandon, READER_RESTORE_WAIT_MS);
    tryOpen();

    return () => {
        if (!done) abandon();
        if (settleTimer !== null) clearTimer(settleTimer);
        settleTimer = null;
    };
}
