import './comic-strip';
import { ComicFlowController, comicBookForFlow, isComicFormat } from './comic-flow';
import { readCbrAsCbz } from '../../../core/lib/cbr';

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
import { computeTextSelectionRects } from '../foliate/selection-rects';
import { isNativeRangeFile, openNativeRangeFile, type BookSource } from '../../../core/lib/native-range-file';
import { 
    registerEngineStyleCallback,
    getCurrentReaderSettings,
} from '../../../core/lib/design-tokens';
import { isTauri, isWebKitGTK } from '../../../core/lib/env';
import { toDocMetadata } from './doc-metadata';
import { collectAudioSections } from './audio-sections';
import { Overlayer } from '../foliate-js-runtime/overlayer.js';
import { useLibraryStore } from '../../../core/store';
import { isUserRelocation } from '../lib/resume-progress';
import {
    applyRendererLayoutAttributes,
    buildFoliateStyles,
    computeFoliateCssKey,
    extractTocItems,
    getHighlightColor,
    SELECTION_FILL,
    SELECTION_OVERLAY_CLASS,
} from './foliate-styles';
import { FoliateSelectionController } from './foliate-selection';

const READER_SEARCH_EXACT_LIMIT = 120;
const MIN_READER_ZOOM_LEVEL = 0.2;
const MIN_PAGED_READER_ZOOM_LEVEL = 1.0;
const MAX_READER_ZOOM_LEVEL = 4.0;
const READER_ZOOM_STEP = 0.1;
const READER_OPEN_TIMEOUT_MS = 20000;
const READER_INITIAL_NAVIGATION_TIMEOUT_MS = 15000;
const READER_INITIAL_NAVIGATION_RETRIES = 1;

// Parsed foliate Book models, keyed by stable book identity (materialized
// path or filename+size) so repeat opens skip EPUB OPF/nav re-parsing. The
// Book keeps its source File/Blob alive, so the cache is intentionally small.
const BOOK_MODEL_CACHE_LIMIT = 2;
/** `MediaOverlay` in foliate-js-runtime/epub.js. Fires `highlight`, `unhighlight`, `finished`, `error`. */
export interface MediaOverlayPlayer extends EventTarget {
    pause(): void;
    resume(): void;
    stop(): void;
    prev(): void;
    next(): void;
    setVolume(volume: number): void;
    setRate(rate: number): void;
}

const bookModelCache = new Map<string, { book: unknown; cleanup: () => void }>();

function isBookInModelCache(book: unknown): boolean {
    if (!book) return false;
    for (const entry of bookModelCache.values()) {
        if (entry.book === book) return true;
    }
    return false;
}

interface ReaderSearchExcerpt {
    pre?: string;
    match?: string;
    post?: string;
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
    /** location → spine index, resolved once through foliate (null = unresolvable). */
    private annotationSectionCache: Map<string, number | null> = new Map();
    /** Overlayers that already hold every annotation of their section. */
    private populatedOverlayers: WeakSet<object> = new WeakSet();
    /** Section documents whose selection is drawn by the overlayer. */
    private selectionOverlayDocs: WeakSet<Document> = new WeakSet();
    private currentLocation: DocLocation | null = null;
    private sectionFractions: number[] = [];
    private sectionPageCounts: Map<number, number> = new Map();

    private comicFlowController = new ComicFlowController();
    private format: BookFormat = 'epub';
    private isFixedLayoutFormat = false;

    private layout: PageLayout = 'single';
    private flow: ReadingFlow = 'paged';
    private zoom_level = 1;
    
    private selectionNavLockUntil = 0;
    private theme: ReaderTheme = 'light';
    
    private pendingUpdateFrame: number | null = null;

    private _lastCssSettingsKey = '';
    /** Exactly what was last passed to `renderer.setStyles`: foliate's base sheet and ours. */
    private _lastCssResult: string | [string, string] | null = null;
    private _lastAnnotationActivatedAt = 0;

    private unsubscribeFromStyles: (() => void) | null = null;

    private _keyboardAttached = new WeakSet<Document>();

    private _awaitingInitialRelocate = false;
    
    private _lastSectionIndex = -1;
    
    private _navigationInProgress = false;

    private pendingTimeouts: Set<number> = new Set();
    private readonly selectionController: FoliateSelectionController;

