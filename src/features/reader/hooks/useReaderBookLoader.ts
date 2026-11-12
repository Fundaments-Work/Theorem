import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { toast } from "sonner";
import { loadBookLocations } from "../../../core/lib/book-locations";
import { isTauri } from "../../../core/lib/env";
import { ensureFilenameForFormat, extractFilenameFromPath } from "../../../core/lib/import";
import { openNativeRangeFile, type BookSource } from "../../../core/lib/native-range-file";
import { getBookBlob, getBookData, getBookMaterializedPath } from "../../../core/lib/storage";
import { useLibraryStore, useRssStore, useUIStore } from "../../../core/store";
import type { AppRoute, Book, DocLocation, DocMetadata, PdfZoomMode, RssArticle, TocItem } from "../../../core/types";
import {
    DEFAULT_PDF_ZOOM,
    DEFAULT_PDF_ZOOM_MODE,
    getMimeTypeForBookFormat,
    normalizeInitialReaderLocation,
    RANGE_READ_FORMATS,
    resolvePdfTargetPage,
} from "../lib/reader-page-helpers";

export interface UseReaderBookLoaderParams {
    activeDocId: string | null;
    currentBookId?: string;
    currentArticle: RssArticle | null | undefined;
    loadAttempt: number;
    setLoadAttempt: Dispatch<SetStateAction<number>>;
    getBook: (bookId: string) => Book | undefined;
    updateBook: (bookId: string, updates: Partial<Book>) => void;
    setRoute: (route: AppRoute) => void;
    readerZoomValue: number;
    readerZoomRef: MutableRefObject<number>;
    loadedBookIdRef: MutableRefObject<string | null>;
    suppressProgressRef: MutableRefObject<boolean>;
    resumeTargetRef: MutableRefObject<string | null>;
    resumeTimeoutRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;
    hasAppliedInitialLocationRef: MutableRefObject<boolean>;
    setShowToolbar: Dispatch<SetStateAction<boolean>>;
    setTtsData: Dispatch<SetStateAction<{ text: string; startWordId: string } | null>>;
    setFile: Dispatch<SetStateAction<BookSource | null>>;
    setPdfData: Dispatch<SetStateAction<Uint8Array | null>>;
    setPdfCurrentPage: Dispatch<SetStateAction<number>>;
    setPdfTotalPages: Dispatch<SetStateAction<number>>;
    setPdfZoom: Dispatch<SetStateAction<number>>;
    setPdfZoomMode: Dispatch<SetStateAction<PdfZoomMode>>;
    setPdfPresentationMode: Dispatch<SetStateAction<"scroll" | "paged" | "two-page">>;
    setPdfInitialPage: Dispatch<SetStateAction<number>>;
    setPdfInitialZoom: Dispatch<SetStateAction<number>>;
    setPdfInitialZoomMode: Dispatch<SetStateAction<PdfZoomMode>>;
    setResolvedPdfPath: Dispatch<SetStateAction<string>>;
    setResolvedNativePath: Dispatch<SetStateAction<string>>;
    setIsPresentationFullscreen: Dispatch<SetStateAction<boolean>>;
    setPdfHasOutline: Dispatch<SetStateAction<boolean>>;
    setMetadata: Dispatch<SetStateAction<DocMetadata | null>>;
    setToc: Dispatch<SetStateAction<TocItem[]>>;
    setLocation: Dispatch<SetStateAction<DocLocation | null>>;
    setIsBookReady: Dispatch<SetStateAction<boolean>>;
    setInitialLocation: Dispatch<SetStateAction<string | undefined>>;
    setInitialFraction: Dispatch<SetStateAction<number | undefined>>;
    setLoadError: Dispatch<SetStateAction<string | null>>;
}

