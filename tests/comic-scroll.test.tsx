import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { comicBookForFlow, ComicFlowController, COMIC_SCROLL_CSS } from '../src/features/reader/engines/comic-flow';
import { ReaderSettings } from '../src/features/reader/components/ReaderSettings';
import type { ReaderSettings as Settings, ReadingFlow } from '../src/core/types';


const book = Object.freeze({ rendition: Object.freeze({ layout: 'pre-paginated', spread: 'none' }) });
function view() {
    const instance = {
        isFixedLayout: true,
        renderer: { setStyles: vi.fn() },
        close: vi.fn(),
        open: vi.fn(async (next: typeof book) => { instance.isFixedLayout = next.rendition.layout === 'pre-paginated'; }),
        goTo: vi.fn(async () => {}),
    };
    return instance;
}
describe('comic renderer switching', () => {
    it('uses responsive scrolling without mutating the cached book', () => {
        expect(comicBookForFlow(book, 'scroll').rendition).toEqual({ layout: 'reflowable', spread: 'none', comicFlow: 'scroll' });
        expect(comicBookForFlow(book, 'paged').rendition.layout).toBe('pre-paginated');
        expect(book.rendition.layout).toBe('pre-paginated');
    });
    it('preserves the page in both directions and avoids rebuilding an unchanged mode', async () => {
        const controller = new ComicFlowController();
        const current = view();
        let flow: ReadingFlow = 'scroll';
        const configure = vi.fn();
        const ensure = () => controller.ensure(current, book, () => flow, 12, configure, () => true);
        expect(await ensure()).toBe(true);
        expect(current.goTo).toHaveBeenLastCalledWith(12);
        expect(current.renderer.setStyles).toHaveBeenCalledWith(COMIC_SCROLL_CSS);
        expect(current.isFixedLayout).toBe(false);
        expect(await ensure()).toBe(false);
        expect(current.close).toHaveBeenCalledTimes(1);
        flow = 'paged';
        expect(await ensure()).toBe(true);
        expect(current.isFixedLayout).toBe(true);
        expect(current.goTo).toHaveBeenLastCalledWith(12);
        expect(configure).toHaveBeenCalledTimes(2);
    });
    it('serializes rapid changes and settles at the latest mode', async () => {
        const controller = new ComicFlowController();
        const current = view();
        const originalOpen = current.open.getMockImplementation()!;
        let release!: () => void;
        current.open.mockImplementationOnce(async next => {
            await new Promise<void>(resolve => { release = resolve; });
            await originalOpen(next);
        });
        let flow: ReadingFlow = 'scroll';
        const first = controller.ensure(current, book, () => flow, 4, vi.fn(), () => true);
        flow = 'paged';
        const second = controller.ensure(current, book, () => flow, 4, vi.fn(), () => true);
        expect(first).toBe(second);
        release();
        await first;
        expect(current.open).toHaveBeenCalledTimes(2);
        expect(current.isFixedLayout).toBe(true);
        expect(current.goTo).toHaveBeenLastCalledWith(4);
    });
    it('does not navigate a disposed view or block its replacement', async () => {
        const controller = new ComicFlowController();
        const old = view();
        let release!: () => void;
        old.open.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
        let alive = true;
        const pending = controller.ensure(old, book, () => 'scroll', 5, vi.fn(), () => alive);
        alive = false;
        const replacement = view();
        await controller.ensure(replacement, book, () => 'scroll', -1, vi.fn(), () => true);
        expect(replacement.goTo).toHaveBeenCalledWith(0);
        release();
        await pending;
        expect(old.goTo).not.toHaveBeenCalled();
    });
    it('allows retry after a renderer fails to open', async () => {
        const controller = new ComicFlowController();
        const current = view();
        current.open.mockRejectedValueOnce(new Error('renderer failed'));
        const ensure = () => controller.ensure(current, book, () => 'scroll', 0, vi.fn(), () => true);
        await expect(ensure()).rejects.toThrow('renderer failed');
        await expect(ensure()).resolves.toBe(true);
        expect(current.goTo).toHaveBeenCalledTimes(1);
    });
});

describe('comic reading settings', () => {
    it.each(['cbr', 'cbz'] as const)('allows selecting Scroll for %s', format => {
        const onUpdate = vi.fn();
        const settings = { flow: 'paged', theme: 'light', zoom: 100, brightness: 100 } as Settings;
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        const host = document.createElement('div');
        document.body.append(host);
        const root = createRoot(host);
        try {
            act(() => root.render(<ReaderSettings settings={settings} visible onClose={vi.fn()} onUpdate={onUpdate} format={format} />));
            const button = (name: string) => [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === name)!;
            act(() => button('Layout').click());
            const scroll = button('Scroll');
            expect(scroll).toBeDefined();
            expect(scroll.disabled).toBe(false);
            act(() => scroll.click());
            expect(onUpdate).toHaveBeenCalledWith({ flow: 'scroll' });
        } finally {
            act(() => root.unmount());
            host.remove();
        }
    });
});
