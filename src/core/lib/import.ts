
import type { Book, BookFormat } from '../types';
import { v4 as uuidv4 } from 'uuid';
import { isTauri, isMobile } from './env';
import { saveBookData, getBookData } from './storage';
import { normalizeFilePath, safeDecodeURIComponent } from './utils';
import { invoke } from '@tauri-apps/api/core';

let tauriDialog: typeof import('@tauri-apps/plugin-dialog') | null = null;
let tauriFs: typeof import('@tauri-apps/plugin-fs') | null = null;

const DEFAULT_IMPORT_CONCURRENCY = 4;
const MAX_IMPORT_CONCURRENCY = 8;
const INSTANT_IMPORT_MODE = true;
const CONTENT_URI_READ_TIMEOUT_MS = 20000;
const IMPORT_ENTRY_TIMEOUT_MS = 90000;
const SUPPORTED_IMPORT_EXTENSIONS = ['epub', 'mobi', 'azw', 'azw3', 'fb2', 'fbz', 'fb2.zip', 'cbz', 'cbr', 'pdf'];
const SUPPORTED_IMPORT_SUFFIXES = SUPPORTED_IMPORT_EXTENSIONS.map((extension) => `.${extension}`);
const BROWSER_IMPORT_ACCEPT = SUPPORTED_IMPORT_SUFFIXES.join(',');
type ImportFailureHandler = (source: string, error: unknown) => void;

function getImportConcurrency(): number {
    if (isMobile()) {
        return 1;
    }

    const hardwareConcurrency = globalThis.navigator?.hardwareConcurrency;
    if (typeof hardwareConcurrency === 'number' && hardwareConcurrency > 0) {
        return Math.max(
            DEFAULT_IMPORT_CONCURRENCY,
            Math.min(MAX_IMPORT_CONCURRENCY, Math.floor(hardwareConcurrency / 2)),
        );
    }

    return DEFAULT_IMPORT_CONCURRENCY;
}

function arrayBufferToHex(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let hex = '';
    for (let index = 0; index < bytes.length; index += 1) {
        hex += bytes[index].toString(16).padStart(2, '0');
    }
    return hex;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
            reject(new Error(`[Import] Timeout while ${label} (${timeoutMs}ms)`));
        }, timeoutMs);

        promise
            .then((value) => {
                clearTimeout(timeoutId);
                resolve(value);
            })
            .catch((error) => {
                clearTimeout(timeoutId);
                reject(error);
            });
    });
}

async function computeContentHash(buffer: ArrayBuffer): Promise<string | undefined> {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) {
        return undefined;
    }

    try {
        const digest = await subtle.digest('SHA-256', buffer);
        return arrayBufferToHex(digest);
    } catch (error) {
        return undefined;
    }
}

async function runWithConcurrency<TInput, TOutput>(
    items: TInput[],
    concurrency: number,
    worker: (item: TInput, index: number) => Promise<TOutput>,
): Promise<TOutput[]> {
    if (items.length === 0) {
        return [];
    }

    const results: TOutput[] = new Array(items.length);
    let nextIndex = 0;

    const runWorker = async () => {
        while (nextIndex < items.length) {
            const currentIndex = nextIndex;
            nextIndex += 1;
            results[currentIndex] = await worker(items[currentIndex], currentIndex);
        }
    };

    const workerCount = Math.max(1, Math.min(concurrency, items.length));
    const workers = Array.from({ length: workerCount }, () => runWorker());
    await Promise.all(workers);
    return results;
}

function normalizeImportPath(filePath: string): string {
    return normalizeFilePath(filePath);
}

function normalizeFilenameCandidate(candidate: string): string | null {
    const decodedCandidate = safeDecodeURIComponent(candidate).trim();
    if (!decodedCandidate) {
        return null;
    }

    const withoutStoragePrefix = decodedCandidate.includes(':')
        ? decodedCandidate.slice(decodedCandidate.indexOf(':') + 1)
        : decodedCandidate;
    const basename = withoutStoragePrefix
        .replace(/\\/g, '/')
        .split('/')
        .filter(Boolean)
        .pop()
        ?.trim();

    if (!basename || basename === '.' || basename === '..') {
        return null;
    }

    return basename;
}

