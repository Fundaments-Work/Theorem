import { useCallback, useEffect, useRef, useState } from "react";
import { buildFallbackCoverSvg, shouldUseExtractedAuthor, shouldUseExtractedTitle } from "../../../core/lib/cover-extractor";
import { showOpenDirectoryDialog } from "../../../core/lib/dialogs";
import { isMobile, isTauri } from "../../../core/lib/env";
import { describeFolderImport, importFolder, type FolderImportDeps, type FolderImportProgress } from "../../../core/lib/folder-import";
import { ensureFilenameForFormat, extractFilenameFromPath, pickAndImportBooksIncremental, scanBookFolder } from "../../../core/lib/import";
import { pickLibraryFolderMobile, scanLibraryFolderMobileDetailed } from "../../../core/lib/mobile-folder-scan";
import { getBookData, saveCoverImage } from "../../../core/lib/storage";
import { normalizeFilePath } from "../../../core/lib/utils";
import { useLibraryStore } from "../../../core/store";
import type { AppSettings, Book } from "../../../core/types";
import { normalizeMetadataText } from "../components/BookCard";

type ExtractMetadataFn = typeof import("../../../core/lib/cover-extractor").extractMetadata;

const IMPORT_METADATA_TIMEOUT_MS = isMobile() ? 9000 : 6000;
const IMPORT_COVER_TIMEOUT_MS = isMobile() ? 7000 : 4000;
const IMPORT_METADATA_QUEUE_CONCURRENCY = isMobile() ? 1 : 3;
let extractMetadataPromise: Promise<ExtractMetadataFn> | null = null;

async function getExtractMetadataFn(): Promise<ExtractMetadataFn> {
    if (!extractMetadataPromise) {
        extractMetadataPromise = import("../../../core/lib/cover-extractor").then(
            (module) => module.extractMetadata,
        );
    }
    return extractMetadataPromise;
}

export interface UseLibraryImportAndMetadataParams {
    books: Book[];
    coversHydrated: boolean;
    settings: AppSettings;
    addBook: (book: Book) => void;
    updateBook: (bookId: string, updates: Partial<Book>) => void;
    updateSettings: (updates: Partial<AppSettings>) => void;
    setLastScannedAt: (date: Date) => void;
    setAlertInfo: (info: { title: string; message: string } | null) => void;
    onPreservedFolderImported: (root: string) => void;
}

