import { describe, expect, it, vi } from "vitest";
import {
    READER_RESTORE_SETTLE_MS,
    READER_RESTORE_WAIT_MS,
    READER_RESUME_WINDOW_MS,
    READER_SESSION_STORAGE_KEY,
    decideReaderResume,
    readReaderSessionMarker,
    restoreReaderSession,
    startReaderSessionTracking,
    writeReaderSessionMarker,
} from "../src/core/lib/reader-session";

const HOUR = 60 * 60 * 1000;
const T0 = Date.UTC(2026, 9, 22, 8, 0, 0);

function memoryStorage() {
    const map = new Map<string, string>();
    return {
        map,
        getItem: (k: string) => map.get(k) ?? null,
        setItem: (k: string, v: string) => void map.set(k, v),
        removeItem: (k: string) => void map.delete(k),
    };
}

/** A minimal UI store + document: what the app wires in. */
function fakeApp(initial: { currentRoute: string; currentBookId?: string } = { currentRoute: "library" }) {
    let state = { ...initial };
    const routeListeners = new Set<() => void>();
    const bookListeners = new Set<() => void>();
    const docListeners = new Set<() => void>();
    const books = new Set<string>();
    const doc = {
        visibilityState: "visible" as DocumentVisibilityState,
        addEventListener: (_: string, cb: () => void) => void docListeners.add(cb),
        removeEventListener: (_: string, cb: () => void) => void docListeners.delete(cb),
    };
    return {
        doc,
        books,
        getRoute: () => state,
        subscribeRoute: (cb: () => void) => {
            routeListeners.add(cb);
            return () => routeListeners.delete(cb);
        },
        subscribeBooks: (cb: () => void) => {
            bookListeners.add(cb);
            return () => bookListeners.delete(cb);
        },
        hasBook: (id: string) => books.has(id),
        setRoute(route: string, bookId?: string) {
            state = { currentRoute: route, currentBookId: bookId };
            for (const cb of [...routeListeners]) cb();
        },
        loadBook(id: string) {
            books.add(id);
            for (const cb of [...bookListeners]) cb();
        },
        hide() {
            doc.visibilityState = "hidden";
            for (const cb of [...docListeners]) cb();
        },
        bookListenerCount: () => bookListeners.size,
    };
}

describe("decideReaderResume", () => {
    it("fresh launch (no marker) starts on the Library", () => {
        expect(decideReaderResume(null, T0)).toEqual({ kind: "library", reason: "no-session" });
    });

    it("resumes a session that ended in the reader within the window", () => {
        expect(decideReaderResume({ bookId: "b1", at: T0 - 2 * HOUR }, T0)).toEqual({ kind: "resume", bookId: "b1" });
        expect(decideReaderResume({ bookId: "b1", at: T0 - READER_RESUME_WINDOW_MS }, T0).kind).toBe("resume");
    });

    it("treats a marker older than the window as stale", () => {
        expect(decideReaderResume({ bookId: "b1", at: T0 - READER_RESUME_WINDOW_MS - 1 }, T0))
            .toEqual({ kind: "library", reason: "stale" });
        expect(decideReaderResume({ bookId: "b1", at: T0 - 30 * 24 * HOUR }, T0).kind).toBe("library");
    });

    it("treats a marker far in the future (clock moved back) as stale, tolerating small skew", () => {
        expect(decideReaderResume({ bookId: "b1", at: T0 + 60_000 }, T0).kind).toBe("resume");
        expect(decideReaderResume({ bookId: "b1", at: T0 + 2 * HOUR }, T0)).toEqual({ kind: "library", reason: "stale" });
    });

    it("never retries a reopen that did not settle (crash-loop guard)", () => {
        expect(decideReaderResume({ bookId: "b1", at: T0 - 1000, restoring: true }, T0))
            .toEqual({ kind: "library", reason: "restore-failed" });
    });
});