    constructor(options: FoliateEngineOptions = {}) {
        this.options = options;
        this.selectionController = new FoliateSelectionController({
            getView: () => this.view,
            getBook: () => this.book,
            getCFIFromRange: (index, range) => this.getCFIFromRange(index, range),
            pendingTimeouts: this.pendingTimeouts,
            setSelectionNavLockUntil: (until) => { this.selectionNavLockUntil = until; },
            getLastAnnotationActivatedAt: () => this._lastAnnotationActivatedAt,
            onViewportTap: () => this.options.onViewportTap?.(),
            shouldForceViewportTap: () => this.options.shouldForceViewportTap?.() ?? false,
            onFootnote: (data) => this.options.onFootnote?.(data),
        });
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

    // Initial open-path navigation runs while the spine, CSS, and native
    // prefetch are still settling, so a single short timeout produces
    // false-positive "Timed out" errors (#105). Retry once with the longer
    // initial-navigation budget before surfacing.
    private async goToWithRetry(
        target: string | { index: number; fraction: number },
        operation: string,
    ): Promise<unknown> {
        let lastError: unknown = null;
        for (let attempt = 0; attempt <= READER_INITIAL_NAVIGATION_RETRIES; attempt++) {
            try {
                return await this.withTimeout(
                    this.view.goTo(target),
                    READER_INITIAL_NAVIGATION_TIMEOUT_MS,
                    operation,
                );
            } catch (err) {
                lastError = err;
            }
        }
        throw lastError;
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

    /** The book's Media Overlay player, or null when it has no synced narration. */
    public getMediaOverlay(): MediaOverlayPlayer | null {
        return this.view?.mediaOverlay ?? null;
    }

    /** Starts synced narration at the beginning of the current section. */
    public async startMediaOverlay(): Promise<void> {
        if (this.view?.mediaOverlay) await this.view.startMediaOverlay();
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

        const visibleRange = (this.view as any)?.lastLocation?.range as Range | undefined;
        let fullText = "";

        for (const content of contents) {
            const doc = content.document || content.doc;
            if (!doc || !doc.body) continue;

            if (visibleRange) {
                try {
                    const afterRange = doc.createRange();
                    afterRange.setStart(visibleRange.endContainer, visibleRange.endOffset);
                    afterRange.setEndAfter(doc.body.lastChild || doc.body);
                    const text = afterRange.toString().trim();
                    if (text) fullText += (fullText ? "\n" : "") + text;
                } catch {
                    // Fallback to body text if boundary points are in different nodes
                }
            } else {
                const body = doc.body as HTMLElement;
                const text = (body.innerText || '').trim();
                if (text) fullText += (fullText ? "\n" : "") + text;
            }
        }

        if (!fullText.trim()) return null;
        return { text: fullText.trim().slice(0, 2500), startWordId: "" };
    }

    async open(
        source: BookSource | ArrayBuffer | string,
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
            if (isNativeRangeFile(source)) {
                // Read ranges from disk; zip.js only uses size/slice/arrayBuffer.
                file = source as unknown as File;
            } else if (source instanceof File) {
                file = source;
            } else if (source instanceof Blob) {
                file = new File([source], _filename, { type: source.type || 'application/epub+zip' });
            } else {
                const buffer = typeof source === 'string' ? new TextEncoder().encode(source) : source;
                file = new File([buffer], _filename, { type: 'application/epub+zip' });
            }

            if (format === 'cbr' && isTauri()) {
                try {
                    const targetPath = nativeFilePath || (source as { path?: string })?.path;
                    if (targetPath) {
                        const cbzName = _filename.replace(/\.cbr$/i, '.cbz');
                        const { invoke } = await import('@tauri-apps/api/core');
                        const cachedCbzPath = await invoke<string>('prepare_cbr_as_cbz', { path: targetPath }).catch(() => '');
                        const ranged = cachedCbzPath
                            ? await openNativeRangeFile(cachedCbzPath, cbzName, 'application/vnd.comicbook+zip')
                            : null;
                        if (ranged) {
                            file = ranged as unknown as File;
                        } else {
                            const cbzBytes = await readCbrAsCbz(targetPath);
                            file = new File([cbzBytes], cbzName, {
                                type: 'application/vnd.comicbook+zip',
                            });
                        }
                    }
                } catch (e) {
                    throw new Error(`Failed to convert CBR to CBZ: ${e}`);
                }
            }

            const bookCacheKey = nativeFilePath ?? `${_filename}:${file.size}`;
            const cachedEntry = bookModelCache.get(bookCacheKey);
            if (cachedEntry) {
                // Refresh LRU recency on hit so actively reopened books stay warm.
                bookModelCache.delete(bookCacheKey);
                bookModelCache.set(bookCacheKey, cachedEntry);
                this.book = cachedEntry.book;
            } else {
                this.book = await makeBook(file,
                    nativeFilePath ? import('../../../core/lib/tauri-epub-bridge')
                        .then(m => m.tryNativePrefetchEpub(nativeFilePath)) : undefined
                );
                // Build a cleanup fn that destroys the book's internal resources
                const bookRef = this.book;
                const cleanup = () => {
                    try { (bookRef as { destroy?: () => void }).destroy?.(); } catch { /* ignore */ }
                };
                bookModelCache.set(bookCacheKey, { book: this.book, cleanup });
                if (bookModelCache.size > BOOK_MODEL_CACHE_LIMIT) {
                    const [oldestKey, oldestEntry] = bookModelCache.entries().next().value as [string, { book: unknown; cleanup: () => void }];
                    if (oldestKey !== undefined) {
                        oldestEntry.cleanup();
                        bookModelCache.delete(oldestKey);
                    }
                }
            }
            this.annotationSectionCache.clear();

            this.view = document.createElement('foliate-view');
            this.view.style.width = '100%';
            this.view.style.height = '100%';
            this.view.style.display = 'block';
            this.container.appendChild(this.view);

            this.setupEventListeners();

            this.flow = flow;
            await this.withTimeout(
                this.view.open(isComicFormat(this.format) ? comicBookForFlow(this.book, flow) : this.book),
                READER_OPEN_TIMEOUT_MS,
                'opening the book',
            );

            if (this.view.mediaOverlay) {
                // Changing the rate of playing audio silences WebKitGTK; the overlay
                // restarts the phrase at the new rate there instead.
                this.view.mediaOverlay.restartOnRateChange = isWebKitGTK();
            }

            this.sectionFractions = this.view.getSectionFractions() || [];
            this.sectionPageCounts.clear();
            
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
                        const result = await this.goToWithRetry(
                            initialLocation,
                            'restoring saved location',
                        );
                        if (!result) {
                            
                            await this.goToWithRetry(
                                { index: 0, fraction: 0 },
                                'navigating to the start',
                            );
                        } else {
                        }
                } catch (err) {
                    
                    await this.goToWithRetry(
                        { index: 0, fraction: 0 },
                        'navigating to the start',
                    );
                    
                    if (this.options.onLocationChange) {
                        this.options.onLocationChange({ cfi: '', percentage: 0, tocItem: undefined, pageItem: undefined, pageInfo: undefined });
                    }
                }
                } else {
                    await this.goToWithRetry(
                        { index: 0, fraction: 0 },
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
            const sectionIndex = typeof detail.index === 'number' ? detail.index
                : typeof detail.section?.current === 'number' ? detail.section.current : 0;
            const totalSections = detail.section?.total ?? this.book?.sections?.length ?? 1;
            const isLastSection = sectionIndex >= totalSections - 1;
            const sectionPages = isPaginator ? Math.max(1, renderer.pages > 2 ? renderer.pages - 2 : renderer.pages) : 1;
            const isAtEnd = !!(renderer?.atEnd || (isPaginator && isLastSection && renderer.page >= sectionPages));

            let pageInfo: DocLocation['pageInfo'] | undefined;
            if (isPaginator) {
                this.sectionPageCounts.set(sectionIndex, sectionPages);
                if (isSingleSection) {
                    const currentPage = isAtEnd ? sectionPages : Math.max(1, Math.min(sectionPages, renderer.page ?? 1));
                    pageInfo = {
                        currentPage,
                        endPage: currentPage,
                        totalPages: sectionPages,
                        range: `${currentPage}`,
                        isEstimated: false,
                    };
                } else {
                    const sectionSizes: number[] = this.book?.sections?.map((s: any) =>
                        (s.linear !== 'no' && s.size > 0 ? s.size : 0)
                    ) || [];
                    const currentSectionSize = sectionSizes[sectionIndex] || 0;
                    const bytesPerPage = currentSectionSize > 0 ? currentSectionSize / sectionPages : 1500;

                    let pagesBefore = 0;
                    for (let i = 0; i < sectionIndex; i++) {
                        if (this.sectionPageCounts.has(i)) {
                            pagesBefore += this.sectionPageCounts.get(i)!;
                        } else {
                            const size_i = sectionSizes[i] || 0;
                            pagesBefore += Math.max(1, Math.round(size_i / bytesPerPage));
                        }
                    }

                    let pagesAfter = 0;
                    for (let i = sectionIndex + 1; i < totalSections; i++) {
                        if (this.sectionPageCounts.has(i)) {
                            pagesAfter += this.sectionPageCounts.get(i)!;
                        } else {
                            const size_i = sectionSizes[i] || 0;
                            pagesAfter += Math.max(1, Math.round(size_i / bytesPerPage));
                        }
                    }

                    const rawCurrentPage = pagesBefore + Math.max(1, Math.min(sectionPages, renderer.page ?? 1));
                    const totalPages = Math.max(rawCurrentPage, pagesBefore + sectionPages + pagesAfter);
                    const currentPage = isAtEnd ? totalPages : rawCurrentPage;
                    pageInfo = {
                        currentPage,
                        endPage: currentPage,
                        totalPages,
                        range: `${currentPage}`,
                        isEstimated: true,
                    };
                }
            } else if (isComicFormat(this.format) && typeof detail.section?.current === 'number') {
                const currentPage = detail.section.current + 1;
                pageInfo = { currentPage, endPage: currentPage, totalPages: this.book.sections.length,
                    range: String(currentPage), isEstimated: false };
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
                ...(isUserRelocation(detail.reason) ? { byUser: true } : {}),
            };

            this.currentLocation = location;

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
                this.renderAnnotationsForSection(sectionIndex, true);
            }
        });