function hasKnownBookExtension(candidate: string): boolean {
    const lowerName = candidate.toLowerCase();
    return SUPPORTED_IMPORT_SUFFIXES.some((suffix) => lowerName.endsWith(suffix));
}

function defaultFilenameForFormat(format: BookFormat): string {
    switch (format) {
        case 'epub':
            return 'book.epub';
        case 'mobi':
            return 'book.mobi';
        case 'azw':
            return 'book.azw';
        case 'azw3':
            return 'book.azw3';
        case 'fb2':
            return 'book.fb2';
        case 'cbz':
            return 'book.cbz';
        case 'cbr':
            return 'book.cbr';
        case 'pdf':
            return 'book.pdf';
    }
}

export function ensureFilenameForFormat(filename: string | undefined, format: BookFormat): string {
    const normalizedCandidate = normalizeFilenameCandidate(filename || '');
    if (!normalizedCandidate) {
        return defaultFilenameForFormat(format);
    }

    if (hasKnownBookExtension(normalizedCandidate)) {
        return normalizedCandidate;
    }

    const hasGenericExtension = /\.[A-Za-z0-9]{1,10}$/.test(normalizedCandidate);
    if (hasGenericExtension) {
        return normalizedCandidate;
    }

    const fallbackName = defaultFilenameForFormat(format);
    const fallbackExtension = fallbackName.slice(fallbackName.lastIndexOf('.'));
    return `${normalizedCandidate}${fallbackExtension}`;
}

export function extractFilenameFromPath(filePath: string): string {
    const normalizedPath = normalizeImportPath(filePath);

    if (normalizedPath.startsWith('content://')) {
        try {
            const uri = new URL(normalizedPath);
            const directCandidates = [
                uri.searchParams.get('displayName'),
                uri.searchParams.get('_display_name'),
                uri.searchParams.get('name'),
                uri.searchParams.get('filename'),
            ];
            for (const value of directCandidates) {
                if (!value) {
                    continue;
                }
                const normalizedCandidate = normalizeFilenameCandidate(value);
                if (normalizedCandidate && hasKnownBookExtension(normalizedCandidate)) {
                    return normalizedCandidate;
                }
            }

            const encodedDocumentMatch = uri.pathname.match(/\/document\/(.+)$/);
            if (encodedDocumentMatch && encodedDocumentMatch[1]) {
                const documentId = safeDecodeURIComponent(encodedDocumentMatch[1]);
                const normalizedCandidate = normalizeFilenameCandidate(documentId);
                if (normalizedCandidate) {
                    return normalizedCandidate;
                }
            }

            const decodedPathname = safeDecodeURIComponent(uri.pathname);
            const decodedDocumentMatch = decodedPathname.match(/\/document\/(.+)$/);
            if (decodedDocumentMatch && decodedDocumentMatch[1]) {
                const normalizedCandidate = normalizeFilenameCandidate(decodedDocumentMatch[1]);
                if (normalizedCandidate) {
                    return normalizedCandidate;
                }
            }
        } catch {
            
        }
    }

    const fallbackFilename = normalizedPath.split(/[/\\]/).pop() || 'Unknown';
    const normalizedFallback = normalizeFilenameCandidate(fallbackFilename);
    if (normalizedFallback) {
        return normalizedFallback;
    }
    return safeDecodeURIComponent(fallbackFilename);
}

function isSupportedImportFilename(lowerName: string): boolean {
    return SUPPORTED_IMPORT_SUFFIXES.some((suffix) => lowerName.endsWith(suffix));
}

