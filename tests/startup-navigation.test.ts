import { beforeEach, describe, expect, it } from 'vitest';
import { useUIStore } from '../src/core/store/uiStore';
import { restoreReaderSession } from '../src/core/lib/reader-session';

beforeEach(() => {
    useUIStore.setState({ currentRoute: 'library', currentBookId: undefined });
});

describe('launch navigation', () => {
    it('keeps navigation as session state, never persisted', () => {
        // The sidebar is a fixed rail, so the UI store has nothing worth persisting.
        // The open book and reader route must not survive a launch.
        expect((useUIStore as unknown as { persist?: unknown }).persist).toBeUndefined();
    });
    it('keeps an explicit book-opening action', () => {
        useUIStore.getState().setRoute('reader', 'requested-book', false);
        expect(useUIStore.getState().currentRoute).toBe('reader');
        expect(useUIStore.getState().currentBookId).toBe('requested-book');
    });
    it('a launch with no reader-session marker stays on the Library', () => {
        // Phones reopen a book only from their own marker (reader-session.ts),
        // written while the reader is on screen; navigation itself stays
        // unpersisted, and without that marker nothing is reopened.
        const storage = new Map<string, string>();
        let opened: string | undefined;
        const stop = restoreReaderSession({
            getRoute: () => useUIStore.getState(),
            openBook: (id) => { opened = id; },
            hasBook: () => true,
            subscribeBooks: () => () => {},
            storage: {
                getItem: (k) => storage.get(k) ?? null,
                setItem: (k, v) => { storage.set(k, v); },
                removeItem: (k) => { storage.delete(k); },
            },
        });
        stop();
        expect(opened).toBeUndefined();
        expect(useUIStore.getState().currentRoute).toBe('library');
    });
});