describe("marker storage", () => {
    it("ignores corrupt or partial markers", () => {
        const storage = memoryStorage();
        for (const raw of ["{", "null", "[]", '{"bookId":""}', '{"bookId":"b1"}', '{"bookId":"b1","at":"x"}', '{"bookId":7,"at":1}']) {
            storage.map.set(READER_SESSION_STORAGE_KEY, raw);
            expect(readReaderSessionMarker(storage)).toBeNull();
        }
    });

    it("survives storage that throws", () => {
        const broken = {
            getItem: () => { throw new Error("denied"); },
            setItem: () => { throw new Error("quota"); },
            removeItem: () => { throw new Error("denied"); },
        };
        expect(readReaderSessionMarker(broken)).toBeNull();
        expect(() => writeReaderSessionMarker({ bookId: "b1", at: T0 }, broken)).not.toThrow();
        expect(() => restoreReaderSession({
            getRoute: () => ({ currentRoute: "library" }),
            openBook: () => { throw new Error("must not open"); },
            hasBook: () => true,
            subscribeBooks: () => () => {},
            storage: broken,
        })).not.toThrow();
    });
});

describe("tracking the reader session", () => {
    it("records the open book and refreshes it when the app is hidden", () => {
        const storage = memoryStorage();
        const app = fakeApp();
        let now = T0;
        const stop = startReaderSessionTracking({ ...app, storage, now: () => now });
        expect(readReaderSessionMarker(storage)).toBeNull();

        app.setRoute("reader", "b1");
        expect(readReaderSessionMarker(storage)).toEqual({ bookId: "b1", at: T0, restoring: false });

        now = T0 + HOUR;
        app.hide();
        expect(readReaderSessionMarker(storage)?.at).toBe(T0 + HOUR);
        stop();
    });

    it("removes the marker when the user leaves the reader", () => {
        const storage = memoryStorage();
        const app = fakeApp();
        const stop = startReaderSessionTracking({ ...app, storage, now: () => T0 });
        app.setRoute("reader", "b1");
        app.setRoute("library");
        expect(readReaderSessionMarker(storage)).toBeNull();
        // Hidden outside the reader writes nothing.
        app.hide();
        expect(readReaderSessionMarker(storage)).toBeNull();
        stop();
    });

    it("follows a switch to another book", () => {
        const storage = memoryStorage();
        const app = fakeApp();
        const stop = startReaderSessionTracking({ ...app, storage, now: () => T0 });
        app.setRoute("reader", "b1");
        app.setRoute("reader", "b2");
        expect(readReaderSessionMarker(storage)?.bookId).toBe("b2");
        stop();
    });

    it("leaves an earlier session's marker alone at launch (the restore decides)", () => {
        const storage = memoryStorage();
        writeReaderSessionMarker({ bookId: "b1", at: T0 - HOUR }, storage);
        const app = fakeApp();
        const stop = startReaderSessionTracking({ ...app, storage, now: () => T0 });
        app.setRoute("settings");
        expect(readReaderSessionMarker(storage)?.bookId).toBe("b1");
        stop();
    });
});