function normalizePathForFormatLookup(filePath: string): string {
    
    if (filePath.startsWith('content://')) {
        try {
            const uri = new URL(filePath);
            const nameParam = uri.searchParams.get('name') || 
                             uri.searchParams.get('displayName') ||
                             uri.searchParams.get('filename');
            if (nameParam) {
                return nameParam.toLowerCase();
            }
        } catch {
            
        }
    }
    
    const normalizedPath = normalizeImportPath(filePath);
    return normalizedPath.split(/[?#]/, 1)[0].toLowerCase();
}

function isZipSignature(bytes: Uint8Array): boolean {
    if (bytes.length < 4) {
        return false;
    }

    return bytes[0] === 0x50
        && bytes[1] === 0x4b
        && (
            (bytes[2] === 0x03 && bytes[3] === 0x04)
            || (bytes[2] === 0x05 && bytes[3] === 0x06)
            || (bytes[2] === 0x07 && bytes[3] === 0x08)
        );
}

function detectFormatFromBuffer(buffer: ArrayBuffer): BookFormat | null {
    const bytes = new Uint8Array(buffer);
    if (bytes.length === 0) {
        return null;
    }

    if (
        bytes.length >= 5
        && bytes[0] === 0x25
        && bytes[1] === 0x50
        && bytes[2] === 0x44
        && bytes[3] === 0x46
        && bytes[4] === 0x2d
    ) {
        return 'pdf';
    }

    if (bytes.length >= 68) {
        const mobiMagic = String.fromCharCode(...bytes.slice(60, 68));
        if (mobiMagic === 'BOOKMOBI') {
            return 'mobi';
        }
    }

    const textProbe = new TextDecoder().decode(bytes.slice(0, Math.min(bytes.length, 4096))).toLowerCase();
    if (textProbe.includes('<fictionbook')) {
        return 'fb2';
    }

    if (bytes.length >= 7 && bytes[0] === 0x52 && bytes[1] === 0x61
        && bytes[2] === 0x72 && bytes[3] === 0x21 && bytes[4] === 0x1A
        && bytes[5] === 0x07) {
        return 'cbr';
    }

    if (isZipSignature(bytes)) {
        
        const probeSize = Math.min(bytes.length, 524288); 
        const zipProbe = new TextDecoder().decode(bytes.slice(0, probeSize)).toLowerCase();
        
        const hasEpubMimetype = zipProbe.includes('application/epub+zip') || 
            zipProbe.includes('mimetypeapplication/epub+zip') || 
            zipProbe.includes(' mimetype'); 
        
        const hasEpubStructure = zipProbe.includes('meta-inf/container.xml') || 
            zipProbe.includes('.opf') ||
            zipProbe.includes('container.xml') ||
            zipProbe.includes('meta-inf/');
        
        if (hasEpubMimetype || hasEpubStructure) {
            return 'epub';
        }
        
        if (zipProbe.includes('.fb2') || zipProbe.includes('fictionbook')) {
            return 'fb2';
        }
        
        if (/\.(png|jpe?g|webp|gif|bmp|avif)/.test(zipProbe) && 
            !zipProbe.includes('.opf') && 
            !zipProbe.includes('container.xml') &&
            !zipProbe.includes('mimetype')) {
            return 'cbz';
        }
        
        return 'epub';
    }

    return null;
}

async function initTauriPlugins() {
    if (!isTauri()) {
        return null; 
    }

    if (!tauriDialog) {
        tauriDialog = await import('@tauri-apps/plugin-dialog');
    }
    if (!tauriFs) {
        tauriFs = await import('@tauri-apps/plugin-fs');
    }
    return { dialog: tauriDialog, fs: tauriFs };
}

export function getBookFormat(filePath: string): BookFormat | null {
    const lowerPath = normalizePathForFormatLookup(filePath);

    const filename = lowerPath.split(/[\\/]/).pop() || '';
    
    if (filename.endsWith('.fb2.zip') || lowerPath.endsWith('.fb2.zip')) return 'fb2';

    const extensions: [string, BookFormat][] = [
        ['.epub', 'epub'],
        ['.mobi', 'mobi'],
        ['.azw3', 'azw3'],
        ['.azw', 'azw'],
        ['.fb2', 'fb2'],
        ['.fbz', 'fb2'],
        ['.cbz', 'cbz'],
        ['.cbr', 'cbr'],
        ['.pdf', 'pdf'],
    ];

    for (const [ext, format] of extensions) {
        if (filename.endsWith(ext) || lowerPath.endsWith(ext)) {
            return format;
        }
    }

    let lastMatch: { ext: string; format: BookFormat; position: number } | null = null;
    
    for (const [ext, format] of extensions) {
        const position = filename.lastIndexOf(ext);
        if (position !== -1) {
            
            const afterExt = filename.substring(position + ext.length);
            if (afterExt === '' || afterExt.startsWith('.')) {
                if (!lastMatch || position > lastMatch.position) {
                    lastMatch = { ext, format, position };
                }
            }
        }
    }
    
    if (lastMatch) {
        return lastMatch.format;
    }

    return null;
}

export function isImportFormatSupported(_format: BookFormat): boolean {
    return true;
}

export async function pickBookFiles(): Promise<string[]> {
    const plugins = await initTauriPlugins();
    if (!plugins?.dialog) throw new Error('Dialog plugin not available');

    try {
        const selected = await plugins.dialog.open({
            multiple: true,
            pickerMode: 'document',
            
            fileAccessMode: 'scoped',
            filters: [
                {
                    name: 'All eBooks',
                    extensions: [
                        ...SUPPORTED_IMPORT_EXTENSIONS,
                        'application/epub+zip',
                        'application/x-mobipocket-ebook',
                        'application/x-fictionbook+xml',
                        'application/vnd.comicbook+zip',
                        'application/pdf',
                    ],
                },
                { name: 'EPUB', extensions: ['epub'] },
                { name: 'Kindle (MOBI/AZW)', extensions: ['mobi', 'azw', 'azw3'] },
                { name: 'FictionBook (FB2)', extensions: ['fb2', 'fbz', 'fb2.zip'] },
                { name: 'Comics (CBZ, CBR)', extensions: ['cbz', 'cbr'] },
                { name: 'PDF', extensions: ['pdf'] },
            ],
        });

        if (isMobile()) {
        }

        if (!selected) return [];
        const entries = (Array.isArray(selected) ? selected : [selected]) as unknown[];
        const paths: string[] = [];

        for (const entry of entries) {
            if (typeof entry === 'string') {
                
                if (entry.startsWith('content://')) {
                    paths.push(entry);
                } else {
                    paths.push(normalizeImportPath(entry));
                }
                continue;
            }

            if (entry && typeof entry === 'object') {
                
                if ('path' in entry && typeof (entry as { path?: unknown }).path === 'string') {
                    paths.push(normalizeImportPath((entry as { path: string }).path));
                    continue;
                }
                
                if ('uri' in entry && typeof (entry as { uri?: unknown }).uri === 'string') {
                    const uri = (entry as { uri: string }).uri;
                    paths.push(uri.startsWith('content://') ? uri : normalizeImportPath(uri));
                }
            }
        }

        return paths;
    } catch (error) {
        throw error;
    }
}

export function pickBookFilesBrowser(): Promise<File[]> {
    return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        input.accept = BROWSER_IMPORT_ACCEPT;
        
        input.onchange = () => {
            const files = input.files ? Array.from(input.files) : [];
            resolve(files);
        };
        
        input.oncancel = () => resolve([]);
        
        input.click();
    });
}

