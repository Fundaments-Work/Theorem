interface ComicSection { load(): Promise<string>; unload?(): void }
interface ComicBook { sections: ComicSection[] }
interface Position { index: number; fraction: number }
interface Resource { controller: AbortController; image?: HTMLImageElement; promise: Promise<void>; loaded?: boolean }

/** One native scroll surface, with page-sized placeholders and bounded decoding. */
export class ComicStrip extends HTMLElement {
    private root = this.attachShadow({ mode: 'open' });
    private scroller = document.createElement('div');
    private pages: HTMLDivElement[] = [];
    private documents = new Map<number, Document>();
    private resources = new Map<number, Resource>();
    private wanted = new Set<number>();
    private failed = new Set<number>();
    private queue: Array<{ index: number; run: () => Promise<void>; cancel: () => void }> = [];
    private active = 0;
    private generation = 0;
    private navigation = 0;
    private frame: number | null = null;
    private reportTimer: ReturnType<typeof setTimeout> | null = null;
    private resize: ResizeObserver | null = null;
    private position: Position = { index: 0, fraction: 0 };
    book: ComicBook = { sections: [] };
    readonly scrolled = true;

    constructor() {
        super();
        const style = document.createElement('style');
        style.textContent = `:host { display:block; width:100%; height:100%; }
            .strip { position:relative; height:100%; overflow:auto; overflow-anchor:none; touch-action:pan-y pinch-zoom; }
            .page { position:relative; width:100%; aspect-ratio:0.70710678; padding:0; margin:0; border:0; }
            .page img { position:absolute; inset:0; display:block; width:100%; height:100%; margin:0; padding:0; border:0; }
            .page button { position:absolute; inset:40% 10%; color:inherit; background:transparent; }`;
        this.scroller.className = 'strip';
        this.scroller.setAttribute('aria-label', 'Continuous comic strip');
        this.root.append(style, this.scroller);
        this.scroller.addEventListener('scroll', () => {
            if (this.frame === null) this.frame = requestAnimationFrame(() => {
                this.frame = null;
                this.position = this.readPosition();
                this.refresh();
            });
            if (this.reportTimer) clearTimeout(this.reportTimer);
            this.reportTimer = setTimeout(() => this.report('scroll'), 120);
        }, { passive: true });
    }

    open(book: ComicBook): void {
        this.destroy();
        this.book = book;
        this.position = { index: 0, fraction: 0 };
        this.pages = book.sections.map((_, index) => {
            const page = document.createElement('div');
            page.className = 'page';
            page.dataset.page = String(index);
            page.setAttribute('aria-label', `Comic page ${index + 1}`);
            return page;
        });
        this.scroller.replaceChildren(...this.pages);
        this.scroller.scrollTop = 0;
        this.resize = new ResizeObserver(() => {
            this.restorePosition(this.position);
            this.refresh();
        });
        this.resize.observe(this.scroller);
    }