export function useLibraryImportAndMetadata({
    books,
    coversHydrated,
    settings,
    addBook,
    updateBook,
    updateSettings,
    setLastScannedAt,
    setAlertInfo,
    onPreservedFolderImported,
}: UseLibraryImportAndMetadataParams) {
    const [isImporting, setIsImporting] = useState(false);
    const importInProgress = useRef(false);
    const [isScanning, setIsScanning] = useState(false);
    const scanInProgress = useRef(false);
    const [folderImportProgress, setFolderImportProgress] = useState<FolderImportProgress | null>(null);
    const folderImportAbort = useRef<AbortController | null>(null);
    const [stoppingFolderImport, setStoppingFolderImport] = useState(false);
    const [showFolderImport, setShowFolderImport] = useState(false);

    const isExtractingCoversRef = useRef(false);
    const isUnmountedRef = useRef(false);
    const latestBooksRef = useRef(books);
    latestBooksRef.current = books;

    useEffect(() => {
        isUnmountedRef.current = false;
        return () => {
            isUnmountedRef.current = true;
        };
    }, []);

    const extractedBookIdsRef = useRef<Set<string>>(new Set());
    const pendingImportMetadataQueueRef = useRef<Book[]>([]);
    const queuedImportMetadataIdsRef = useRef<Set<string>>(new Set());
    const activeImportMetadataTasksRef = useRef(0);

    const performImportedBookMetadataExtraction = useCallback(async (book: Book) => {
        const latestBook = useLibraryStore
            .getState()
            .getBook(book.id) ?? book;

        if (latestBook.coverExtractionDone && latestBook.coverPath) {
            return;
        }

        try {
            const extractMetadata = await getExtractMetadataFn();
            let data: ArrayBuffer | null = null;
            const isContentUri = latestBook.filePath.startsWith("content://");
            const hasOriginalFilePath = (
                !latestBook.filePath.startsWith("browser://")
                && !latestBook.filePath.startsWith("idb://")
                && !latestBook.filePath.startsWith("sqlite://")
                && !isContentUri
            );

            if (hasOriginalFilePath) {
                data = await getBookData("", latestBook.filePath);
            }

            if (!data) {
                const storagePath = latestBook.storagePath || latestBook.filePath;
                data = await getBookData(latestBook.id, storagePath);
            }

            if (!data) {
                if (!latestBook.coverPath) {
                    const fallbackSvg = buildFallbackCoverSvg(
                        latestBook.title,
                        latestBook.author || "Unknown Author",
                    );
                    const blob = new Blob([fallbackSvg], { type: "image/svg+xml" });
                    const dataUrl = await saveCoverImage(latestBook.id, blob);
                    updateBook(latestBook.id, {
                        coverPath: dataUrl,
                        coverExtractionDone: true,
                    });
                }
                return;
            }

            const filename = ensureFilenameForFormat(
                extractFilenameFromPath(latestBook.filePath),
                latestBook.format,
            );
            const metadata = await extractMetadata(
                data,
                latestBook.format,
                filename,
                latestBook.id,
                {
                    metadataTimeoutMs: IMPORT_METADATA_TIMEOUT_MS,
                    coverTimeoutMs: IMPORT_COVER_TIMEOUT_MS,
                    allowFallbackCover: true,
                },
            );

            const updates: Partial<Book> = {};

            if (metadata.coverDataUrl) {
                updates.coverPath = metadata.coverDataUrl;
            }

            const shouldUpdateTitle = shouldUseExtractedTitle(latestBook.title, metadata.title, latestBook.filePath);
            if (shouldUpdateTitle) {
                updates.title = normalizeMetadataText(metadata.title);
            }

            const shouldUpdateAuthor = shouldUseExtractedAuthor(latestBook.author, metadata.author);
            if (shouldUpdateAuthor) {
                updates.author = normalizeMetadataText(metadata.author);
            }

            if (metadata.description && !latestBook.description) {
                updates.description = metadata.description;
            }
            if (metadata.publisher && !latestBook.publisher) {
                updates.publisher = metadata.publisher;
            }
            if (metadata.language && !latestBook.language) {
                updates.language = metadata.language;
            }
            if (metadata.publishedDate && !latestBook.publishedDate) {
                updates.publishedDate = metadata.publishedDate;
            }
            if (metadata.series && !latestBook.series) {
                updates.series = metadata.series;
            }
            if (metadata.seriesIndex !== undefined && latestBook.seriesIndex === undefined) {
                updates.seriesIndex = metadata.seriesIndex;
            }

            const hasUsefulMetadataUpdate = (
                Boolean(metadata.coverDataUrl)
                || shouldUpdateTitle
                || shouldUpdateAuthor
                || Boolean(metadata.description && !latestBook.description)
                || Boolean(metadata.publisher && !latestBook.publisher)
                || Boolean(metadata.language && !latestBook.language)
                || Boolean(metadata.publishedDate && !latestBook.publishedDate)
                || Boolean(metadata.series && !latestBook.series)
                || Boolean(metadata.seriesIndex !== undefined && latestBook.seriesIndex === undefined)
            );

            if (hasUsefulMetadataUpdate) {
                updates.coverExtractionDone = true;
            }

            if (Object.keys(updates).length > 0) {
                updateBook(latestBook.id, updates);
            }
        } catch {
        }
    }, [updateBook]);

    const pumpImportMetadataQueue = useCallback(() => {
        while (
            activeImportMetadataTasksRef.current < IMPORT_METADATA_QUEUE_CONCURRENCY
            && pendingImportMetadataQueueRef.current.length > 0
        ) {
            const nextBook = pendingImportMetadataQueueRef.current.pop();
            if (!nextBook) {
                break;
            }

            if (extractedBookIdsRef.current.has(nextBook.id)) {
                continue;
            }

            activeImportMetadataTasksRef.current += 1;
            extractedBookIdsRef.current.add(nextBook.id);

            void performImportedBookMetadataExtraction(nextBook)
                .catch(e => console.error("[catch]", e))
                .finally(() => {
                    activeImportMetadataTasksRef.current = Math.max(0, activeImportMetadataTasksRef.current - 1);
                    extractedBookIdsRef.current.delete(nextBook.id);
                    queuedImportMetadataIdsRef.current.delete(nextBook.id);
                    if (pendingImportMetadataQueueRef.current.length > 0) {
                        pumpImportMetadataQueue();
                    }
                });
        }
    }, [performImportedBookMetadataExtraction]);

    const extractImportedBookMetadata = useCallback((book: Book) => {
        if (
            book.coverExtractionDone
            || queuedImportMetadataIdsRef.current.has(book.id)
            || extractedBookIdsRef.current.has(book.id)
        ) {
            return;
        }

        queuedImportMetadataIdsRef.current.add(book.id);
        pendingImportMetadataQueueRef.current.push(book);
        pumpImportMetadataQueue();
    }, [pumpImportMetadataQueue]);

    useEffect(() => {
        if (!coversHydrated || isExtractingCoversRef.current || books.length === 0) {
            return;
        }

        const knownBookIds = new Set(books.map((book) => book.id));
        extractedBookIdsRef.current.forEach((bookId) => {
            if (!knownBookIds.has(bookId)) {
                extractedBookIdsRef.current.delete(bookId);
            }
        });

        const hasPendingFallback = books.some(
            (book) =>
                !book.coverPath
                && !extractedBookIdsRef.current.has(book.id)
                && !book.syncedWithoutFile,
        );

        if (!hasPendingFallback) {
            return;
        }

        const generateFallbacks = async () => {
            isExtractingCoversRef.current = true;

            try {
                const extractMetadata = await getExtractMetadataFn();

                while (!isUnmountedRef.current) {
                    const batch = latestBooksRef.current.filter(
                        (book) =>
                            !book.coverPath
                            && !extractedBookIdsRef.current.has(book.id)
                            && !book.syncedWithoutFile,
                    );
                    if (batch.length === 0) {
                        break;
                    }

                    for (const book of batch) {
                        if (isUnmountedRef.current) break;
                        extractedBookIdsRef.current.add(book.id);

                        try {
                            const isContentUri = book.filePath.startsWith("content://");
                            const hasOriginalFilePath = (
                                !book.filePath.startsWith("browser://")
                                && !book.filePath.startsWith("idb://")
                                && !book.filePath.startsWith("sqlite://")
                                && !isContentUri
                            );

                            let data: ArrayBuffer | null = null;
                            if (hasOriginalFilePath) {
                                data = await getBookData("", book.filePath);
                            }
                            if (!data) {
                                const storagePath = book.storagePath || book.filePath;
                                data = await getBookData(book.id, storagePath);
                            }

                            if (data) {
                                const filename = ensureFilenameForFormat(
                                    extractFilenameFromPath(book.filePath),
                                    book.format,
                                );
                                const metadata = await extractMetadata(
                                    data,
                                    book.format,
                                    filename,
                                    book.id,
                                    { allowFallbackCover: true },
                                );
                                const updates: Partial<Book> = {};
                                if (metadata.coverDataUrl) {
                                    updates.coverPath = metadata.coverDataUrl;
                                }

                                if (shouldUseExtractedTitle(book.title, metadata.title, book.filePath)) {
                                    updates.title = normalizeMetadataText(metadata.title);
                                }
                                if (metadata.author && !book.author) {
                                    updates.author = metadata.author;
                                }
                                if (metadata.description && !book.description) {
                                    updates.description = metadata.description;
                                }
                                if (metadata.publisher && !book.publisher) {
                                    updates.publisher = metadata.publisher;
                                }
                                if (metadata.language && !book.language) {
                                    updates.language = metadata.language;
                                }
                                if (metadata.publishedDate && !book.publishedDate) {
                                    updates.publishedDate = metadata.publishedDate;
                                }

                                const hasAnyUpdate = (
                                    Boolean(metadata.coverDataUrl)
                                    || updates.title !== undefined
                                    || updates.author !== undefined
                                    || updates.description !== undefined
                                    || updates.publisher !== undefined
                                    || updates.language !== undefined
                                    || updates.publishedDate !== undefined
                                );

                                if (hasAnyUpdate) {
                                    updates.coverExtractionDone = true;
                                    if (!isUnmountedRef.current) updateBook(book.id, updates);
                                }
                            } else {
                                const fallbackSvg = buildFallbackCoverSvg(
                                    book.title,
                                    book.author || "Unknown Author",
                                );
                                const blob = new Blob([fallbackSvg], { type: "image/svg+xml" });
                                const dataUrl = await saveCoverImage(book.id, blob);
                                if (!isUnmountedRef.current) {
                                    updateBook(book.id, {
                                        coverPath: dataUrl,
                                        coverExtractionDone: true,
                                    });
                                }
                            }
                        } catch {
                            // Keep this book in extractedBookIdsRef so a failing asset doesn't loop forever.
                        }
                    }
                }
            } finally {
                isExtractingCoversRef.current = false;
            }
        };

        void generateFallbacks();
    }, [coversHydrated, books, updateBook]);

    const handleAddBooks = useCallback(async () => {
        if (scanInProgress.current || importInProgress.current) return;
        importInProgress.current = true;
        setIsImporting(true);
        const failedImports: Array<{ source: string; message: string }> = [];
        try {
            const importBooks = isTauri()
                ? (await import("../../../core/lib/native-import-jobs")).pickAndImportNativeJob
                : pickAndImportBooksIncremental;
            await importBooks(
                (book) => {
                    addBook(book);
                    void extractImportedBookMetadata(book);
                },
                (source, error) => {
                    failedImports.push({
                        source,
                        message: error instanceof Error ? error.message : String(error),
                    });
                },
            );
        } catch (err) {
            failedImports.push({ source: "Import", message: err instanceof Error ? err.message : String(err) });
        } finally {
            importInProgress.current = false;
            setIsImporting(false);
        }
        if (failedImports.length > 0) {
            const preview = failedImports
                .slice(0, 3)
                .map((failure) => `- ${failure.source}: ${failure.message}`)
                .join("\n");
            setAlertInfo({
                title: "Import Errors",
                message: `Some books failed to import (${failedImports.length}).\n\n${preview}` +
                    (failedImports.length > 3 ? `\n\n(+${failedImports.length - 3} more)` : ""),
            });
        }
    }, [addBook, extractImportedBookMetadata, setAlertInfo]);

    const runFolderImport = useCallback(async (root: string, preserve: boolean, scan: FolderImportDeps["scan"]) => {
        const controller = new AbortController();
        folderImportAbort.current = controller;
        setStoppingFolderImport(false);
        try {
            const result = await importFolder(root, preserve, {
                scan,
                importBooks: async (paths, onBook, onFailure, options) => {
                    const { importBooksIncremental } = await import("../../../core/lib/import");
                    return importBooksIncremental(paths, onBook, onFailure, { ...options, durable: true });
                },
                getBooks: () => useLibraryStore.getState().books,
                addBooks: (batch) => useLibraryStore.getState().addBooks(batch),
                updateBooks: (updates) => useLibraryStore.getState().updateBooks(updates),
                onBooksAdded: (batch) => {
                    for (const book of batch) void extractImportedBookMetadata(book);
                },
                onProgress: (progress) => setFolderImportProgress(progress.phase === "scanning" ? progress : null),
            }, controller.signal);
            if (!result.cancelled) setLastScannedAt(new Date());
            if (preserve && result.imported + result.alreadyInLibrary > 0) {
                onPreservedFolderImported(root);
            }
            const summary = describeFolderImport(result);
            if (summary) setAlertInfo(summary);
        } finally {
            folderImportAbort.current = null;
            setFolderImportProgress(null);
            setStoppingFolderImport(false);
        }
    }, [extractImportedBookMetadata, onPreservedFolderImported, setAlertInfo, setLastScannedAt]);

    const stopFolderImport = useCallback(() => {
        setStoppingFolderImport(true);
        folderImportAbort.current?.abort();
    }, []);

    const handleScanFolder = useCallback(async (preserve: boolean) => {
        if (scanInProgress.current || isImporting) return;
        if (!isTauri()) {
            setAlertInfo({ title: "Not Available", message: "Folder scanning requires the desktop app." });
            return;
        }

        scanInProgress.current = true;
        setIsScanning(true);
        try {
            if (isMobile()) {
                const pickedFolder = await pickLibraryFolderMobile();
                if (!pickedFolder) {
                    setIsScanning(false);
                    return;
                }

                const prevScanFolders = settings.scanFolders;
                const nextFolders = prevScanFolders.includes(pickedFolder)
                    ? prevScanFolders
                    : [...prevScanFolders, pickedFolder];
                updateSettings({ scanFolders: nextFolders });

                try {
                    await runFolderImport(pickedFolder, preserve, (root) => scanLibraryFolderMobileDetailed(root));
                } catch (err) {
                    updateSettings({ scanFolders: prevScanFolders });
                    throw err;
                }
                return;
            }

            const defaultDesktopFolder = settings.scanFolders[0]?.startsWith("content://")
                ? undefined
                : settings.scanFolders[0] || undefined;
            const selectedFolder = await showOpenDirectoryDialog({
                title: "Scan Library Folder",
                defaultPath: defaultDesktopFolder,
            });
            if (!selectedFolder) {
                return;
            }

            const normalizedFolderPath = normalizeFilePath(selectedFolder);
            if (!normalizedFolderPath) {
                return;
            }

            const nextFolders = settings.scanFolders.includes(normalizedFolderPath)
                ? settings.scanFolders
                : [...settings.scanFolders, normalizedFolderPath];
            updateSettings({ scanFolders: nextFolders });

            setIsScanning(true);
            await runFolderImport(normalizedFolderPath, preserve, (root, signal) => scanBookFolder(root, signal));
        } catch (err) {
            setAlertInfo({ title: "Scan Error", message: err instanceof Error ? err.message : "Failed to scan selected folder." });
        } finally {
            scanInProgress.current = false;
            setIsScanning(false);
        }
    }, [
        isImporting,
        runFolderImport,
        setAlertInfo,
        settings.scanFolders,
        updateSettings,
    ]);

    return {
        isImporting,
        isScanning,
        folderImportProgress,
        stoppingFolderImport,
        showFolderImport,
        setShowFolderImport,
        handleAddBooks,
        handleScanFolder,
        stopFolderImport,
    };
}
