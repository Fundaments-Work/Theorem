import { beforeEach, describe, expect, it, vi } from 'vitest';
const storage = vi.hoisted(() => ({
    getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn(),
}));
vi.mock('../src/core/lib/persist-storage', () => ({
    deferredJsonStorage: storage,
    memoizePartialize: (_select: unknown, partialize: unknown) => partialize,
}));
import { useUIStore } from '../src/core/store/uiStore';

beforeEach(() => {
    vi.clearAllMocks();
    useUIStore.setState({ currentRoute: 'library', currentBookId: undefined, sidebarOpen: true });
});

describe('launch navigation', () => {
    it('migrates an old reader session to the library, retaining sidebar preference', async () => {
        storage.getItem.mockResolvedValue({ version: 1, state: {
            currentRoute: 'reader', currentBookId: 'problem-book', sidebarOpen: false,
        } });
        await useUIStore.persist.rehydrate();
        expect(useUIStore.getState().currentRoute).toBe('library');
        expect(useUIStore.getState().currentBookId).toBeUndefined();
        expect(useUIStore.getState().sidebarOpen).toBe(false);
    });
    it('does not persist the open book or reader route', () => {
        useUIStore.getState().setRoute('reader', 'book', false);
        expect(storage.setItem).toHaveBeenLastCalledWith('theorem-ui', {
            version: 2, state: { sidebarOpen: true },
        });
    });
    it('keeps an explicit book-opening action while preferences hydrate', async () => {
        storage.getItem.mockResolvedValue({ version: 1, state: {
            currentRoute: 'reader', currentBookId: 'old-book', sidebarOpen: false,
        } });
        useUIStore.getState().setRoute('reader', 'requested-book', false);
        await useUIStore.persist.rehydrate();
        expect(useUIStore.getState().currentRoute).toBe('reader');
        expect(useUIStore.getState().currentBookId).toBe('requested-book');
    });
});
