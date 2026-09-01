
import { useState, useEffect, useCallback, useRef, useMemo, lazy, Suspense, memo } from "react";
import { useShallow } from "zustand/react/shallow";
import { cn } from "../../core/lib/utils";
import {
    getBookMaterializedPath,
    getBookBlob,
    getBookData,
    saveCoverImage,
} from "../../core/lib/storage";
import {
    loadBookLocations,
} from "../../core/lib/book-locations";
import {
    extractMetadata,
    shouldUseExtractedTitle,
    shouldUseExtractedAuthor,
} from "../../core/lib/cover-extractor";
import { extractFilenameFromPath, ensureFilenameForFormat } from "../../core/lib/import";
import { isTauri, useAndroidBackButton } from "../../core/lib/env";
import { sqliteShrinkMemory } from "../../core/lib/sqlite-storage";
import {
    useVocabularyStore,
    useLibraryStore,
    useRssStore,
    useSettingsStore,
    useUIStore,
} from "../../core/store";
import { vocabularyTermFromLookup } from "../../core/services/DictionaryService";
import type { DictionaryLookupResult } from "../../core/services/DictionaryService";
import type {
    Annotation,
    Book,
    BookFormat,
    DocLocation,
    DocMetadata,
    HighlightColor,
    PdfZoomMode,
    ReaderSettings as ReaderSettingsState,
    TocItem,
} from "../../core/types";
import { List } from "lucide-react";

import { useReadingTime } from "./hooks/useReadingTime";
import { useDailyGoalReminder } from "./hooks/useDailyGoalReminder";
import { WindowTitlebar } from "./components/WindowTitlebar";
import { TableOfContents } from "./components/TableOfContents";
import { ReaderSettings } from "./components/ReaderSettings";
import { PDFViewSettingsPanel } from "./components/PDFViewSettingsPanel";
import { ReaderAnnotationsPanel } from "./components/ReaderAnnotationsPanel";
import { ReaderSearch } from "./components/ReaderSearch";
import { BookInfoPopover } from "./components/BookInfoPopover";
import { ReaderNavbar } from "./components/progress/ReaderNavbar";
import { ReaderViewport } from "./components/ReaderViewport";
import { HighlightColorPicker } from "./components/highlights/HighlightColorPicker";
import { NoteEditor } from "./components/highlights/NoteEditor";
const PDFReader = lazy(() => import("./components/PDFReader"));
import { useReaderFullscreen, useToolbarHeight } from "./hooks";
import type { PDFJsEngineRef } from "./engines/pdfjs-engine";
import type { ReaderViewportHandle } from "./components/ReaderViewport";
import { PDFFloatingToolbar } from "./components/PDFFloatingToolbar";
import { registerShortcuts } from "../../core/lib/keyboard-shortcuts";
import { immersionPlayer } from "./audio/ImmersionPlayer";
import { SpeedReader } from "./components/SpeedReader";

const MOBILE_READER_MEDIA_QUERY = '(max-width: 768px)';
const MIN_READER_ZOOM = 50;
const MIN_PAGED_READER_ZOOM = 100;
const MAX_READER_ZOOM = 200;
const PDF_STATE_SAVE_DEBOUNCE_MS = 900;
const READER_PROGRESS_SAVE_DEBOUNCE_MS = 1200;
const DEFAULT_PDF_ZOOM = 1;
const DEFAULT_PDF_ZOOM_MODE: PdfZoomMode = 'width-fit';
const PDF_ZOOM_PERSIST_PRECISION = 100;

type PendingProgressUpdate = {
    bookId: string;
    percentage: number;
    cfi: string;
    lastClickFraction?: number;
    pageProgress?: {
        currentPage: number;
        endPage?: number;
        totalPages: number;
        range: string;
    };
};

function clampReaderZoomByFlow(zoom: number, flow: ReaderSettingsState['flow']): number {
    const minZoom = flow === 'paged' ? MIN_PAGED_READER_ZOOM : MIN_READER_ZOOM;
    return Math.max(minZoom, Math.min(MAX_READER_ZOOM, Math.round(zoom)));
}