export async function createBookEntryFromFile(file: File): Promise<Book | null> {
    const format = getBookFormat(file.name);
    if (!format) {
        return null;
    }
    if (!isImportFormatSupported(format)) {
        return null;
    }

    const buffer = await file.arrayBuffer();
    if (!buffer || buffer.byteLength === 0) {
        return null;
    }
    const contentHash = await computeContentHash(buffer);

    const id = uuidv4();
    const fileSize = file.size;

    if (fileSize > 100 * 1024 * 1024) {
    }

    const storagePath = await saveBookData(id, buffer);

    const filename = file.name;
    const filenameMetadata = extractFilenameMetadata(filename);

    const book: Book = {
        id,
        title: filenameMetadata.title,
        author: filenameMetadata.author || "",
        filePath: `browser://${filename}`, 
        storagePath,
        format,
        contentHash,
        fileSize,
        addedAt: new Date(),
        progress: 0,
        isFavorite: false,
        tags: [],
        readingTime: 0,
        coverExtractionDone: !INSTANT_IMPORT_MODE,
    };

    return book;
}

export async function importBooksFromFiles(files: File[]): Promise<Book[]> {
    return importBooksFromFilesIncremental(files);
}

export async function importBooksFromFilesIncremental(
    files: File[],
    onBookImported?: (book: Book) => void,
    onBookFailed?: ImportFailureHandler,
): Promise<Book[]> {
    const imported = await runWithConcurrency(
        files,
        getImportConcurrency(),
        async (file): Promise<Book | null> => {
            try {
                const book = await createBookEntryFromFile(file);
                if (book) {
                    onBookImported?.(book);
                } else {
                    onBookFailed?.(file.name, new Error('[Import] Failed to import file'));
                }
                return book;
            } catch (error) {
                onBookFailed?.(file.name, error);
                return null;
            }
        },
    );

    return imported.filter((book): book is Book => book !== null);
}