    private indexAt(offset: number): number {
        let low = 0, high = this.pages.length - 1;
        while (low < high) {
            const mid = Math.ceil((low + high) / 2);
            if (this.pages[mid].offsetTop <= offset) low = mid;
            else high = mid - 1;
        }
        return low;
    }
    private readPosition(): Position {
        if (!this.pages.length) return { index: 0, fraction: 0 };
        const index = this.indexAt(this.scroller.scrollTop);
        const page = this.pages[index];
        return { index, fraction: Math.max(0, Math.min(1,
            (this.scroller.scrollTop - page.offsetTop) / Math.max(1, page.offsetHeight))) };
    }
    private restorePosition(position: Position): void {
        const page = this.pages[position.index];
        if (page) {
            const offset = page.offsetTop + position.fraction * page.offsetHeight;
            if (Math.abs(offset - this.scroller.scrollTop) > 0.5) this.scroller.scrollTop = offset;
        }
    }
    private refresh(): void {
        if (!this.pages.length) return;
        const height = this.scroller.clientHeight || 800;
        const first = this.indexAt(Math.max(0, this.scroller.scrollTop - height));
        const last = this.indexAt(this.scroller.scrollTop + height * 2);
        this.wanted = new Set(Array.from({ length: last - first + 1 }, (_, i) => first + i));
        for (const [index, resource] of this.resources) {
            if (!this.wanted.has(index)) {
                resource.controller.abort();
                resource.image?.remove();
                this.pages[index]?.replaceChildren();
                this.documents.delete(index);
                if (resource.loaded) {
                    this.resources.delete(index);
                    this.book.sections[index]?.unload?.();
                }
            }
        }
        // Decode the visible page first, then its nearest neighbors.
        [...this.wanted].sort((a, b) => Math.abs(a - this.position.index) - Math.abs(b - this.position.index))
            .forEach(index => { if (!this.failed.has(index)) void this.loadPage(index).catch(() => {}); });
        this.pump();
    }
    private pump(): void {
        while (this.active < 2 && this.queue.length) {
            const job = this.queue.shift()!;
            if (!this.wanted.has(job.index)) { job.cancel(); continue; }
            this.active++;
            void job.run().finally(() => { this.active--; this.pump(); });
        }
    }
    private loadPage(index: number): Promise<void> {
        const existing = this.resources.get(index);
        if (existing) return existing.controller.signal.aborted
            ? existing.promise.catch(error => {
                if (!this.wanted.has(index)) throw error;
                return this.loadPage(index);
            }) : existing.promise;
        const section = this.book.sections[index];
        const page = this.pages[index];
        if (!section || !page) return Promise.reject(new Error('Comic page is unavailable.'));
        const generation = this.generation;
        const controller = new AbortController();
        let resolve!: () => void, reject!: (error: unknown) => void;
        const promise = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; });
        const resource: Resource = { controller, promise };
        this.resources.set(index, resource);
        const assertActive = () => {
            if (controller.signal.aborted || generation !== this.generation) throw new DOMException('Page released', 'AbortError');
        };
        const run = async () => {
            try {
                assertActive();
                const htmlUrl = await section.load();
                assertActive();
                if (!htmlUrl.startsWith('blob:')) throw new Error('Unsupported comic page source.');
                const response = await fetch(htmlUrl, { signal: controller.signal });
                if (response.ok === false) throw new Error('Could not read the local comic page.');
                const html = await response.text();
                assertActive();
                const doc = new DOMParser().parseFromString(html, 'text/html');
                const src = doc.querySelector('img')?.getAttribute('src');
                if (!src?.startsWith('blob:')) throw new Error('Comic page has no local image.');
                const image = document.createElement('img');
                resource.image = image;
                image.alt = `Comic page ${index + 1}`;
                image.decoding = 'async';
                await new Promise<void>((ok, fail) => {
                    const finish = (error?: Error) => {
                        image.onload = image.onerror = null;
                        controller.signal.removeEventListener('abort', aborted);
                        if (error) fail(error); else ok();
                    };
                    const aborted = () => finish(new DOMException('Page released', 'AbortError'));
                    controller.signal.addEventListener('abort', aborted, { once: true });
                    image.onload = () => finish();
                    image.onerror = () => finish(new Error(`Could not decode comic page ${index + 1}.`));
                    image.src = src;
                });
                assertActive();
                if (!image.naturalWidth || !image.naturalHeight) throw new Error('Comic image has invalid dimensions.');
                const anchor = this.readPosition();
                page.style.aspectRatio = `${image.naturalWidth} / ${image.naturalHeight}`;
                page.replaceChildren(image);
                if (index <= anchor.index) this.restorePosition(anchor);
                this.position = this.readPosition();
                resource.loaded = true;
                resolve();
            } catch (error) {
                if (generation !== this.generation && this.book.sections[index] !== section) section.unload?.();
                if (generation === this.generation && this.resources.get(index) === resource) {
                    this.resources.delete(index);
                    section.unload?.();
                    if (!controller.signal.aborted) {
                        this.failed.add(index);
                        const retry = document.createElement('button');
                        retry.textContent = `Page ${index + 1} could not load. Tap to retry.`;
                        retry.onclick = () => {
                            this.failed.delete(index); this.wanted.add(index);
                            void this.loadPage(index).catch(() => {}); this.pump();
                        };
                        page.replaceChildren(retry);
                    }
                }
                reject(error);
            }
        };
        this.queue.push({ index, run, cancel: () => {
            controller.abort();
            if (this.resources.get(index) === resource) this.resources.delete(index);
            reject(new DOMException('Page released', 'AbortError'));
        } });
        return promise;
    }
    private positionDocument(index: number): Document {
        let doc = this.documents.get(index);
        if (!doc) {
            doc = document.implementation.createHTMLDocument();
            const marker = doc.createElement('p');
            marker.textContent = '0'.repeat(1000);
            doc.body.append(marker);
            this.documents.set(index, doc);
        }
        return doc;
    }
    private report(reason: string): void {
        if (!this.pages.length) return;
        this.position = this.readPosition();
        const { index, fraction } = this.position;
        const doc = this.positionDocument(index);
        const range = doc.createRange();
        range.setStart(doc.body.firstChild!.firstChild!, Math.min(1000, Math.round(fraction * 1000)));
        range.collapse(true);
        this.dispatchEvent(new CustomEvent('relocate', { detail: {
            reason, index, fraction, size: Math.min(1, this.scroller.clientHeight / Math.max(1, this.pages[index].offsetHeight)), range,
        } }));
    }
    async goTo(target: { index: number; anchor?: number | ((doc: Document) => Range) }): Promise<void> {
        if (!target || !Number.isInteger(target.index) || !this.pages[target.index]) return;
        const navigation = ++this.navigation;
        let fraction = typeof target.anchor === 'number' ? target.anchor : 0;
        if (typeof target.anchor === 'function') {
            try { fraction = target.anchor(this.positionDocument(target.index)).startOffset / 1000; } catch { /* legacy image CFI: page start */ }
        }
        this.position = { index: target.index, fraction: Number.isFinite(fraction) ? Math.max(0, Math.min(1, fraction)) : 0 };
        this.restorePosition(this.position);
        this.refresh();
        await this.loadPage(target.index);
        if (navigation !== this.navigation || !this.pages.length) return;
        this.restorePosition(this.position);
        this.report('navigation');
    }
    async next(distance = this.scroller.clientHeight * 0.85): Promise<void> {
        if (!Number.isFinite(distance) || distance < 0) return;
        this.scroller.scrollTop = Math.min(Math.max(0, this.scroller.scrollHeight - this.scroller.clientHeight), this.scroller.scrollTop + distance);
        this.position = this.readPosition(); this.refresh(); this.report('page');
    }
    async prev(distance = this.scroller.clientHeight * 0.85): Promise<void> {
        if (!Number.isFinite(distance) || distance < 0) return;
        this.scroller.scrollTop = Math.max(0, this.scroller.scrollTop - distance);
        this.position = this.readPosition(); this.refresh(); this.report('page');
    }
    get atEnd(): boolean { return this.pages.length > 0 && this.scroller.scrollHeight - this.scroller.clientHeight - this.scroller.scrollTop <= 2; }
    get atStart(): boolean { return this.scroller.scrollTop <= 2; }
    getContents(): Array<{ doc: Document; index: number }> { return []; }
    setStyles(_css: string | string[]): void { /* Comic images retain their own colors and contiguous geometry. */ }
    destroy(): void {
        this.generation++; this.navigation++;
        this.resize?.disconnect(); this.resize = null;
        if (this.frame !== null) cancelAnimationFrame(this.frame);
        this.frame = null;
        if (this.reportTimer) clearTimeout(this.reportTimer);
        this.reportTimer = null;
        for (const job of this.queue) job.cancel();
        this.queue = [];
        for (const [index, resource] of this.resources) {
            resource.controller.abort(); resource.image?.remove(); this.book.sections[index]?.unload?.();
        }
        this.resources.clear(); this.documents.clear(); this.wanted.clear(); this.failed.clear();
        this.pages = []; this.scroller.replaceChildren();
        this.book = { sections: [] };
    }
}
if (!customElements.get('theorem-comic-strip')) customElements.define('theorem-comic-strip', ComicStrip);
