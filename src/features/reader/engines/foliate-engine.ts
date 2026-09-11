
import type {
    DocLocation,
    DocMetadata,
    TocItem,
    HighlightColor,
    Annotation,
    SearchResult,
    ReadingFlow,
    PageLayout,
    ThemeSettings,
    ReaderTheme,
    BookFormat,
} from '../../../core/types';
import { isFixedLayout } from '../../../core/types';
import { getTheme } from '../foliate/themes';
import { getCSS } from '../foliate/reader.js';
import { 
    registerEngineStyleCallback,
    getCurrentReaderSettings,
    getThemeColors,
    getHighlightSolidColor,
} from '../../../core/lib/design-tokens';
import { rankByFuzzyQuery } from "../../../core/lib/search/fuzzy";
import { normalizeAuthor } from '../../../core/lib/utils';

const READER_SEARCH_EXACT_LIMIT = 120;
const READER_SEARCH_FALLBACK_TRIGGER_THRESHOLD = 3;
const READER_SEARCH_FALLBACK_LIMIT = 12;
const READER_SEARCH_FALLBACK_MAX_SECTIONS = 300;
const READER_SEARCH_FALLBACK_SECTION_CHAR_LIMIT = 8000;
const READER_SEARCH_EXCERPT_CONTEXT_CHARS = 80;
const MIN_READER_ZOOM_LEVEL = 0.2;
const MIN_PAGED_READER_ZOOM_LEVEL = 1.0;
const MAX_READER_ZOOM_LEVEL = 4.0;
const READER_ZOOM_STEP = 0.1;
const READER_OPEN_TIMEOUT_MS = 20000;
const READER_NAVIGATION_TIMEOUT_MS = 6000;

// Parsed foliate Book models, keyed by stable book identity (materialized
// path or filename+size) so repeat opens skip EPUB OPF/nav re-parsing. The
// Book keeps its source File/Blob alive, so the cache is intentionally small.
const BOOK_MODEL_CACHE_LIMIT = 2;
const bookModelCache = new Map<string, any>();

interface ReaderSearchExcerpt {
    pre?: string;
    match?: string;
    post?: string;
}

interface ReaderSearchSectionCacheItem {
    cfi: string;
    text: string;
}

export interface FootnoteData {
    text: string;
    html?: string;
    title?: string;
    href?: string;
    rect?: { top: number; left: number; right: number; bottom: number; width: number; height: number };
}

export interface FoliateEngineOptions {
    onLocationChange?: (location: DocLocation) => void;
    onReady?: (metadata: DocMetadata, toc: TocItem[]) => void;
    onError?: (error: Error) => void;
    onTextSelected?: (cfi: string, text: string, rangeOrEvent: Range | MouseEvent) => void;
    onViewportTap?: () => void;
    shouldForceViewportTap?: () => boolean;
    onFootnote?: (data: FootnoteData) => void;
}

export class FoliateEngine {
    private container: HTMLElement | null = null;
    private view: any = null;
    private book: any = null;
    private options: FoliateEngineOptions = {};
    private annotations: Map<string, Annotation> = new Map();
    private annotationLocations: Map<string, Annotation> = new Map();
    private currentLocation: DocLocation | null = null;
    private sectionFractions: number[] = [];

    private format: BookFormat = 'epub';
    private isFixedLayoutFormat = false;

    private layout: PageLayout = 'single';
    private flow: ReadingFlow = 'paged';
    private zoom_level = 1;
    
    private selectionNavLockUntil = 0;
    private theme: ReaderTheme = 'light';
    
    private pendingUpdateFrame: number | null = null;

    private _lastCssSettingsKey = '';
    private _lastCssResult: string | null = null;
    private _lastTapNotifiedAt = 0;
    private _lastAnnotationActivatedAt = 0;

    private unsubscribeFromStyles: (() => void) | null = null;

    private _keyboardAttached = new WeakSet<Document>();

    private searchSectionCache: ReaderSearchSectionCacheItem[] | null = null;
    private searchCacheBookRef: unknown = null;
    private _awaitingInitialRelocate = false;
    
    private _lastSectionIndex = -1;
    
    private _navigationInProgress = false;

    constructor(options: FoliateEngineOptions = {}) {
        this.options = options;
    }

