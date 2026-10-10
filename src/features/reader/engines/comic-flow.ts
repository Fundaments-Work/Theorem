import type { BookFormat, ReadingFlow } from '../../../core/types';

export const isComicFormat = (format: BookFormat) => format === 'cbz' || format === 'cbr';
export const COMIC_SCROLL_CSS = `html, body { margin: 0 !important; padding: 0 !important; }
img { display: block; width: 100% !important; height: auto !important; max-height: none !important; margin: 0 auto !important; }`;

export function comicBookForFlow<T extends { rendition?: Record<string, unknown> }>(book: T, flow: ReadingFlow): T {
    return { ...book, rendition: { ...book.rendition, layout: flow === 'scroll' ? 'reflowable' : 'pre-paginated', comicFlow: flow } };
}
type ComicBook = { rendition?: Record<string, unknown> };
interface ComicView {
    isFixedLayout: boolean;
    renderer: { setStyles?: (css: string) => void };
    close(): void;
    open(book: ComicBook): Promise<void>;
    goTo(index: number): Promise<void>;
}
/** Serialize renderer replacement and settle rapid mode changes at the latest choice. */
export class ComicFlowController {
    private pending = new WeakMap<ComicView, Promise<boolean>>();
    ensure(view: ComicView, book: ComicBook, flow: () => ReadingFlow, index: number,
        configure: () => void, alive: () => boolean): Promise<boolean> {
        const pending = this.pending.get(view);
        if (pending) return pending;
        const operation = (async () => {
            let switched = false;
            while (alive() && view.isFixedLayout !== (flow() === 'paged')) {
                const requested = flow();
                view.close();
                await view.open(comicBookForFlow(book, requested));
                if (!alive()) return switched;
                configure();
                if (requested === 'scroll') view.renderer.setStyles?.(COMIC_SCROLL_CSS);
                // View.goTo(number) addresses a section. Object fractions address
                // the whole book and would incorrectly reset to its beginning.
                await view.goTo(Math.max(0, index));
                switched = true;
            }
            return switched;
        })().finally(() => { this.pending.delete(view); });
        this.pending.set(view, operation);
        return operation;
    }
}