function resolvePdfTargetPage(target: string): number | null {
    const directMatch = target.match(/pdf:page:(\d+)/i);
    if (directMatch) {
        return Number(directMatch[1]);
    }
    const hashMatch = target.match(/[?#&]page=(\d+)/i);
    if (hashMatch) {
        return Number(hashMatch[1]);
    }
    const numericValue = Number(target);
    if (Number.isFinite(numericValue) && numericValue > 0) {
        return Math.floor(numericValue);
    }
    return null;
}

function getMimeTypeForBookFormat(format: BookFormat): string {
    switch (format) {
        case "epub":
            return "application/epub+zip";
        case "mobi":
        case "azw":
        case "azw3":
            return "application/x-mobipocket-ebook";
        case "fb2":
            return "application/x-fictionbook+xml";
        case "cbz":
            return "application/vnd.comicbook+zip";
        case "pdf":
            return "application/pdf";
        case "cbr":
        default:
            return "application/octet-stream";
    }
}

function extractSectionIndex(cfi: string): number | null {
    const match = cfi.match(/\/6\/(\d+)/);
    return match ? parseInt(match[1], 10) : null;
}

function isSyntheticSectionLocation(location: string): boolean {
    return /^section-\d+$/i.test(location.trim());
}

function normalizeInitialReaderLocation(location?: string): string | undefined {
    if (!location) {
        return undefined;
    }
    const normalized = location.trim();
    if (!normalized) {
        return undefined;
    }
    if (isSyntheticSectionLocation(normalized) || normalized.startsWith('pdf:page:')) {
        return undefined;
    }
    return normalized;
}

const BookReaderPage = memo(function BookReaderPage() {
    const currentBookId = useUIStore((state) => state.currentBookId);
    const setRoute = useUIStore((state) => state.setRoute);
    const currentArticle = useRssStore((state) => state.currentArticle);
    const feeds = useRssStore((state) => state.feeds);
    const closeArticleViewer = useRssStore((state) => state.closeArticleViewer);
    const activeDocId = currentBookId || (currentArticle ? `rss:${currentArticle.id}` : null);

    const getBook = useLibraryStore((state) => state.getBook);
    const updateBook = useLibraryStore((state) => state.updateBook);
    const updateProgress = useLibraryStore((state) => state.updateProgress);
    const updatePdfReadingState = useLibraryStore((state) => state.updatePdfReadingState);
    const saveBookLocations = useLibraryStore((state) => state.saveBookLocations);
    const addReadingTime = useLibraryStore((state) => state.addReadingTime);
    const markBookCompleted = useLibraryStore((state) => state.markBookCompleted);
    const lookupTerm = useVocabularyStore((state) => state.lookupTerm);
    const saveVocabularyTerm = useVocabularyStore((state) => state.saveVocabularyTerm);
    const installedDictionaryCount = useVocabularyStore((state) => state.installedDictionaries.length);

    const settings = useSettingsStore(useShallow((state) => state.settings));
    const updateReaderSettings = useSettingsStore((state) => state.updateReaderSettings);
    const stats = useSettingsStore((state) => state.stats);
    const updateStats = useSettingsStore((state) => state.updateStats);
    const readerZoomRef = useRef(settings.readerSettings.zoom);
    const readerRef = useRef<ReaderViewportHandle>(null);
    const pdfReaderRef = useRef<PDFJsEngineRef>(null);
    const loadedBookIdRef = useRef<string | null>(null);
    const toolbarContainerRef = useRef<HTMLDivElement>(null);
    const toolbarHeight = useToolbarHeight(toolbarContainerRef, {
        defaultHeight: 56,
        minHeight: 44,
    });

    // PDF-specific state for titlebar controls
    const [pdfCurrentPage, setPdfCurrentPage] = useState(1);
    const [pdfTotalPages, setPdfTotalPages] = useState(0);
    const [pdfZoom, setPdfZoom] = useState(DEFAULT_PDF_ZOOM);
    const [pdfZoomMode, setPdfZoomMode] = useState<PdfZoomMode>(DEFAULT_PDF_ZOOM_MODE);
    const [pdfPresentationMode, setPdfPresentationMode] = useState<'scroll' | 'paged'>('scroll');
    const [pdfInitialPage, setPdfInitialPage] = useState(1);
    const [pdfInitialZoom, setPdfInitialZoom] = useState(DEFAULT_PDF_ZOOM);
    const [pdfInitialZoomMode, setPdfInitialZoomMode] = useState<PdfZoomMode>(DEFAULT_PDF_ZOOM_MODE);
    const [resolvedPdfPath, setResolvedPdfPath] = useState("");
    const [resolvedNativePath, setResolvedNativePath] = useState("");
    const [pdfAnnotationMode, setPdfAnnotationMode] = useState<'none' | 'highlight' | 'pen' | 'text' | 'erase'>('none');
    const [pdfHighlightColor, setPdfHighlightColor] = useState<HighlightColor>("yellow");
    const [pdfBrushColor, setPdfBrushColor] = useState<HighlightColor>("blue");
    const [pdfBrushWidth, setPdfBrushWidth] = useState(2);
    const [pdfHasOutline, setPdfHasOutline] = useState(false);

    const statsRef = useRef(stats);
    statsRef.current = stats;
    useEffect(() => {
        readerZoomRef.current = settings.readerSettings.zoom;
    }, [settings.readerSettings.zoom]);

    // File state
    const [file, setFile] = useState<File | Blob | null>(null);
    const [pdfData, setPdfData] = useState<Uint8Array | null>(null);
    const [metadata, setMetadata] = useState<DocMetadata | null>(null);
    const [toc, setToc] = useState<TocItem[]>([]);
    const [location, setLocation] = useState<DocLocation | null>(null);
    const [sectionFractions, setSectionFractions] = useState<number[]>([]);
    // UI state
    const [isMobileViewport, setIsMobileViewport] = useState(() => (
        typeof window !== 'undefined'
            ? window.matchMedia(MOBILE_READER_MEDIA_QUERY).matches
            : false
    ));
    const [showToolbar, setShowToolbar] = useState(true);
    type ReaderPanel = 'toc' | 'settings' | 'bookmarks' | 'search' | 'info' | 'menu' | null;
    const [activePanel, setActivePanel] = useState<ReaderPanel>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [loadAttempt, setLoadAttempt] = useState(0);
    const [downloadProgress, setDownloadProgress] = useState<{
        progress: number;
        downloaded: number;
        total: number;
    } | null>(null);
    const [initialLocation, setInitialLocation] = useState<string | undefined>(undefined);
    const [initialFraction, setInitialFraction] = useState<number | undefined>(undefined);
    const [ttsData, setTtsData] = useState<{ text: string; startWordId: string } | null>(null);
    const [ttsState, setTtsState] = useState<'idle' | 'loading' | 'playing' | 'paused'>('idle');
    const ttsEnabled = settings.tts.enabled;
    const [immersionMode, setImmersionMode] = useState(false);
    const immersionModeRef = useRef(immersionMode);
    const [speedReadMode, setSpeedReadMode] = useState(false);
    const [speedReadText, setSpeedReadText] = useState("");
    // Keep ref in sync
    useEffect(() => { immersionModeRef.current = immersionMode; }, [immersionMode]);
    // Exit immersion mode if TTS is disabled while active
    useEffect(() => {
        if (!ttsEnabled && immersionMode) {
            setImmersionMode(false);
            immersionPlayer.stop();
        }
    }, [ttsEnabled, immersionMode]);

    useEffect(() => {
        if (!immersionMode) return;
        const data = readerRef.current?.getVisibleTextForTts?.();
        if (data?.text) setTtsData(data);
    }, [immersionMode]);
    const suppressProgressRef = useRef(false);
    const resumeTargetRef = useRef<string | null>(null);
    const resumeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const pdfProgressSaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const lastPersistedPdfStateRef = useRef<{
        bookId: string;
        page: number;
        totalPages: number;
        zoom: number;
        zoomMode: PdfZoomMode;
        presentationMode: 'scroll' | 'paged';
    } | null>(null);
    const progressSaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const pendingProgressUpdateRef = useRef<PendingProgressUpdate | null>(null);
    const hasAppliedInitialLocationRef = useRef(false);
    const lastCreatedHighlightRef = useRef<{
        annotationId: string;
        text: string;
        cfi: string;
        sectionIndex: number;
        timestamp: number;
    } | null>(null);

    const debug = useCallback((..._args: unknown[]) => {
        if (import.meta.env.DEV) {
        }
    }, []);

    const togglePanel = useCallback((panel: ReaderPanel) => {
        setActivePanel(current => current === panel ? null : panel);
    }, []);

    // Get current book format
    const currentBook = currentBookId ? getBook(currentBookId) : null;
    const isPdfFormat = currentBook?.format === 'pdf';

    const effectiveReaderSettings = useMemo<ReaderSettingsState>(() => {
        if (isPdfFormat) {
            return settings.readerSettings;
        }

        const isArticle = !currentBookId && !!currentArticle;
        const baseFlow = isArticle ? 'scroll' : settings.readerSettings.flow;
        const effectiveLayout = isMobileViewport ? 'single' : settings.readerSettings.layout;
        const effectiveZoom = clampReaderZoomByFlow(
            settings.readerSettings.zoom,
            baseFlow,
        );

        if (
            baseFlow !== settings.readerSettings.flow
            || effectiveLayout !== settings.readerSettings.layout
            || effectiveZoom !== settings.readerSettings.zoom
        ) {
            return {
                ...settings.readerSettings,
                flow: baseFlow,
                layout: effectiveLayout,
                zoom: effectiveZoom,
            };
        }

        return settings.readerSettings;
    }, [isMobileViewport, isPdfFormat, currentBookId, currentArticle, settings.readerSettings]);

    useEffect(() => {
        if (isPdfFormat || settings.readerSettings.flow !== 'paged') {
            return;
        }

        if (settings.readerSettings.zoom >= MIN_PAGED_READER_ZOOM) {
            return;
        }

        updateReaderSettings({ zoom: MIN_PAGED_READER_ZOOM });
    }, [
        isPdfFormat,
        settings.readerSettings.flow,
        settings.readerSettings.zoom,
        updateReaderSettings,
    ]);

    useEffect(() => {
        if (typeof window === 'undefined') {
            return;
        }

        const mediaQuery = window.matchMedia(MOBILE_READER_MEDIA_QUERY);
        const updateViewportState = (matches: boolean) => {
            setIsMobileViewport(matches);
        };

        updateViewportState(mediaQuery.matches);

        const handleChange = (event: MediaQueryListEvent) => {
            updateViewportState(event.matches);
        };

        mediaQuery.addEventListener('change', handleChange);
        return () => {
            mediaQuery.removeEventListener('change', handleChange);
        };
    }, []);

    useEffect(() => {
        return () => {
            setFile(null);
            setPdfData(null);
            setResolvedPdfPath("");
            setMetadata(null);
            setToc([]);
            void sqliteShrinkMemory();
        };
    }, []);

    // PDF callbacks - memoized to prevent infinite re-renders
    const handlePdfLoad = useCallback((info: import('./engines/pdfjs-engine').PDFDocumentInfo) => {
        // Get current book data for fallback
        const currentBookData = currentBookId ? getBook(currentBookId) : null;

        // Priority: 1. PDF metadata title, 2. Book title from library, 3. Filename, 4. 'Untitled'
        // Only use PDF title if it differs from the filename (meaning it came from actual metadata)
        const isPdfTitleFromMetadata = info.title && info.title !== info.filename;
        const displayTitle = (isPdfTitleFromMetadata
            ? info.title
            : (currentBookData?.title || info.title || 'Untitled')) || 'Untitled';
        const displayAuthor = info.author || currentBookData?.author || 'Unknown';

        setMetadata({
            title: displayTitle,
            author: displayAuthor,
            description: currentBookData?.description || '',
            language: currentBookData?.language || '',
            publisher: currentBookData?.publisher || '',
            pubdate: currentBookData?.publishedDate,
            identifier: currentBookData?.isbn,
            cover: currentBookData?.coverPath,
        });
        setToc(Array.isArray(info.toc) ? info.toc : []);
        setPdfHasOutline(Boolean(info.hasOutline ?? ((info.toc?.length || 0) > 0)));
        // Ensure titlebar page indicator has total pages immediately on load.
        setPdfCurrentPage((currentPage) => Math.max(1, currentPage));
        setPdfTotalPages(Math.max(0, info.totalPages || 0));
        setIsBookReady(true);

        // Background cover extraction for PDF books
        void extractBookCover(currentBookId ?? null);
    }, [currentBookId, getBook]);

    // Shared cover extraction helper — runs when any book opens in the reader.
    // Accepts the bytes already loaded for reading (Blob or Uint8Array) so we
    // avoid a second full-file read over IPC. The bytes are only converted to an
    // ArrayBuffer after the early-return checks, so books that already have a
    // cover pay no copy cost.
    const extractBookCover = useCallback(async (
        bookId: string | null,
        preloadedSource?: Blob | Uint8Array,
    ) => {
        if (!bookId) return;
        const book = getBook(bookId);
        if (!book) return;

        const hasRealCover = book.coverPath && !book.coverPath.startsWith('data:image/svg+xml');
        if (hasRealCover && book.coverExtractionDone) {
            return;
        }

        try {
            let data: ArrayBuffer | undefined;
            if (preloadedSource instanceof Blob) {
                data = await preloadedSource.arrayBuffer().catch(() => undefined);
            } else if (preloadedSource instanceof Uint8Array) {
                const buffer = preloadedSource.buffer as ArrayBuffer;
                data = buffer.slice(
                    preloadedSource.byteOffset,
                    preloadedSource.byteOffset + preloadedSource.byteLength,
                );
            } else {
                const storagePath = book.storagePath || book.filePath;
                data = (await getBookData(book.id, storagePath)) ?? undefined;
            }
            if (!data) {
                return;
            }

            const filename = ensureFilenameForFormat(
                extractFilenameFromPath(book.filePath),
                book.format,
            );

            const metadata = await extractMetadata(data, book.format, filename, book.id, {
                allowFallbackCover: !hasRealCover,
                metadataTimeoutMs: 12000,
                coverTimeoutMs: 8000,
            });

            const updates: Partial<Book> = {};
            if (metadata.coverDataUrl) {
                updates.coverPath = metadata.coverDataUrl;
            } else if (!book.coverPath) {
                const { buildFallbackCoverSvg } = await import('../../core/lib/cover-extractor');
                const fallbackSvg = buildFallbackCoverSvg(
                    metadata.title || book.title,
                    metadata.author || book.author || 'Unknown Author',
                );
                const blob = new Blob([fallbackSvg], { type: 'image/svg+xml' });
                const dataUrl = await saveCoverImage(book.id, blob);
                updates.coverPath = dataUrl;
            }

            if (shouldUseExtractedTitle(book.title, metadata.title, book.filePath)) {
                updates.title = metadata.title;
            }
            if (shouldUseExtractedAuthor(book.author, metadata.author)) {
                updates.author = metadata.author;
            }
            updates.coverExtractionDone = true;

            if (Object.keys(updates).length > 0) {
                updateBook(book.id, updates);
            }
        } catch (error) {
        }
    }, [getBook, updateBook]);

    // Sync book title from store to metadata when renamed while reader is open
    const storeTitle = useLibraryStore(
        (s) => currentBookId ? (s.getBook(currentBookId)?.title ?? null) : null,
    );
    useEffect(() => {
        if (!storeTitle || !metadata || storeTitle === metadata.title) return;
        setMetadata((prev) => prev ? { ...prev, title: storeTitle } : prev);
    }, [storeTitle]);

    const handlePdfError = useCallback((err: Error) => {
        setLoadError(err.message);
    }, []);

    const handlePdfPageChange = useCallback((page: number, total: number, scale: number) => {
        // 
        setPdfCurrentPage(Math.max(1, page));
        setPdfTotalPages((prevTotal) => {
            if (total > 0) {
                return total;
            }
            return prevTotal;
        });
        setPdfZoom(scale);
    }, []);

    const downloadingBookId = useUIStore((s) => s.downloadingBookId);

    useEffect(() => {
        if (!downloadingBookId) {
            setDownloadProgress(null);
            return;
        }
        setDownloadProgress(null);
        let cancelled = false;
        import("@tauri-apps/api/event").then(({ listen }) => {
            if (cancelled) return;
            listen<{ book_id: string; progress: number; downloaded: number; total: number }>(
                "download-progress",
                (event) => {
                    if (event.payload.book_id === downloadingBookId) {
                        setDownloadProgress({
                            progress: event.payload.progress,
                            downloaded: event.payload.downloaded,
                            total: event.payload.total,
                        });
                    }
                },
            ).catch(() => {});
        }).catch(() => {});
        return () => {
            cancelled = true;
            setDownloadProgress(null);
        };
    }, [downloadingBookId]);

    // Load book file
    useEffect(() => {
        // Guard: already loaded this book/document
        if (activeDocId && loadedBookIdRef.current === activeDocId) {
            return;
        }

        // Guard: no document ID
        if (!activeDocId) {
            loadedBookIdRef.current = null;
            return;
        }

        // Set immediately to prevent duplicate loads during async operations
        loadedBookIdRef.current = activeDocId;
        setShowToolbar(true);
        setTtsData(null);
        // Initialize zoom from persisted settings across book opens
        readerZoomRef.current = settings.readerSettings.zoom;

        let isCancelled = false;

        const loadBook = async () => {
            if (!currentBookId && currentArticle) {
                setPdfData(null);
                setResolvedPdfPath("");
                setMetadata({
                    title: currentArticle.title || "Untitled Article",
                    author: currentArticle.author || (feeds.find(f => f.id === currentArticle.feedId)?.title) || "RSS Feed",
                });
                setToc([]);
                setLocation(null);
                setIsBookReady(false);
                setInitialLocation(undefined);
                setInitialFraction(undefined);
                suppressProgressRef.current = false;
                resumeTargetRef.current = null;
                hasAppliedInitialLocationRef.current = true;
                setLoadError(null);

                try {
                    const feedTitle = feeds.find((feed) => feed.id === currentArticle.feedId)?.title;
                    const { convertArticleToEpubBlob } = await import("../../core/lib/rss-epub");

                    let articleToRender = currentArticle;

                    if (!articleToRender.fullContent && articleToRender.url) {
                        try {
                            const fullContent = await useRssStore.getState().fetchFullArticle(articleToRender.id);
                            if (fullContent && !isCancelled) {
                                const refreshed = useRssStore.getState().currentArticle;
                                if (refreshed && refreshed.id === articleToRender.id) {
                                    articleToRender = refreshed;
                                }
                            }
                        } catch {
                            // Fall back to summary
                        }
                    }

                    if (isCancelled) return;

                    const epubBlob = convertArticleToEpubBlob(articleToRender, feedTitle);
                    setFile(epubBlob);
                } catch (err) {
                    if (!isCancelled) {
                        setLoadError(err instanceof Error ? err.message : 'Error preparing article');
                        loadedBookIdRef.current = null;
                    }
                }
                return;
            }

            let book = currentBookId ? getBook(currentBookId) : null;
            if (!book) {
                setLoadError('Book not found in library');
                return;
            }

            if (currentBookId) {
                const bookLoc = book;
                // Restore locations from SQLite BLOB (stripped from Zustand persist).
                loadBookLocations(currentBookId).then((loadedLocations) => {
                    if (loadedLocations && loadedLocations !== bookLoc.locations) {
                        updateBook(currentBookId, { locations: loadedLocations });
                    }
                });
            }

            if (book.syncedWithoutFile && currentBookId) {
                const state = useUIStore.getState();
                const downloadId = book.id;
                if (state.downloadingBookId !== downloadId) {
                    state.setDownloadingBook(downloadId);
                    import("../../core/lib/sync-orchestrator").then(({ downloadBookOnDemand }) => {
                        downloadBookOnDemand(downloadId).catch(() => {});
                    });
                }

                const DOWNLOAD_TIMEOUT_MS = 120_000;
                const startTime = Date.now();
                while (book.syncedWithoutFile) {
                    if (Date.now() - startTime > DOWNLOAD_TIMEOUT_MS) {
                        setLoadError('Book download timed out. The file may not be available on any paired device. You can try reopening later.');
                        loadedBookIdRef.current = null;
                        useUIStore.getState().setDownloadingBook(undefined);
                        return;
                    }
                    await new Promise<void>(r => setTimeout(r, 200));
                    if (isCancelled) return;
                    const current = getBook(currentBookId);
                    if (!current) return;
                    book = current;
                }
            }
            if (!book) {
                setLoadError('Book not found in library');
                loadedBookIdRef.current = null;
                return;
            }

            setFile(null);
            setPdfData(null);
            setPdfCurrentPage(1);
            setPdfTotalPages(0);
            setPdfZoom(DEFAULT_PDF_ZOOM);
            setPdfZoomMode(DEFAULT_PDF_ZOOM_MODE);
            setPdfPresentationMode('scroll');
            setPdfInitialPage(1);
            setPdfInitialZoom(DEFAULT_PDF_ZOOM);
            setPdfInitialZoomMode(DEFAULT_PDF_ZOOM_MODE);
            setResolvedPdfPath("");
            setPdfHasOutline(false);
            setMetadata(null);
            setToc([]);
            setLocation(null);
            setIsBookReady(false);
            if (book.format === 'pdf') {
                const fallbackPage = resolvePdfTargetPage(book.currentLocation || '') ?? 1;
                const savedPdfState = book.pdfViewState;
                const nextInitialPage = Math.max(
                    1,
                    Math.floor(savedPdfState?.page ?? fallbackPage),
                );
                const nextInitialZoom = Math.max(
                    0.25,
                    Math.min(
                        5,
                        savedPdfState?.zoom ?? DEFAULT_PDF_ZOOM,
                    ),
                );
                const nextInitialZoomMode = savedPdfState?.zoomMode ?? DEFAULT_PDF_ZOOM_MODE;
                const nextPresentationMode = savedPdfState?.presentationMode ?? 'scroll';

                setPdfPresentationMode(nextPresentationMode);
                setPdfInitialPage(nextInitialPage);
                setPdfInitialZoom(nextInitialZoom);
                setPdfInitialZoomMode(nextInitialZoomMode);
                setPdfCurrentPage(nextInitialPage);
                setPdfZoom(nextInitialZoom);
                setPdfZoomMode(nextInitialZoomMode);

                setInitialLocation(undefined);
                setInitialFraction(undefined);
                suppressProgressRef.current = false;
                resumeTargetRef.current = null;
                hasAppliedInitialLocationRef.current = true;
            } else {
                const nextLocation = normalizeInitialReaderLocation(book.currentLocation);
                setInitialLocation(nextLocation);
                
                const progressFallback = book.progress !== undefined && book.progress < 0.95 ? book.progress : undefined;
                const fractionToUse = book.lastClickFraction ?? progressFallback;
                setInitialFraction(fractionToUse);
                suppressProgressRef.current = !!nextLocation || fractionToUse !== undefined;
                resumeTargetRef.current = nextLocation || null;
                hasAppliedInitialLocationRef.current = false;
            }
            if (resumeTimeoutRef.current) {
                clearTimeout(resumeTimeoutRef.current);
            }
            setLoadError(null);

            try {
                const storagePath = book.storagePath || book.filePath;

                if (book.format === 'pdf') {
                    if (isTauri()) {
                        const materializedPath = await getBookMaterializedPath(book.id, storagePath);
                        if (materializedPath) {
                            if (!isCancelled) {
                                setResolvedPdfPath(materializedPath);
                            }
                            return;
                        }
                    }

                    const data = await getBookData(book.id, storagePath);
                    if (isCancelled) return;
                    if (!data || data.byteLength === 0) {
                        throw new Error('Could not read PDF file from storage - data is empty.');
                    }
                    setResolvedPdfPath("");
                    setPdfData(new Uint8Array(data));
                    return;
                }

                if (isTauri()) {
                    const materializedPath = await getBookMaterializedPath(book.id, storagePath);
                    if (materializedPath && !isCancelled) {
                        setResolvedNativePath(materializedPath);
                    }
                }

                const blob = await getBookBlob(book.id, storagePath);
                if (isCancelled) return;
                if (!blob) {
                    throw new Error('Could not read book file from storage.');
                }
                const expectedMimeType = getMimeTypeForBookFormat(book.format);
                
                const typedBlob = blob.type === expectedMimeType
                    ? blob
                    : blob.slice(0, blob.size, expectedMimeType);
                setFile(typedBlob);
            } catch (err) {
                if (!isCancelled) {
                    setLoadError(err instanceof Error ? err.message : 'Unknown error loading book');
                    
                    loadedBookIdRef.current = null;
                }
            }
        };

        loadBook();
        return () => {
            isCancelled = true;
            
            loadedBookIdRef.current = null;
        };
    }, [currentBookId, getBook, loadAttempt]);

    useEffect(() => {
        if (!currentBookId) {
            return;
        }

        const allBooks = useLibraryStore.getState().books;
        const currentBookIndex = allBooks.findIndex((book) => book.id === currentBookId);
        if (currentBookIndex === -1) {
            return;
        }

        const upcomingBooks = allBooks.slice(currentBookIndex + 1, currentBookIndex + 4);
        for (const book of upcomingBooks) {
            if (book.format === 'pdf') {
                continue;
            }

            const storagePath = book.storagePath || book.filePath;
            void getBookBlob(book.id, storagePath).catch(e => console.error("[catch]", e));
        }
    }, [currentBookId]);

    useReadingTime({ currentBookId, addReadingTime, stats, updateStats });
    useDailyGoalReminder();

    useEffect(() => {
        return () => {
            if (resumeTimeoutRef.current) {
                clearTimeout(resumeTimeoutRef.current);
            }
            if (pdfProgressSaveTimeoutRef.current) {
                clearTimeout(pdfProgressSaveTimeoutRef.current);
            }
            if (progressSaveTimeoutRef.current) {
                clearTimeout(progressSaveTimeoutRef.current);
            }
        };
    }, []);

    useEffect(() => {
        lastPersistedPdfStateRef.current = null;
    }, [currentBookId]);

    const handleReaderExitFullscreen = useCallback(() => {
        updateReaderSettings({ fullscreen: false });
    }, [updateReaderSettings]);

    useReaderFullscreen({
        fullscreen: settings.readerSettings.fullscreen,
        onExitFullscreen: handleReaderExitFullscreen,
        errorLabel: "[Reader]",
    });

    const handleReady = useCallback((meta: DocMetadata, tocItems: TocItem[]) => {
        const loadedBook = currentBookId ? getBook(currentBookId) : null;
        const mergedMetadata: DocMetadata = {
            ...meta,
            pubdate: loadedBook?.publishedDate || meta.pubdate,
            cover: loadedBook?.coverPath || meta.cover,
        };

        setMetadata(mergedMetadata);
        setToc(Array.isArray(tocItems) ? tocItems : []);
        setIsBookReady(true);

        const fractions = readerRef.current?.getSectionFractions() ?? [];
        setSectionFractions(fractions);

        void extractBookCover(currentBookId ?? null, file ?? pdfData ?? undefined);
    }, [currentBookId, getBook, extractBookCover, file, pdfData]);

    const lastClickFractionRef = useRef<number | null>(null);
    const handleBookCompletionProgress = useCallback((bookId: string, progress: number) => {
        if (progress < 0.99) {
            return;
        }

        const result = markBookCompleted(bookId, "auto");
        if (!result || result.wasAlreadyCompleted) {
            return;
        }

        const currentYear = new Date().getFullYear();
        const currentStats = statsRef.current;
        updateStats({
            booksCompleted: currentStats.booksCompleted + 1,
            booksReadThisYear: result.completedYear === currentYear
                ? currentStats.booksReadThisYear + 1
                : currentStats.booksReadThisYear,
        });
    }, [markBookCompleted, updateStats]);

    const flushPendingProgressUpdate = useCallback(() => {
        const pendingUpdate = pendingProgressUpdateRef.current;
        if (!pendingUpdate) {
            return;
        }

        pendingProgressUpdateRef.current = null;
        if (progressSaveTimeoutRef.current) {
            clearTimeout(progressSaveTimeoutRef.current);
            progressSaveTimeoutRef.current = null;
        }

        updateProgress(
            pendingUpdate.bookId,
            pendingUpdate.percentage,
            pendingUpdate.cfi,
            pendingUpdate.lastClickFraction,
            pendingUpdate.pageProgress,
        );
        handleBookCompletionProgress(pendingUpdate.bookId, pendingUpdate.percentage);
    }, [handleBookCompletionProgress, updateProgress]);

    const scheduleProgressUpdate = useCallback((nextUpdate: PendingProgressUpdate) => {
        pendingProgressUpdateRef.current = nextUpdate;

        if (progressSaveTimeoutRef.current) {
            clearTimeout(progressSaveTimeoutRef.current);
        }

        progressSaveTimeoutRef.current = setTimeout(() => {
            progressSaveTimeoutRef.current = null;
            flushPendingProgressUpdate();
        }, READER_PROGRESS_SAVE_DEBOUNCE_MS);
    }, [flushPendingProgressUpdate]);

    useEffect(() => {
        flushPendingProgressUpdate();
    }, [currentBookId, flushPendingProgressUpdate]);

    useEffect(() => {
        return () => {
            flushPendingProgressUpdate();
        };
    }, [flushPendingProgressUpdate]);

    const handleLocationChange = useCallback((loc: DocLocation) => {
        setLocation(loc);

        if (suppressProgressRef.current) {
            const target = resumeTargetRef.current;

            debug('[Reader] Location change while suppressed:', {
                hasTarget: !!target,
                targetCfi: target?.substring(0, 50),
                currentCfi: loc.cfi?.substring(0, 50),
                percentage: loc.percentage,
            });

            if (target && loc.cfi && loc.cfi.startsWith(target)) {
                debug('[Reader] ✓ Arrived at resume target, clearing suppression');
                suppressProgressRef.current = false;
                resumeTargetRef.current = null;
                hasAppliedInitialLocationRef.current = true;
                if (resumeTimeoutRef.current) {
                    clearTimeout(resumeTimeoutRef.current);
                    resumeTimeoutRef.current = null;
                }
                return; 
            }

            if (target && loc.cfi && !loc.cfi.startsWith(target)) {
                if (currentBookId) {
                    updateProgress(currentBookId, 0, '', undefined);
                }
                suppressProgressRef.current = false;
                resumeTargetRef.current = null;
                hasAppliedInitialLocationRef.current = true;
                if (resumeTimeoutRef.current) {
                    clearTimeout(resumeTimeoutRef.current);
                    resumeTimeoutRef.current = null;
                }
                return; 
            }

            if (!resumeTimeoutRef.current) {
                debug('[Reader] Starting suppression timeout (1000ms)');
                resumeTimeoutRef.current = setTimeout(() => {
                    debug('[Reader] Suppression timeout expired');
                    suppressProgressRef.current = false;
                    resumeTargetRef.current = null;
                    resumeTimeoutRef.current = null;
                }, 1000);
            }

            return; 
        }

        if (currentBookId) {
            debug('[Reader] Saving location update:', {
                cfi: loc.cfi?.substring(0, 50),
                percentage: loc.percentage,
            });

            const safePercentage = Math.max(0, Math.min(1, loc.percentage || 0));
            const safeCfi = loc.cfi && !isSyntheticSectionLocation(loc.cfi)
                ? loc.cfi
                : '';
            const lastClickFraction = lastClickFractionRef.current ?? undefined;
            const pageProgress = loc.pageInfo ? {
                currentPage: loc.pageInfo.currentPage,
                endPage: loc.pageInfo.endPage,
                totalPages: loc.pageInfo.totalPages,
                range: loc.pageInfo.range || `${loc.pageInfo.currentPage}`,
            } : undefined;

            scheduleProgressUpdate({
                bookId: currentBookId,
                percentage: safePercentage,
                cfi: safeCfi,
                lastClickFraction,
                pageProgress,
            });
            lastClickFractionRef.current = null;
        } else if (currentArticle) {
            const safePercentage = Math.max(0, Math.min(1, loc.percentage || 0));
            useRssStore.getState().updateArticleProgress(currentArticle.id, safePercentage);
        }

    }, [currentBookId, currentArticle, scheduleProgressUpdate, updateProgress]);

    useEffect(() => {
        if (isPdfFormat || !location?.cfi) return;

        let cancelled = false;
        let retries = 0;
        const MAX_RETRIES = 8;
        const INITIAL_DELAY = 500;
        const RETRY_INTERVAL = 250;

        const extract = () => {
            if (cancelled) return;
            const data = readerRef.current?.getVisibleTextForTts?.();
            const text = data?.text || '';

            if (text) {
                setTtsData(data || null);
            } else if (retries < MAX_RETRIES) {
                retries++;
                setTimeout(extract, RETRY_INTERVAL);
            } else {
                setTtsData(null);
            }
        };

        const timer = setTimeout(extract, INITIAL_DELAY);
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [location?.cfi, isPdfFormat]);

    const handleTtsComplete = useCallback(async () => {
        if (isPdfFormat || !ttsEnabled || !immersionMode) return;
        await readerRef.current?.next();
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        const newData = readerRef.current?.getVisibleTextForTts?.();
        if (!newData?.text) return;
        setTtsData(newData);
        
        immersionPlayer.speak(newData.text, settings.tts.voice);
    }, [isPdfFormat, ttsEnabled, immersionMode, settings.tts.voice]);

    const handleTtsPlay = useCallback(() => {
        const text = ttsData?.text?.trim();
        if (!text) return;
        immersionPlayer.speak(text, settings.tts.voice);
    }, [ttsData, settings.tts.voice]);

    const handleTtsPause = useCallback(() => {
        immersionPlayer.pause();
    }, []);

    const handleTtsStop = useCallback(() => {
        immersionPlayer.stop();
        setTtsState('idle');
    }, []);

    useEffect(() => {
        immersionPlayer.init({
            onStateChange: (state) => {
                setTtsState(state);
            },
            onError: () => setTtsState('idle'),
            onComplete: handleTtsComplete,
        });
        return () => immersionPlayer.destroy();
    }, [handleTtsComplete]);

    useEffect(() => {
        if (!isPdfFormat || !currentBookId || pdfTotalPages <= 0) {
            return;
        }

        if (pdfProgressSaveTimeoutRef.current) {
            clearTimeout(pdfProgressSaveTimeoutRef.current);
        }

        pdfProgressSaveTimeoutRef.current = setTimeout(() => {
            const safeTotalPages = Math.max(1, Math.floor(pdfTotalPages));
            const safeCurrentPage = Math.max(1, Math.min(Math.floor(pdfCurrentPage), safeTotalPages));
            const safeZoom = Math.round(
                Math.max(0.25, Math.min(5, pdfZoom)) * PDF_ZOOM_PERSIST_PRECISION,
            ) / PDF_ZOOM_PERSIST_PRECISION;
            const nextPersistedState = {
                bookId: currentBookId,
                page: safeCurrentPage,
                totalPages: safeTotalPages,
                zoom: safeZoom,
                zoomMode: pdfZoomMode,
                presentationMode: pdfPresentationMode,
            } as const;

            const previousPersistedState = lastPersistedPdfStateRef.current;
            if (
                previousPersistedState
                && previousPersistedState.bookId === nextPersistedState.bookId
                && previousPersistedState.page === nextPersistedState.page
                && previousPersistedState.totalPages === nextPersistedState.totalPages
                && Math.abs(previousPersistedState.zoom - nextPersistedState.zoom) < 0.0001
                && previousPersistedState.zoomMode === nextPersistedState.zoomMode
                && previousPersistedState.presentationMode === nextPersistedState.presentationMode
            ) {
                return;
            }

            lastPersistedPdfStateRef.current = nextPersistedState;

            updatePdfReadingState(currentBookId, {
                page: safeCurrentPage,
                totalPages: safeTotalPages,
                zoom: safeZoom,
                zoomMode: pdfZoomMode,
                presentationMode: pdfPresentationMode,
            });

            handleBookCompletionProgress(currentBookId, safeCurrentPage / safeTotalPages);
        }, PDF_STATE_SAVE_DEBOUNCE_MS);

        return () => {
            if (pdfProgressSaveTimeoutRef.current) {
                clearTimeout(pdfProgressSaveTimeoutRef.current);
                pdfProgressSaveTimeoutRef.current = null;
            }
        };
    }, [
        currentBookId,
        handleBookCompletionProgress,
        isPdfFormat,
        pdfCurrentPage,
        pdfPresentationMode,
        pdfTotalPages,
        pdfZoom,
        pdfZoomMode,
        updatePdfReadingState,
    ]);

    const goTo = useCallback(async (target: string) => {
        if (isPdfFormat) {
            const pageNumber = resolvePdfTargetPage(target);
            if (pageNumber) {
                pdfReaderRef.current?.goToPage(pageNumber);
            }
            setActivePanel(null);
            return;
        }

        if (readerRef.current) {
            await readerRef.current.goTo(target);
        }
        setActivePanel(null);
    }, [isPdfFormat]);

    const handleSeek = useCallback((fraction: number) => {
        lastClickFractionRef.current = fraction;
        if (readerRef.current) {
            readerRef.current.goToFraction(fraction);
        }
    }, []);

    const handleZoomGestureChange = useCallback((zoom: number) => {
        const clampedZoom = clampReaderZoomByFlow(zoom, settings.readerSettings.flow);
        if (readerZoomRef.current === clampedZoom) {
            return;
        }
        updateReaderSettings({ zoom: clampedZoom });
    }, [settings.readerSettings.flow, updateReaderSettings]);

    const handleReaderSettingsUpdate = useCallback((updates: Partial<ReaderSettingsState>) => {
        const nextFlow = updates.flow ?? settings.readerSettings.flow;
        const nextZoomInput = updates.zoom ?? settings.readerSettings.zoom;
        const shouldNormalizeZoom =
            updates.zoom !== undefined
            || updates.flow !== undefined
            || (nextFlow === 'paged' && settings.readerSettings.zoom < MIN_PAGED_READER_ZOOM);

        if (!shouldNormalizeZoom) {
            updateReaderSettings(updates);
            return;
        }

        updateReaderSettings({
            ...updates,
            zoom: clampReaderZoomByFlow(nextZoomInput, nextFlow),
        });
    }, [
        settings.readerSettings.flow,
        settings.readerSettings.zoom,
        updateReaderSettings,
    ]);

    const handlePdfZoomModeChange = useCallback((mode: PdfZoomMode) => {
        setPdfZoomMode(mode);
    }, []);

    const shouldShowReaderChrome = showToolbar || activePanel !== null;
    const readerPopoverPadding = useMemo(() => {
        const defaultInset = 12;
        if (!isMobileViewport) {
            return {
                top: defaultInset,
                right: defaultInset,
                bottom: defaultInset,
                left: defaultInset,
            };
        }

        const topInset = shouldShowReaderChrome
            ? Math.max(defaultInset, toolbarHeight + 4)
            : 16;
        const bottomInset = (!isPdfFormat && shouldShowReaderChrome)
            ? 48
            : 16;

        return {
            top: topInset,
            right: 12,
            bottom: bottomInset,
            left: 12,
        };
    }, [isMobileViewport, isPdfFormat, shouldShowReaderChrome, toolbarHeight]);
    const colorPickerViewportPadding = useMemo(() => {
        if (!isMobileViewport) {
            return readerPopoverPadding;
        }
        return {
            ...readerPopoverPadding,
            
            bottom: Math.max(16, Math.min(readerPopoverPadding.bottom, 24)),
        };
    }, [isMobileViewport, readerPopoverPadding]);

    const [showColorPicker, setShowColorPicker] = useState(false);
    const [colorPickerMode, setColorPickerMode] = useState<"actions" | "dictionary">("actions");
    const [colorPickerPosition, setColorPickerPosition] = useState<{ x: number; y: number; height?: number }>({ x: 0, y: 0 });
    const [selectedText, setSelectedText] = useState('');
    const [selectedCfi, setSelectedCfi] = useState('');
    const [activeAnnotation, setActiveAnnotation] = useState<Annotation | null>(null);
    const [annotations, setAnnotations] = useState<Annotation[]>([]);
    const [editingHighlightId, setEditingHighlightId] = useState<string | null>(null);

    const annotationsById = useMemo(() => new Map(annotations.map(a => [a.id, a])), [annotations]);
    const annotationsByLocation = useMemo(() => {
        const m = new Map<string, Annotation>();
        for (const a of annotations) {
            if (a.type === 'highlight' || a.type === 'note') m.set(a.location, a);
        }
        return m;
    }, [annotations]);
    const bookmarkByPage = useMemo(() => {
        const m = new Map<number, Annotation>();
        for (const a of annotations) {
            if (a.type === 'bookmark' && a.pageNumber !== undefined) m.set(a.pageNumber, a);
        }
        return m;
    }, [annotations]);

    const [showNoteEditor, setShowNoteEditor] = useState(false);
    const [noteEditorPosition, setNoteEditorPosition] = useState({ x: 0, y: 0 });
    const [editingNote, setEditingNote] = useState('');
    const [pendingHighlightColor, setPendingHighlightColor] = useState<HighlightColor | null>(null);
    const [dictionaryLookupTerm, setDictionaryLookupTerm] = useState('');
    const [dictionaryLookupResult, setDictionaryLookupResult] = useState<DictionaryLookupResult | null>(null);
    const [dictionaryLookupError, setDictionaryLookupError] = useState<string | null>(null);
    const [dictionaryLookupLoading, setDictionaryLookupLoading] = useState(false);
    const [dictionaryLookupSaved, setDictionaryLookupSaved] = useState(false);
    const [canGoBackState, setCanGoBackState] = useState(false);
    const [canGoForwardState, setCanGoForwardState] = useState(false);

    const handleHistoryChange = useCallback(({ canGoBack, canGoForward }: { canGoBack: boolean; canGoForward: boolean }) => {
        setCanGoBackState(prev => (prev !== canGoBack ? canGoBack : prev));
        setCanGoForwardState(prev => (prev !== canGoForward ? canGoForward : prev));
    }, []);

    const handleBack = useCallback(() => {
        if (activePanel) {
            setActivePanel(null);
            return;
        }

        if (showColorPicker) {
            setShowColorPicker(false);
            return;
        }

        if (showNoteEditor) {
            setShowNoteEditor(false);
            return;
        }

        if (currentArticle && !currentBookId) {
            closeArticleViewer();
            return;
        }

        flushPendingProgressUpdate();
        setRoute("library");
    }, [activePanel, showColorPicker, showNoteEditor, currentArticle, currentBookId, closeArticleViewer, setRoute, flushPendingProgressUpdate]);

    const handleNavBack = useCallback((): boolean => {
        if (showColorPicker) {
            setShowColorPicker(false);
            return true;
        }
        if (showNoteEditor) {
            setShowNoteEditor(false);
            return true;
        }
        if (activePanel) {
            setActivePanel(null);
            return true;
        }
        if (speedReadMode) {
            setSpeedReadMode(false);
            setSpeedReadText("");
            return true;
        }
        if (!isPdfFormat && readerRef.current?.canGoBack) {
            readerRef.current.goBack();
            return true;
        }
        return false;
    }, [showColorPicker, setShowColorPicker, showNoteEditor, setShowNoteEditor, activePanel, setActivePanel, speedReadMode, setSpeedReadMode, isPdfFormat]);

    const handleNavBackRef = useRef(handleNavBack);
    handleNavBackRef.current = handleNavBack;

    useAndroidBackButton(() => {
        if (useUIStore.getState().currentRoute !== "reader") return false;
        return handleNavBackRef.current();
    });

    const handleViewportTap = useCallback(() => {
        if (showColorPicker || showNoteEditor) {
            setShowColorPicker(false);
            setColorPickerMode("actions");
            setShowNoteEditor(false);
            setEditingHighlightId(null);
            setActiveAnnotation(null);
            setSelectedText('');
            setSelectedCfi('');
            setEditingNote('');
            setDictionaryLookupTerm('');
            setDictionaryLookupResult(null);
            setDictionaryLookupError(null);
            setDictionaryLookupLoading(false);
            setDictionaryLookupSaved(false);
            readerRef.current?.clearSelection?.();
            return;
        }

        if (activePanel) {
            setActivePanel(null);
            return;
        }

        setShowToolbar((previous) => !previous);
    }, [activePanel, showColorPicker, showNoteEditor]);

    const shouldForceViewportTap = useCallback(() => {
        return showColorPicker || showNoteEditor;
    }, [showColorPicker, showNoteEditor]);

    const addAnnotation = useLibraryStore((state) => state.addAnnotation);
    const removeAnnotation = useLibraryStore((state) => state.removeAnnotation);
    const getBookAnnotations = useLibraryStore((state) => state.getBookAnnotations);
    const updateAnnotation = useLibraryStore((state) => state.updateAnnotation);

    const handlePdfZoomFitPage = useCallback(() => {
        pdfReaderRef.current?.zoomFitPage();
        setPdfZoomMode('page-fit');
    }, []);

    const handlePdfZoomFitWidth = useCallback(() => {
        pdfReaderRef.current?.zoomFitWidth();
        setPdfZoomMode('width-fit');
    }, []);

    const handlePdfPresentationModeChange = useCallback((mode: 'scroll' | 'paged') => {
        setPdfPresentationMode((prev) => {
            if (prev === mode) return prev;
            return mode;
        });
        pdfReaderRef.current?.setPresentationMode(mode);
    }, []);

    const handlePdfZoomIn = useCallback(() => {
        pdfReaderRef.current?.zoomIn();
        setPdfZoomMode('custom');
    }, []);

    const handlePdfZoomOut = useCallback(() => {
        pdfReaderRef.current?.zoomOut();
        setPdfZoomMode('custom');
    }, []);

    const handlePdfZoomReset = useCallback(() => {
        pdfReaderRef.current?.zoomReset();
        setPdfZoomMode('custom');
    }, []);

    const handlePdfAnnotationAdd = useCallback((partialAnnotation: Partial<Annotation>) => {
        if (!currentBookId) {
            return;
        }

        const annotationId = partialAnnotation.id || crypto.randomUUID();
        const pageNumber = partialAnnotation.pageNumber ?? pdfCurrentPage;
        const annotationColor = partialAnnotation.color
            || (
                partialAnnotation.pdfAnnotationType === "highlight"
                    || partialAnnotation.type === "highlight"
                    ? pdfHighlightColor
                    : partialAnnotation.pdfAnnotationType === "drawing"
                        || partialAnnotation.pdfAnnotationType === "textNote"
                        ? pdfBrushColor
                        : undefined
            );
        const annotationStrokeWidth = partialAnnotation.strokeWidth
            ?? (
                partialAnnotation.pdfAnnotationType === "drawing"
                    ? pdfBrushWidth
                    : undefined
            );
        const normalizedAnnotation: Annotation = {
            id: annotationId,
            bookId: currentBookId,
            referenceId: partialAnnotation.referenceId || currentBookId,
            type: partialAnnotation.type
                || (partialAnnotation.pdfAnnotationType === "highlight" ? "highlight" : "note"),
            location: partialAnnotation.location || `pdf:page:${pageNumber}`,
            selectedText: partialAnnotation.selectedText,
            noteContent: partialAnnotation.noteContent,
            color: annotationColor,
            createdAt: partialAnnotation.createdAt ? new Date(partialAnnotation.createdAt) : new Date(),
            updatedAt: partialAnnotation.updatedAt ? new Date(partialAnnotation.updatedAt) : undefined,
            pageNumber,
            pdfAnnotationType: partialAnnotation.pdfAnnotationType,
            drawingData: partialAnnotation.drawingData,
            textNoteContent: partialAnnotation.textNoteContent,
            rect: partialAnnotation.rect,
            rects: partialAnnotation.rects,
            strokeWidth: annotationStrokeWidth,
        };

        const existingAnnotation = getBookAnnotations(currentBookId).find((annotation) => annotation.id === annotationId);
        if (existingAnnotation) {
            updateAnnotation(annotationId, {
                ...normalizedAnnotation,
                updatedAt: new Date(),
            });
        } else {
            addAnnotation(normalizedAnnotation);
        }

        setAnnotations((previousAnnotations) => {
            const existingIndex = previousAnnotations.findIndex((annotation) => annotation.id === annotationId);
            if (existingIndex === -1) {
                return [...previousAnnotations, normalizedAnnotation];
            }
            const nextAnnotations = [...previousAnnotations];
            nextAnnotations[existingIndex] = {
                ...nextAnnotations[existingIndex],
                ...normalizedAnnotation,
                updatedAt: new Date(),
            };
            return nextAnnotations;
        });

    }, [
        addAnnotation,
        currentBookId,
        getBookAnnotations,
        pdfBrushColor,
        pdfBrushWidth,
        pdfCurrentPage,
        pdfHighlightColor,
        updateAnnotation,
    ]);

    const handlePdfAnnotationChange = useCallback((annotation: Annotation) => {
        if (!currentBookId) {
            return;
        }

        updateAnnotation(annotation.id, {
            ...annotation,
            updatedAt: new Date(),
        });

        setAnnotations((previousAnnotations) => previousAnnotations.map((currentAnnotation) =>
            currentAnnotation.id === annotation.id
                ? { ...currentAnnotation, ...annotation, updatedAt: new Date() }
                : currentAnnotation
        ));

    }, [
        currentBookId,
        updateAnnotation,
    ]);

    const handlePdfAnnotationRemove = useCallback((annotationId: string) => {
        removeAnnotation(annotationId);
        setAnnotations((previousAnnotations) => previousAnnotations.filter(
            (annotation) => annotation.id !== annotationId,
        ));
    }, [removeAnnotation]);

    const handlePdfAddBookmark = useCallback(() => {
        if (!currentBookId) return;
        const pageLocation = `pdf:page:${pdfCurrentPage}`;

        const existing = bookmarkByPage.get(pdfCurrentPage);

        if (existing) {
            handlePdfAnnotationRemove(existing.id);
        } else {
            const bookmark: Annotation = {
                id: crypto.randomUUID(),
                bookId: currentBookId,
                referenceId: currentBookId,
                type: 'bookmark',
                location: pageLocation,
                pageNumber: pdfCurrentPage,
                createdAt: new Date(),
            };
            handlePdfAnnotationAdd(bookmark);
        }
    }, [bookmarkByPage, currentBookId, handlePdfAnnotationAdd, handlePdfAnnotationRemove, pdfCurrentPage]);

    const isPdfPageBookmarked = bookmarkByPage.has(pdfCurrentPage);

    const [isBookReady, setIsBookReady] = useState(false);

    const isCurrentPageBookmarked = annotations.some(
        a => a.type === 'bookmark' && a.location === location?.cfi
    );

    useEffect(() => {
        if (activeDocId && isBookReady) {
            const bookAnnotations = getBookAnnotations(activeDocId);
            setAnnotations(bookAnnotations);
            if (isPdfFormat) {
                return;
            }
            
            const timer = setTimeout(() => {
                readerRef.current?.loadAnnotations?.(bookAnnotations).catch(e => console.error("[catch]", e));
            }, 500);
            return () => clearTimeout(timer);
        }
    }, [activeDocId, getBookAnnotations, isBookReady, isPdfFormat]);

    useEffect(() => {
        if (!isBookReady || !readerRef.current || hasAppliedInitialLocationRef.current) return;

        if (initialLocation) {
            debug('[Reader] CFI was provided, engine should have navigated');
            hasAppliedInitialLocationRef.current = true;
            return;
        }

        if (typeof initialFraction === 'number') {
            debug('[Reader] No CFI, using fraction fallback:', initialFraction);
            hasAppliedInitialLocationRef.current = true;
            
            setTimeout(() => {
                readerRef.current?.goToFraction(initialFraction);
            }, 100);
        }
    }, [isBookReady, initialLocation, initialFraction]);

    const handleTextSelected = useCallback((cfi: string, text: string, rangeOrEvent?: Range | MouseEvent) => {
        debug('[Reader] Text selected:', { cfi: cfi.substring(0, 50), text: text.substring(0, 50) });

        const freshAnnotations = activeDocId ? getBookAnnotations(activeDocId) : [];
        debug('[Reader] Fresh annotations from store:', freshAnnotations.length);
        debug('[Reader] Available highlight/note annotations:', freshAnnotations.filter(a => a.type === 'highlight' || a.type === 'note').map(a => ({ id: a.id.substring(0, 8), loc: a.location?.substring(0, 40), text: a.selectedText?.substring(0, 30) })));

        if (!cfi) {
            debug('[Reader] Empty CFI, ignoring');
            return;
        }

        const resolvePickerPosition = (anchor?: Range | MouseEvent) => {
            if (anchor && 'getBoundingClientRect' in anchor) {
                const rect = anchor.getBoundingClientRect();
                let normalizedLeft = rect.left;
                let normalizedTop = rect.top;

                const rangeDocument = anchor.startContainer?.ownerDocument;
                const frameElement = rangeDocument?.defaultView?.frameElement;
                if (frameElement instanceof HTMLElement) {
                    const frameRect = frameElement.getBoundingClientRect();
                    normalizedLeft += frameRect.left;
                    normalizedTop += frameRect.top;
                }

                return {
                    x: normalizedLeft + rect.width / 2,
                    y: normalizedTop,
                    height: Math.max(rect.height, 24),
                };
            }

            if (anchor && 'clientX' in anchor) {
                return {
                    x: anchor.clientX,
                    y: anchor.clientY,
                };
            }

            return {
                x: window.innerWidth / 2,
                y: window.innerHeight / 3,
            };
        };

        let existingAnnotation = freshAnnotations.find(a => {
            
            if (a.location === cfi && (a.type === 'highlight' || a.type === 'note')) {
                debug('[Reader] Matched annotation by exact CFI:', a.id);
                return true;
            }
            
            if (a.location && cfi && (a.type === 'highlight' || a.type === 'note')) {
                const isPrefixMatch = cfi.startsWith(a.location) || a.location.startsWith(cfi);
                if (isPrefixMatch) {
                    debug('[Reader] Matched annotation by partial CFI:', a.id, { cfi: cfi.substring(0, 40), stored: a.location.substring(0, 40) });
                    return true;
                }
            }
            
            if (text && text.length > 3 && a.selectedText &&
                a.type !== 'bookmark' &&
                a.selectedText.trim() === text.trim()) {
                debug('[Reader] Matched annotation by text content:', a.id);
                return true;
            }
            return false;
        });

        if (!existingAnnotation) {
            existingAnnotation = freshAnnotations.find(a => a.location === cfi);
        }

        if (existingAnnotation) {
            
            debug('[Reader] ✓ Found existing annotation:', existingAnnotation.id, existingAnnotation.type, '- setting editingHighlightId');
            setActiveAnnotation(existingAnnotation);
            setEditingHighlightId(existingAnnotation.id);
            debug('[Reader] editingHighlightId set to:', existingAnnotation.id);
            setSelectedCfi(existingAnnotation.location); 
            setSelectedText(existingAnnotation.selectedText || text || '');

            const pickerPosition = resolvePickerPosition(rangeOrEvent);
            debug('[Reader] Positioning color picker:', pickerPosition);
            setColorPickerPosition(pickerPosition);

            setColorPickerMode("actions");
            setDictionaryLookupTerm('');
            setDictionaryLookupResult(null);
            setDictionaryLookupError(null);
            setDictionaryLookupLoading(false);
            setDictionaryLookupSaved(false);
            setShowColorPicker(true);
        } else {
            
            debug('[Reader] ✗ No existing annotation found - treating as new selection');
            if (!text.trim()) {
                debug('[Reader] Empty text selection, ignoring');
                return;
            }

            setEditingHighlightId(null);
            setActiveAnnotation(null);
            setSelectedCfi(cfi);
            setSelectedText(text);

            const pickerPosition = resolvePickerPosition(rangeOrEvent);
            debug('[Reader] Positioning color picker:', pickerPosition);
            setColorPickerPosition(pickerPosition);

            setColorPickerMode("actions");
            setDictionaryLookupTerm('');
            setDictionaryLookupResult(null);
            setDictionaryLookupError(null);
            setDictionaryLookupLoading(false);
            setDictionaryLookupSaved(false);
            setShowColorPicker(true);
        }
    }, [activeDocId, getBookAnnotations]); 

    const handleDefineSelection = useCallback(async () => {
        const term = selectedText.trim();
        if (!term) {
            return;
        }

        readerRef.current?.clearSelection?.();
        if (typeof window !== "undefined") {
            window.getSelection?.()?.removeAllRanges?.();
        }

        setColorPickerMode("dictionary");
        setShowColorPicker(true);
        setDictionaryLookupTerm(term);
        setDictionaryLookupResult(null);
        setDictionaryLookupError(null);
        setDictionaryLookupSaved(false);
        setDictionaryLookupLoading(true);

        try {
            const result = await lookupTerm(term, "en");
            setDictionaryLookupResult(result);
            if (!result) {
                if (installedDictionaryCount === 0) {
                    setDictionaryLookupError(
                        "No dictionaries installed. Download one from Settings > Dictionary to look up words offline.",
                    );
                } else {
                    setDictionaryLookupError("No dictionary result found for this selection.");
                }
            }
        } catch (error) {
            setDictionaryLookupError("Dictionary lookup failed. Install a dictionary in Settings > Dictionary.");
        } finally {
            setDictionaryLookupLoading(false);
        }
    }, [
        installedDictionaryCount,
        lookupTerm,
        selectedText,
    ]);

    const handleSaveDictionaryResult = useCallback(() => {
        if (!dictionaryLookupResult || !settings.vocabulary.vocabularyEnabled) {
            return;
        }

        saveVocabularyTerm(vocabularyTermFromLookup(dictionaryLookupResult));
        setDictionaryLookupSaved(true);
    }, [dictionaryLookupResult, saveVocabularyTerm, settings.vocabulary.vocabularyEnabled]);

    const handleColorSelect = useCallback(async (color: HighlightColor) => {
        if (!selectedCfi || !activeDocId) return;

        const freshAnnotations = getBookAnnotations(activeDocId);

        if (editingHighlightId) {
            const existingAnnotation = freshAnnotations.find(a => a.id === editingHighlightId);
            if (existingAnnotation) {
                
                updateAnnotation(editingHighlightId, { color });
                setAnnotations(prev => prev.map(a =>
                    a.id === editingHighlightId ? { ...a, color, updatedAt: new Date() } : a
                ));

                try {
                    await readerRef.current?.removeHighlight?.(editingHighlightId);
                    const updatedAnnotation: Annotation = { ...existingAnnotation, color, updatedAt: new Date() };
                    await readerRef.current?.addAnnotation?.(updatedAnnotation);
                    debug('[Reader] Updated existing highlight color:', editingHighlightId, color);
                } catch (err) {
                }
            }

            setShowColorPicker(false);
            setColorPickerMode("actions");
            setEditingHighlightId(null);
            setActiveAnnotation(null);
            setSelectedText('');
            setSelectedCfi('');
            
            readerRef.current?.clearSelection?.();
            return;
        }

        const existingHighlight = freshAnnotations.find(a =>
            (a.type === 'highlight' || a.type === 'note') &&
            (a.location === selectedCfi || (a.selectedText && a.selectedText.trim() === selectedText.trim()))
        );

        if (existingHighlight) {
            
            debug('[Reader] Found existing highlight, updating color instead of creating duplicate:', existingHighlight.id);
            updateAnnotation(existingHighlight.id, { color });
            setAnnotations(prev => prev.map(a =>
                a.id === existingHighlight.id ? { ...a, color, updatedAt: new Date() } : a
            ));

            try {
                await readerRef.current?.removeHighlight?.(existingHighlight.id);
                const updatedAnnotation: Annotation = { ...existingHighlight, color, updatedAt: new Date() };
                await readerRef.current?.addAnnotation?.(updatedAnnotation);
            } catch (err) {
            }
            } else {
                
                try {
                    const annotation = await readerRef.current?.addHighlight?.(selectedCfi, selectedText, color);
                    if (annotation) {
                        
                        const annotationWithBookId = {
                            ...annotation,
                            bookId: activeDocId,
                            referenceId: annotation.referenceId || activeDocId,
                        };
                        
                        addAnnotation(annotationWithBookId);
                        setAnnotations(prev => [...prev, annotationWithBookId]);
                        debug('[Reader] Created new highlight:', annotationWithBookId.id);

                        const currentSection = extractSectionIndex(selectedCfi);
                        const lastHL = lastCreatedHighlightRef.current;
                        if (lastHL && currentSection !== null && lastHL.sectionIndex >= 0) {
                            const timeSinceLast = Date.now() - lastHL.timestamp;
                            const isAdjacentSection = Math.abs(currentSection - lastHL.sectionIndex) === 1;
                            if (timeSinceLast < 30000 && isAdjacentSection) {
                                debug('[Reader] Merging cross-page highlights:', {
                                    prev: lastHL.text.substring(0, 30),
                                    next: selectedText.substring(0, 30),
                                });
                                const mergedText = lastHL.text + " " + selectedText;
                                
                                removeAnnotation(lastHL.annotationId);
                                readerRef.current?.removeHighlight?.(lastHL.annotationId);
                                setAnnotations(prev => prev.filter(a => a.id !== lastHL.annotationId));
                                
                                updateAnnotation(annotationWithBookId.id, { selectedText: mergedText });
                                setAnnotations(prev => prev.map(a =>
                                    a.id === annotationWithBookId.id
                                        ? { ...a, selectedText: mergedText }
                                        : a
                                ));
                                debug('[Reader] Merged cross-page highlight');
                            }
                        }

                        lastCreatedHighlightRef.current = {
                            annotationId: annotationWithBookId.id,
                            text: selectedText,
                            cfi: selectedCfi,
                            sectionIndex: extractSectionIndex(selectedCfi) ?? -1,
                            timestamp: Date.now(),
                        };
                    } else {
                    }
                } catch (err) {
                }
            }

        setShowColorPicker(false);
        setColorPickerMode("actions");
        setEditingHighlightId(null);
        setActiveAnnotation(null);
        setSelectedText('');
        setSelectedCfi('');

        readerRef.current?.clearSelection?.();
    }, [selectedCfi, selectedText, activeDocId, addAnnotation, editingHighlightId, annotations, updateAnnotation, removeAnnotation]);

    const handleAddNote = useCallback(() => {
        if (!selectedCfi || !activeDocId) return;

        debug('[Reader] Opening note editor, editingHighlightId:', editingHighlightId, 'activeAnnotation:', activeAnnotation?.id);

        setShowColorPicker(false);
        setColorPickerMode("actions");
        setNoteEditorPosition(colorPickerPosition);

        if (editingHighlightId && activeAnnotation) {
            setEditingNote(activeAnnotation.noteContent || '');
            setPendingHighlightColor(activeAnnotation.color || 'yellow');
            debug('[Reader] Editing existing highlight, preserving ID:', editingHighlightId);
        } else {
            setEditingNote('');
            setPendingHighlightColor('yellow');
            debug('[Reader] Creating new highlight with note');
        }

        setShowNoteEditor(true);
    }, [selectedCfi, activeDocId, colorPickerPosition, editingHighlightId, activeAnnotation]);

    const handleSaveNote = useCallback(async (noteContent: string) => {
        if (!selectedCfi || !activeDocId) return;

        let existingHighlight = editingHighlightId
            ? (annotationsById.get(editingHighlightId) ?? null)
            : null;

        if (!existingHighlight) {
            existingHighlight = annotationsByLocation.get(selectedCfi) ?? null;
        }

        if (!existingHighlight && selectedText) {
            existingHighlight = annotations.find(a =>
                (a.type === 'highlight' || a.type === 'note') &&
                a.selectedText?.trim() === selectedText.trim()
            ) ?? null;
        }

        if (existingHighlight) {
            
            debug('[Reader] Adding note to existing highlight:', existingHighlight.id);
            updateAnnotation(existingHighlight.id, {
                type: noteContent ? 'note' : 'highlight',
                noteContent: noteContent || undefined,
            });

            setAnnotations(prev => prev.map(a =>
                a.id === existingHighlight!.id
                    ? { ...a, type: noteContent ? 'note' : 'highlight', noteContent: noteContent || undefined, updatedAt: new Date() }
                    : a
            ));

            const updatedAnnotation: Annotation = {
                ...existingHighlight,
                type: noteContent ? 'note' : 'highlight',
                noteContent: noteContent || undefined,
                updatedAt: new Date()
            };
            try {
                await readerRef.current?.removeHighlight?.(existingHighlight.id);
                await readerRef.current?.addAnnotation?.(updatedAnnotation);
                debug('[Reader] Re-rendered highlight with note in viewport');
            } catch (err) {
            }
        } else {
            
            debug('[Reader] Creating new highlight with note');
            const annotation: Annotation = {
                id: crypto.randomUUID(),
                bookId: activeDocId,
                referenceId: activeDocId,
                type: noteContent ? 'note' : 'highlight',
                location: selectedCfi,
                selectedText,
                color: pendingHighlightColor ?? 'yellow',
                noteContent: noteContent || undefined,
                createdAt: new Date(),
            };

            addAnnotation(annotation);
            setAnnotations(prev => [...prev, annotation]);

            try {
                await readerRef.current?.addHighlight?.(selectedCfi, selectedText, pendingHighlightColor ?? 'yellow');
            } catch (err) {
            }
        }

        setShowNoteEditor(false);
        setEditingHighlightId(null);
        setActiveAnnotation(null);
        setSelectedText('');
        setSelectedCfi('');
        setEditingNote('');
        setPendingHighlightColor('yellow');

        readerRef.current?.clearSelection?.();
    }, [
        selectedCfi,
        selectedText,
        activeDocId,
        annotations,
        addAnnotation,
        editingHighlightId,
        pendingHighlightColor,
        updateAnnotation,
    ]);

    const handleBookmarkFromSelection = useCallback(() => {
        if (!selectedCfi || !activeDocId) return;

        const annotation: Annotation = {
            id: crypto.randomUUID(),
            bookId: activeDocId,
            referenceId: activeDocId,
            type: 'bookmark',
            location: selectedCfi,
            selectedText,
            createdAt: new Date(),
        };

        addAnnotation(annotation);
        setAnnotations(prev => [...prev, annotation]);

        setShowColorPicker(false);
        setColorPickerMode("actions");
        setSelectedText('');
        setSelectedCfi('');

        readerRef.current?.clearSelection?.();
    }, [selectedCfi, selectedText, activeDocId, addAnnotation]);

    const handleAddPageBookmark = useCallback(() => {
        if (!activeDocId || !location) return;

        const existingBookmark = annotations.find(
            a => a.type === 'bookmark' && a.location === location.cfi
        );

        if (existingBookmark) {
            
            removeAnnotation(existingBookmark.id);
            setAnnotations(prev => prev.filter(a => a.id !== existingBookmark.id));
        } else {
            
            const annotation: Annotation = {
                id: crypto.randomUUID(),
                bookId: activeDocId,
                referenceId: activeDocId,
                type: 'bookmark',
                location: location.cfi || '',
                selectedText: location.tocItem?.label || `Page ${location.pageInfo?.currentPage || 0}`,
                createdAt: new Date(),
            };

            addAnnotation(annotation);
            setAnnotations(prev => [...prev, annotation]);
        }
    }, [activeDocId, location, annotations, addAnnotation, removeAnnotation]);

    const handleDeleteFromColorPicker = useCallback(async () => {
        if (!editingHighlightId) {
            return;
        }

        debug('[Reader] Deleting highlight:', editingHighlightId);

        try {
            await readerRef.current?.removeHighlight?.(editingHighlightId);
            debug('[Reader] Successfully removed highlight from viewport');
        } catch (err) {
        }

        removeAnnotation(editingHighlightId);

        setAnnotations(prev => prev.filter(a => a.id !== editingHighlightId));

        setShowColorPicker(false);
        setColorPickerMode("actions");
        setEditingHighlightId(null);
        setActiveAnnotation(null);
        setSelectedText('');
        setSelectedCfi('');

        readerRef.current?.clearSelection?.();
    }, [editingHighlightId, removeAnnotation]);

    const handleLocationsSaved = useCallback((locations: string) => {
        if (currentBookId) {
            saveBookLocations(currentBookId, locations);
        }
    }, [currentBookId, saveBookLocations]);

    useEffect(() => {
        return registerShortcuts("reader", [
            {
                label: "Find in book",
                keys: "Ctrl+F",
                category: "Reader",
                handler: () => setActivePanel((prev) => prev === "search" ? null : "search"),
            },
            {
                label: "Toggle bookmark",
                keys: "Ctrl+D",
                category: "Reader",
                handler: () => {
                    if (isPdfFormat) handlePdfAddBookmark();
                    else handleAddPageBookmark();
                },
            },
            {
                label: "Toggle fullscreen",
                keys: "F11",
                category: "Reader",
                handler: () => updateReaderSettings({ fullscreen: !settings.readerSettings.fullscreen }),
            },
            {
                label: "Table of contents",
                keys: "Ctrl+T",
                category: "Reader",
                handler: () => setActivePanel((prev) => prev === "toc" ? null : "toc"),
            },
            {
                label: "Reader settings",
                keys: "Ctrl+S",
                category: "Reader",
                handler: () => setActivePanel((prev) => prev === "settings" ? null : "settings"),
            },
            {
                label: "Annotations panel",
                keys: "Ctrl+A",
                category: "Reader",
                handler: () => setActivePanel((prev) => prev === "bookmarks" ? null : "bookmarks"),
            },
            {
                label: "Previous reading location (back)",
                keys: "Alt+ArrowLeft",
                category: "Reader",
                handler: () => {
                    if (!isPdfFormat && readerRef.current?.canGoBack) readerRef.current.goBack();
                },
            },
            {
                label: "Next reading location (forward)",
                keys: "Alt+ArrowRight",
                category: "Reader",
                handler: () => {
                    if (!isPdfFormat && readerRef.current?.canGoForward) readerRef.current.goForward();
                },
            },
        ], "reader");
    }, [isPdfFormat, settings.readerSettings.fullscreen, updateReaderSettings, handlePdfAddBookmark, handleAddPageBookmark]);

    if (downloadingBookId && currentBookId && downloadingBookId === currentBookId) {
        const pct = downloadProgress?.progress ?? 0;
        const hasProgress = downloadProgress !== null;
        const fmt = (bytes: number) => {
            if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
            if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
            return `${bytes} B`;
        };

        return (
            <div className="fixed inset-0 flex items-center justify-center bg-[var(--color-background)] px-4 sm:px-8 py-8">
                <div className="mx-auto w-full max-w-[26rem] min-w-0 flex flex-col items-center text-center">
                    <div className="w-16 h-16 flex items-center justify-center mb-6 bg-[var(--color-accent)]/10 text-[var(--color-accent)]">
                        <svg className="w-8 h-8 animate-spin" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                        </svg>
                    </div>
                    <h2 className="w-full break-words text-balance text-xl font-semibold text-[color:var(--color-text-primary)] mb-2">
                        Downloading Book
                    </h2>
                    <p className="mx-auto w-full max-w-[24rem] break-words text-[color:var(--color-text-secondary)] mb-6 leading-relaxed">
                        This book was synced from another device. Downloading from paired device...
                    </p>
                    <div className="w-full max-w-xs mb-2">
                        <div className="h-2 bg-[var(--color-surface-muted)] rounded-full overflow-hidden">
                            <div
                                className="h-full bg-[var(--color-accent)] rounded-full transition-[width] duration-300"
                                style={{ width: `${hasProgress ? Math.max(pct, 2) : 60}%` }}
                            />
                        </div>
                    </div>
                    {hasProgress && (
                        <p className="text-xs text-[color:var(--color-text-muted)]">
                            {fmt(downloadProgress.downloaded)} / {fmt(downloadProgress.total)} ({Math.round(pct)}%)
                        </p>
                    )}
                    {!hasProgress && (
                        <p className="text-xs text-[color:var(--color-text-muted)] animate-pulse">
                            Connecting to peer...
                        </p>
                    )}
                </div>
            </div>
        );
    }

    if (loadError) {
        const displayLoadError = loadError.replace(/\s+/g, " ").trim();
        const isSyncedWithoutFile = displayLoadError.includes('synced from another device');
        const isDownloadTimeout = displayLoadError.includes('timed out') || displayLoadError.includes('download');

        return (
            <div className="fixed inset-0 flex items-center justify-center bg-[var(--color-background)] px-4 sm:px-8 py-8">
                <div className="mx-auto w-full max-w-[26rem] min-w-0 flex flex-col items-center text-center">
                    <div className={`w-16 h-16 flex items-center justify-center mb-6 ${isSyncedWithoutFile || isDownloadTimeout ? 'bg-[var(--color-warning)]/10 text-[color:var(--color-warning)]' : 'bg-[var(--color-error)]/10 text-[color:var(--color-error)]'}`}>
                        {isSyncedWithoutFile || isDownloadTimeout ? (
                            <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                            </svg>
                        ) : (
                            <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                            </svg>
                        )}
                    </div>
                    <h2 className="w-full break-words text-balance text-xl font-semibold text-[color:var(--color-text-primary)] mb-2">
                        {isSyncedWithoutFile ? 'Book Not Yet Transferred' : isDownloadTimeout ? 'Book Unavailable' : 'Failed to Load Book'}
                    </h2>
                    <p className="mx-auto w-full max-w-[24rem] break-words text-[color:var(--color-text-secondary)] mb-8 leading-relaxed">
                        {displayLoadError}
                    </p>
                    <div className="flex gap-3">
                        <button
                            onClick={() => setRoute('library')}
                            className="ui-btn-primary"
                        >
                            Back to Library
                        </button>
                        <button
                            onClick={() => {
                                setLoadError(null);
                                loadedBookIdRef.current = null;
                                setLoadAttempt(v => v + 1);
                            }}
                            className="ui-btn-secondary"
                        >
                            Try Again
                        </button>
                        {isSyncedWithoutFile && (
                            <button
                                onClick={() => setRoute('settings')}
                                className="ui-btn-secondary"
                            >
                                Go to Sync Settings
                            </button>
                        )}
                    </div>
                </div>
            </div>
        );
    }

    if (currentBookId && currentBook?.syncedWithoutFile && downloadingBookId !== currentBookId) {
        return (
            <div className="fixed inset-0 flex items-center justify-center bg-[var(--color-background)] px-4 sm:px-8 py-8">
                <div className="mx-auto w-full max-w-[26rem] min-w-0 flex flex-col items-center text-center">
                    <div className="w-16 h-16 flex items-center justify-center mb-6 bg-[var(--color-warning)]/10 text-[color:var(--color-warning)]">
                        <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                        </svg>
                    </div>
                    <h2 className="w-full break-words text-balance text-xl font-semibold text-[color:var(--color-text-primary)] mb-2">
                        Book File Not Available
                    </h2>
                    <p className="mx-auto w-full max-w-[24rem] break-words text-[color:var(--color-text-secondary)] mb-8 leading-relaxed">
                        This book was synced from another device, but its file could not be downloaded. Try pairing with the source device or reopening later.
                    </p>
                    <div className="flex gap-3">
                        <button
                            onClick={() => setRoute('library')}
                            className="ui-btn-primary"
                        >
                            Back to Library
                        </button>
                        <button
                            onClick={() => {
                                setLoadError(null);
                                loadedBookIdRef.current = null;
                                setLoadAttempt(v => v + 1);
                            }}
                            className="ui-btn-secondary"
                        >
                            Try Again
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div
            className={cn(
                "fixed inset-0 overflow-clip",
                !isPdfFormat && `theme-${settings.readerSettings.theme}`
            )}
            style={{
                backgroundColor: isPdfFormat ? 'var(--color-surface)' : 'var(--reader-bg)',
                overscrollBehavior: 'none',
            }}
            data-reading-mode={isPdfFormat ? undefined : settings.readerSettings.flow}
        >
            
            <div
                ref={toolbarContainerRef}
                className={cn(
                    "absolute top-0 left-0 right-0 z-[140] transition-transform duration-300",
                    shouldShowReaderChrome ? "translate-y-0" : "-translate-y-full"
                )}
            >
                <WindowTitlebar
                    metadata={metadata}
                    location={location}
                    onBack={handleBack}
                    canGoBack={canGoBackState}
                    canGoForward={canGoForwardState}
                    onGoBack={() => readerRef.current?.goBack()}
                    onGoForward={() => readerRef.current?.goForward()}
                    onPrevPage={() => isPdfFormat ? pdfReaderRef.current?.prevPage() : readerRef.current?.prev()}
                    onNextPage={() => isPdfFormat ? pdfReaderRef.current?.nextPage() : readerRef.current?.next()}
                    onToggleToc={() => togglePanel('toc')}
                    onToggleSettings={() => togglePanel('settings')}
                    onToggleBookmarks={() => togglePanel('bookmarks')}
                    onToggleSearch={() => togglePanel('search')}
                    onToggleInfo={() => togglePanel('info')}
                    onToggleMenu={() => togglePanel('menu')}
                    onAddBookmark={isPdfFormat ? handlePdfAddBookmark : handleAddPageBookmark}
                    isCurrentPageBookmarked={isPdfFormat ? isPdfPageBookmarked : isCurrentPageBookmarked}
                    activePanel={activePanel}
                    fullscreen={settings.readerSettings.fullscreen}
                    onToggleFullscreen={() => updateReaderSettings({ fullscreen: !settings.readerSettings.fullscreen })}
                    immersionMode={immersionMode}
                    onToggleImmersion={(!isPdfFormat && ttsEnabled) ? () => setImmersionMode(v => !v) : undefined}
                    speedReadMode={speedReadMode}
                    onToggleSpeedRead={(!isPdfFormat && settings.speedReadEnabled) ? () => {
                        if (speedReadMode) {
                            setSpeedReadMode(false);
                            setSpeedReadText("");
                        } else {
                            const engine = readerRef.current;
                            if (engine && typeof engine.getVisibleTextForTts === "function") {
                                const result = engine.getVisibleTextForTts();
                                if (result?.text) {
                                    setSpeedReadText(result.text.replace(/\s+/g, " ").trim());
                                    setSpeedReadMode(true);
                                }
                            }
                        }
                    } : undefined}
                />
            </div>

            <div className="absolute inset-0 overflow-hidden">
                {isPdfFormat ? (
                    <Suspense fallback={<div className="flex items-center justify-center h-full">Loading PDF...</div>}>
                        <PDFReader
                            ref={pdfReaderRef}
                            pdfPath={resolvedPdfPath}
                            pdfData={pdfData ?? undefined}
                            originalFilename={currentBook?.title}
                            initialPage={pdfInitialPage}
                            initialZoom={pdfInitialZoom}
                            initialZoomMode={pdfInitialZoomMode}
                            presentationMode={pdfPresentationMode}
                            onPresentationModeChange={handlePdfPresentationModeChange}
                            brightness={settings.readerSettings.brightness}
                            onPageChange={handlePdfPageChange}
                            onZoomModeChange={handlePdfZoomModeChange}
                            onLoad={handlePdfLoad}
                            onError={handlePdfError}
                            onViewportTap={handleViewportTap}
                            showControls={shouldShowReaderChrome}
                            annotations={annotations}
                            annotationMode={pdfAnnotationMode}
                            highlightColor={pdfHighlightColor}
                            penColor={pdfBrushColor}
                            penWidth={pdfBrushWidth}
                            onAnnotationAdd={handlePdfAnnotationAdd}
                            onAnnotationChange={handlePdfAnnotationChange}
                            onAnnotationRemove={handlePdfAnnotationRemove}
                        />
                    </Suspense>
                ) : (
                    <ReaderViewport
                        key={activeDocId || 'no-doc'}
                        ref={readerRef}
                        file={file}
                        settings={effectiveReaderSettings}
                        format={currentBook?.format || "epub"}
                        initialLocation={initialLocation}
                        savedLocations={currentBook?.locations}
                        nativeFilePath={resolvedNativePath || currentBook?.storagePath || currentBook?.filePath}
                        onReady={handleReady}
                        onLocationChange={handleLocationChange}
                        onLocationsSaved={handleLocationsSaved}
                        onTextSelected={handleTextSelected}
                        onViewportTap={handleViewportTap}
                        shouldForceViewportTap={shouldForceViewportTap}
                        onZoomGestureChange={handleZoomGestureChange}
                        onHistoryChange={handleHistoryChange}
                        className="w-full h-full"
                    />
                )}
            </div>

            {isBookReady && isPdfFormat && (
                <>
                    <button
                        onClick={() => togglePanel('toc')}
                        className={cn(
                            "fixed bottom-6 z-[100]",
                            isMobileViewport ? "left-4" : "left-8",
                            "flex items-center justify-center w-11 h-11 rounded-full shadow-lg transition-all duration-300",
                            "bg-[var(--color-surface)]/95 backdrop-blur-xl text-[color:var(--color-text-primary)] border border-[var(--color-border)]",
                            "hover:scale-105 active:scale-95 hover:bg-[var(--color-surface)]",
                            (shouldShowReaderChrome || pdfAnnotationMode !== 'none') ? "translate-y-0 opacity-100" : "translate-y-20 opacity-0 pointer-events-none"
                        )}
                        aria-label="Table of Contents"
                    >
                        <List className="w-5 h-5 text-[color:var(--color-text-primary)]" />
                    </button>
                    <PDFFloatingToolbar
                        annotationMode={pdfAnnotationMode}
                        highlightColor={pdfHighlightColor}
                        penColor={pdfBrushColor}
                        penWidth={pdfBrushWidth}
                        onAnnotationModeChange={setPdfAnnotationMode}
                        onHighlightColorChange={setPdfHighlightColor}
                        onPenColorChange={setPdfBrushColor}
                        onPenWidthChange={setPdfBrushWidth}
                        className={cn(
                            "bottom-6 transition-all duration-300",
                            isMobileViewport ? "right-4" : "right-8",
                            (shouldShowReaderChrome || pdfAnnotationMode !== 'none') ? "translate-y-0 opacity-100" : "translate-y-20 opacity-0 pointer-events-none"
                        )}
                    />
                </>
            )}

            {!isPdfFormat && (
                <>
                    <SpeedReader
                        isOpen={speedReadMode}
                        text={speedReadText}
                        onClose={() => { setSpeedReadMode(false); setSpeedReadText(""); }}
                        onAutoNext={() => {
                            const engine = readerRef.current;
                            if (engine && typeof engine.next === "function") {
                                engine.next();
                                setTimeout(() => {
                                    if (engine && typeof engine.getVisibleTextForTts === "function") {
                                        const result = engine.getVisibleTextForTts();
                                        if (result?.text) setSpeedReadText(result.text.replace(/\s+/g, " ").trim());
                                    }
                                }, 600);
                            }
                        }}
                        theme={settings.readerSettings.theme}
                    />
                    
                    <ReaderNavbar
                        location={location}
                        toc={toc}
                        sectionFractions={sectionFractions}
                        onSeek={handleSeek}
                        totalPages={location?.pageInfo?.totalPages}
                        onToggleToc={() => togglePanel('toc')}
                        immersionMode={immersionMode}
                        ttsState={ttsState}
                        onTtsPlay={handleTtsPlay}
                        onTtsPause={handleTtsPause}
                        onTtsStop={handleTtsStop}
                        className={cn(
                            "fixed bottom-0 left-0 right-0 z-40 transition-transform duration-300 backdrop-blur-xl",
                            immersionMode
                                ? shouldShowReaderChrome ? "translate-y-0" : "translate-y-full pointer-events-none"
                                : shouldShowReaderChrome ? "translate-y-0" : "translate-y-full pointer-events-none",
                        )}
                    />
                </>
            )}

            <TableOfContents
                toc={toc}
                visible={activePanel === 'toc'}
                onClose={() => setActivePanel(null)}
                onNavigate={goTo}
                currentHref={isPdfFormat ? `pdf:page:${pdfCurrentPage}` : location?.tocItem?.href}
                isPdf={isPdfFormat}
                pdfHasOutline={pdfHasOutline}
            />

            <ReaderAnnotationsPanel
                bookId={activeDocId || ''}
                visible={activePanel === 'bookmarks'}
                onClose={() => setActivePanel(null)}
                onNavigate={goTo}
                onDelete={(id) => {
                    if (isPdfFormat) {
                        handlePdfAnnotationRemove(id);
                        return;
                    }
                    readerRef.current?.removeHighlight?.(id);
                }}
            />

            {isPdfFormat ? (
                <PDFViewSettingsPanel
                    visible={activePanel === "settings"}
                    onClose={() => setActivePanel(null)}
                    zoom={pdfZoom}
                    zoomMode={pdfZoomMode}
                    presentationMode={pdfPresentationMode}
                    onZoomIn={handlePdfZoomIn}
                    onZoomOut={handlePdfZoomOut}
                    onZoomReset={handlePdfZoomReset}
                    onFitPage={handlePdfZoomFitPage}
                    onFitWidth={handlePdfZoomFitWidth}
                    onRotate={() => pdfReaderRef.current?.rotateClockwise()}
                    onPresentationModeChange={handlePdfPresentationModeChange}
                />
            ) : (
                <ReaderSettings
                    settings={effectiveReaderSettings}
                    visible={activePanel === 'settings'}
                    onClose={() => setActivePanel(null)}
                    onUpdate={handleReaderSettingsUpdate}
                    format={getBook(currentBookId || '')?.format}
                />
            )}

            <BookInfoPopover
                metadata={metadata}
                visible={activePanel === 'info'}
                onClose={() => setActivePanel(null)}
            />

            <ReaderSearch
                visible={activePanel === 'search'}
                onClose={() => setActivePanel(null)}
                onNavigate={goTo}
                onSearch={(q) => {
                    if (isPdfFormat) {
                        return pdfReaderRef.current?.search(q) || (async function* () {
                            yield 'done' as const;
                        })();
                    }
                    return readerRef.current?.search(q) || (async function* () {
                        yield 'done' as const;
                    })();
                }}
                onClearSearch={() => {
                    if (isPdfFormat) {
                        pdfReaderRef.current?.clearSearch();
                        return;
                    }
                    readerRef.current?.clearSearch();
                }}
            />

            {!isPdfFormat && (
                <>
                    <HighlightColorPicker
                        isOpen={showColorPicker}
                        position={colorPickerPosition}
                        currentColor={activeAnnotation?.color}
                        onSelectColor={handleColorSelect}
                        onAddNote={handleAddNote}
                        onCopy={() => {
                            const text = selectedText || activeAnnotation?.selectedText;
                            if (text) navigator.clipboard.writeText(text).catch(() => {});
                            setShowColorPicker(false);
                        }}
                        onDefine={handleDefineSelection}
                        onBookmark={handleBookmarkFromSelection}
                        onDelete={editingHighlightId ? handleDeleteFromColorPicker : undefined}
                        viewportPadding={colorPickerViewportPadding}
                        dictionary={colorPickerMode === "dictionary"
                            ? {
                                term: dictionaryLookupTerm,
                                result: dictionaryLookupResult,
                                loading: dictionaryLookupLoading,
                                error: dictionaryLookupError,
                                saved: dictionaryLookupSaved,
                                canSaveToVocabulary: settings.vocabulary.vocabularyEnabled,
                                saveDisabledMessage: "Enable Vocabulary Builder in Settings to save terms.",
                                onSave: handleSaveDictionaryResult,
                                onBack: () => {
                                    setColorPickerMode("actions");
                                },
                            }
                            : undefined}
                        onClose={() => {
                            setShowColorPicker(false);
                            setColorPickerMode("actions");
                            setEditingHighlightId(null);
                            setActiveAnnotation(null);
                            setSelectedText('');
                            setSelectedCfi('');
                            setDictionaryLookupTerm('');
                            setDictionaryLookupResult(null);
                            setDictionaryLookupError(null);
                            setDictionaryLookupLoading(false);
                            setDictionaryLookupSaved(false);
                            readerRef.current?.clearSelection?.();
                        }}
                    />

                    <NoteEditor
                        isOpen={showNoteEditor}
                        position={noteEditorPosition}
                        initialNote={editingNote}
                        selectedText={selectedText}
                        viewportPadding={readerPopoverPadding}
                        onSave={handleSaveNote}
                        onClose={() => {
                            setShowNoteEditor(false);
                            setEditingNote('');
                            
                            if (!editingHighlightId) {
                                
                                readerRef.current?.clearSelection?.();
                            }
                        }}
                    />

                </>
            )}
        </div>
    );
});

export const ReaderPage = memo(function ReaderPage() {
    const currentRoute = useUIStore((state) => state.currentRoute);
    const currentBookId = useUIStore((state) => state.currentBookId);
    const setRoute = useUIStore((state) => state.setRoute);
    const currentArticle = useRssStore((state) => state.currentArticle);
    const setCurrentArticle = useRssStore((state) => state.setCurrentArticle);

    useEffect(() => {
        if (currentRoute === "reader" && !currentArticle && !currentBookId) {
            setRoute("feeds");
        }
    }, [currentArticle, currentBookId, currentRoute, setRoute]);

    useEffect(() => {
        if (currentRoute === "reader" && currentBookId && currentArticle) {
            setCurrentArticle(null);
        }
    }, [currentRoute, currentBookId, currentArticle, setCurrentArticle]);

    return <BookReaderPage />;
});