        this.view.history?.addEventListener('index-change', () => {
            if (this.options.onLocationChange && this.currentLocation) {
                this.options.onLocationChange(this.currentLocation);
            }
        });

        this.view.history?.addEventListener('popstate', (_e: any) => {
        });

        this.view.addEventListener('create-overlay', (e: any) => {
            const index = e?.detail?.index;
            if (typeof index === 'number') {
                this.renderAnnotationsForSection(index);
                const doc = (this.view?.renderer?.getContents?.() || []).find((c: any) => c.index === index)?.doc;
                if (doc) this.attachSelectionOverlay(doc);
            }
        });

        this.view.addEventListener('load', (e: any) => {
            const detail = e.detail;
            
            requestAnimationFrame(() => {
                if (this.options.onTextSelected) {
                    this.setupIframeSelectionListener(this.options.onTextSelected);
                }
                if (typeof detail?.index === 'number') {
                    this.renderAnnotationsForSection(detail.index);
                }
                if (detail?.doc) this.attachSelectionOverlay(detail.doc);
            });
        });

        this.view.addEventListener('draw-annotation', (e: any) => {
            const { draw, annotation } = e.detail;
            
            if (!draw || !annotation) {
                return;
            }

            const color = this.getHighlightColor(annotation.color || 'yellow');
            try {
                draw(Overlayer.highlight, { color });
            } catch (err) {
                console.error('[draw-annotation] failed to draw highlight', err);
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
        return getHighlightColor(colorName);
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

        return toDocMetadata(this.book.metadata);
    }

    private extractToc(): TocItem[] {
        return extractTocItems(this.book?.toc);
    }

    private applySettingsSync(): void {
        if (!this.view?.renderer || typeof this.view.renderer.setAttribute !== 'function') return;
        applyRendererLayoutAttributes({
            renderer: this.view.renderer,
            flow: this.flow,
            layout: this.layout,
            zoomLevel: this.zoom_level,
            isFixedLayoutFormat: this.isFixedLayoutFormat,
            currentSettings: getCurrentReaderSettings(),
        });
        this.applyZoomSync();
    }

    private async applySettingsAsync(): Promise<void> {
        if (!this.view?.renderer) return;
        if (isComicFormat(this.format)) {
            const view = this.view;
            const switched = await this.comicFlowController.ensure(view, this.book,
                () => this.flow, this._lastSectionIndex,
                () => this.applySettingsSync(), () => this.view === view);
            if (this.view !== view) return;
            if (switched) this._lastCssSettingsKey = '';
        }

        const currentSettings = getCurrentReaderSettings();
        if (!currentSettings) return;

        const cssKey = computeFoliateCssKey(currentSettings, this.theme, this.zoom_level, this.flow);
        const renderer = this.view.renderer;

        if (this._lastCssSettingsKey === cssKey && this._lastCssResult) {
            if (renderer.setStyles) renderer.setStyles(this._lastCssResult);
            return;
        }
        this._lastCssSettingsKey = cssKey;

        if (renderer.setStyles) {
            const styles = buildFoliateStyles({
                currentSettings,
                themeName: this.theme,
                format: this.format,
                flow: this.flow,
                mediaActiveClass: this.book?.media?.activeClass,
                viewStyle: this.view?.style,
            });
            this._lastCssResult = styles;
            renderer.setStyles(styles);
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
                selectedText: text,
            });
            const contents = this.view?.renderer?.getContents?.() || [];
            for (const content of contents) {
                content.overlayer?.redraw();
            }
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
                    selectedText: annotation.selectedText,
                });
                const contents = this.view?.renderer?.getContents?.() || [];
                for (const content of contents) {
                    content.overlayer?.redraw();
                }
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
                const contents = this.view?.renderer?.getContents?.() || [];
                for (const content of contents) {
                    content.overlayer?.redraw();
                }
            } else {
                
                await this.view.goTo({ index: 0, fraction: 0 });
                
                if (this.options.onLocationChange) {
                    this.options.onLocationChange({ cfi: '', percentage: 0, tocItem: undefined, pageItem: undefined, pageInfo: undefined });
                }
            }
        } catch (e) {
        }
    }

    /** The text a CFI covers in a currently loaded section ('' when it cannot be resolved). */
    async resolveCfiText(cfi: string): Promise<string> {
        try {
            const resolved = await this.view?.resolveNavigation?.(cfi);
            if (!resolved) return '';
            const contents = this.view?.renderer?.getContents?.() || [];
            const content = contents.find((c: any) => c.index === resolved.index);
            if (!content?.doc) return '';
            const range = typeof resolved.anchor === 'function'
                ? resolved.anchor(content.doc)
                : resolved.anchor;
            return typeof range?.toString === 'function' ? range.toString().trim() : '';
        } catch {
            return '';
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

    private annotationSectionIndex(location: string): number | null {
        const cached = this.annotationSectionCache.get(location);
        if (cached !== undefined) return cached;
        let index: number | null = null;
        try {
            const resolved = this.view?.resolveNavigation?.(location);
            if (Number.isInteger(resolved?.index) && resolved.index >= 0) index = resolved.index;
        } catch {
            index = null;
        }
        this.annotationSectionCache.set(location, index);
        return index;
    }

    /**
     * Draw the highlights/notes that belong to one loaded section. Each
     * annotation's section is resolved once and cached, so a chapter turn costs
     * O(annotations in that chapter) instead of re-resolving every CFI in the
     * book. `force` redraws an overlayer that was already populated (after the
     * annotation set changed); otherwise repeated load/create-overlay events for
     * the same overlayer are no-ops.
     */
    /**
     * Draw this document's text selection in the overlayer from text-only rects
     * (glyph boxes, like PDF) instead of the native paint, which floods block
     * margins and the blank space between paragraphs. The native highlight is
     * made transparent only once an overlayer that can draw it is present.
     */
    private attachSelectionOverlay(doc: Document): void {
        if (!doc?.documentElement) return;
        const findOverlayer = () =>
            (this.view?.renderer?.getContents?.() || []).find((content: any) => content.doc === doc)?.overlayer;
        const enable = () => {
            if (typeof findOverlayer()?.setSelection !== 'function') return false;
            doc.documentElement.classList.add(SELECTION_OVERLAY_CLASS);
            return true;
        };
        if (this.selectionOverlayDocs.has(doc)) {
            enable();
            return;
        }
        this.selectionOverlayDocs.add(doc);
        enable();

        let frame = 0;
        const update = () => {
            frame = 0;
            const overlayer = findOverlayer();
            if (typeof overlayer?.setSelection !== 'function') return;
            enable();
            const selection = doc.getSelection();
            if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
                overlayer.setSelection(null);
                return;
            }
            // A live clone: after a re-layout the overlayer recomputes rects from it.
            const range = selection.getRangeAt(0).cloneRange();
            overlayer.setSelection(() => computeTextSelectionRects(range), SELECTION_FILL);
        };
        doc.addEventListener('selectionchange', () => {
            if (frame === 0) frame = requestAnimationFrame(update);
        });
    }

    async renderAnnotationsForSection(sectionIndex: number, force = false): Promise<void> {
        if (!this.view || !this.book || sectionIndex < 0) {
            return;
        }
        const contents = this.view.renderer?.getContents?.() || [];
        const content = contents.find((c: any) => c.index === sectionIndex);
        const overlayer = content?.overlayer;
        if (!overlayer) return;
        if (!force && this.populatedOverlayers.has(overlayer)) return;
        this.populatedOverlayers.add(overlayer);

        const docText = content?.doc?.body?.textContent || '';

        for (const annotation of this.annotations.values()) {
            if ((annotation.type !== 'highlight' && annotation.type !== 'note') || !annotation.location) continue;
            let index = this.annotationSectionIndex(annotation.location);

            // Resilient text check: if the CFI index didn't point here, check if text belongs to this section
            if (index !== sectionIndex && annotation.selectedText && docText && content?.doc) {
                const snippet = annotation.selectedText.trim().slice(0, 30);
                if (snippet && docText.includes(snippet)) {
                    const range = this.findRangeByText(content.doc, annotation.selectedText);
                    if (range) {
                        const newCfi = this.view.getCFI?.(sectionIndex, range);
                        if (newCfi) {
                            this.selfHealAnnotation(annotation, newCfi);
                            index = sectionIndex;
                        }
                    }
                }
            }

            // Unresolvable CFIs keep the old behaviour: foliate decides per section.
            if (index !== null && index !== sectionIndex) continue;
            try {
                await this.view?.addAnnotation?.({
                    value: annotation.location,
                    color: annotation.color,
                    selectedText: annotation.selectedText,
                });
            } catch (e) {
            }
        }
    }

    private selfHealAnnotation(annotation: Annotation, newCfi: string): void {
        if (!annotation || !newCfi || annotation.location === newCfi) return;
        const oldLocation = annotation.location;
        annotation.location = newCfi;
        this.annotations.set(annotation.id, annotation);
        if (oldLocation) {
            this.annotationLocations.delete(oldLocation);
            this.annotationSectionCache.delete(oldLocation);
        }
        this.annotationLocations.set(newCfi, annotation);
        const newSecIndex = this.annotationSectionIndex(newCfi);
        if (typeof newSecIndex === 'number') {
            this.annotationSectionCache.set(newCfi, newSecIndex);
        }

        try {
            useLibraryStore.getState().updateAnnotation(annotation.id, { location: newCfi });
        } catch (e) {
            console.warn('[foliate] store updateAnnotation failed during self-heal', e);
        }
    }

    async loadAnnotations(annotations: Annotation[]): Promise<void> {
        if (!this.view || !this.book) {
            return;
        }

        this.annotations.clear();
        this.annotationLocations.clear();

        const toRender = annotations.filter(
            (a) => a.location && (a.type === 'highlight' || a.type === 'note'),
        );
        for (const annotation of toRender) {
            this.annotations.set(annotation.id, annotation);
            this.annotationLocations.set(annotation.location, annotation);
        }

        const contents = this.view.renderer?.getContents?.() || [];
        for (const content of contents) {
            if (typeof content.index === 'number') {
                await this.renderAnnotationsForSection(content.index, true);
                content.overlayer?.redraw();
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
        if (!this.view) return;
        this.annotations.set(annotation.id, annotation);
        if (annotation.location) {
            this.annotationLocations.set(annotation.location, annotation);
        }

        let navSucceeded = false;

        // 1. Try native navigation first if location is present
        if (annotation.location) {
            try {
                const resolved = this.view.resolveNavigation?.(annotation.location);
                if (resolved && typeof resolved.index === 'number') {
                    await this.goTo(annotation.location);
                    const contents = this.view.renderer?.getContents?.() || [];
                    const currentContent = contents.find((c: any) => c.index === resolved.index);
                    if (annotation.selectedText && currentContent?.doc) {
                        const range = this.findRangeByText(currentContent.doc, annotation.selectedText);
                        if (range) {
                            navSucceeded = true;
                            const el = range.startContainer.parentElement;
                            if (el && typeof el.scrollIntoView === 'function') {
                                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                            }
                            const cleanCfi = this.view.getCFI?.(resolved.index, range);
                            if (cleanCfi && cleanCfi !== annotation.location) {
                                this.selfHealAnnotation(annotation, cleanCfi);
                            }
                        }
                    } else if (!annotation.selectedText) {
                        navSucceeded = true;
                    }
                }
            } catch {
                navSucceeded = false;
            }
        }

        // 2. If direct navigation didn't locate the text, fallback to text search across the book
        if (!navSucceeded && annotation.selectedText && typeof this.view.search === 'function') {
            const raw = annotation.selectedText.trim();
            const query = raw.length > 50 ? raw.slice(0, 50).trim() : raw;
            if (query) {
                try {
                    const searchIter = this.view.search({
                        query,
                        matchCase: false,
                        matchDiacritics: false,
                        matchWholeWords: false,
                    });
                    for await (const res of searchIter) {
                        if (res && typeof res === 'object' && 'cfi' in res && typeof res.cfi === 'string') {
                            const newCfi = res.cfi;
                            await this.goTo(newCfi);
                            this.selfHealAnnotation(annotation, newCfi);
                            navSucceeded = true;
                            break;
                        }
                    }
                } catch (e) {
                    console.warn('[foliate] fallback search for highlight failed', e);
                }
            }
        }

        // 3. Re-render and redraw the overlayer for the target section
        try {
            const currentCfi = annotation.location;
            if (currentCfi) {
                const resolved = this.view.resolveNavigation?.(currentCfi);
                const sectionIndex = resolved?.index;
                if (typeof sectionIndex === 'number') {
                    await this.renderAnnotationsForSection(sectionIndex, true);
                    const contents = this.view.renderer?.getContents?.() || [];
                    const targetContent = contents.find((c: any) => c.index === sectionIndex);
                    targetContent?.overlayer?.redraw();
                }
            }
        } catch {
            // Ignore resolution errors during redraw
        }
    }

    async *search(query: string, options?: { matchCase?: boolean; wholeWord?: boolean }): AsyncGenerator<SearchResult | { progress: number } | 'done'> {
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
                matchCase: options?.matchCase ?? false,
                matchDiacritics: false,
                matchWholeWords: options?.wholeWord ?? false,
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

        // Literal matches only. The former fallbacks (fuzzy subsequence
        // ranking of whole chapters, and "a number jumps to that section")
        // produced results that contained no match at all.
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

    /** Text of every narratable section with its chapter name, for Save-as-Audiobook generation
     *  (see audio-sections.ts: TOC names, no cover, contents page or non-linear items). */
    public async getAllSectionsForAudio(): Promise<{ id: string; title: string; text: string }[]> {
        const book = this.book as any;
        if (!book) return [];
        return collectAudioSections({
            sections: book.sections || [],
            toc: book.toc,
            landmarks: book.landmarks,
            navPath: book.resources?.navPath,
            coverHref: book.resources?.cover?.href,
            resolveIndex: (href: string) => book.resolveHref?.(href)?.index,
        });
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
        return this.selectionController.getSelectionFromDocument();
    }

    setupIframeSelectionListener(callback: (cfi: string, text: string, rangeOrEvent: Range | MouseEvent) => void): void {
        this.selectionController.setupIframeSelectionListener(callback);
    }

    clearSelection(): void {
        this.selectionController.clearSelection();
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

        for (const timerId of this.pendingTimeouts) {
            window.clearTimeout(timerId);
        }
        this.pendingTimeouts.clear();
        this.selectionController.destroy();
        
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
        this.annotationSectionCache.clear();
        this.sectionPageCounts.clear();
        if (this.book && !isBookInModelCache(this.book)) {
            try { this.book.destroy?.(); } catch { /* ignore destroy errors */ }
        }
        this.book = null;
        this.container = null;
    }
}

export default FoliateEngine;