export async function readBookFile(filePath: string, bookId?: string): Promise<ArrayBuffer> {
    const normalizedFilePath = normalizeImportPath(filePath);
    try {
        
        const data = await getBookData(bookId || '', normalizedFilePath);
        if (!data) {
            throw new Error('Could not read book file from storage - data not found');
        }
        return data;
    } catch (error) {
        throw new Error(`Failed to read book file: ${error}`);
    }
}

export function extractFilenameMetadata(filePath: string): { title: string; author: string } {
    const filename = extractFilenameFromPath(filePath);
    const nameWithoutExt = filename.replace(/\.[^/.]+$/, '');
    
    const parts = nameWithoutExt.split(/\s*[-–—]\s*/);
    if (parts.length >= 2) {
        return {
            author: parts[0].trim(),
            title: parts.slice(1).join(' - ').trim(),
        };
    }
    
    return {
        title: nameWithoutExt,
        author: 'Unknown Author',
    };
}

export async function createBookEntry(filePath: string): Promise<Book | null> {
    const normalizedFilePath = normalizeImportPath(filePath);
    const isContentUri = normalizedFilePath.startsWith('content://');
    let format = getBookFormat(normalizedFilePath);

    const plugins = await initTauriPlugins();
    if (!plugins?.fs) throw new Error('FS plugin not available - this function requires Tauri');
    const fs = plugins.fs;

    let readPath = normalizedFilePath;
    if (isContentUri) {
        const { invoke } = await import('@tauri-apps/api/core');
        const resolvedFilename = ensureFilenameForFormat(
            extractFilenameFromPath(normalizedFilePath),
            format || 'epub',
        );
        readPath = await withTimeout(
            invoke<string>('materialize_android_content_uri', {
                uri: normalizedFilePath,
                fileName: resolvedFilename,
            }),
            CONTENT_URI_READ_TIMEOUT_MS,
            `materializing Android content URI: ${normalizedFilePath}`,
        );
    }

    let fileSize = 0;
    try {
        const stats = await fs.stat(readPath);
        fileSize = Number(stats.size);
    } catch {
        
    }

    if (fileSize > 100 * 1024 * 1024) {
    }

    const buffer = await readBookFile(readPath);
    if (!buffer || buffer.byteLength === 0) {
        return null;
    }
    if (fileSize <= 0) {
        fileSize = buffer.byteLength;
    }

    if (!format) {
        format = detectFormatFromBuffer(buffer);
    }
    if (!format) {
        return null;
    }
    if (!isImportFormatSupported(format)) {
        return null;
    }
    const contentHash = await computeContentHash(buffer);

    const id = uuidv4();

    let storagePath = await saveBookData(id, buffer);
    let finalFormat = format;

    if (format === 'cbr' && isTauri()) {
        try {
            const cbzData = await invoke<Uint8Array>('read_cbr_as_cbz', { path: storagePath });
            storagePath = await saveBookData(id, (cbzData.buffer as ArrayBuffer));
            finalFormat = 'cbz';
        } catch (err) {
            console.error('CBR to CBZ conversion failed:', err);
            return null;
        }
    }

    const resolvedFilename = ensureFilenameForFormat(extractFilenameFromPath(normalizedFilePath), format);
    const filenameMetadata = extractFilenameMetadata(resolvedFilename);

    const book: Book = {
        id,
        title: filenameMetadata.title,
        author: filenameMetadata.author || "",
        filePath: normalizedFilePath,
        storagePath,
        format: finalFormat,
        contentHash,
        fileSize,
        addedAt: new Date(),
        progress: 0,
        isFavorite: false,
        tags: [],
        readingTime: 0,
        coverExtractionDone: !INSTANT_IMPORT_MODE,
    };

    return book;
}