    private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, operation: string): Promise<T> {
        let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

        try {
            return await Promise.race([
                promise,
                new Promise<T>((_, reject) => {
                    timeoutHandle = setTimeout(() => {
                        reject(new Error(`Timed out while ${operation}.`));
                    }, timeoutMs);
                }),
            ]);
        } finally {
            if (timeoutHandle) {
                clearTimeout(timeoutHandle);
            }
        }
    }

    private getMinZoomLevelForFlow(flow: ReadingFlow = this.flow): number {
        if (flow === 'scroll') {
            return MIN_READER_ZOOM_LEVEL;
        }
        
        if (this.isFixedLayoutFormat) {
            return MIN_PAGED_READER_ZOOM_LEVEL;
        }
        return MIN_READER_ZOOM_LEVEL;
    }

    private clampZoomLevel(level: number, flow: ReadingFlow = this.flow): number {
        return Math.max(
            this.getMinZoomLevelForFlow(flow),
            Math.min(MAX_READER_ZOOM_LEVEL, level),
        );
    }

    private applyZoomToDocument(doc: Document): void {
        const root = doc.documentElement;
        if (!root) {
            return;
        }

        if (this.isFixedLayoutFormat) {
            root.style.removeProperty('transform');
            root.style.removeProperty('transform-origin');
            root.style.removeProperty('width');
            root.style.removeProperty('zoom');
        } else {
            root.style.removeProperty('transform');
            root.style.removeProperty('transform-origin');
            root.style.removeProperty('width');
            root.style.removeProperty('zoom');
            root.style.removeProperty('font-size');
            
            const currentSettings = getCurrentReaderSettings();
            const baseFontSize = currentSettings?.fontSize ?? 16;
            const effectiveFontSize = baseFontSize * this.zoom_level;
            
            root.style.setProperty('--reader-zoom', String(this.zoom_level));
            root.style.setProperty('font-size', `${effectiveFontSize}px`, 'important');
        }
    }

    async init(container: HTMLElement): Promise<void> {
        this.container = container;
        
        this.unsubscribeFromStyles = registerEngineStyleCallback(() => {
            this.handleExternalStyleChange();
        });
    }

    public getVisibleTextForTts(): { text: string; startWordId: string } | null {
        if (!this.view?.renderer?.getContents) return null;
        
        const contents = this.view.renderer.getContents();
        if (!contents || contents.length === 0) return null;

        const visibleRange = (this.view as any)?.lastLocation?.range as Range | undefined;
        const parts: string[] = [];

        for (const content of contents) {
            const doc = content.document || content.doc;
            if (!doc || !doc.body) continue;

            if (visibleRange) {
                
                let rangeText = "";
                try { rangeText = visibleRange.toString(); } catch {  }
                rangeText = rangeText.trim();
                if (!rangeText) {
                    
                    try {
                        const frag = visibleRange.cloneContents();
                        const w = doc.createElement("div");
                        w.appendChild(frag);
                        rangeText = (w.textContent || '').trim();
                    } catch {  }
                }
                if (!rangeText) {
                    
                    const body = doc.body as HTMLElement;
                    rangeText = (body.innerText || '').trim();
                }
                if (rangeText) parts.push(rangeText);
            } else {
                const body = doc.body as HTMLElement;
                const bodyText = (body.innerText || '').trim();
                if (bodyText) parts.push(bodyText);
            }
        }

        if (parts.length === 0) return null;
        return { text: parts.join("\n"), startWordId: "" };
    }

    public getNextPageTextForTts(): { text: string; startWordId: string } | null {
        if (!this.view?.renderer?.getContents) return null;

        const contents = this.view.renderer.getContents();
        if (!contents || contents.length === 0) return null;

        const visibleRange = (this.view as any)?.lastLocation?.range;

        let fullText = "";
        let firstWordId = "";

        if (visibleRange) {
            
            type Phase = 'before' | 'during' | 'after';
            let phase: Phase = 'before';

            for (const content of contents) {
                const doc = content.document || content.doc;
                if (!doc) continue;

                const ttsWords = Array.from(doc.querySelectorAll('.tts-word')) as HTMLElement[];
                for (const node of ttsWords) {
                    const inRange = visibleRange.intersectsNode(node);

                    if (phase === 'before') {
                        if (inRange) phase = 'during';
                    } else if (phase === 'during') {
                        if (!inRange) {
                            phase = 'after';
                            if (!firstWordId) firstWordId = node.id;
                            fullText += (node.textContent || '') + " ";
                        }
                    } else if (phase === 'after') {
                        fullText += (node.textContent || '') + " ";
                    }
                }
            }
        } else {
            
            let sectionIndex = 0;
            for (const content of contents) {
                const doc = content.document || content.doc;
                if (!doc) continue;
                sectionIndex++;
                if (sectionIndex <= 1) continue; 

                const ttsWords = Array.from(doc.querySelectorAll('.tts-word')) as HTMLElement[];
                for (const node of ttsWords) {
                    if (!firstWordId) firstWordId = node.id;
                    fullText += (node.textContent || '') + " ";
                }
            }
        }

        if (!fullText.trim()) return null;
        return { text: fullText.trim(), startWordId: firstWordId };
    }

    async open(
        source: File | Blob | ArrayBuffer | string,
        _filename: string = 'document.epub',
        initialLocation?: string,
        layout: PageLayout = 'double',
        _savedLocations?: string,
        flow: ReadingFlow = 'paged',
        zoom: number = 100,
        _margins: number = 10,
        format: BookFormat = 'epub',
        nativeFilePath?: string,
    ): Promise<void> {
        
        this.format = format;
        this.isFixedLayoutFormat = isFixedLayout(format);
        if (!this.container) {
            throw new Error('Engine not initialized');
        }

        try {
            
            const { makeBook } = await import('../foliate-js-runtime/view.js');

            let file: File | Blob;
            if (source instanceof File) {
                file = source;
            } else if (source instanceof Blob) {
                file = new File([source], _filename, { type: source.type || 'application/epub+zip' });
            } else {
                const buffer = typeof source === 'string' ? new TextEncoder().encode(source) : source;
                file = new File([buffer], _filename, { type: 'application/epub+zip' });
            }

            const bookCacheKey = nativeFilePath ?? `${_filename}:${file.size}`;
            const cachedBook = bookModelCache.get(bookCacheKey);
            if (cachedBook) {
                this.book = cachedBook;
            } else {
                this.book = await makeBook(file,
                    nativeFilePath ? import('../../../core/lib/tauri-epub-bridge')
                        .then(m => m.tryNativePrefetchEpub(nativeFilePath)) : undefined
                );
                bookModelCache.set(bookCacheKey, this.book);
                if (bookModelCache.size > BOOK_MODEL_CACHE_LIMIT) {
                    const oldestKey = bookModelCache.keys().next().value;
                    if (oldestKey !== undefined) bookModelCache.delete(oldestKey);
                }
            }
            this.searchSectionCache = null;
            this.searchCacheBookRef = this.book;

            this.view = document.createElement('foliate-view');
            this.view.style.width = '100%';
            this.view.style.height = '100%';
            this.view.style.display = 'block';
            this.container.appendChild(this.view);

            this.setupEventListeners();

            await this.withTimeout(
                this.view.open(this.book),
                READER_OPEN_TIMEOUT_MS,
                'opening the book',
            );

            this.sectionFractions = this.view.getSectionFractions() || [];
            
            if (this.sectionFractions.length === 0) {
                
                this.sectionFractions = [0, 1];
            }

            this.layout = layout;
            this.flow = flow;
            this.zoom_level = this.clampZoomLevel(zoom / 100, this.flow);

            const initialSettings = getCurrentReaderSettings();
            if (initialSettings) {
                this.theme = initialSettings.theme;
            }

            this.applySettingsSync();

            // Build/apply the reader CSS concurrently with the first navigation;
            // the content container stays hidden until onReady, so any re-layout
            // from setStyles is not visible. We still await it before onReady.
            const settingsApplied = this.applySettingsAsync().catch(() => undefined);

            this.applyZoomSync();

            const metadata = this.extractMetadata();
            const toc = this.extractToc();

            this._awaitingInitialRelocate = true;
            
            this._navigationInProgress = true;
            
            try {
                if (initialLocation) {
                    try {
                        const result = await this.withTimeout(
                            this.view.goTo(initialLocation),
                            READER_NAVIGATION_TIMEOUT_MS,
                            'restoring saved location',
                        );
                        if (!result) {
                            
                            await this.withTimeout(
                                this.view.goTo({ index: 0, fraction: 0 }),
                                READER_NAVIGATION_TIMEOUT_MS,
                                'navigating to the start',
                            );
                        } else {
                        }
                } catch (err) {
                    
                    await this.withTimeout(
                        this.view.goTo({ index: 0, fraction: 0 }),
                        READER_NAVIGATION_TIMEOUT_MS,
                        'navigating to the start',
                    );
                    
                    if (this.options.onLocationChange) {
                        this.options.onLocationChange({ cfi: '', percentage: 0, tocItem: undefined, pageItem: undefined, pageInfo: undefined });
                    }
                }
                } else {
                    await this.withTimeout(
                        this.view.goTo({ index: 0, fraction: 0 }),
                        READER_NAVIGATION_TIMEOUT_MS,
                        'navigating to the start',
                    );
                }

                this.applyZoomSync();
                this.scheduleSettingsUpdate();
            } finally {
                this._navigationInProgress = false;
            }

            await settingsApplied;

            this.options.onReady?.(metadata, toc);

        } catch (error) {
            this.options.onError?.(error as Error);
            throw error;
        }
    }

    private setupEventListeners(): void {
        if (!this.view) return;

        this.view.addEventListener('load', (e: any) => {
            const detail = e.detail;
            if (detail?.doc?.documentElement) {
                
                this.applyZoomToDocument(detail.doc);

                const doc = detail.doc;
                const win = doc?.defaultView;
                if (win && !this._keyboardAttached.has(doc)) {
                    this._keyboardAttached.add(doc);
                    win.addEventListener('keydown', (ev: KeyboardEvent) => {
                        if (ev.target instanceof HTMLInputElement || ev.target instanceof HTMLTextAreaElement) return;
                        switch (ev.key) {
                            case 'ArrowLeft': ev.preventDefault(); this.prev(); break;
                            case 'ArrowRight': ev.preventDefault(); this.next(); break;
                            case 'ArrowUp': case 'PageUp':
                                ev.preventDefault();
                                if (this.flow === 'scroll') this.scrollUp();
                                else this.prev();
                                break;
                            case 'ArrowDown': case 'PageDown': case ' ':
                                ev.preventDefault();
                                if (this.flow === 'scroll') this.scrollDown();
                                else this.next();
                                break;
                            case 'Home': ev.preventDefault(); this.goToFraction(0); break;
                            case 'End': ev.preventDefault(); this.goToFraction(0.999); break;
                        }
                    }, { capture: true, passive: false });
                }
            }
        });

        this.view.addEventListener('relocate', (e: any) => {
            const detail = e.detail;
            
            let cfi = detail.cfi || '';
            
            if (!cfi && detail.section?.current != null && detail.section.current >= 0 && this.view?.getCFI) {
                try {
                    cfi = this.view.getCFI(detail.section.current, detail.range) || '';
                    if (!cfi) {
                        cfi = `section-${detail.section.current}`;
                    }
                } catch (err) {
                    cfi = `section-${detail.section.current}`;
                }
            }
            
            const renderer = this.view?.renderer as any;
            const isPaginator = renderer && typeof renderer.page === 'number' && typeof renderer.pages === 'number' && !renderer.scrolled;
            const isSingleSection = !detail.section || detail.section.total <= 1;
            const isAtEnd = !!(renderer?.atEnd || (isPaginator && isSingleSection && renderer.page >= (renderer.pages > 2 ? renderer.pages - 2 : renderer.pages)));

            let pageInfo: DocLocation['pageInfo'] | undefined;
            if (isPaginator && isSingleSection) {
                const totalPages = Math.max(1, renderer.pages > 2 ? renderer.pages - 2 : renderer.pages);
                const currentPage = isAtEnd ? totalPages : Math.max(1, Math.min(totalPages, renderer.page ?? 1));
                pageInfo = {
                    currentPage,
                    endPage: currentPage,
                    totalPages,
                    range: `${currentPage}`,
                    isEstimated: false,
                };
            } else if (detail.location) {
                const totalLoc = detail.location.total;
                const currentLoc = isAtEnd ? totalLoc : Math.min(totalLoc, detail.location.current + 1);
                pageInfo = {
                    currentPage: currentLoc,
                    endPage: isAtEnd ? totalLoc : Math.min(totalLoc, detail.location.next + 1),
                    totalPages: totalLoc,
                    range: `${currentLoc}`,
                    isEstimated: true,
                };
            }

            let fraction: number;
            if (isAtEnd) {
                fraction = 1.0;
            } else if (isPaginator && pageInfo && pageInfo.totalPages > 0 && isSingleSection) {
                fraction = Math.max(0, Math.min(1, pageInfo.currentPage / pageInfo.totalPages));
            } else {
                const rawFraction = detail.fraction;
                fraction = typeof rawFraction === 'number' && isFinite(rawFraction)
                    ? Math.max(0, Math.min(1, rawFraction))
                    : NaN;
                if (!isFinite(fraction)) {
                    if (pageInfo && pageInfo.totalPages > 1) {
                        fraction = Math.max(
                            0,
                            Math.min(1, (pageInfo.currentPage - 1) / (pageInfo.totalPages - 1)),
                        );
                    } else if (
                        typeof detail.section?.current === 'number'
                        && detail.section.current >= 0
                        && this.sectionFractions.length > detail.section.current + 1
                    ) {
                        const start = this.sectionFractions[detail.section.current];
                        const end = this.sectionFractions[detail.section.current + 1];
                        if (isFinite(start) && isFinite(end)) {
                            fraction = Math.max(0, Math.min(1, (start + end) / 2));
                        }
                    }
                }
            }
            if (!isFinite(fraction)) {
                fraction = this.currentLocation?.percentage ?? 0;
            }
            
            const location: DocLocation = {
                cfi,
                percentage: fraction,
                tocItem: detail.tocItem,
                pageItem: detail.pageItem,
                pageInfo,
            };

            this.currentLocation = location;

            const sectionIndex = typeof detail.index === 'number' ? detail.index : -1;
            if (sectionIndex >= 0 && sectionIndex !== this._lastSectionIndex) {
                this._lastSectionIndex = sectionIndex;
                if (!this._navigationInProgress) {
                    requestAnimationFrame(() => {
                        this.applyZoomSync();
                        this.scheduleSettingsUpdate();
                    });
                }
            }

            if (this._awaitingInitialRelocate) {
                this._awaitingInitialRelocate = false;
                requestAnimationFrame(() => {
                    this.applyZoomSync();
                    this.scheduleSettingsUpdate();
                });
            }

            this.options.onLocationChange?.(location);

            if (detail.reason === 'selection') {
                const sectionIndex = typeof detail.index === 'number' ? detail.index : -1;
                this.renderAnnotationsForSection(sectionIndex);
            }
        });

        this.view.history?.addEventListener('index-change', () => {
            if (this.options.onLocationChange && this.currentLocation) {
                this.options.onLocationChange(this.currentLocation);
            }
        });

        this.view.history?.addEventListener('popstate', (_e: any) => {
        });

        this.view.addEventListener('load', (e: any) => {
            const detail = e.detail;
            
            if (detail?.doc) {
                this.iframeListenersAttached.delete(detail.doc);
            }
            
            setTimeout(() => {
                if (this.options.onTextSelected) {
                    this.setupIframeSelectionListener(this.options.onTextSelected);
                } else {
                }
                
                this.renderAnnotationsForSection(detail?.index);
            }, 500);
        });

        this.view.addEventListener('draw-annotation', (e: any) => {
            const { draw, annotation, doc } = e.detail;
            
            if (!draw || !annotation) {
                return;
            }

            const color = this.getHighlightColor(annotation.color || 'yellow');
            
            try {
                
                draw((rects: DOMRectList) => {
                    const g = doc.createElementNS('http://www.w3.org/2000/svg', 'g');
                    g.setAttribute('fill', color);
                    g.setAttribute('data-highlight', 'true');
                    g.style.opacity = '0.4';
                    g.style.mixBlendMode = 'multiply';
                    g.style.pointerEvents = 'none';
                    
                    for (const rect of rects) {
                        const el = doc.createElementNS('http://www.w3.org/2000/svg', 'rect');
                        el.setAttribute('x', String(rect.left));
                        el.setAttribute('y', String(rect.top));
                        el.setAttribute('width', String(rect.width));
                        el.setAttribute('height', String(rect.height));
                        el.setAttribute('rx', '2');
                        g.appendChild(el);
                    }
                    
                    return g;
                }, annotation);
            } catch (err) {
            }
        });

        this.view.addEventListener('show-annotation', (e: any) => {
            const { value, range } = e.detail;
            
            let annotation = this.annotationLocations.get(value);
            if (!annotation) {
                annotation = Array.from(this.annotations.values())
                    .find(a => a.location === value);
                if (annotation) {
                    this.annotationLocations.set(value, annotation);
                }
            }
            
            if (!annotation && value) {
                annotation = Array.from(this.annotations.values())
                    .find(a => a.location && value.startsWith(a.location));
            }
            
            if (annotation) {
                
                if (this.options.onTextSelected) {
                    // Mark this activation so the viewport-tap handler does not
                    // immediately close the annotation/action popover that the
                    // selection callback is about to open.
                    this._lastAnnotationActivatedAt = Date.now();
                    if (range && typeof range.cloneRange === 'function') {
                        this.options.onTextSelected(annotation.location, annotation.selectedText || '', range.cloneRange());
                    } else {
                        const rect = range?.getBoundingClientRect?.();
                        let rectLeft = rect?.left ?? 0;
                        let rectTop = rect?.top ?? 0;
                        if (range) {
                            const rangeDoc = range.startContainer?.ownerDocument;
                            const frameElement = rangeDoc?.defaultView?.frameElement;
                            if (frameElement instanceof HTMLElement) {
                                const frameRect = frameElement.getBoundingClientRect();
                                rectLeft += frameRect.left;
                                rectTop += frameRect.top;
                            }
                        }
                        const syntheticEvent = new MouseEvent('click', {
                            clientX: rect ? rectLeft + rect.width / 2 : window.innerWidth / 2,
                            clientY: rect ? rectTop : window.innerHeight / 2,
                            bubbles: true
                        });
                        this.options.onTextSelected(annotation.location, annotation.selectedText || '', syntheticEvent);
                    }
                }
            } else {
            }
        });
    }

    private getHighlightColor(colorName: string): string {
        const colorKey: HighlightColor = (
            colorName === "yellow"
            || colorName === "green"
            || colorName === "blue"
            || colorName === "red"
            || colorName === "orange"
            || colorName === "purple"
        )
            ? colorName
            : "yellow";
        return getHighlightSolidColor(colorKey);
    }

    private handleExternalStyleChange(): void {
        const currentSettings = getCurrentReaderSettings();
        if (!currentSettings) return;
        
        this.theme = currentSettings.theme;
        if (currentSettings.flow && currentSettings.flow !== this.flow) {
            this.flow = currentSettings.flow;
        }
        this.zoom_level = this.clampZoomLevel(currentSettings.zoom / 100, this.flow);
        
        // Bust the CSS cache so applySettingsAsync always recomputes with new theme/zoom.
        this._lastCssSettingsKey = '';
        
        // Apply sync layout changes first, then push new CSS to the iframe immediately
        // without waiting for a RAF so theme changes are instant.
        this.applySettingsSync();
        this.applySettingsAsync().catch(() => undefined);
    }

    private extractMetadata(): DocMetadata {
        if (!this.book) {
            return { title: '', author: '' };
        }

        const meta = this.book.metadata || {};
        return {
            title: this.formatLanguageMap(meta.title) || 'Unknown Title',
            
            author: normalizeAuthor(meta.author) || 'Unknown Author',
            description: meta.description,
            publisher: meta.publisher,
            language: meta.language,
            pubdate: meta.published,
            identifier: meta.identifier,
        };
    }

    private extractToc(): TocItem[] {
        if (!this.book?.toc) {
            return [];
        }

        const convertToc = (items: any[]): TocItem[] => {
            return items.map(item => ({
                label: item.label || '',
                href: item.href || '',
                subitems: item.subitems ? convertToc(item.subitems) : undefined,
            }));
        };

        return convertToc(this.book.toc);
    }

    private formatLanguageMap(x: any): string {
        if (!x) return '';
        if (typeof x === 'string') return x;
        const keys = Object.keys(x);
        return x[keys[0]] || '';
    }

    private applySettingsSync(): void {
        if (!this.view?.renderer) return;

        const renderer = this.view.renderer;
        const currentSettings = getCurrentReaderSettings();
        
        renderer.setAttribute('flow', this.flow === 'scroll' ? 'scrolled' : 'paginated');
        renderer.setAttribute('gap', '5%');
        
        const isMobileViewport = typeof window !== 'undefined'
            && window.matchMedia('(max-width: 768px)').matches;
        const columnCount = isMobileViewport && this.flow !== 'scroll'
            ? 1
            : this.layout === 'single'
                ? 1
                : this.layout === 'double'
                    ? 2
                    : this.flow === 'scroll'
                        ? 1
                        : 2;
        
        renderer.setAttribute('max-column-count', String(columnCount));
        
        renderer.setAttribute(
            'max-inline-size',
            `${currentSettings?.fontSize ? Math.max(480, currentSettings.fontSize * 40) : 720}px`,
        );
        renderer.setAttribute('max-block-size', '800px');
        if (currentSettings?.enableAnimations) {
            renderer.setAttribute('animated', '');
        } else {
            renderer.removeAttribute('animated');
        }

        if (this.isFixedLayoutFormat && this.flow !== 'scroll') {
            const zoomValue = this.zoom_level === 1.0 ? 'fit-page' : this.zoom_level;
            renderer.setAttribute('zoom', String(zoomValue));
        } else {
            renderer.removeAttribute('zoom');
        }
        
        this.applyZoomSync();
    }

    private async applySettingsAsync(): Promise<void> {
        if (!this.view?.renderer) return;

        const currentSettings = getCurrentReaderSettings();
        if (!currentSettings) return;

        const cssKey = [
            currentSettings.fontSize,
            currentSettings.lineHeight,
            currentSettings.fontFamily,
            currentSettings.letterSpacing,
            currentSettings.wordSpacing,
            currentSettings.textAlign,
            currentSettings.hyphenation,
            currentSettings.forcePublisherStyles ?? false,
            this.theme,
            this.zoom_level,
        ].join('|');

        const renderer = this.view.renderer;

        if (this._lastCssSettingsKey === cssKey && this._lastCssResult) {
            if (renderer.setStyles) renderer.setStyles(this._lastCssResult);
            return;
        }
        this._lastCssSettingsKey = cssKey;

        const alignValue = currentSettings.textAlign === 'justify' ? 'justify' :
                          currentSettings.textAlign === 'center' ? 'center' : 'left';

        const theme = getTheme(this.theme);

        const readerStyle = {
            spacing: currentSettings.lineHeight,
            lineHeight: currentSettings.lineHeight,
            justify: currentSettings.textAlign === 'justify',
            hyphenate: currentSettings.hyphenation,
            invert: false,
            theme,
            overrideFont: currentSettings.forcePublisherStyles,
        };
        
        if (renderer.setStyles) {
            
            const colors = getThemeColors(this.theme);
            
            const fontFamilyCSS = currentSettings.fontFamily === 'original' ? '' : `
                /* Font family override - applies to ALL elements with !important */
                html, body, 
                p, div, span, 
                h1, h2, h3, h4, h5, h6,
                li, ul, ol,
                blockquote, q,
                td, th, tr, table,
                dd, dt, dl,
                pre, code, samp, kbd,
                em, strong, b, i, u,
                small, sub, sup,
                label, figcaption,
                a, abbr, cite,
                input, textarea, button,
                ::before, ::after {
                    font-family: ${currentSettings.fontFamily === 'serif' ? 'Georgia, "Times New Roman", serif' : currentSettings.fontFamily === 'sans' ? '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif' : currentSettings.fontFamily === 'mono' ? '"SF Mono", Monaco, "Cascadia Code", "Roboto Mono", Consolas, "Courier New", monospace' : 'inherit'} !important;
                }
                
                /* Override inline styles that specify font-family */
                [style*="font-family"] {
                    font-family: ${currentSettings.fontFamily === 'serif' ? 'Georgia, "Times New Roman", serif' : currentSettings.fontFamily === 'sans' ? '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif' : currentSettings.fontFamily === 'mono' ? '"SF Mono", Monaco, "Cascadia Code", "Roboto Mono", Consolas, "Courier New", monospace' : 'inherit'} !important;
                }
            `;
            
            const textAlignCSS = `
                /* Text alignment - comprehensive selector coverage */
                body, p, div, 
                h1, h2, h3, h4, h5, h6,
                li, 
                blockquote, q,
                td, th,
                dd, dt,
                figcaption {
                    text-align: ${alignValue} !important;
                }
                
                /* Don't justify headers and captions */
                h1, h2, h3, h4, h5, h6, figcaption {
                    text-align: ${currentSettings.textAlign === 'justify' || currentSettings.textAlign === 'left' ? 'left' : currentSettings.textAlign} !important;
                }
                
                /* Override align attributes */
                [align="left"] { text-align: left !important; }
                [align="right"] { text-align: right !important; }
                [align="center"] { text-align: center !important; }
                [align="justify"] { text-align: justify !important; }
                
                /* Override inline text-align styles */
                [style*="text-align"] {
                    text-align: ${alignValue} !important;
                }
            `;
            
            const fontSizeOverrideCSS = currentSettings.forcePublisherStyles ? '' : `
                /* Force font-size inheritance on ALL text elements to override book CSS */
                p, div, span,
                h1, h2, h3, h4, h5, h6,
                li, ul, ol,
                blockquote, q,
                td, th, tr, table,
                dd, dt, dl,
                pre, code,
                em, strong, b, i, u,
                small, sub, sup,
                label, figcaption,
                a, abbr, cite {
                    font-size: inherit !important;
                }
                
                /* Override inline font-size styles from book.
                   Exclude html and body to preserve engine-set zoom font-size. */
                :not(html):not(body)[style*="font-size"] {
                    font-size: inherit !important;
                }
            `;

            const customCSS = `
                @namespace epub "http://www.idpf.org/2007/ops";
                
                :root {
                    --reader-bg: ${colors.bg};
                    --reader-fg: ${colors.fg};
                    --reader-link: ${colors.link};
                }
                
                @media screen {
                    html {
                        font-size: calc(${currentSettings.fontSize}px * var(--reader-zoom, 1)) !important;
                        line-height: ${currentSettings.lineHeight} !important;
                        color: ${colors.fg} !important;
                        background: ${colors.bg} !important;
                        letter-spacing: ${currentSettings.letterSpacing}em !important;
                        word-spacing: ${currentSettings.wordSpacing}em !important;
                        column-count: auto !important;
                    }
                    
                    body {
                        font-size: inherit !important;
                        line-height: inherit !important;
                        color: inherit !important;
                        background: ${colors.bg} !important;
                        letter-spacing: inherit !important;
                        word-spacing: inherit !important;
                        column-count: auto !important;
                        column-width: auto !important;
                    }
                    
                    ${fontSizeOverrideCSS}
                    
                    ${fontFamilyCSS}
                    
                    ${textAlignCSS}
                    
                    a:any-link {
                        color: ${colors.link} !important;
                    }
                    
                    /* Typography elements */
                    p, li, blockquote, dd {
                        line-height: ${currentSettings.lineHeight} !important;
                        hyphens: ${currentSettings.hyphenation ? 'auto' : 'none'} !important;
                    }
                    
                    ::selection {
                        background: color-mix(in srgb, ${colors.fg} 35%, transparent) !important;
                        color: ${colors.fg} !important;
                    }

                    /* Suppress iOS native callout menu so Theorem's toolbar
                       is not obscured by the system Look Up / Copy / Share popup.
                       Native selection handles and the magnifying loupe still work. */
                    html, body {
                        -webkit-touch-callout: none;
                    }
                }
            `;
            
            const foliateCSS = getCSS(readerStyle);
            const cssResult = Array.isArray(foliateCSS)
                ? `${foliateCSS[1]}\n${customCSS}`
                : `${foliateCSS}\n${customCSS}`;
            this._lastCssResult = cssResult;

            if (Array.isArray(foliateCSS)) {
                renderer.setStyles([foliateCSS[0], cssResult]);
            } else {
                renderer.setStyles(cssResult);
            }
        }
    }

    private scheduleSettingsUpdate(): void {
        if (this.pendingUpdateFrame) {
            cancelAnimationFrame(this.pendingUpdateFrame);
        }
        
        this.pendingUpdateFrame = requestAnimationFrame(() => {
            this.pendingUpdateFrame = null;
            this.applySettingsSync();
            this.applySettingsAsync().catch(console.error);
        });
    }

    async goTo(target: string | number): Promise<void> {
        if (!this.view) return;
        this._navigationInProgress = true;
        try {
            await this.view.goTo(target);
            this.applyZoomSync();
            this.scheduleSettingsUpdate();
        } finally {
            this._navigationInProgress = false;
        }
    }

    async goToFraction(fraction: number): Promise<void> {
        if (!this.view) return;
        this._navigationInProgress = true;
        try {
            const clampedFraction = Math.max(0, Math.min(1, fraction));
            await this.view.goToFraction(clampedFraction);
            this.applyZoomSync();
            this.scheduleSettingsUpdate();
        } finally {
            this._navigationInProgress = false;
        }
    }

    async next(distance?: number): Promise<void> {
        if (!this.view?.renderer) return;
        if (Date.now() < this.selectionNavLockUntil) return;
        this._navigationInProgress = true;
        try {
            await this.view.next(distance);
            this.applyZoomSync();
            // scheduleSettingsUpdate() keeps font-size/theme in sync on
            // page turns (matches the same call in goTo / goToFraction).
            // The old 350ms *setTimeout* workaround has been removed — styles
            // are now eagerly injected in afterLoad on chapter boundary. This
            // immediate RAF call is non-thrashing and covers within-chapter
            // turns as well.
            this.scheduleSettingsUpdate();
        } finally {
            this._navigationInProgress = false;
        }
    }

    async prev(distance?: number): Promise<void> {
        if (!this.view?.renderer) return;
        if (Date.now() < this.selectionNavLockUntil) return;
        this._navigationInProgress = true;
        try {
            await this.view.prev(distance);
            this.applyZoomSync();
            this.scheduleSettingsUpdate();
        } finally {
            this._navigationInProgress = false;
        }
    }

    async scrollUp(distance?: number): Promise<void> {
        if (Date.now() < this.selectionNavLockUntil) return;
        if (this.flow === 'scroll') {
            this._navigationInProgress = true;
            try {
                const scrollDistance = distance ?? this.getScrollDistance();
                await this.view?.prev?.(scrollDistance);
                this.applyZoomSync();
            } finally {
                this._navigationInProgress = false;
            }
        } else {
            await this.prev();
        }
    }

    async scrollDown(distance?: number): Promise<void> {
        if (Date.now() < this.selectionNavLockUntil) return;
        if (this.flow === 'scroll') {
            this._navigationInProgress = true;
            try {
                const scrollDistance = distance ?? this.getScrollDistance();
                await this.view?.next?.(scrollDistance);
                this.applyZoomSync();
            } finally {
                this._navigationInProgress = false;
            }
        } else {
            await this.next();
        }
    }

    private getScrollDistance(): number {
        
        const currentSettings = getCurrentReaderSettings();
        if (!currentSettings) return 48; 
        
        return currentSettings.fontSize * currentSettings.lineHeight * 3;
    }

    async goLeft(): Promise<void> {
        if (!this.view?.renderer) return;
        if (Date.now() < this.selectionNavLockUntil) return;
        await this.view.goLeft();
    }

    async goRight(): Promise<void> {
        if (!this.view?.renderer) return;
        if (Date.now() < this.selectionNavLockUntil) return;
        await this.view.goRight();
    }

    goBack(): void {
        this.view?.history?.back();
    }

    goForward(): void {
        this.view?.history?.forward();
    }

    canGoBack(): boolean {
        return this.view?.history?.canGoBack || false;
    }

    canGoForward(): boolean {
        return this.view?.history?.canGoForward || false;
    }

    setLayout(layout: PageLayout): void {
        if (this.layout === layout) return;
        this.layout = layout;
        this.scheduleSettingsUpdate();
    }

    setFlow(flow: ReadingFlow): void {
        if (this.flow === flow) return;
        this.flow = flow;
        const clampedZoom = this.clampZoomLevel(this.zoom_level);
        if (clampedZoom !== this.zoom_level) {
            this.zoom_level = clampedZoom;
            this.applyZoomSync();
        }
        
        if (this.isFixedLayoutFormat && this.view?.renderer) {
            if (this.flow !== 'scroll') {
                const zoomValue = this.zoom_level === 1.0 ? 'fit-page' : this.zoom_level;
                this.view.renderer.setAttribute('zoom', String(zoomValue));
            } else {
                this.view.renderer.removeAttribute('zoom');
            }
        }
        this.scheduleSettingsUpdate();
    }

    zoomIn(): void {
        this.setZoomLevel(this.zoom_level + READER_ZOOM_STEP);
    }

    zoomOut(): void {
        this.setZoomLevel(this.zoom_level - READER_ZOOM_STEP);
    }

    zoomRestore(): void {
        this.setZoomLevel(1.0);
    }

    setZoomLevel(level: number): void {
        const newLevel = this.clampZoomLevel(level);
        if (this.zoom_level === newLevel) return;
        
        this.zoom_level = newLevel;
        this.applyZoomSync();
    }

    setZoom(zoom: number): void {
        this.setZoomLevel(zoom / 100);
    }

    getZoomLevel(): number {
        return this.zoom_level;
    }

    private applyZoomSync(): void {
        if (!this.view?.renderer) {
            return;
        }

        const contents = this.view.renderer.getContents?.() || [];
        for (const content of contents) {
            const doc = content.doc;
            if (doc?.documentElement) {
                const root = doc.documentElement;
                if (this.isFixedLayoutFormat) {
                    this.applyZoomToDocument(doc);
                } else {
                    const currentZoom = root.style.getPropertyValue('--reader-zoom');
                    const currentSettings = getCurrentReaderSettings();
                    const expectedBaseFontSize = currentSettings?.fontSize ?? 16;
                    const expectedFontSizeStr = `${expectedBaseFontSize * this.zoom_level}px`;
                    const currentFontSize = root.style.getPropertyValue('font-size');
                    
                    if (currentZoom !== String(this.zoom_level) || currentFontSize !== expectedFontSizeStr) {
                        this.applyZoomToDocument(doc);
                    }
                }
            }
        }

        if (!this.isFixedLayoutFormat && typeof this.view.renderer.render === 'function') {
            
            const renderer = this.view.renderer as any;
            const currentSize = renderer?.size ?? 0;
            if (currentSize === 0) {
                this.view.renderer.render();
                this._retryIfBrokenLayout(0);
            }
        }
    }

    private _retryIfBrokenLayout(retries: number): void {
        if (retries >= 3) return;
        try {
            const renderer = this.view?.renderer as any;
            const pages = renderer?.pages;
            const viewSize = renderer?.viewSize;
            if (Number.isFinite(pages) && pages > 0 && Number.isFinite(viewSize) && viewSize > 0) return;
        } catch {
            return;
        }
        requestAnimationFrame(() => {
            try {
                if (typeof this.view?.renderer?.render === 'function') {
                    this.view.renderer.render();
                }
            } catch {
                
            }
            this._retryIfBrokenLayout(retries + 1);
        });
    }

    setMargins(_margins: number): void {
    }

    applyTheme(settings: ThemeSettings): void {
        
        if (settings.flow) {
            this.flow = settings.flow;
            this.zoom_level = this.clampZoomLevel(this.zoom_level, this.flow);
        }
        if (settings.layout) this.layout = settings.layout;
        if (settings.zoom) this.zoom_level = this.clampZoomLevel(settings.zoom / 100);

        this.scheduleSettingsUpdate();
        
        if (settings.zoom) {
            this.applyZoomSync();
        }
        
        if (this.isFixedLayoutFormat && this.view?.renderer && settings.zoom) {
            if (this.flow !== 'scroll') {
                const zoomValue = this.zoom_level === 1.0 ? 'fit-page' : this.zoom_level;
                this.view.renderer.setAttribute('zoom', String(zoomValue));
            } else {
                this.view.renderer.removeAttribute('zoom');
            }
        }
    }

    setTheme(theme: ReaderTheme): void {
        if (this.theme === theme) return;
        this.theme = theme;
        this.scheduleSettingsUpdate();
    }

    async addHighlight(cfi: string, text: string, color: HighlightColor, bookId?: string): Promise<Annotation> {
        
        const annotation: Annotation = {
            id: crypto.randomUUID(),
            bookId: bookId || '',
            type: 'highlight',
            location: cfi,
            selectedText: text,
            color,
            createdAt: new Date(),
        };

        this.annotations.set(annotation.id, annotation);
        this.annotationLocations.set(annotation.location, annotation);
        
        try {
            await this.view?.addAnnotation?.({
                value: cfi,
                color: color,
            });
        } catch (e) {
        }

        return annotation;
    }

    async addAnnotation(annotation: Annotation): Promise<void> {
        this.annotations.set(annotation.id, annotation);
        if (annotation.location) {
            this.annotationLocations.set(annotation.location, annotation);
        }
        
        if ((annotation.type === 'highlight' || annotation.type === 'note') && annotation.location) {
            try {
                await this.view?.addAnnotation?.({
                    value: annotation.location,
                    color: annotation.color,
                });
            } catch (e) {
            }
        }
    }

    async removeHighlight(id: string): Promise<void> {
        let annotation = this.annotations.get(id);
        if (!annotation) {
            annotation = this.annotationLocations.get(id);
        }
        if (!annotation) {
            return;
        }
        
        this.annotations.delete(annotation.id);
        if (annotation.location) {
            this.annotationLocations.delete(annotation.location);
        }
        
        try {
            if (this.view?.deleteAnnotation) {
                await this.view.deleteAnnotation({ value: annotation.location });
            } else {
                
                await this.view.goTo({ index: 0, fraction: 0 });
                
                if (this.options.onLocationChange) {
                    this.options.onLocationChange({ cfi: '', percentage: 0, tocItem: undefined, pageItem: undefined, pageInfo: undefined });
                }
            }
        } catch (e) {
        }
    }

    async removeAnnotation(id: string): Promise<void> {
        await this.removeHighlight(id);
    }

    getAnnotations(): Annotation[] {
        return Array.from(this.annotations.values());
    }

    getAnnotationsByBookId(bookId: string): Annotation[] {
        return Array.from(this.annotations.values()).filter(a => a.bookId === bookId);
    }

    async renderAnnotationsForSection(_sectionIndex: number): Promise<void> {
        if (!this.view || !this.book) {
            return;
        }

        const allAnnotations = Array.from(this.annotations.values());
        
        for (const annotation of allAnnotations) {
            
            if ((annotation.type === 'highlight' || annotation.type === 'note') && annotation.location) {
                try {
                    await this.view?.addAnnotation?.({
                        value: annotation.location,
                        color: annotation.color,
                    });
                } catch (e) {
                    
                }
            }
        }
        
    }

    async loadAnnotations(annotations: Annotation[]): Promise<void> {
        
        if (!this.view || !this.book) {
            return;
        }

        const deleteOps = Array.from(this.annotations.values())
            .map((annotation) =>
                this.view?.deleteAnnotation?.({ value: annotation.location })
                    ?.catch((e: any) => console.error("[catch]", e)) ?? Promise.resolve(),
            );
        await Promise.all(deleteOps);
        this.annotations.clear();
        this.annotationLocations.clear();

        const toRender = annotations.filter(
            (a) => a.location && (a.type === 'highlight' || a.type === 'note'),
        );
        for (const annotation of toRender) {
            this.annotations.set(annotation.id, annotation);
            this.annotationLocations.set(annotation.location, annotation);
        }

        const BATCH_SIZE = 12;
        for (let i = 0; i < toRender.length; i += BATCH_SIZE) {
            const batch = toRender.slice(i, i + BATCH_SIZE);
            await Promise.all(batch.map((annotation) =>
                this.view?.addAnnotation?.({
                    value: annotation.location,
                    color: annotation.color,
                })?.catch((e: any) => console.error("[catch]", e)) ?? Promise.resolve(),
            ));
            
            if (i + BATCH_SIZE < toRender.length) {
                await new Promise((resolve) => setTimeout(resolve, 4));
            }
        }
    }

    findRangeByText(doc: Document, text: string): Range | null {
        if (!text || !doc.body) return null;
        const target = text.trim();
        if (!target) return null;

        const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, null);
        let node: Text | null;
        const textNodes: Text[] = [];
        let fullText = '';
        while ((node = walker.nextNode() as Text | null)) {
            textNodes.push(node);
            fullText += node.nodeValue || '';
        }
        const index = fullText.indexOf(target);
        if (index === -1) return null;

        let cur = 0;
        let startNode: Text | null = null;
        let startOffset = 0;
        let endNode: Text | null = null;
        let endOffset = 0;
        const endIndex = index + target.length;

        for (const tn of textNodes) {
            const len = tn.nodeValue?.length || 0;
            if (!startNode && cur + len > index) {
                startNode = tn;
                startOffset = index - cur;
            }
            if (startNode && cur + len >= endIndex) {
                endNode = tn;
                endOffset = endIndex - cur;
                break;
            }
            cur += len;
        }

        if (startNode && endNode) {
            try {
                const range = doc.createRange();
                range.setStart(startNode, startOffset);
                range.setEnd(endNode, endOffset);
                return range;
            } catch {
                return null;
            }
        }
        return null;
    }

    async goToAnnotation(annotation: Annotation): Promise<void> {
        if (!annotation.location || !this.view) return;
        this._navigationInProgress = true;
        try {
            await this.view.goTo(annotation.location);
            this.applyZoomSync();
            this.scheduleSettingsUpdate();

            const contents = this.view.renderer?.getContents?.() || [];
            for (const content of contents) {
                const doc = content?.doc;
                if (!doc) continue;

                let exactRange: Range | null = null;

                try {
                    const resolved = this.view.resolveNavigation(annotation.location);
                    if (resolved?.anchor) {
                        const candidate = resolved.anchor(doc);
                        if (candidate instanceof Range) {
                            if (!annotation.selectedText || candidate.toString().trim() === annotation.selectedText.trim()) {
                                exactRange = candidate;
                            }
                        }
                    }
                } catch {}

                if (!exactRange && annotation.selectedText) {
                    exactRange = this.findRangeByText(doc, annotation.selectedText);
                }

                if (exactRange) {
                    await this.view.renderer?.scrollToAnchor?.(exactRange, 'selection');
                    this._lastAnnotationActivatedAt = Date.now();
                    if (this.options.onTextSelected) {
                        this.options.onTextSelected(annotation.location, annotation.selectedText || '', exactRange.cloneRange());
                    }
                    break;
                }
            }
        } finally {
            this._navigationInProgress = false;
        }
    }

    async *search(query: string): AsyncGenerator<SearchResult | { progress: number } | 'done'> {
        if (!this.book || !this.view) return;

        const normalizedQuery = query.trim();
        if (!normalizedQuery) {
            yield 'done';
            return;
        }

        let exactMatchCount = 0;
        const yieldedCFIs = new Set<string>();

        try {
            const searchIterator = this.view.search({
                query: normalizedQuery,
                matchCase: false,
                matchDiacritics: false,
                matchWholeWords: false,
            });

            for await (const result of searchIterator) {
                if (result === 'done') {
                    break;
                }

                if (
                    result
                    && typeof result === 'object'
                    && 'progress' in result
                    && typeof result.progress === 'number'
                ) {
                    yield { progress: result.progress };
                    continue;
                }

                if (!result || typeof result !== 'object') {
                    continue;
                }

                if ('cfi' in result && typeof result.cfi === 'string' && result.cfi) {
                    if (!yieldedCFIs.has(result.cfi)) {
                        yieldedCFIs.add(result.cfi);
                        yield {
                            cfi: result.cfi,
                            excerpt: this.normalizeSearchExcerpt((result as { excerpt?: unknown }).excerpt),
                        };
                        exactMatchCount++;
                    }
                }

                if ('subitems' in result && Array.isArray(result.subitems)) {
                    for (const subitem of result.subitems) {
                        if (!subitem || typeof subitem !== 'object') {
                            continue;
                        }
                        if (!('cfi' in subitem) || typeof subitem.cfi !== 'string' || !subitem.cfi) {
                            continue;
                        }

                        if (yieldedCFIs.has(subitem.cfi)) {
                            continue;
                        }

                        yieldedCFIs.add(subitem.cfi);
                        yield {
                            cfi: subitem.cfi,
                            excerpt: this.normalizeSearchExcerpt(
                                (subitem as { excerpt?: unknown }).excerpt,
                            ),
                        };
                        exactMatchCount++;

                        if (exactMatchCount >= READER_SEARCH_EXACT_LIMIT) {
                            break;
                        }
                    }
                }

                if (exactMatchCount >= READER_SEARCH_EXACT_LIMIT) {
                    break;
                }
            }
        } catch (error) {
        }

        if (exactMatchCount === 0) {
            const sectionNumber = Number(normalizedQuery);
            const sections = this.book.sections || [];
            const targetSectionIndex = sectionNumber - 1;
            if (Number.isInteger(sectionNumber) && targetSectionIndex >= 0 && targetSectionIndex < sections.length) {
                const cfi = this.view.getCFI?.(targetSectionIndex) || `section-${targetSectionIndex}`;
                if (cfi && !yieldedCFIs.has(cfi)) {
                    yieldedCFIs.add(cfi);
                    const fallbackText = this.createSectionFallbackSearchText(
                        sections[targetSectionIndex],
                        targetSectionIndex,
                    );
                    yield {
                        cfi,
                        excerpt: fallbackText || `Page ${sectionNumber}`,
                    };
                    exactMatchCount++;
                }
            }
        }

        if (exactMatchCount < READER_SEARCH_FALLBACK_TRIGGER_THRESHOLD) {
            const sectionCache = await this.getSearchSectionCache();
            const fallbackResults = rankByFuzzyQuery(sectionCache, normalizedQuery, {
                keys: [{ name: 'text', weight: 1 }],
                limit: READER_SEARCH_FALLBACK_LIMIT,
            });

            for (const { item } of fallbackResults) {
                if (yieldedCFIs.has(item.cfi)) {
                    continue;
                }

                yieldedCFIs.add(item.cfi);
                yield {
                    cfi: item.cfi,
                    excerpt: this.createSearchExcerpt(item.text, normalizedQuery),
                };
            }
        }

        yield 'done';
    }

    private normalizeSearchExcerpt(excerpt: unknown): string {
        if (typeof excerpt === 'string') {
            return excerpt;
        }

        if (excerpt && typeof excerpt === 'object') {
            const parsedExcerpt = excerpt as ReaderSearchExcerpt;
            const pre = parsedExcerpt.pre || '';
            const match = parsedExcerpt.match || '';
            const post = parsedExcerpt.post || '';
            const normalized = `${pre}${match}${post}`.trim();
            if (normalized) {
                return normalized;
            }
        }

        return '';
    }

    private createSearchExcerpt(sectionText: string, query: string): string {
        const normalizedText = sectionText.replace(/\s+/g, ' ').trim();
        if (!normalizedText) {
            return '';
        }

        const queryIndex = normalizedText.toLowerCase().indexOf(query.toLowerCase());
        if (queryIndex === -1) {
            return normalizedText.slice(0, READER_SEARCH_EXCERPT_CONTEXT_CHARS * 2);
        }

        const excerptStart = Math.max(0, queryIndex - READER_SEARCH_EXCERPT_CONTEXT_CHARS);
        const excerptEnd = Math.min(
            normalizedText.length,
            queryIndex + query.length + READER_SEARCH_EXCERPT_CONTEXT_CHARS,
        );
        const needsLeadingEllipsis = excerptStart > 0;
        const needsTrailingEllipsis = excerptEnd < normalizedText.length;

        return `${needsLeadingEllipsis ? '…' : ''}${normalizedText.slice(excerptStart, excerptEnd)}${needsTrailingEllipsis ? '…' : ''}`;
    }

    private async getSearchSectionCache(): Promise<ReaderSearchSectionCacheItem[]> {
        if (!this.book || !this.view) {
            return [];
        }

        if (this.searchSectionCache && this.searchCacheBookRef === this.book) {
            return this.searchSectionCache;
        }

        const sections = this.book.sections || [];
        const sectionCache: ReaderSearchSectionCacheItem[] = [];
        const sectionsToCache = Math.min(sections.length, READER_SEARCH_FALLBACK_MAX_SECTIONS);

        for (let i = 0; i < sectionsToCache; i++) {
            const section = sections[i];
            try {
                const sectionDocument = await section.createDocument?.();
                const rawText = sectionDocument?.body?.textContent || '';
                const normalizedText = rawText.replace(/\s+/g, ' ').trim();
                const cfi = this.view.getCFI?.(i) || `section-${i}`;
                if (!cfi) {
                    continue;
                }

                const sectionSearchText = normalizedText
                    ? normalizedText.slice(0, READER_SEARCH_FALLBACK_SECTION_CHAR_LIMIT)
                    : this.createSectionFallbackSearchText(section, i);
                if (!sectionSearchText) {
                    continue;
                }

                sectionCache.push({
                    cfi,
                    text: sectionSearchText,
                });
            } catch (error) {
            }
        }

        this.searchSectionCache = sectionCache;
        this.searchCacheBookRef = this.book;
        return sectionCache;
    }

    /** Full text of every section, for Save-as-Audiobook generation. */
    public async getAllSectionsForAudio(): Promise<{ id: string; title: string; text: string }[]> {
        const sections = this.book.sections || [];
        if (sections.length === 0) return [];
        const out: { id: string; title: string; text: string }[] = [];
        for (let i = 0; i < sections.length; i++) {
            const section = sections[i];
            try {
                const doc = await section.createDocument?.();
                const text = (doc?.body?.textContent || '').replace(/\s+/g, ' ').trim();
                if (!text) continue;
                out.push({
                    id: `section-${i}`,
                    title: section.title || section.label || `Section ${i + 1}`,
                    text,
                });
            } catch {
                // Skip unreadable sections; narration continues with the rest.
            }
        }
        return out;
    }

    private createSectionFallbackSearchText(section: any, sectionIndex: number): string {
        const sectionPositionLabel = this.isFixedLayoutFormat
            ? `Page ${sectionIndex + 1}`
            : `Section ${sectionIndex + 1}`;
        const candidates = [
            this.normalizeSectionSearchLabel(section?.id),
            this.normalizeSectionSearchLabel(section?.href),
            this.normalizeSectionSearchLabel(section?.name),
            this.normalizeSectionSearchLabel(section?.label),
            this.normalizeSectionSearchLabel(section?.filename),
        ];
        const parts = new Set<string>([sectionPositionLabel]);
        for (const candidate of candidates) {
            if (candidate) {
                parts.add(candidate);
            }
        }
        return Array.from(parts).join(' | ');
    }

    private normalizeSectionSearchLabel(value: unknown): string {
        if (typeof value !== 'string') {
            return '';
        }
        return value
            .replace(/^.*[\\/]/, '')
            .replace(/[#?].*$/, '')
            .replace(/\.[a-z0-9]{1,5}$/i, '')
            .replace(/[_-]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    clearSearch(): void {
        this.view?.clearSearch?.();
    }

    getCurrentLocation(): DocLocation | null {
        return this.currentLocation;
    }

    getSectionFractions(): number[] {
        return this.sectionFractions;
    }

    getCFIFromRange(index: number, range: Range): string {
        if (!this.view?.getCFI) return '';
        try {
            return this.view.getCFI(index, range);
        } catch (e) {
            return '';
        }
    }

    getSelectionFromDocument(): { text: string; cfi: string; range: Range } | null {
        
        if (!this.view || !this.book) {
            return null;
        }

        try {
            const contents = this.view.renderer?.getContents?.() || [];
            
            for (const content of contents) {
                
                if (!content || typeof content.index !== 'number') continue;
                
                const doc = content.doc;
                if (!doc) continue;

                const selection = doc.getSelection();
                if (selection && !selection.isCollapsed) {
                    const text = selection.toString().trim();
                    if (text) {
                        const range = selection.getRangeAt(0);
                        const cfi = this.getCFIFromRange(content.index, range);
                        if (cfi) {
                            return { text, cfi, range };
                        }
                    }
                }
            }
        } catch (e) {
            
        }
        return null;
    }

    private iframeListenersAttached = new WeakSet<Document>();
    private selectionCheckInterval: ReturnType<typeof setInterval> | null = null;

    private postMessageHandler: ((event: MessageEvent) => void) | null = null;

    private isInteractiveTapTarget(target: EventTarget | null): boolean {
        if (!(target instanceof Element)) {
            return false;
        }

        if (
            target.closest(
                'a,button,input,textarea,select,summary,label,[role="button"],[contenteditable="true"],[data-no-viewport-tap]',
            )
        ) {
            return true;
        }

        if (target instanceof SVGElement) {
            return true;
        }

        return false;
    }

    private notifyViewportTap(target: EventTarget | null): void {
        if (!this.options.onViewportTap) {
            return;
        }
        // A tap that just activated a highlight must not also toggle the
        // viewport chrome / close the annotation popover it opened. The
        // highlight overlay uses pointer-events:none, so event.target cannot
        // tell us this; use the activation timestamp instead.
        if (Date.now() - this._lastAnnotationActivatedAt < 420) {
            return;
        }
        if (this.isInteractiveTapTarget(target)) {
            return;
        }
        this._lastTapNotifiedAt = Date.now();
        this.options.onViewportTap();
    }

    private shouldForceViewportTap(): boolean {
        return this.options.shouldForceViewportTap?.() ?? false;
    }

    setupIframeSelectionListener(callback: (cfi: string, text: string, rangeOrEvent: Range | MouseEvent) => void): void {
        if (!this.view?.renderer) return;

        if (!this.postMessageHandler) {
            this.postMessageHandler = (event: MessageEvent) => {
                if (event.data?.type === 'foliate-selection') {
                    
                    const { sectionIndex, text, clientX, clientY, rect } = event.data;
                    
                    const contents = this.view?.renderer?.getContents?.() || [];
                    const content = contents.find((c: any) => c.index === sectionIndex);
                    
                    if (content?.doc) {
                        
                        const doc = content.doc;
                        const selection = doc.getSelection();
                        const frameElement = doc.defaultView?.frameElement;
                        const frameRect = frameElement instanceof HTMLElement
                            ? frameElement.getBoundingClientRect()
                            : null;
                        
                        if (selection && !selection.isCollapsed) {
                            try {
                                const range = selection.getRangeAt(0);
                                const cfi = this.getCFIFromRange(sectionIndex, range);
                                
                                if (cfi) {
                                    try {
                                        callback(cfi, text, range.cloneRange());
                                    } catch {
                                        const syntheticEvent = new MouseEvent('mouseup', {
                                            clientX: (
                                                frameRect
                                                    ? frameRect.left + (clientX || (rect?.left + rect?.width / 2) || 0)
                                                    : (clientX || (rect?.left + rect?.width / 2) || 0)
                                            ),
                                            clientY: (
                                                frameRect
                                                    ? frameRect.top + (clientY || (rect?.top) || 0)
                                                    : (clientY || (rect?.top) || 0)
                                            ),
                                            bubbles: true
                                        });
                                        callback(cfi, text, syntheticEvent);
                                    }
                                }
                            } catch (err) {
                            }
                        }
                    }
                } else if (event.data?.type === 'foliate-tap') {
                    const hasSelection = Boolean(event.data?.hasSelection);
                    if (hasSelection && !this.shouldForceViewportTap()) {
                        return;
                    }
                    this.notifyViewportTap(null);
                } else if (event.data?.type === 'foliate-footnote') {
                    this.options.onFootnote?.({
                        text: event.data.text,
                        html: event.data.html,
                        title: event.data.title,
                        href: event.data.href,
                        rect: event.data.rect,
                    });
                }
            };
            
            window.addEventListener('message', this.postMessageHandler);
        }

        const contents = this.view.renderer.getContents?.() || [];
        
        for (const content of contents) {
            const doc = content.doc;
            const win = doc?.defaultView;
            if (!doc || !win) {
                continue;
            }

            if (this.iframeListenersAttached.has(doc)) {
                continue;
            }

            this.iframeListenersAttached.add(doc);

            const iframeElement = doc.defaultView?.frameElement as HTMLIFrameElement;
            if (iframeElement) {
                
                iframeElement.addEventListener('load', () => {
                    this.attachSelectionListenersToIframe(iframeElement, content.index, callback);
                });
                
                this.attachSelectionListenersToIframe(iframeElement, content.index, callback);
            } else {
                
                this.injectSelectionScript(doc, content.index, callback);
            }

        }

        this.setupSelectionPolling(callback);
    }

    private attachSelectionListenersToIframe(
        iframe: HTMLIFrameElement,
        index: number,
        callback: (cfi: string, text: string, rangeOrEvent: Range | MouseEvent) => void
    ): void {
        try {
            const doc = iframe.contentDocument;
            const win = iframe.contentWindow;
            
            if (!doc || !win) {
                return;
            }

            if (doc.documentElement) {
                doc.documentElement.style.touchAction = 'manipulation';
            }
            if (doc.body) {
                doc.body.style.touchAction = 'manipulation';
            }
            
            let lastSelectionKey = '';
            let pointerDownX = 0;
            let pointerDownY = 0;
            let pointerDownAt = 0;
            let pointerMoved = false;
            const SELECTION_CAPTURE_DELAY = 12;
            const SELECTION_INTERACTION_SUPPRESS_MS = 420;
            const TAP_MAX_DISTANCE = 12;
            const TAP_MAX_DURATION = 350;
            let selectionCaptureTimeout: number | null = null;
            let lastSelectionCapturedAt = 0;
            // Track whether a touch gesture is active so the selection callback
            // is deferred to touchend rather than fired on every selectionchange
            // mid-drag (which caused the toolbar to flash while extending selection).
            let isTouchActive = false;
            let pendingTouchSelection = false;

            const getEventPoint = (event?: MouseEvent | PointerEvent | TouchEvent): { x: number; y: number } | null => {
                if (!event) {
                    return null;
                }
                if ('changedTouches' in event && event.changedTouches.length > 0) {
                    const touch = event.changedTouches[0];
                    return { x: touch.clientX, y: touch.clientY };
                }
                if ('clientX' in event && typeof event.clientX === 'number') {
                    return { x: event.clientX, y: event.clientY };
                }
                return null;
            };

            const scheduleSelectionCapture = (
                event?: MouseEvent | PointerEvent | TouchEvent,
                delay: number = SELECTION_CAPTURE_DELAY,
            ) => {
                if (selectionCaptureTimeout !== null) {
                    window.clearTimeout(selectionCaptureTimeout);
                }
                selectionCaptureTimeout = window.setTimeout(() => {
                    selectionCaptureTimeout = null;
                    try {
                        const selection = doc.getSelection();
                        if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
                            lastSelectionKey = '';
                            return;
                        }

                        const text = selection.toString().trim();
                        if (!text) {
                            return;
                        }

                        const range = selection.getRangeAt(0);
                        const cfi = this.getCFIFromRange(index, range);
                        if (!cfi) {
                            return;
                        }

                        const selectionKey = `${cfi}::${text}`;
                        if (selectionKey === lastSelectionKey) {
                            return;
                        }
                        lastSelectionKey = selectionKey;

                        lastSelectionCapturedAt = Date.now();
                        
                        this.selectionNavLockUntil = Date.now() + 2000;
                        try {
                            callback(cfi, text, range.cloneRange());
                        } catch {
                            const rect = range.getBoundingClientRect();
                            const point = getEventPoint(event) ?? {
                                x: rect.left + rect.width / 2,
                                y: rect.top,
                            };
                            const iframeRect = iframe.getBoundingClientRect();
                            const syntheticEvent = new MouseEvent('mouseup', {
                                clientX: iframeRect.left + point.x,
                                clientY: iframeRect.top + point.y,
                                bubbles: true,
                            });
                            callback(cfi, text, syntheticEvent);
                        }
                    } catch (err) {
                    }
                }, delay);
            };

            doc.addEventListener(
                'contextmenu',
                (event: MouseEvent) => {
                    event.preventDefault();
                    event.stopPropagation();
                },
                true,
            );

            win.addEventListener(
                'contextmenu',
                (event: MouseEvent) => {
                    event.preventDefault();
                    event.stopPropagation();
                },
                true,
            );

            const suppressDoubleTapZoom = (event: Event) => {
                event.preventDefault();
            };

            doc.addEventListener('dblclick', suppressDoubleTapZoom, true);
            win.addEventListener('dblclick', suppressDoubleTapZoom, true);

            win.addEventListener(
                'pointerdown',
                (event: PointerEvent) => {
                    if (!event.isPrimary || event.button !== 0) {
                        return;
                    }
                    pointerDownX = event.clientX;
                    pointerDownY = event.clientY;
                    pointerDownAt = Date.now();
                    pointerMoved = false;
                },
                true,
            );

            win.addEventListener(
                'pointermove',
                (event: PointerEvent) => {
                    if (pointerDownAt === 0) {
                        return;
                    }
                    const distance = Math.hypot(
                        event.clientX - pointerDownX,
                        event.clientY - pointerDownY,
                    );
                    if (distance > TAP_MAX_DISTANCE) {
                        pointerMoved = true;
                    }
                },
                true,
            );

            win.addEventListener(
                'pointercancel',
                (event: PointerEvent) => {
                    pointerDownAt = 0;
                    pointerMoved = false;
                    isTouchActive = false;
                    pendingTouchSelection = false;
                    // On mobile (Android), long-press triggers the native selection layer
                    // and cancels DOM pointer/touch events. Process the pending selection.
                    scheduleSelectionCapture(event, 30);
                    window.setTimeout(() => {
                        scheduleSelectionCapture(undefined, 0);
                    }, 80);
                },
                true,
            );

            win.addEventListener(
                'touchstart',
                () => {
                    isTouchActive = true;
                    pendingTouchSelection = false;
                },
                { capture: true, passive: true },
            );

            win.addEventListener(
                'touchend',
                (event: TouchEvent) => {
                    isTouchActive = false;
                    if (pendingTouchSelection) {
                        // Touch is finishing — process the deferred selection exactly once
                        // at gesture end rather than once per selectionchange event mid-drag.
                        pendingTouchSelection = false;
                    }
                    scheduleSelectionCapture(event);
                },
                { capture: true, passive: true },
            );

            win.addEventListener(
                'touchcancel',
                (event: TouchEvent) => {
                    isTouchActive = false;
                    pendingTouchSelection = false;
                    pointerDownAt = 0;
                    pointerMoved = false;
                    // On mobile (Android), long-press triggers the native selection layer
                    // and dispatches touchcancel. Capture the committed single-word selection.
                    scheduleSelectionCapture(event, 30);
                    window.setTimeout(() => {
                        scheduleSelectionCapture(undefined, 0);
                    }, 80);
                },
                { capture: true, passive: true },
            );

            doc.addEventListener('selectionchange', () => {
                const sel = doc.getSelection();
                // Always maintain the nav lock while selection is non-empty.
                if (sel && !sel.isCollapsed && sel.toString().trim().length > 0) {
                    this.selectionNavLockUntil = Date.now() + 2000;
                }
                // While a touch gesture is active, defer the selection callback to
                // touchend to prevent the toolbar from flashing during drag-to-select.
                // Mouse/keyboard selections process immediately as before.
                if (isTouchActive) {
                    pendingTouchSelection = true;
                    return;
                }
                scheduleSelectionCapture();
            }, true);

            win.addEventListener('mouseup', (event: MouseEvent) => {
                scheduleSelectionCapture(event);
            }, true);

            win.addEventListener(
                'pointerup',
                (event: PointerEvent) => {
                    if (!event.isPrimary || event.button !== 0) {
                        pointerDownAt = 0;
                        pointerMoved = false;
                        return;
                    }

                    const elapsed = Date.now() - pointerDownAt;
                    const distance = Math.hypot(
                        event.clientX - pointerDownX,
                        event.clientY - pointerDownY,
                    );
                    const isTap =
                        pointerDownAt > 0
                        && !pointerMoved
                        && elapsed <= TAP_MAX_DURATION
                        && distance <= TAP_MAX_DISTANCE;

                    pointerDownAt = 0;
                    pointerMoved = false;
                    scheduleSelectionCapture(event);

                    if (!isTap) {
                        return;
                    }

                    window.setTimeout(() => {
                        // Dedup: if the injected-script foliate-tap postMessage already
                        // notified within 150ms, skip. This prevents a double-toggle when
                        // both paths fire on same-origin iframes. If the postMessage path
                        // never fires (cross-origin, script injection unavailable, etc.),
                        // this outer handler is the reliable fallback.
                        const TAP_DEDUP_MS = 150;
                        if (Date.now() - this._lastTapNotifiedAt < TAP_DEDUP_MS) {
                            return;
                        }

                        const shouldSuppressInteraction =
                            Date.now() - lastSelectionCapturedAt < SELECTION_INTERACTION_SUPPRESS_MS;
                        if (shouldSuppressInteraction) {
                            return;
                        }

                        const selection = doc.getSelection();
                        const hasSelection = Boolean(
                            selection
                            && !selection.isCollapsed
                            && selection.toString().trim().length > 0,
                        );
                        if (hasSelection && !this.shouldForceViewportTap()) {
                            return;
                        }
                        this.notifyViewportTap(event.target);
                    }, SELECTION_CAPTURE_DELAY);
                },
                true,
            );
            
        } catch (err) {
        }
    }

    private injectSelectionScript(
        doc: Document, 
        index: number, 
        _callback: (cfi: string, text: string, event: MouseEvent) => void
    ): void {
        const script = doc.createElement('script');
        script.textContent = `
            (function() {
                let lastSelection = '';
                let pointerDownX = 0;
                let pointerDownY = 0;
                let pointerDownAt = 0;
                let pointerMoved = false;
                const SELECTION_CAPTURE_DELAY = 24;
                const TAP_MAX_DISTANCE = 12;
                const TAP_MAX_DURATION = 350;
                
                function postSelection(clientX, clientY) {
                    var selection = document.getSelection();
                    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
                        lastSelection = '';
                        return false;
                    }

                    var text = selection.toString().trim();
                    if (!text || text === lastSelection) {
                        return false;
                    }

                    lastSelection = text;
                    var range = selection.getRangeAt(0);
                    var rect = range.getBoundingClientRect();
                    window.parent.postMessage({
                        type: 'foliate-selection',
                        sectionIndex: ${index},
                        text: text,
                        clientX: Number.isFinite(clientX) ? clientX : rect.left + rect.width / 2,
                        clientY: Number.isFinite(clientY) ? clientY : rect.top,
                        rect: {
                            left: rect.left,
                            top: rect.top,
                            width: rect.width,
                            height: rect.height
                        }
                    }, '*');
                    return true;
                }
                
                document.addEventListener('pointerdown', function(e) {
                    if (!e.isPrimary || e.button !== 0) {
                        return;
                    }
                    pointerDownX = e.clientX;
                    pointerDownY = e.clientY;
                    pointerDownAt = Date.now();
                    pointerMoved = false;
                });

                document.addEventListener('pointermove', function(e) {
                    if (pointerDownAt === 0) {
                        return;
                    }
                    var distance = Math.hypot(e.clientX - pointerDownX, e.clientY - pointerDownY);
                    if (distance > TAP_MAX_DISTANCE) {
                        pointerMoved = true;
                    }
                });

                function handleCancel(e) {
                    pointerDownAt = 0;
                    pointerMoved = false;
                    var touch = e && e.changedTouches && e.changedTouches.length > 0
                        ? e.changedTouches[0]
                        : null;
                    var clientX = touch ? touch.clientX : (e && typeof e.clientX === 'number' ? e.clientX : undefined);
                    var clientY = touch ? touch.clientY : (e && typeof e.clientY === 'number' ? e.clientY : undefined);
                    setTimeout(function() {
                        postSelection(clientX, clientY);
                    }, 30);
                    setTimeout(function() {
                        postSelection();
                    }, 80);
                }

                document.addEventListener('pointercancel', handleCancel, true);
                document.addEventListener('touchcancel', handleCancel, { passive: true });

                document.addEventListener('contextmenu', function(e) {
                    e.preventDefault();
                    e.stopPropagation();
                }, true);
                
                document.addEventListener('pointerup', function(e) {
                    const elapsed = Date.now() - pointerDownAt;
                    const distance = Math.hypot(e.clientX - pointerDownX, e.clientY - pointerDownY);
                    const isTap =
                        pointerDownAt > 0
                        && !pointerMoved
                        && elapsed <= TAP_MAX_DURATION
                        && distance <= TAP_MAX_DISTANCE;
                    pointerDownAt = 0;
                    pointerMoved = false;
                    
                    // Check selection after a short delay
                    setTimeout(function() {
                        var hasSelection = postSelection(e.clientX, e.clientY);
                        if (isTap) {
                            window.parent.postMessage({
                                type: 'foliate-tap',
                                sectionIndex: ${index},
                                hasSelection: hasSelection,
                            }, '*');
                        }
                    }, SELECTION_CAPTURE_DELAY);
                });

                document.addEventListener('touchend', function(e) {
                    setTimeout(function() {
                        var touch = e.changedTouches && e.changedTouches.length > 0
                            ? e.changedTouches[0]
                            : null;
                        postSelection(touch ? touch.clientX : undefined, touch ? touch.clientY : undefined);
                    }, SELECTION_CAPTURE_DELAY);
                }, { passive: true });

                document.addEventListener('selectionchange', function() {
                    setTimeout(function() {
                        postSelection();
                    }, SELECTION_CAPTURE_DELAY);
                });
            })();
        `;
        
        if (doc.head) {
            doc.head.appendChild(script);
        } else if (doc.body) {
            doc.body.appendChild(script);
        }
    }

    private setupSelectionPolling(_callback: (cfi: string, text: string, event: MouseEvent) => void): void {
        
    }

    clearSelection(): void {
        if (!this.view) return;
        
        try {
            const contents = this.view.renderer?.getContents?.() || [];
            for (const content of contents) {
                const doc = content.doc;
                if (doc) {
                    doc.getSelection()?.removeAllRanges();
                }
            }
        } catch (e) {
            
        }
    }

    getCurrentSectionIndex(): number {
        const contents = this.view?.renderer?.getContents?.() || [];
        if (contents.length > 0) {
            return contents[0].index;
        }
        return -1;
    }

    getDocumentForSection(index: number): Document | null {
        const contents = this.view?.renderer?.getContents?.() || [];
        const content = contents.find((c: { index: number }) => c.index === index);
        return content?.doc || null;
    }

    getFormat(): BookFormat {
        return this.format;
    }

    isFixedLayout(): boolean {
        return this.isFixedLayoutFormat;
    }

    isReflowable(): boolean {
        return !this.isFixedLayoutFormat;
    }

    destroy(): void {
        
        if (this.pendingUpdateFrame) {
            cancelAnimationFrame(this.pendingUpdateFrame);
            this.pendingUpdateFrame = null;
        }

        if (this.selectionCheckInterval) {
            clearInterval(this.selectionCheckInterval);
            this.selectionCheckInterval = null;
        }

        if (this.postMessageHandler) {
            window.removeEventListener('message', this.postMessageHandler);
            this.postMessageHandler = null;
        }
        
        if (this.unsubscribeFromStyles) {
            this.unsubscribeFromStyles();
            this.unsubscribeFromStyles = null;
        }
        
        if (this.view) {
            this.view.close?.();
            this.view.remove?.();
            this.view = null;
        }
        this.annotations.clear();
        this.annotationLocations.clear();
        this.searchSectionCache = null;
        this.searchCacheBookRef = null;
        if (this.book) {
            try { this.book.destroy?.(); } catch { /* ignore destroy errors */ }
        }
        this.book = null;
        this.container = null;
    }
}

export default FoliateEngine;
