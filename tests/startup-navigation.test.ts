import { beforeEach, describe, expect, it } from 'vitest';
import { useUIStore } from '../src/core/store/uiStore';

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
});