export async function importBooks(filePaths: string[]): Promise<Book[]> {
    return importBooksIncremental(filePaths);
}

export async function importBooksIncremental(
    filePaths: string[],
    onBookImported?: (book: Book) => void,
    onBookFailed?: ImportFailureHandler,
): Promise<Book[]> {
    if (isTauri() && !isMobile() && filePaths.length > 0) {
        try {
            const { listen } = await import('@tauri-apps/api/event');
            let unlisten: (() => void) | null = null;

            unlisten = await listen<{
                completed: number;
                total: number;
                currentFile: string;
                book?: any;
                error?: string;
            }>('import-batch-progress', (event) => {
                if (event.payload.book) {
                    const raw = event.payload.book;
                    const book: Book = {
                        id: raw.id,
                        title: raw.title,
                        author: raw.author,
                        filePath: raw.file_path || raw.filePath,
                        storagePath: raw.storagePath,
                        format: raw.format as BookFormat,
                        contentHash: raw.contentHash,
                        coverPath: raw.coverPath,
                        coverExtractionDone: raw.coverExtractionDone ?? true,
                        description: raw.description,
                        publisher: raw.publisher,
                        publishedDate: raw.publishedDate,
                        language: raw.language,
                        isbn: raw.isbn,
                        fileSize: raw.fileSize || 0,
                        readingTime: raw.readingTime || 0,
                        addedAt: raw.addedAt ? new Date(raw.addedAt) : new Date(),
                        progress: raw.progress || 0,
                        isFavorite: raw.isFavorite || false,
                        tags: raw.tags || [],
                    };
                    onBookImported?.(book);
                } else if (event.payload.error) {
                    onBookFailed?.(event.payload.currentFile, new Error(event.payload.error));
                }
            });

            try {
                const results = await invoke<any[]>('ingest_books_native', { filePaths });
                if (Array.isArray(results) && results.length > 0) {
                    return results.map((raw) => ({
                        id: raw.id,
                        title: raw.title,
                        author: raw.author,
                        filePath: raw.file_path || raw.filePath,
                        storagePath: raw.storagePath,
                        format: raw.format as BookFormat,
                        contentHash: raw.contentHash,
                        coverPath: raw.coverPath,
                        coverExtractionDone: raw.coverExtractionDone ?? true,
                        description: raw.description,
                        publisher: raw.publisher,
                        publishedDate: raw.publishedDate,
                        language: raw.language,
                        isbn: raw.isbn,
                        fileSize: raw.fileSize || 0,
                        readingTime: raw.readingTime || 0,
                        addedAt: raw.addedAt ? new Date(raw.addedAt) : new Date(),
                        progress: raw.progress || 0,
                        isFavorite: raw.isFavorite || false,
                        tags: raw.tags || [],
                    }));
                }
            } finally {
                unlisten?.();
            }
        } catch (error) {
            console.warn('[Import] Native batch ingestion failed, falling back to JS worker:', error);
        }
    }

    const imported = await runWithConcurrency(
        filePaths,
        getImportConcurrency(),
        async (filePath): Promise<Book | null> => {
            try {
                const book = await withTimeout(
                    createBookEntry(filePath),
                    IMPORT_ENTRY_TIMEOUT_MS,
                    `importing file: ${filePath}`,
                );
                if (book) {
                    onBookImported?.(book);
                } else {
                    onBookFailed?.(filePath, new Error('[Import] Failed to import file'));
                }
                return book;
            } catch (error) {
                onBookFailed?.(filePath, error);
                return null;
            }
        },
    );

    return imported.filter((book): book is Book => book !== null);
}

export async function pickAndImportBooks(): Promise<Book[]> {
    return pickAndImportBooksIncremental();
}

export async function pickAndImportBooksIncremental(
    onBookImported?: (book: Book) => void,
    onBookFailed?: ImportFailureHandler,
): Promise<Book[]> {
    if (isTauri() && !isMobile()) {
        
        const filePaths = await pickBookFiles();
        if (filePaths.length === 0) {
            return [];
        }
        return importBooksIncremental(filePaths, onBookImported, onBookFailed);
    } else if (isTauri() && isMobile()) {
        
        const files = await pickBookFilesBrowser();
        if (files.length === 0) {
            return [];
        }
        return importBooksFromFilesIncremental(files, onBookImported, onBookFailed);
    } else {
        
        const files = await pickBookFilesBrowser();
        if (files.length === 0) {
            return [];
        }
        return importBooksFromFilesIncremental(files, onBookImported, onBookFailed);
    }
}

