
import { useState, useEffect, useCallback, useRef, useMemo, lazy, Suspense, memo } from "react";
import { useShallow } from "zustand/react/shallow";
import { cn, isBookMarkedRead } from "../../core/lib/utils";
import {
    getBookData,
    saveCoverImage,
    isFallbackCover,
} from "../../core/lib/storage";
import {
    extractMetadata,
    shouldUseExtractedTitle,
    shouldUseExtractedAuthor,
    isPlaceholderMetadataTitle,
} from "../../core/lib/cover-extractor";
import { extractFilenameFromPath, ensureFilenameForFormat } from "../../core/lib/import";
import { isTauri, isTauriDesktop, isTauriMobile, useAndroidBackButton } from "../../core/lib/env";
import { sqliteShrinkMemory } from "../../core/lib/sqlite-storage";
import { registerPrePersistFlush } from "../../core/lib/persist-storage";
import { isNativeRangeFile, type BookSource } from "../../core/lib/native-range-file";
import {
    useVocabularyStore,
    useLibraryStore,
    useRssStore,
    useSettingsStore,
    useUIStore,
} from "../../core/store";
import type {
    Annotation,
    Book,
    DocLocation,
    DocMetadata,
    HighlightColor,
    PdfZoomMode,
    ReaderSettings as ReaderSettingsState,
    TocItem,
} from "../../core/types";
import { List } from "lucide-react";

import { useReadingTime } from "./hooks/useReadingTime";
import { WindowTitlebar } from "./components/WindowTitlebar";
import { TableOfContents } from "./components/TableOfContents";
import { ReaderSettings } from "./components/ReaderSettings";
import { PDFViewSettingsPanel } from "./components/PDFViewSettingsPanel";
import { ReaderAnnotationsPanel } from "./components/ReaderAnnotationsPanel";
import { ReaderSearch } from "./components/ReaderSearch";
import { BookInfoPopover } from "./components/BookInfoPopover";
import { ReaderNavbar } from "./components/progress/ReaderNavbar";
import { ReaderViewport } from "./components/ReaderViewport";
import { resolvePdfDisplayTitle } from "./engines/pdf-display-title";
import { HighlightColorPicker } from "./components/highlights/HighlightColorPicker";
import { NoteEditor } from "./components/highlights/NoteEditor";
const PDFReader = lazy(() => import("./components/PDFReader"));
import { useReaderFullscreen, useToolbarHeight } from "./hooks";
import { PdfSelectionBubble } from "./components/PdfSelectionBubble";
import type { PDFJsEngineRef } from "./engines/pdfjs-engine";
import type { ReaderViewportHandle } from "./components/ReaderViewport";
import { PDFFloatingToolbar } from "./components/PDFFloatingToolbar";
import { registerShortcuts } from "../../core/lib/keyboard-shortcuts";
import { immersionPlayer } from "./audio/ImmersionPlayer";
import { toast } from "sonner";
import { notifyNextSeriesBook } from "./series-completion-notification";
import { AudiobookBar } from "./audio/AudiobookBar";
import { MediaOverlayBar } from "./audio/MediaOverlayBar";
import { SpeedReader } from "./components/SpeedReader";
import { resumeDecision } from "./lib/resume-progress";
import { immersionSource, immersionUsesTts } from "./lib/immersion-source";
import {
    clampReaderZoomByFlow,
    DEFAULT_PDF_ZOOM,
    DEFAULT_PDF_ZOOM_MODE,
    isSyntheticSectionLocation,
    MIN_PAGED_READER_ZOOM,
    MOBILE_READER_MEDIA_QUERY,
    PDF_BRUSH_WIDTH,
    PDF_STATE_SAVE_DEBOUNCE_MS,
    PDF_ZOOM_PERSIST_PRECISION,
    type PendingProgressUpdate,
    READER_PROGRESS_SAVE_DEBOUNCE_MS,
    resolvePdfTargetPage,
} from "./lib/reader-page-helpers";
import { useReaderBookLoader } from "./hooks/useReaderBookLoader";
import { useReaderAudioAndTts } from "./hooks/useReaderAudioAndTts";
import { useReaderAnnotationsAndDictionary } from "./hooks/useReaderAnnotationsAndDictionary";

export { resolvePdfTargetPage };