export function useReaderBookLoader({
    activeDocId,
    currentBookId,
    currentArticle,
    loadAttempt,
    setLoadAttempt,
    getBook,
    updateBook,
    setRoute,
    readerZoomValue,
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
}: UseReaderBookLoaderParams): void {
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
        readerZoomRef.current = readerZoomValue;

        let isCancelled = false;

        const loadBook = async () => {
            if (!currentBookId && currentArticle) {
                setPdfData(null);
                setResolvedPdfPath("");
                const currentFeeds = useRssStore.getState().feeds;
                setMetadata({
                    title: currentArticle.title || "Untitled Article",
                    author: currentArticle.author || (currentFeeds.find(f => f.id === currentArticle.feedId)?.title) || "RSS Feed",
                });
                setToc([]);
                setLocation(null);
                setIsBookReady(false);
                const pendingLocation = useUIStore.getState().pendingReaderLocation;
                if (pendingLocation) {
                    useUIStore.getState().setPendingReaderLocation(undefined);
                }
                const nextLocation = normalizeInitialReaderLocation(pendingLocation);
                setInitialLocation(nextLocation);
                setInitialFraction(undefined);
                suppressProgressRef.current = !!nextLocation;
                resumeTargetRef.current = nextLocation || null;
                hasAppliedInitialLocationRef.current = !nextLocation;
                setLoadError(null);

                try {
                    const feedTitle = currentFeeds.find((feed) => feed.id === currentArticle.feedId)?.title;
                    const { convertArticleToEpubBlob } = await import("../../../core/lib/rss-epub");

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

                    const epubBlob = await convertArticleToEpubBlob(articleToRender, feedTitle);
                    setFile(epubBlob);
                } catch (err) {
                    if (!isCancelled) {
                        setLoadError(err instanceof Error ? err.message : "Error preparing article");
                        loadedBookIdRef.current = null;
                    }
                }
                return;
            }

            let book = currentBookId ? getBook(currentBookId) : null;
            if (!book) {
                setLoadError("Book not found in library");
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
                if (isTauri()) {
                    const localPath = await getBookMaterializedPath(book.id, book.storagePath);
                    if (localPath) {
                        updateBook(book.id, {
                            syncedWithoutFile: false,
                            filePath: localPath,
                            storagePath: localPath,
                        });
                        book = {
                            ...book,
                            syncedWithoutFile: false,
                            filePath: localPath,
                            storagePath: localPath,
                        };
                    }
                }
            }

            if (book.syncedWithoutFile && currentBookId) {
                const state = useUIStore.getState();
                const downloadId = book.id;
                if (state.downloadingBookId !== downloadId) {
                    state.setDownloadingBook(downloadId);
                    import("../../../core/lib/sync-orchestrator").then(({ downloadBookOnDemand }) => {
                        downloadBookOnDemand(downloadId).catch(() => {});
                    });
                }

                const DOWNLOAD_TIMEOUT_MS = 120_000;
                const startTime = Date.now();
                while (book.syncedWithoutFile) {
                    if (Date.now() - startTime > DOWNLOAD_TIMEOUT_MS) {
                        setLoadError("Book download timed out. The file may not be available on any paired device. You can try reopening later.");
                        loadedBookIdRef.current = null;
                        useUIStore.getState().setDownloadingBook(undefined);
                        return;
                    }
                    await new Promise<void>(r => setTimeout(r, 200));
                    if (isCancelled) return;
                    const current = getBook(currentBookId);
                    if (!current) return;
                    book = current;
                    if (!useUIStore.getState().downloadingBookId && book.syncedWithoutFile) {
                        setLoadError("This book was synced from another device, but its file could not be downloaded. Try pairing with the source device or reopening later.");
                        loadedBookIdRef.current = null;
                        return;
                    }
                }
            }
            if (!book) {
                setLoadError("Book not found in library");
                loadedBookIdRef.current = null;
                return;
            }

            setFile(null);
            setPdfData(null);
            setPdfCurrentPage(1);
            setPdfTotalPages(0);
            setPdfZoom(DEFAULT_PDF_ZOOM);
            setPdfZoomMode(DEFAULT_PDF_ZOOM_MODE);
            setPdfPresentationMode("scroll");
            setPdfInitialPage(1);
            setPdfInitialZoom(DEFAULT_PDF_ZOOM);
            setPdfInitialZoomMode(DEFAULT_PDF_ZOOM_MODE);
            setResolvedPdfPath("");
            setResolvedNativePath("");
            setIsPresentationFullscreen(false);
            setPdfHasOutline(false);
            setMetadata(null);
            setToc([]);
            setLocation(null);
            setIsBookReady(false);
            // A one-shot target set when opening a bookmark/annotation from a
            // list. Consume it so we land on the exact location instead of the
            // book's last-read position.
            const pendingLocation = useUIStore.getState().pendingReaderLocation;
            if (pendingLocation) {
                useUIStore.getState().setPendingReaderLocation(undefined);
            }
            if (book.format === "pdf") {
                const pendingTargetPage = pendingLocation ? resolvePdfTargetPage(pendingLocation) : null;
                const savedPdfState = book.pdfViewState;
                const fallbackPage = resolvePdfTargetPage(book.currentLocation || "") ?? 1;
                const nextInitialPage = Math.max(
                    1,
                    Math.floor(pendingTargetPage ?? savedPdfState?.page ?? fallbackPage),
                );
                const nextInitialZoom = Math.max(
                    0.25,
                    Math.min(
                        5,
                        savedPdfState?.zoom ?? DEFAULT_PDF_ZOOM,
                    ),
                );
                const nextInitialZoomMode = savedPdfState?.zoomMode ?? DEFAULT_PDF_ZOOM_MODE;
                const nextPresentationMode = savedPdfState?.presentationMode ?? "scroll";

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
                const nextLocation = normalizeInitialReaderLocation(pendingLocation || book.currentLocation);
                setInitialLocation(nextLocation);

                const progressFallback = book.progress !== undefined && book.progress > 0 && book.progress < 1 ? book.progress : undefined;
                const fractionToUse = book.lastClickFraction ?? progressFallback;
                setInitialFraction(fractionToUse);
                suppressProgressRef.current = !!nextLocation || fractionToUse !== undefined;
                resumeTargetRef.current = nextLocation || null;
                hasAppliedInitialLocationRef.current = false;
            }
            if (resumeTimeoutRef.current) {
                clearTimeout(resumeTimeoutRef.current);
                // A cleared id left here blocked the next resume's timer, so
                // its suppression could never end.
                resumeTimeoutRef.current = null;
            }
            setLoadError(null);

            try {
                const storagePath = book.storagePath || book.filePath;

                if (book.format === "pdf") {
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
                        if (book.syncedWithoutFile) {
                            useUIStore.getState().setDownloadingBook(book.id);
                            const { downloadBookOnDemand } = await import("../../../core/lib/sync-orchestrator");
                            const downloaded = await downloadBookOnDemand(book.id);
                            if (downloaded && !isCancelled) {
                                loadedBookIdRef.current = null;
                                setLoadAttempt(v => v + 1);
                                return;
                            }
                            throw new Error("This book was synced from another device, but its file could not be downloaded. Try pairing with the source device or reopening later.");
                        }
                        throw new Error("Book file not found. The file may have been moved, renamed, or deleted from disk.");
                    }
                    setResolvedPdfPath("");
                    setPdfData(new Uint8Array(data));
                    return;
                }

                if (isTauri()) {
                    const materializedPath = await getBookMaterializedPath(book.id, storagePath);
                    if (materializedPath && !isCancelled) {
                        setResolvedNativePath(materializedPath);
                        // Zip-based books: read ranges from disk instead of loading
                        // the whole file into the WebView heap.
                        if (RANGE_READ_FORMATS.has(book.format)) {
                            const rangeFile = await openNativeRangeFile(
                                materializedPath,
                                ensureFilenameForFormat(extractFilenameFromPath(book.filePath), book.format),
                                getMimeTypeForBookFormat(book.format),
                            );
                            if (isCancelled) return;
                            if (rangeFile) {
                                setFile(rangeFile);
                                return;
                            }
                        }
                    }
                }

                const blob = await getBookBlob(book.id, storagePath);
                if (isCancelled) return;
                if (!blob) {
                    if (book.syncedWithoutFile) {
                        useUIStore.getState().setDownloadingBook(book.id);
                        const { downloadBookOnDemand } = await import("../../../core/lib/sync-orchestrator");
                        const downloaded = await downloadBookOnDemand(book.id);
                        if (downloaded && !isCancelled) {
                            loadedBookIdRef.current = null;
                            setLoadAttempt(v => v + 1);
                            return;
                        }
                        const currentBookStillExists = useLibraryStore.getState().getBook(book.id);
                        if (!currentBookStillExists) {
                            toast.info("This book was deleted on the source device.");
                            setRoute("library");
                            return;
                        }
                        throw new Error("This book was synced from another device, but its file could not be downloaded. Try pairing with the source device or reopening later.");
                    }
                    throw new Error("Book file not found. The file may have been moved, renamed, or deleted from disk.");
                }
                const expectedMimeType = getMimeTypeForBookFormat(book.format);

                const typedBlob = blob.type === expectedMimeType
                    ? blob
                    : blob.slice(0, blob.size, expectedMimeType);
                setFile(typedBlob);
            } catch (err) {
                if (!isCancelled) {
                    const msg = err instanceof Error ? err.message : "Unknown error loading book";
                    if (msg.includes("PEER_BOOK_DELETED")) {
                        if (currentBookId) {
                            useLibraryStore.getState().removeBook(currentBookId);
                        }
                        toast.info("This book was deleted on the source device.");
                        setRoute("library");
                        return;
                    }
                    setLoadError(msg);
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
}