export async function scanFolderForBooks(folderPath: string): Promise<string[]> {
    const rootFolderPath = normalizeImportPath(folderPath);
    if (!rootFolderPath) {
        return [];
    }

    if (isTauri() && !isMobile()) {
        try {
            const { invoke } = await import('@tauri-apps/api/core');
            const result = await invoke<string[]>('scan_library_folder_desktop', {
                folderPath: rootFolderPath,
            });
            return Array.isArray(result) ? result : [];
        } catch (error) {
            
        }
    }

    const plugins = await initTauriPlugins();
    if (!plugins?.fs) throw new Error('FS plugin not available - folder scanning requires Tauri');
    const fs = plugins.fs;

    const bookFiles: string[] = [];
    const visitedDirectories = new Set<string>();

    type ScanEntryLike = {
        name?: unknown;
        path?: unknown;
        isDirectory?: unknown;
        isFile?: unknown;
        isSymlink?: unknown;
    };

    type ScanEntryKind = 'directory' | 'file' | 'skip';

    function joinScanPath(parentDir: string, childName: string): string {
        const safeChildName = childName.replace(/^[/\\]+/, '');
        if (!parentDir) {
            return safeChildName;
        }

        if (parentDir.endsWith('/') || parentDir.endsWith('\\')) {
            return `${parentDir}${safeChildName}`;
        }

        const separator = parentDir.includes('\\') && !parentDir.includes('/') ? '\\' : '/';
        return `${parentDir}${separator}${safeChildName}`;
    }

    function getEntryName(entry: ScanEntryLike): string | null {
        if (typeof entry.name === 'string') {
            const trimmedName = entry.name.trim();
            if (trimmedName) {
                return trimmedName;
            }
        }

        if (typeof entry.path === 'string') {
            const trimmedPath = entry.path.trim();
            if (!trimmedPath) {
                return null;
            }
            const pathName = trimmedPath.replace(/\\/g, '/').split('/').filter(Boolean).pop();
            return pathName?.trim() || null;
        }

        return null;
    }

    function getBooleanFlag(value: unknown): boolean | null {
        return typeof value === 'boolean' ? value : null;
    }

    async function resolveEntryKind(entry: ScanEntryLike, fullPath: string): Promise<ScanEntryKind> {
        if (getBooleanFlag(entry.isSymlink) === true) {
            return 'skip';
        }

        if (getBooleanFlag(entry.isDirectory) === true) {
            return 'directory';
        }

        if (getBooleanFlag(entry.isFile) === true) {
            return 'file';
        }

        try {
            const stats = await fs.stat(fullPath);
            if (stats.isSymlink) {
                return 'skip';
            }
            if (stats.isDirectory) {
                return 'directory';
            }
            if (stats.isFile) {
                return 'file';
            }
        } catch {
            
        }

        return 'skip';
    }

    async function scanDir(dir: string) {
        const normalizedDir = normalizeImportPath(dir);
        if (visitedDirectories.has(normalizedDir)) {
            return;
        }
        visitedDirectories.add(normalizedDir);

        try {
            const entries = await fs.readDir(normalizedDir);
            
            for (const entry of entries) {
                const entryLike = entry as ScanEntryLike;
                const entryName = getEntryName(entryLike);
                if (!entryName) {
                    continue;
                }

                const fullPath = normalizeImportPath(joinScanPath(normalizedDir, entryName));
                const kind = await resolveEntryKind(entryLike, fullPath);

                if (kind === 'directory') {
                    await scanDir(fullPath);
                } else if (kind === 'file') {
                    const lowerName = entryName.toLowerCase();
                    const isSupportedBook = isSupportedImportFilename(lowerName);

                    if (isSupportedBook) {
                        bookFiles.push(fullPath);
                    }
                }
            }
        } catch (error) {
        }
    }

    await scanDir(rootFolderPath);
    return Array.from(new Set(bookFiles));
}
