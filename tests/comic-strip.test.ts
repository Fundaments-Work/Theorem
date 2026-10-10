import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ComicStrip } from '../src/features/reader/engines/comic-strip';
import '../src/features/reader/foliate-js-runtime/view.js';

let strip: ComicStrip;
let inFlight = 0, maximum = 0;
let width = 500, height = 1000;
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const scroller = () => strip.shadowRoot!.querySelector<HTMLDivElement>('.strip')!;
const pageHeight = (page: Element) => {
    const ratio = (page as HTMLElement).style.aspectRatio;
    const dimensions = ratio.split('/').map(Number);
    return dimensions.length === 2 ? 500 * dimensions[1] / dimensions[0] : 1000;
};
beforeEach(() => {
    inFlight = maximum = 0; width = 500; height = 1000;
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(function () {
        let offset = 0;
        for (let previous = this.previousElementSibling; previous; previous = previous.previousElementSibling) offset += pageHeight(previous);
        return offset;
    });
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function () { return pageHeight(this); });
    vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(600);
    vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockImplementation(function () {
        return [...this.children].reduce((sum, page) => sum + pageHeight(page), 0);
    });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ text: async () => `<img src="blob:image-${url.split('-').at(-1)}">` })));
    vi.spyOn(HTMLImageElement.prototype, 'src', 'set').mockImplementation(function (src) {
        this.setAttribute('src', src);
        Object.defineProperties(this, { naturalWidth: { value: width }, naturalHeight: { value: height } });
        queueMicrotask(() => { inFlight--; this.dispatchEvent(new Event('load')); });
    });
    strip = new ComicStrip(); document.body.append(strip);
});
afterEach(() => { strip.destroy(); strip.remove(); vi.unstubAllGlobals(); });
function book(count = 30) {
    return {
        metadata: { title: 'Test comic' },
        rendition: { layout: 'reflowable', comicFlow: 'scroll' },
        sections: Array.from({ length: count }, (_, index) => ({
            id: `page-${index}`, size: 200,
            load: vi.fn(async () => { maximum = Math.max(maximum, ++inFlight); return `blob:page-${index}`; }),
            unload: vi.fn(),
        })),
        toc: [], splitTOCHref: (href: string) => [href, null], getTOCFragment: (doc: Document) => doc.documentElement,
        resolveHref: (href: string) => ({ index: Number(href.split('-').at(-1)) }),
    };
}
describe('continuous comic strip', () => {
    it('keeps all pages in one ordered scroll surface and decodes only nearby images', async () => {
        const comic = book(100);
        strip.open(comic);
        await strip.goTo({ index: 0 }); await tick();
        expect(scroller().children.length).toBe(100);
        expect([...scroller().children].map(p => (p as HTMLElement).dataset.page)).toEqual(Array.from({ length: 100 }, (_, i) => String(i)));
        expect(strip.shadowRoot!.querySelectorAll('.strip').length).toBe(1);
        expect(strip.shadowRoot!.querySelectorAll('iframe').length).toBe(0);
        expect(strip.shadowRoot!.querySelectorAll('img').length).toBeLessThanOrEqual(3);
        expect(comic.sections[99].load).not.toHaveBeenCalled();
        expect(maximum).toBeLessThanOrEqual(2);
        const rows = [...scroller().children];
        await strip.next(1100); await tick();
        expect(scroller().scrollTop).toBe(1100);
        expect([...scroller().children]).toEqual(rows);
        await strip.prev(200);
        expect(scroller().scrollTop).toBe(900);
    });
    it('loads a deep jump, evicts distant images, and keeps the original page order', async () => {
        const comic = book(); strip.open(comic);
        await strip.goTo({ index: 0 }); await tick();
        await strip.goTo({ index: 20, anchor: 0.25 }); await tick();
        expect(scroller().scrollTop).toBe(20250);
        expect(comic.sections[0].unload).toHaveBeenCalled();
        expect(strip.shadowRoot!.querySelector('img[alt="Comic page 1"]')).toBeNull();
        expect(strip.shadowRoot!.querySelector('img[alt="Comic page 21"]')).not.toBeNull();
        expect(strip.shadowRoot!.querySelectorAll('img').length).toBeLessThanOrEqual(4);
        expect(maximum).toBeLessThanOrEqual(2);
    });
    it('uses each image aspect ratio and retains the visible page offset after loading', async () => {
        width = 1000; height = 500;
        strip.open(book());
        await strip.goTo({ index: 8, anchor: 0.5 }); await tick();
        const row = scroller().children[8] as HTMLElement;
        expect(row.style.aspectRatio).toBe('1000 / 500');
        expect(scroller().scrollTop).toBe(row.offsetTop + row.offsetHeight * 0.5);
    });
    it('round-trips the visible page and offset through the real Foliate CFI bridge', async () => {
        const view = document.createElement('foliate-view') as any;
        document.body.append(view);
        try {
            await view.open(book());
            expect(view.renderer).toBeInstanceOf(ComicStrip);
            strip.destroy(); strip.remove(); strip = view.renderer;
            await strip.goTo({ index: 5, anchor: 0.375 }); await tick();
            const saved = view.lastLocation.cfi;
            const resolved = view.resolveNavigation(saved);
            expect(resolved.index).toBe(5);
            expect(view.lastLocation.section.current).toBe(5);
            await strip.goTo({ index: 2 });
            await strip.goTo(resolved);
            const row = scroller().children[5] as HTMLElement;
            expect(scroller().scrollTop).toBe(row.offsetTop + row.offsetHeight * 0.375);
        } finally { view.close(); view.remove(); }
    });
    it('fails visibly for a bad page and allows retry without breaking neighboring pages', async () => {
        const comic = book();
        comic.sections[0].load.mockRejectedValueOnce(new Error('bad page'));
        strip.open(comic);
        await expect(strip.goTo({ index: 0 })).rejects.toThrow('bad page');
        const retry = scroller().children[0].querySelector('button')!;
        expect(retry.textContent).toContain('Tap to retry');
        retry.click(); await tick();
        expect(scroller().children[0].querySelector('img')).not.toBeNull();
        expect(scroller().children[1].querySelector('img')).not.toBeNull();
    });
    it('does not install late images into a destroyed renderer', async () => {
        const comic = book(1); let release!: (url: string) => void;
        comic.sections[0].load.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
        strip.open(comic);
        const pending = strip.goTo({ index: 0 });
        strip.destroy(); release('blob:page-0');
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        expect(scroller().children.length).toBe(0);
        expect(comic.sections[0].unload).toHaveBeenCalled();
    });
    it('handles an empty strip and clamps navigation at the first and last page', async () => {
        strip.open(book(0)); await strip.goTo({ index: 0 }); await strip.next(); await strip.prev();
        expect(scroller().scrollTop).toBe(0);
        expect(strip.atEnd).toBe(false);
        strip.open(book(1)); await strip.goTo({ index: 0 });
        await strip.next(10000); expect(scroller().scrollTop).toBe(400); expect(strip.atEnd).toBe(true);
        await strip.prev(10000); expect(scroller().scrollTop).toBe(0); expect(strip.atStart).toBe(true);
        await strip.goTo({ index: -1 }); await strip.goTo({ index: 100 });
        await strip.next(NaN); await strip.prev(-10);
        expect(scroller().scrollTop).toBe(0);
    });
});