const BookReaderPage = memo(function BookReaderPage() {
    const currentBookId = useUIStore((state) => state.currentBookId);
    const setRoute = useUIStore((state) => state.setRoute);
    const currentArticle = useRssStore((state) => state.currentArticle);
    const closeArticleViewer = useRssStore((state) => state.closeArticleViewer);
    const activeDocId = currentBookId || (currentArticle ? `rss:${currentArticle.id}` : null);

    const getBook = useLibraryStore((state) => state.getBook);
    const recordBookOpened = useLibraryStore(state => state.recordBookOpened);
    const updateBook = useLibraryStore((state) => state.updateBook);
    const updateProgress = useLibraryStore((state) => state.updateProgress);
    const updatePdfReadingState = useLibraryStore((state) => state.updatePdfReadingState);
    const saveBookLocations = useLibraryStore((state) => state.saveBookLocations);
    const addReadingTime = useLibraryStore((state) => state.addReadingTime);
    const markBookCompleted = useLibraryStore((state) => state.markBookCompleted);
    const addAnnotation = useLibraryStore((state) => state.addAnnotation);
    const removeAnnotation = useLibraryStore((state) => state.removeAnnotation);
    const getBookAnnotations = useLibraryStore((state) => state.getBookAnnotations);
    const updateAnnotation = useLibraryStore((state) => state.updateAnnotation);
    const lookupTerm = useVocabularyStore((state) => state.lookupTerm);
    const saveVocabularyTerm = useVocabularyStore((state) => state.saveVocabularyTerm);
    const installedDictionaryCount = useVocabularyStore((state) => state.installedDictionaries.length);

    const settings = useSettingsStore(
        useShallow((state) => ({
            readerSettings: state.settings.readerSettings,
            tts: state.settings.tts,
            vocabulary: state.settings.vocabulary,
            speedReadEnabled: state.settings.speedReadEnabled,
        }))
    );
    const updateReaderSettings = useSettingsStore((state) => state.updateReaderSettings);
    const updateStats = useSettingsStore((state) => state.updateStats);
    const updateTtsSettings = useSettingsStore((state) => state.updateTtsSettings);
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
    const [pdfPresentationMode, setPdfPresentationMode] = useState<'scroll' | 'paged' | 'two-page'>('scroll');
    const [pdfInitialPage, setPdfInitialPage] = useState(1);
    const [pdfInitialZoom, setPdfInitialZoom] = useState(DEFAULT_PDF_ZOOM);
    const [pdfInitialZoomMode, setPdfInitialZoomMode] = useState<PdfZoomMode>(DEFAULT_PDF_ZOOM_MODE);
    const [resolvedPdfPath, setResolvedPdfPath] = useState("");
    const [resolvedNativePath, setResolvedNativePath] = useState("");
    const [isPresentationFullscreen, setIsPresentationFullscreen] = useState(false);
    const [pdfAnnotationMode, setPdfAnnotationMode] = useState<'none' | 'highlight' | 'pen' | 'text' | 'erase'>('none');
    const [pdfHighlightColor, setPdfHighlightColor] = useState<HighlightColor>("yellow");
    const [pdfBrushColor, setPdfBrushColor] = useState<HighlightColor>("blue");
    // Stroke width is not user-adjustable in the PDF toolbar yet; the setter it
    // used to be fed by was discarded, so this is a constant rather than state.
    const pdfBrushWidth = PDF_BRUSH_WIDTH;
    const [pdfHasOutline, setPdfHasOutline] = useState(false);

    const pageTurnWordTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const lastRecordedLocKeyRef = useRef<string | null>(null);
    useEffect(() => {
        readerZoomRef.current = settings.readerSettings.zoom;
    }, [settings.readerSettings.zoom]);

    // File state
    const [file, setFile] = useState<BookSource | null>(null);
    const [pdfData, setPdfData] = useState<Uint8Array | null>(null);
    const [metadata, setMetadata] = useState<DocMetadata | null>(null);
    const [toc, setToc] = useState<TocItem[]>([]);
    const [location, setLocation] = useState<DocLocation | null>(null);
    const [sectionFractions, setSectionFractions] = useState<number[]>([]);

    const flatToc = useMemo(() => {
        const list: TocItem[] = [];
        const walk = (items: TocItem[]) => {
            for (const item of items) {
                list.push(item);
                if (item.subitems && item.subitems.length > 0) {
                    walk(item.subitems);
                }
            }
        };
        walk(toc);
        return list;
    }, [toc]);

    const getCurrentChapterInfo = useCallback((): { chapterTitle?: string; chapterIndex?: number } => {
        if (!location) return {};
        const label = location.tocItem?.label?.trim() || location.pageItem?.label?.trim();
        const href = location.tocItem?.href;
        if (!label && !href) {
            if (location.pageInfo?.currentPage) {
                return {
                    chapterTitle: `Page ${location.pageInfo.currentPage}`,
                    chapterIndex: location.pageInfo.currentPage - 1,
                };
            }
            return {};
        }
        const idx = flatToc.findIndex((item) => (href && item.href === href) || (label && item.label === label));
        return {
            chapterTitle: label || (idx >= 0 ? flatToc[idx].label : undefined),
            chapterIndex: idx >= 0 ? idx : undefined,
        };
    }, [location, flatToc]);
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
    const [isExternalNarrationPlaying, setIsExternalNarrationPlaying] = useState(false);
    const ttsEnabled = settings.tts.enabled;
    const [immersionMode, setImmersionMode] = useState(false);
    const immersionModeRef = useRef(immersionMode);
    const [speedReadMode, setSpeedReadMode] = useState(false);
    const [speedReadText, setSpeedReadText] = useState("");
    // Keep ref in sync
    useEffect(() => { immersionModeRef.current = immersionMode; }, [immersionMode]);

    useEffect(() => {
        if (!immersionMode) return;
        const data = readerRef.current?.getVisibleTextForTts?.();
        if (data?.text) setTtsData(data);
    }, [immersionMode]);
    const suppressProgressRef = useRef(false);
    const resumeTargetRef = useRef<string | null>(null);
    const resumeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    /** The delayed jump to the saved fraction (books without a saved CFI). */
    const fractionJumpTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const pdfProgressSaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const lastPersistedPdfStateRef = useRef<{
        bookId: string;
        page: number;
        totalPages: number;
        zoom: number;
        zoomMode: PdfZoomMode;
        presentationMode: 'scroll' | 'paged' | 'two-page';
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
    // The book's real file name, e.g. `0132180146.pdf`. Kept separate from the
    // title so a PDF `Title` that merely echoes the file name can be recognised.
    const currentBookSourceFilename = useMemo(
        () => currentBook?.filePath
            ? ensureFilenameForFormat(
                extractFilenameFromPath(currentBook.filePath),
                currentBook.format,
            )
            : undefined,
        [currentBook?.filePath, currentBook?.format],
    );
    const audioTrack = currentBook?.audioTrack;
    // A book's own synced narration replaces generated speech. An audiobook the
    // user attached on purpose still wins over it.
    const [isBookReady, setIsBookReady] = useState(false);
    const bookMediaOverlay = useMemo(
        () => (isBookReady ? readerRef.current?.getMediaOverlay?.() ?? null : null),
        [currentBookId, isBookReady],
    );
    const bookImmersionSource = immersionSource({ hasAudiobook: !!audioTrack, hasMediaOverlay: !!bookMediaOverlay });
    const mediaOverlay = immersionMode && bookImmersionSource === "book-narration" ? bookMediaOverlay : null;
    // Exit immersion mode if TTS is disabled while generated speech is the source.
    useEffect(() => {
        if (!ttsEnabled && immersionMode && immersionUsesTts(bookImmersionSource)) {
            setImmersionMode(false);
            immersionPlayer.stop();
        }
    }, [ttsEnabled, immersionMode, bookImmersionSource]);
    // Pause platform/neural narration while a human-narrated player is active.
    useEffect(() => {
        if (immersionMode && (audioTrack || mediaOverlay)) {
            immersionPlayer.stop();
        }
    }, [immersionMode, audioTrack, mediaOverlay]);

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
    const handleSaveAttachment = useCallback(async (key: string) => {
        const attachment = await pdfReaderRef.current?.getAttachment(key);
        if (!attachment) {
            toast.error("Could not read the attachment.");
            return;
        }
        const { saveFileAs } = await import("../../core/lib/book-export");
        const result = await saveFileAs(attachment.name, new Blob([attachment.bytes as BlobPart]));
        if (result.ok) toast.success(result.message);
        else if (result.message !== "Save cancelled") toast.error(result.message);
    }, []);

    const handlePdfLoad = useCallback((info: import('./engines/pdfjs-engine').PDFDocumentInfo) => {
        // Get current book data for fallback
        const currentBookData = currentBookId ? getBook(currentBookId) : null;
        if (currentBookData) recordBookOpened(currentBookData.id);

        const displayTitle = resolvePdfDisplayTitle({
            pdfTitle: info.title,
            filename: info.filename,
            sourceFilename: info.sourceFilename,
            libraryTitle: currentBookData?.title,
        });
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
            creator: info.creator,
            producer: info.producer,
            pdfVersion: info.pdfVersion,
            pageSize: info.pageSize,
            attachments: info.attachments,
        });
        setToc(Array.isArray(info.toc) ? info.toc : []);
        setPdfHasOutline(Boolean(info.hasOutline ?? ((info.toc?.length || 0) > 0)));
        // Ensure titlebar page indicator has total pages immediately on load.
        setPdfCurrentPage((currentPage) => Math.max(1, currentPage));
        setPdfTotalPages(Math.max(0, info.totalPages || 0));
        setIsBookReady(true);

        // Background cover extraction for PDF books
        void extractBookCover(currentBookId ?? null);
    }, [currentBookId, getBook, recordBookOpened]);

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

        // Native comic import already extracted the cover on disk. A fallback
        // cover must not trigger a second, whole-archive read in the reader.
        if (isTauri() && book.format === 'cbz' && book.coverExtractionDone) return;
        const hasRealCover = !!book.coverPath && !isFallbackCover(book.coverPath);
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

    // Sync book title from store to metadata when renamed while reader is open.
    // Intentionally keyed on `storeTitle` only: on initial load the document's own
    // title is preferred (see `handleReady`/`handlePdfLoad`), and a PDF/EPUB may
    // carry a better title in its metadata than the library row does.
    const storeTitle = useLibraryStore(
        (s) => currentBookId ? (s.getBook(currentBookId)?.title ?? null) : null,
    );
    useEffect(() => {
        if (!storeTitle || !metadata || storeTitle === metadata.title) return;
        setMetadata((prev) => prev ? { ...prev, title: storeTitle } : prev);
    }, [storeTitle]);

    const handlePdfError = useCallback((err: Error) => {
        const book = currentBookId ? getBook(currentBookId) : null;
        const kind = (err as { kind?: unknown })?.kind;
        const isMissing = kind === 'not_found'
            || err.name === 'MissingPDFException'
            || err.message.toLowerCase().includes('not found')
            || err.message.toLowerCase().includes('no such file');
        if (book?.syncedWithoutFile && isMissing) {
            setLoadError('This book was synced from another device, but its file could not be downloaded. Try pairing with the source device or reopening later.');
            loadedBookIdRef.current = null;
            return;
        }
        setLoadError(err.message);
        loadedBookIdRef.current = null;
    }, [currentBookId, getBook]);

    const handlePdfPageChange = useCallback((page: number, total: number, scale: number) => {
        const safePage = Math.max(1, page);
        setPdfCurrentPage(safePage);
        setPdfTotalPages((prevTotal) => {
            const resolvedTotal = total > 0 ? total : prevTotal;
            const label = pdfReaderRef.current?.getPageLabel(safePage);
            const percentage = resolvedTotal > 0 ? (safePage - 1) / Math.max(1, resolvedTotal - 1) : 0;
            setLocation({
                cfi: String(safePage),
                percentage,
                pageItem: label ? { label } : undefined,
                pageInfo: {
                    currentPage: safePage,
                    totalPages: resolvedTotal,
                },
            });
            return resolvedTotal;
        });
        setPdfZoom(scale);
    }, []);

    const downloadingBookId = useUIStore((s) => s.downloadingBookId);

    useEffect(() => {
        if (!downloadingBookId) {
            setDownloadProgress(null);
        }
    }, [downloadingBookId]);

    useEffect(() => {
        if (!isTauri()) return;
        let unlisten: (() => void) | null = null;
        let cancelled = false;

        import("@tauri-apps/api/event").then(({ listen }) => {
            if (cancelled) return;
            listen<{ book_id: string; progress: number; downloaded: number; total: number }>(
                "download-progress",
                (event) => {
                    const activeDownloading = useUIStore.getState().downloadingBookId;
                    if (activeDownloading && event.payload.book_id === activeDownloading) {
                        setDownloadProgress({
                            progress: event.payload.progress,
                            downloaded: event.payload.downloaded,
                            total: event.payload.total,
                        });
                    }
                },
            ).then((fn) => {
                if (cancelled) fn();
                else unlisten = fn;
            }).catch(() => {});
        }).catch(() => {});

        return () => {
            cancelled = true;
            unlisten?.();
        };
    }, []);

    useReaderBookLoader({
        activeDocId,
        currentBookId,
        currentArticle,
        loadAttempt,
        setLoadAttempt,
        getBook,
        updateBook,
        setRoute,
        readerZoomValue: settings.readerSettings.zoom,
        readerZoomRef,
        loadedBookIdRef,
        suppressProgressRef,
        resumeTargetRef,
        resumeTimeoutRef,
        hasAppliedInitialLocationRef,
        setShowToolbar,
        setTtsData,
        setFile,
        setPdfData,
        setPdfCurrentPage,
        setPdfTotalPages,
        setPdfZoom,
        setPdfZoomMode,
        setPdfPresentationMode,
        setPdfInitialPage,
        setPdfInitialZoom,
        setPdfInitialZoomMode,
        setResolvedPdfPath,
        setResolvedNativePath,
        setIsPresentationFullscreen,
        setPdfHasOutline,
        setMetadata,
        setToc,
        setLocation,
        setIsBookReady,
        setInitialLocation,
        setInitialFraction,
        setLoadError,
    });

    const { recordPageTurn, setCurrentPageWordCount } = useReadingTime({
        currentBookId,
        addReadingTime,
        isTtsActive: ttsState === 'playing' || isExternalNarrationPlaying,
    });

    useEffect(() => {
        return () => {
            if (pageTurnWordTimeoutRef.current) {
                clearTimeout(pageTurnWordTimeoutRef.current);
            }
            if (resumeTimeoutRef.current) {
                clearTimeout(resumeTimeoutRef.current);
            }
            if (fractionJumpTimeoutRef.current) {
                clearTimeout(fractionJumpTimeoutRef.current);
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
        lastRecordedLocKeyRef.current = null;
    }, [currentBookId]);

    // PDF presentation: full screen, one page at a time, whole page visible.
    // Leaving full screen (Esc, F11, menu) ends it and restores the layout.
    const presentationRestoreRef = useRef<{ mode: 'scroll' | 'paged' | 'two-page'; zoom: number } | null>(null);
    const stopPresentation = useCallback(() => {
        setIsPresentationFullscreen(false);
        const restore = presentationRestoreRef.current;
        if (!restore) return;
        presentationRestoreRef.current = null;
        const engine = pdfReaderRef.current;
        engine?.setPresentationMode(restore.mode);
        engine?.setZoom(restore.zoom);
        setShowToolbar(true);
    }, []);
    const startPresentation = useCallback(() => {
        const engine = pdfReaderRef.current;
        if (!engine || presentationRestoreRef.current) return;
        presentationRestoreRef.current = { mode: engine.getPresentationMode(), zoom: engine.getZoom() };
        engine.setPresentationMode('paged');
        engine.zoomFitPage();
        setActivePanel(null);
        setShowToolbar(false);
        setIsPresentationFullscreen(true);
    }, []);

    const renderPdfThumbnail = useCallback(
        async (pageNumber: number, cssWidth: number, signal: AbortSignal) =>
            (await pdfReaderRef.current?.renderThumbnail(pageNumber, cssWidth, signal)) ?? null,
        [],
    );
    const getPdfPageLabel = useCallback((pageNumber: number) => pdfReaderRef.current?.getPageLabel(pageNumber), []);
    const navigatePdfPage = useCallback((pageNumber: number) => pdfReaderRef.current?.goToPage(pageNumber), []);
    const pdfPagesNav = useMemo(() => (isPdfFormat && pdfTotalPages > 0 ? {
        totalPages: pdfTotalPages,
        currentPage: pdfCurrentPage,
        renderThumbnail: renderPdfThumbnail,
        getPageLabel: getPdfPageLabel,
        onNavigatePage: navigatePdfPage,
    } : undefined), [isPdfFormat, pdfTotalPages, pdfCurrentPage, renderPdfThumbnail, getPdfPageLabel, navigatePdfPage]);

    const handlePrint = useCallback(async () => {
        const engine = pdfReaderRef.current;
        if (!engine) return;
        const id = toast.loading("Preparing pages for printing…");
        try {
            await engine.print({
                onProgress: (done, total) => toast.loading(`Preparing page ${done} of ${total}…`, { id }),
                openDialog: isTauriDesktop()
                    ? () => import("@tauri-apps/api/core").then(({ invoke }) => invoke<void>("print_webview"))
                    : undefined,
            });
            toast.dismiss(id);
        } catch (error) {
            toast.error(`Print failed: ${error instanceof Error ? error.message : String(error)}`, { id });
        }
    }, []);

    const effectiveFullscreen = settings.readerSettings.fullscreen || isPresentationFullscreen;

    const handleReaderExitFullscreen = useCallback(() => {
        if (isPresentationFullscreen) {
            stopPresentation();
        }
        if (settings.readerSettings.fullscreen) {
            updateReaderSettings({ fullscreen: false });
        }
    }, [isPresentationFullscreen, settings.readerSettings.fullscreen, updateReaderSettings, stopPresentation]);

    useReaderFullscreen({
        fullscreen: effectiveFullscreen,
        onExitFullscreen: handleReaderExitFullscreen,
        errorLabel: "[Reader]",
    });

    const handleReady = useCallback((meta: DocMetadata, tocItems: TocItem[]) => {
        const loadedBook = currentBookId ? getBook(currentBookId) : null;
        if (loadedBook) recordBookOpened(loadedBook.id);
        const mergedMetadata: DocMetadata = {
            ...meta,
            // Comics take their title straight off the archive file name, and
            // blob-loaded books use the synthetic `document.<ext>` name. When
            // the loader has nothing better, the library title wins.
            title: isPlaceholderMetadataTitle(meta.title)
                ? (loadedBook?.title || meta.title)
                : meta.title,
            pubdate: loadedBook?.publishedDate || meta.pubdate,
            cover: loadedBook?.coverPath || meta.cover,
            series: loadedBook?.series || meta.series,
            seriesIndex: loadedBook?.seriesIndex ?? meta.seriesIndex,
            seriesTotal: meta.seriesTotal,
        };

        setMetadata(mergedMetadata);
        setToc(Array.isArray(tocItems) ? tocItems : []);
        setIsBookReady(true);

        const fractions = readerRef.current?.getSectionFractions() ?? [];
        setSectionFractions(fractions);

        // A range file would have to be read whole; let cover extraction load it itself (only runs when a cover is missing).
        void extractBookCover(currentBookId ?? null, (file && !isNativeRangeFile(file) ? file : undefined) ?? pdfData ?? undefined);
    }, [currentBookId, getBook, extractBookCover, file, pdfData, recordBookOpened]);

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
        const currentStats = useSettingsStore.getState().stats;
        updateStats({
            booksCompleted: currentStats.booksCompleted + 1,
            booksReadThisYear: result.completedYear === currentYear
                ? currentStats.booksReadThisYear + 1
                : currentStats.booksReadThisYear,
        });

        // Prompt next volume if book belongs to a series
        const completedBook = useLibraryStore.getState().getBook(bookId);
        if (completedBook?.series?.trim()) {
            const seriesName = completedBook.series.trim().toLowerCase();
            const seriesBooks = useLibraryStore.getState().books
                .filter((b) => b.series?.trim().toLowerCase() === seriesName && b.id !== bookId)
                .sort((a, b) => (a.seriesIndex ?? Infinity) - (b.seriesIndex ?? Infinity));

            const currentIdx = completedBook.seriesIndex ?? -1;
            const nextBook = seriesBooks.find((b) => (b.seriesIndex != null && b.seriesIndex > currentIdx && !isBookMarkedRead(b)))
                || seriesBooks.find((b) => !isBookMarkedRead(b));

            if (nextBook) {
                notifyNextSeriesBook(completedBook, nextBook, (nextBookId) => {
                    useUIStore.getState().setRoute("reader", nextBookId);
                });
            }
        }
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
        const unregister = registerPrePersistFlush(flushPendingProgressUpdate);
        return () => {
            unregister();
            flushPendingProgressUpdate();
        };
    }, [flushPendingProgressUpdate]);

    const handleLocationChange = useCallback((loc: DocLocation) => {
        setLocation(loc);

        // The reader turned the page before the delayed jump to the saved
        // fraction ran: the jump would take them back (a new book went back to
        // page 1 after the first page turn).
        if (loc.byUser && fractionJumpTimeoutRef.current) {
            clearTimeout(fractionJumpTimeoutRef.current);
            fractionJumpTimeoutRef.current = null;
        }

        if (suppressProgressRef.current) {
            const target = resumeTargetRef.current;

            debug('[Reader] Location change while suppressed:', {
                hasTarget: !!target,
                targetCfi: target?.substring(0, 50),
                currentCfi: loc.cfi?.substring(0, 50),
                percentage: loc.percentage,
            });

            const decision = resumeDecision({ target, cfi: loc.cfi, byUser: loc.byUser });
            if (decision === 'wait') {
                // A location that does not start with the target is not a failed
                // resume: the paginator reports the start of the visible page (an
                // earlier CFI than a mid-page target) and the first render can land
                // on the section start before the jump. Erasing the saved progress
                // here lost the reading position in about one reopen in three, so
                // a mismatch only waits; the timeout below ends the suppression and
                // the saved position is kept.
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

            debug('[Reader] Resume over, clearing suppression:', decision);
            suppressProgressRef.current = false;
            resumeTargetRef.current = null;
            hasAppliedInitialLocationRef.current = true;
            if (resumeTimeoutRef.current) {
                clearTimeout(resumeTimeoutRef.current);
                resumeTimeoutRef.current = null;
            }
            // At the target nothing changed; a page turn is a new position to save.
            if (decision === 'arrived') return;
        }

        if (currentBookId) {
            const currentLocKey = loc.cfi || (loc.pageInfo ? String(loc.pageInfo.currentPage) : String(loc.percentage));
            if (lastRecordedLocKeyRef.current !== currentLocKey) {
                lastRecordedLocKeyRef.current = currentLocKey;
                recordPageTurn();

                if (pageTurnWordTimeoutRef.current) {
                    clearTimeout(pageTurnWordTimeoutRef.current);
                }
                pageTurnWordTimeoutRef.current = setTimeout(() => {
                    const sampleVisibleWords = () => {
                        const currentData = readerRef.current?.getVisibleTextForTts?.();
                        const words = currentData?.text ? currentData.text.trim().split(/\s+/).filter(Boolean).length : undefined;
                        if (words && words > 20) {
                            setCurrentPageWordCount(words);
                        }
                    };
                    if (typeof requestIdleCallback !== 'undefined') {
                        requestIdleCallback(sampleVisibleWords);
                    } else {
                        sampleVisibleWords();
                    }
                }, 1000);
            }

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

    }, [currentBookId, currentArticle, scheduleProgressUpdate, updateProgress, recordPageTurn, setCurrentPageWordCount]);

    useEffect(() => {
        if (isPdfFormat || !location?.cfi) return;

        let cancelled = false;
        let retries = 0;
        const MAX_RETRIES = 8;
        const INITIAL_DELAY = 500;
        const RETRY_INTERVAL = 250;

        let retryTimer: ReturnType<typeof setTimeout> | null = null;
        const extract = () => {
            if (cancelled) return;
            const data = readerRef.current?.getVisibleTextForTts?.();
            const text = data?.text || '';

            if (text) {
                setTtsData(data || null);
            } else if (retries < MAX_RETRIES) {
                retries++;
                retryTimer = setTimeout(extract, RETRY_INTERVAL);
            } else {
                setTtsData(null);
            }
        };

        const timer = setTimeout(extract, INITIAL_DELAY);
        return () => {
            cancelled = true;
            clearTimeout(timer);
            if (retryTimer !== null) clearTimeout(retryTimer);
        };
    }, [location?.cfi, isPdfFormat]);

    const {
        readerUnmountedRef,
        neuralReady,
        showNeuralInstall,
        audioGenProgress,
        handleTtsPlay,
        handleTtsPause,
        handleTtsStop,
        handleTtsVoiceChange,
        handleTtsSpeedChange,
        handleOpenNeuralSettings,
        handleGenerateAudiobook,
        handleCancelAudiobook,
    } = useReaderAudioAndTts({
        currentBookId,
        readerRef,
        isPdfFormat,
        ttsEnabled,
        immersionMode,
        mediaOverlay,
        ttsVoice: settings.tts.voice,
        ttsSpeed: settings.tts.speed,
        ttsState,
        setTtsState,
        ttsData,
        setTtsData,
        setRoute,
    });

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
            let pageNumber = resolvePdfTargetPage(target);
            if (!pageNumber && pdfReaderRef.current?.getPageNumberFromLabel) {
                pageNumber = pdfReaderRef.current.getPageNumberFromLabel(target);
            }
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

    const goToAnnotation = useCallback(async (annotation: Annotation) => {
        if (isPdfFormat) {
            const pageNumber = annotation.pageNumber ?? resolvePdfTargetPage(annotation.location);
            if (pageNumber) {
                pdfReaderRef.current?.goToPage(pageNumber);
            }
            setActivePanel(null);
            return;
        }

        if (readerRef.current) {
            await readerRef.current.goToAnnotation(annotation);
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

    const [annotations, setAnnotations] = useState<Annotation[]>([]);

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
    const bookmarkByLocation = useMemo(() => {
        const m = new Map<string, Annotation>();
        for (const a of annotations) {
            if (a.type === 'bookmark') m.set(a.location, a);
        }
        return m;
    }, [annotations]);

    const activePdfTocHref = useMemo(() => {
        if (!isPdfFormat || toc.length === 0) return undefined;
        let bestHref: string | undefined = undefined;
        let bestPage = 0;

        const scan = (items: TocItem[]) => {
            for (const item of items) {
                const match = item.href?.match(/pdf:page:(\d+)/);
                if (match) {
                    const itemPage = parseInt(match[1], 10);
                    if (itemPage <= pdfCurrentPage && itemPage >= bestPage) {
                        bestPage = itemPage;
                        bestHref = item.href;
                    }
                }
                if (item.subitems && item.subitems.length > 0) {
                    scan(item.subitems);
                }
            }
        };

        scan(toc);
        return bestHref ?? toc[0]?.href;
    }, [isPdfFormat, toc, pdfCurrentPage]);

    const {
        showColorPicker,
        setShowColorPicker,
        colorPickerMode,
        setColorPickerMode,
        colorPickerPosition,
        selectedText,
        setSelectedText,
        setSelectedCfi,
        activeAnnotation,
        setActiveAnnotation,
        editingHighlightId,
        setEditingHighlightId,
        showNoteEditor,
        setShowNoteEditor,
        noteEditorPosition,
        editingNote,
        setEditingNote,
        setDictionaryLookupTerm,
        setDictionaryLookupResult,
        setDictionaryLookupError,
        setDictionaryLookupLoading,
        setDictionaryLookupSaved,
        handleTextSelected,
        handleDefineSelection,
        pdfSelection,
        handlePdfDefine,
        handlePdfCopy,
        closeDictionaryPicker,
        dictionaryView,
        handleColorSelect,
        handleAddNote,
        handleSaveNote,
        handleBookmarkFromSelection,
        handleAddPageBookmark,
        handleDeleteFromColorPicker,
    } = useReaderAnnotationsAndDictionary({
        activeDocId,
        readerRef,
        annotations,
        setAnnotations,
        annotationsById,
        bookmarkByLocation,
        location,
        isPdfFormat,
        pdfAnnotationMode,
        getCurrentChapterInfo,
        addAnnotation,
        removeAnnotation,
        getBookAnnotations,
        updateAnnotation,
        lookupTerm,
        saveVocabularyTerm,
        installedDictionaryCount,
        vocabularyEnabled: settings.vocabulary.vocabularyEnabled,
        lastCreatedHighlightRef,
        debug,
    });
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
        if (isPdfFormat ? pdfReaderRef.current?.canGoBack() : readerRef.current?.canGoBack) {
            if (isPdfFormat) pdfReaderRef.current?.goBack();
            else readerRef.current?.goBack();
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

    const handlePdfZoomFitPage = useCallback(() => {
        pdfReaderRef.current?.zoomFitPage();
        setPdfZoomMode('page-fit');
    }, []);

    const handlePdfZoomFitWidth = useCallback(() => {
        pdfReaderRef.current?.zoomFitWidth();
        setPdfZoomMode('width-fit');
    }, []);

    const handlePdfPresentationModeChange = useCallback((mode: 'scroll' | 'paged' | 'two-page') => {
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
        const chapterInfo = getCurrentChapterInfo();
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
            chapterTitle: partialAnnotation.chapterTitle || chapterInfo.chapterTitle,
            chapterIndex: partialAnnotation.chapterIndex ?? chapterInfo.chapterIndex,
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
        getCurrentChapterInfo,
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


    const isCurrentPageBookmarked = location?.cfi ? bookmarkByLocation.has(location.cfi) : false;

    useEffect(() => {
        if (activeDocId && isBookReady) {
            const bookAnnotations = getBookAnnotations(activeDocId);
            setAnnotations(bookAnnotations);

            // Backfill chapter metadata for legacy annotations that lack chapterTitle
            const legacyAnnotations = bookAnnotations.filter((a) => !a.chapterTitle);
            if (legacyAnnotations.length > 0) {
                for (const anno of legacyAnnotations) {
                    if (isPdfFormat) {
                        const pageNum = anno.pageNumber ?? (anno.location ? parseInt(anno.location, 10) : undefined);
                        if (pageNum && !isNaN(pageNum) && pageNum > 0) {
                            updateAnnotation(anno.id, {
                                chapterTitle: `Page ${pageNum}`,
                                chapterIndex: pageNum - 1,
                            });
                        }
                    } else if (anno.location && flatToc.length > 0) {
                        const idMatch = anno.location.match(/\[([^\]]+)\]/);
                        if (idMatch && idMatch[1]) {
                            const anchor = idMatch[1];
                            const matchedIdx = flatToc.findIndex((item) => item.href && item.href.includes(anchor));
                            if (matchedIdx >= 0) {
                                updateAnnotation(anno.id, {
                                    chapterTitle: flatToc[matchedIdx].label,
                                    chapterIndex: matchedIdx,
                                });
                            }
                        }
                    }
                }
            }

            if (isPdfFormat) {
                return;
            }

            readerRef.current?.loadAnnotations?.(bookAnnotations).catch(e => console.error("[catch]", e));
        }
    }, [activeDocId, getBookAnnotations, isBookReady, isPdfFormat, flatToc, updateAnnotation]);

    useEffect(() => {
        if (!isBookReady || !readerRef.current || hasAppliedInitialLocationRef.current) return;

        if (initialLocation) {
            debug('[Reader] CFI was provided, engine should have navigated');
            hasAppliedInitialLocationRef.current = true;
            const ann = annotationsByLocation.get(initialLocation) || (activeDocId ? getBookAnnotations(activeDocId).find(a => a.location === initialLocation) : undefined);
            if (ann) {
                readerRef.current?.goToAnnotation(ann);
            }
            return;
        }

        if (typeof initialFraction === 'number') {
            debug('[Reader] No CFI, using fraction fallback:', initialFraction);
            hasAppliedInitialLocationRef.current = true;
            
            if (fractionJumpTimeoutRef.current) clearTimeout(fractionJumpTimeoutRef.current);
            fractionJumpTimeoutRef.current = setTimeout(() => {
                fractionJumpTimeoutRef.current = null;
                readerRef.current?.goToFraction(initialFraction);
            }, 100);
        }
    }, [isBookReady, initialLocation, initialFraction]);

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
                handler: () => {
                    if (effectiveFullscreen) {
                        stopPresentation();
                        if (settings.readerSettings.fullscreen) {
                            updateReaderSettings({ fullscreen: false });
                        }
                    } else {
                        updateReaderSettings({ fullscreen: true });
                    }
                },
            },
            {
                label: "Present PDF (full screen, one page)",
                keys: "F5",
                category: "Reader",
                handler: () => { if (isPdfFormat) startPresentation(); },
            },
            {
                label: "Print PDF",
                keys: "Ctrl+P",
                category: "Reader",
                handler: () => { if (isPdfFormat && !isTauriMobile()) void handlePrint(); },
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
                    if (isPdfFormat) pdfReaderRef.current?.goBack();
                    else if (readerRef.current?.canGoBack) readerRef.current.goBack();
                },
            },
            {
                label: "Next reading location (forward)",
                keys: "Alt+ArrowRight",
                category: "Reader",
                handler: () => {
                    if (isPdfFormat) pdfReaderRef.current?.goForward();
                    else if (readerRef.current?.canGoForward) readerRef.current.goForward();
                },
            },
        ], "reader");
    }, [isPdfFormat, settings.readerSettings.fullscreen, updateReaderSettings, handlePdfAddBookmark, handleAddPageBookmark, startPresentation, stopPresentation, handlePrint]);

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
                    <h2 className="w-full break-words text-balance text-xl text-[color:var(--color-text-primary)] mb-2">
                        Downloading Book
                    </h2>
                    <p className="mx-auto w-full max-w-[24rem] break-words text-[color:var(--color-text-secondary)] mb-6 leading-relaxed">
                        This book was synced from another device. Downloading from paired device...
                    </p>
                    <div className="w-full max-w-[20rem] mb-2">
                        <div className="h-2 bg-[var(--color-surface-muted)] overflow-hidden">
                            <div
                                className="h-full bg-[var(--color-accent)] transition-[width] duration-300"
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
                    <h2 className="w-full break-words text-balance text-xl text-[color:var(--color-text-primary)] mb-2">
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
                            className="ui-btn-ghost"
                        >
                            Try Again
                        </button>
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
                    <h2 className="w-full break-words text-balance text-xl text-[color:var(--color-text-primary)] mb-2">
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
                                useUIStore.getState().setDownloadingBook(currentBookId);
                                import("../../core/lib/sync-orchestrator").then(({ downloadBookOnDemand }) => {
                                    downloadBookOnDemand(currentBookId).catch(() => {});
                                });
                                setLoadAttempt(v => v + 1);
                            }}
                            className="ui-btn-ghost"
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
            role="main"
            aria-label="Reader"
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
                    "absolute top-0 left-0 right-0 z-[var(--z-reader-bar)] transition-transform duration-150 ease-out",
                    shouldShowReaderChrome ? "translate-y-0" : "-translate-y-full"
                )}
            >
                <WindowTitlebar
                    metadata={metadata}
                    location={location}
                    onBack={handleBack}
                    canGoBack={canGoBackState}
                    canGoForward={canGoForwardState}
                    onGoBack={() => (isPdfFormat ? pdfReaderRef.current?.goBack() : readerRef.current?.goBack())}
                    onGoForward={() => (isPdfFormat ? pdfReaderRef.current?.goForward() : readerRef.current?.goForward())}
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
                    fullscreen={effectiveFullscreen}
                    onToggleFullscreen={() => {
                        if (effectiveFullscreen) {
                            stopPresentation();
                            if (settings.readerSettings.fullscreen) {
                                updateReaderSettings({ fullscreen: false });
                            }
                        } else {
                            updateReaderSettings({ fullscreen: true });
                        }
                    }}
                    onPresent={isPdfFormat ? startPresentation : undefined}
                    onPrint={isPdfFormat && !isTauriMobile() ? () => { void handlePrint(); } : undefined}
                    immersionMode={immersionMode}
                    onToggleImmersion={!isPdfFormat ? () => {
                        if (!ttsEnabled && immersionUsesTts(bookImmersionSource)) {
                            updateTtsSettings({ enabled: true });
                        }
                        setImmersionMode(v => !v);
                    } : undefined}
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

            <div className="absolute inset-0 overflow-hidden z-0 isolate">
                {isPdfFormat ? (
                    <Suspense fallback={<div className="flex items-center justify-center h-full font-sans text-sm text-[color:var(--color-text-secondary)]">Loading PDF...</div>}>
                        {resolvedPdfPath || pdfData ? (
                            <PDFReader
                                key={activeDocId || 'pdf-doc'}
                                ref={pdfReaderRef}
                                pdfPath={resolvedPdfPath}
                                pdfData={pdfData ?? undefined}
                                originalFilename={currentBook?.title}
                                sourceFilename={currentBookSourceFilename}
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
                                onHistoryChange={handleHistoryChange}
                            />
                        ) : (
                            <div className="flex items-center justify-center h-full font-sans text-sm text-[color:var(--color-text-secondary)]">
                                Loading document...
                            </div>
                        )}
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
                        filenameHint={currentBookSourceFilename}
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
                            "fixed bottom-6 z-[var(--z-sticky)]",
                            isMobileViewport ? "left-4" : "left-8",
                            "flex items-center justify-center w-11 h-11 transition-[transform,opacity] duration-150 ease-out",
                            "bg-[var(--color-surface)] text-[color:var(--color-text-primary)] border border-[var(--color-border)]",
                            "hover:bg-[var(--color-surface-muted)]",
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
                        onAnnotationModeChange={setPdfAnnotationMode}
                        onHighlightColorChange={setPdfHighlightColor}
                        onPenColorChange={setPdfBrushColor}
                        className={cn(
                            "bottom-6 transition-[transform,opacity] duration-150 ease-out",
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
                                void (async () => {
                                    await engine.next();
                                    if (!readerUnmountedRef.current && typeof engine.getVisibleTextForTts === "function") {
                                        const result = engine.getVisibleTextForTts();
                                        if (result?.text) setSpeedReadText(result.text.replace(/\s+/g, " ").trim());
                                    }
                                })();
                            }
                        }}
                    />
                    
                    <ReaderNavbar
                        location={location}
                        toc={toc}
                        sectionFractions={sectionFractions}
                        onSeek={handleSeek}
                        totalPages={location?.pageInfo?.totalPages}
                        onToggleToc={() => togglePanel('toc')}
                        immersionMode={immersionMode && !audioTrack && !mediaOverlay}
                        ttsState={ttsState}
                        onTtsPlay={handleTtsPlay}
                        onTtsPause={handleTtsPause}
                        onTtsStop={handleTtsStop}
                        neuralReady={neuralReady}
                        showNeuralInstall={showNeuralInstall}
                        ttsVoice={settings.tts.voice}
                        ttsSpeed={settings.tts.speed}
                        onTtsVoiceChange={handleTtsVoiceChange}
                        onTtsSpeedChange={handleTtsSpeedChange}
                        onOpenNeuralSettings={handleOpenNeuralSettings}
                        onGenerateAudiobook={isTauriDesktop() && neuralReady && !audioTrack ? () => void handleGenerateAudiobook() : undefined}
                        audioGenProgress={audioGenProgress}
                        onCancelAudiobook={handleCancelAudiobook}
                        className={cn(
                            "fixed bottom-0 left-0 right-0 z-[var(--z-reader-bar)] transition-transform duration-150 ease-out",
                            immersionMode
                                ? shouldShowReaderChrome ? "translate-y-0" : "translate-y-full pointer-events-none"
                                : shouldShowReaderChrome ? "translate-y-0" : "translate-y-full pointer-events-none",
                        )}
                    />

                    {mediaOverlay && currentBook && (
                        <MediaOverlayBar
                            key={currentBook.id}
                            overlay={mediaOverlay}
                            onStart={() => readerRef.current?.startMediaOverlay?.() ?? Promise.resolve()}
                            bookTitle={currentBook.title}
                            bookAuthor={currentBook.author}
                            bookCover={currentBook.coverPath}
                            visible={shouldShowReaderChrome}
                            speed={settings.readerSettings.mediaOverlaySpeed ?? 1}
                            onSpeedChange={(rate) => updateReaderSettings({ mediaOverlaySpeed: rate })}
                            onPlayingChange={setIsExternalNarrationPlaying}
                            onClose={() => setImmersionMode(false)}
                        />
                    )}

                    {immersionMode && audioTrack && (
                        <AudiobookBar
                            key={currentBook.id}
                            bookId={currentBook.id}
                            bookTitle={currentBook.title}
                            bookAuthor={currentBook.author}
                            audioTrack={audioTrack}
                            visible={shouldShowReaderChrome}
                            replacesBookNarration={!!bookMediaOverlay}
                            onPlayingChange={setIsExternalNarrationPlaying}
                            onClose={() => setImmersionMode(false)}
                        />
                    )}
                </>
            )}

            <TableOfContents
                toc={toc}
                visible={activePanel === 'toc'}
                onClose={() => setActivePanel(null)}
                onNavigate={goTo}
                currentHref={isPdfFormat ? activePdfTocHref : location?.tocItem?.href}
                isPdf={isPdfFormat}
                pdfHasOutline={pdfHasOutline}
                pdfPages={pdfPagesNav}
            />

            <ReaderAnnotationsPanel
                bookId={activeDocId || ''}
                visible={activePanel === 'bookmarks'}
                onClose={() => setActivePanel(null)}
                onNavigate={(location, annotation) => {
                    if (annotation) {
                        goToAnnotation(annotation);
                    } else {
                        goTo(location);
                    }
                }}
                onDelete={(id) => {
                    if (isPdfFormat) {
                        handlePdfAnnotationRemove(id);
                        return;
                    }
                    readerRef.current?.removeHighlight?.(id);
                    removeAnnotation(id);
                    setAnnotations((previousAnnotations) =>
                        previousAnnotations.filter((annotation) => annotation.id !== id)
                    );
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
                onSaveAttachment={handleSaveAttachment}
            />

            <ReaderSearch
                visible={activePanel === 'search'}
                onClose={() => setActivePanel(null)}
                onNavigate={goTo}
                onSearch={(q, options) => {
                    if (isPdfFormat) {
                        return pdfReaderRef.current?.search(q, options) || (async function* () {
                            yield 'done' as const;
                        })();
                    }
                    return readerRef.current?.search(q, options) || (async function* () {
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

            {isPdfFormat && pdfSelection && !showColorPicker && (
                <PdfSelectionBubble selection={pdfSelection} onDefine={handlePdfDefine} onCopy={handlePdfCopy} />
            )}
            {isPdfFormat && colorPickerMode === "dictionary" && (
                <HighlightColorPicker
                    isOpen={showColorPicker}
                    position={colorPickerPosition}
                    onSelectColor={() => {}}
                    onAddNote={() => {}}
                    onBookmark={() => {}}
                    viewportPadding={colorPickerViewportPadding}
                    dictionary={{ ...dictionaryView, onBack: closeDictionaryPicker }}
                    onClose={closeDictionaryPicker}
                />
            )}

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
                        dictionary={colorPickerMode === "dictionary" ? dictionaryView : undefined}
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