describe("restoring at launch", () => {
    function launch(storage: ReturnType<typeof memoryStorage>, app: ReturnType<typeof fakeApp>, now = T0) {
        vi.useFakeTimers();
        const openBook = vi.fn((id: string) => app.setRoute("reader", id));
        const stopTracking = startReaderSessionTracking({ ...app, storage, now: () => now });
        const stopRestore = restoreReaderSession({ ...app, openBook, storage, now: () => now });
        return { openBook, stop: () => { stopRestore(); stopTracking(); vi.useRealTimers(); } };
    }

    it("fresh launch: stays on the Library", () => {
        const storage = memoryStorage();
        const app = fakeApp();
        app.books.add("b1");
        const { openBook, stop } = launch(storage, app);
        expect(openBook).not.toHaveBeenCalled();
        expect(app.getRoute().currentRoute).toBe("library");
        stop();
    });

    it("after process death in the reader: reopens the same book once the library has it", () => {
        const storage = memoryStorage();
        // Previous session: reading b1, then hidden; Android killed the process.
        const previous = fakeApp();
        const stopPrevious = startReaderSessionTracking({ ...previous, storage, now: () => T0 - HOUR });
        previous.setRoute("reader", "b1");
        previous.hide();
        stopPrevious();

        const app = fakeApp();
        const { openBook, stop } = launch(storage, app);
        expect(openBook).not.toHaveBeenCalled(); // books still loading
        app.loadBook("b1");
        expect(openBook).toHaveBeenCalledWith("b1");
        expect(app.getRoute()).toEqual({ currentRoute: "reader", currentBookId: "b1" });
        expect(app.bookListenerCount()).toBe(0);

        // Still marked as a reopen until it settles…
        expect(readReaderSessionMarker(storage)?.restoring).toBe(true);
        vi.advanceTimersByTime(READER_RESTORE_SETTLE_MS);
        expect(readReaderSessionMarker(storage)).toEqual({ bookId: "b1", at: T0, restoring: false });
        stop();
    });

    it("after the user left the reader: starts on the Library", () => {
        const storage = memoryStorage();
        const previous = fakeApp();
        const stopPrevious = startReaderSessionTracking({ ...previous, storage, now: () => T0 - HOUR });
        previous.setRoute("reader", "b1");
        previous.setRoute("library");
        previous.hide();
        stopPrevious();

        const app = fakeApp();
        app.books.add("b1");
        const { openBook, stop } = launch(storage, app);
        expect(openBook).not.toHaveBeenCalled();
        stop();
    });

    it("stale marker: starts on the Library and forgets it", () => {
        const storage = memoryStorage();
        writeReaderSessionMarker({ bookId: "b1", at: T0 - READER_RESUME_WINDOW_MS - HOUR }, storage);
        const app = fakeApp();
        app.books.add("b1");
        const { openBook, stop } = launch(storage, app);
        expect(openBook).not.toHaveBeenCalled();
        expect(readReaderSessionMarker(storage)).toBeNull();
        stop();
    });

    it("a reopen that crashed the app is not tried again", () => {
        const storage = memoryStorage();
        writeReaderSessionMarker({ bookId: "b1", at: T0 - 60_000 }, storage);
        const first = fakeApp();
        first.books.add("b1");
        const crashed = launch(storage, first);
        expect(crashed.openBook).toHaveBeenCalledWith("b1");
        // The process dies before the reopen settles: no cleanup, no hide.
        vi.useRealTimers();

        const app = fakeApp();
        app.books.add("b1");
        const { openBook, stop } = launch(storage, app, T0 + 30_000);
        expect(openBook).not.toHaveBeenCalled();
        expect(readReaderSessionMarker(storage)).toBeNull();
        stop();
    });

    it("a reopened book that was then hidden normally can be resumed again", () => {
        const storage = memoryStorage();
        writeReaderSessionMarker({ bookId: "b1", at: T0 - 60_000 }, storage);
        const app = fakeApp();
        app.books.add("b1");
        const { stop } = launch(storage, app);
        app.hide();
        expect(readReaderSessionMarker(storage)?.restoring).toBe(false);
        stop();
        expect(decideReaderResume(readReaderSessionMarker(storage), T0 + HOUR).kind).toBe("resume");
    });

    it("gives up when the book never loads (deleted)", () => {
        const storage = memoryStorage();
        writeReaderSessionMarker({ bookId: "gone", at: T0 - 60_000 }, storage);
        const app = fakeApp();
        const { openBook, stop } = launch(storage, app);
        vi.advanceTimersByTime(READER_RESTORE_WAIT_MS);
        app.loadBook("gone"); // too late
        expect(openBook).not.toHaveBeenCalled();
        expect(readReaderSessionMarker(storage)).toBeNull();
        expect(app.bookListenerCount()).toBe(0);
        stop();
    });

    it("does not override a navigation that happened while the library loaded", () => {
        const storage = memoryStorage();
        writeReaderSessionMarker({ bookId: "b1", at: T0 - 60_000 }, storage);
        const app = fakeApp();
        const { openBook, stop } = launch(storage, app);
        app.setRoute("reader", "opened-with-file");
        app.loadBook("b1");
        expect(openBook).not.toHaveBeenCalled();
        expect(app.getRoute().currentBookId).toBe("opened-with-file");
        stop();
    });

    it("cleanup before the book loads stops waiting", () => {
        const storage = memoryStorage();
        writeReaderSessionMarker({ bookId: "b1", at: T0 - 60_000 }, storage);
        const app = fakeApp();
        const { openBook, stop } = launch(storage, app);
        stop();
        app.loadBook("b1");
        expect(openBook).not.toHaveBeenCalled();
        expect(app.bookListenerCount()).toBe(0);
    });
});
