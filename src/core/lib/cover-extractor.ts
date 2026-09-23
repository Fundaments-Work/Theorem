
import type { BookFormat } from '../types';
import { saveCoverImage, downsampleCoverImage } from './storage';
import { getConfiguredPdfJs, PDFJS_ASSET_OPTIONS } from './pdfjs-runtime';
import { normalizeAuthor } from './utils';
import { isMobile } from './env';

const DEFAULT_METADATA_TIMEOUT_MS = isMobile() ? 15000 : 10000;
const DEFAULT_COVER_TIMEOUT_MS = isMobile() ? 12000 : 5000;

export interface ExtractedMetadata {
    title: string;
    author: string;
    description?: string;
    publisher?: string;
    language?: string;
    publishedDate?: string;
    identifier?: string;
    coverDataUrl?: string | null;
}

export interface MetadataExtractionOptions {
    metadataTimeoutMs?: number;
    coverTimeoutMs?: number;
    allowFallbackCover?: boolean;
}

function normalizeMetadataTitle(value: unknown): string {
    if (typeof value === 'string') {
        return value.replace(/\s+/g, ' ').trim();
    }

    if (Array.isArray(value)) {
        for (const item of value) {
            const normalized = normalizeMetadataTitle(item);
            if (normalized) {
                return normalized;
            }
        }
        return '';
    }

    if (value && typeof value === 'object') {
        const recordValue = value as Record<string, unknown>;
        const preferredKeys = ['title', 'name', 'label', 'value'];
        for (const key of preferredKeys) {
            const candidate = normalizeMetadataTitle(recordValue[key]);
            if (candidate) {
                return candidate;
            }
        }
        for (const nestedValue of Object.values(recordValue)) {
            const candidate = normalizeMetadataTitle(nestedValue);
            if (candidate) {
                return candidate;
            }
        }
    }

    return '';
}

function normalizeMetadataString(value: unknown): string | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }
    const normalized = value.replace(/\s+/g, ' ').trim();
    return normalized.length > 0 ? normalized : undefined;
}

function isPlaceholderMetadataTitle(title: string): boolean {
    const normalized = title.trim().toLowerCase();
    return normalized === 'unknown title' || normalized === 'untitled' || normalized === 'untitled book';
}

const BOOK_EXTENSIONS = ['.epub', '.pdf', '.mobi', '.azw', '.azw3', '.fb2', '.cbz', '.cbr'];

function stripBookExtension(title: string): string {
    const lower = title.toLowerCase();
    for (const ext of BOOK_EXTENSIONS) {
        if (lower.endsWith(ext)) {
            return title.slice(0, -ext.length).trim();
        }
    }
    return title;
}

function filenameFallbackData(filePath: string): { title: string; author: string } {
    const filename = filePath.split('/').pop()?.split('\\').pop() || filePath;
    const nameWithoutExt = filename.replace(/\.[^/.]+$/, '');
    const parts = nameWithoutExt.split(/\s*[-–—]\s*/);
    if (parts.length >= 2) {
        return { title: parts.slice(1).join(' - ').trim(), author: parts[0].trim() };
    }
    return { title: nameWithoutExt, author: '' };
}

export function shouldUseExtractedTitle(currentTitle: string, extractedTitle: string | undefined, filePath: string): boolean {
    const nextTitle = normalizeMetadataTitle(extractedTitle);
    if (!nextTitle) {
        return false;
    }

    const loweredNext = nextTitle.toLowerCase();
    if (loweredNext === "unknown title" || loweredNext === "untitled" || loweredNext === "untitled book") {
        return false;
    }

    if (nextTitle.length < 2 || /^[^a-zA-Z0-9]+$/.test(nextTitle)) {
        return false;
    }
    
    if (/^[\[({<"'`]/.test(nextTitle) || /[)\]}>"'`]$/.test(nextTitle)) {
        return false;
    }

    const filenameInfo = filenameFallbackData(filePath);
    const currentNormalized = normalizeMetadataTitle(currentTitle);
    if (!currentNormalized) return true;

    if (currentNormalized === nextTitle) return false;

    const currentIsFilenameFallback = (
        filenameInfo.title.length > 0
        && currentNormalized.toLowerCase() === filenameInfo.title.toLowerCase()
    );

    return currentNormalized === "Unknown" || currentNormalized.includes(".") || currentIsFilenameFallback;
}

export function shouldUseExtractedAuthor(currentAuthor: string, extractedAuthor: string | undefined): boolean {
    const nextAuthor = normalizeMetadataString(extractedAuthor);
    if (!nextAuthor || nextAuthor.toLowerCase() === "unknown author") {
        return false;
    }
    const currentNormalized = normalizeMetadataString(currentAuthor);
    if (!currentNormalized) return true;
    return currentNormalized.toLowerCase() !== nextAuthor.toLowerCase();
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
            reject(new Error(`[CoverExtractor] Timeout while ${label} (${timeoutMs}ms)`));
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

function blobToDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

function getMimeType(format: BookFormat): string {
    switch (format) {
        case 'epub':
            return 'application/epub+zip';
        case 'pdf':
            return 'application/pdf';
        case 'mobi':
        case 'azw':
        case 'azw3':
            return 'application/x-mobipocket-ebook';
        case 'fb2':
            return 'application/x-fictionbook+xml';
        case 'cbz':
            return 'application/vnd.comicbook+zip';
        case 'cbr':
            return 'application/vnd.comicbook-rar';
        default:
            return 'application/octet-stream';
    }
}

function getCoverTimeoutMultiplier(format: BookFormat): number {
    switch (format) {
        case 'mobi':
        case 'azw':
        case 'azw3':
            return isMobile() ? 2.6 : 2.0;
        case 'epub':
        case 'fb2':
            return isMobile() ? 1.8 : 1.5;
        case 'cbz':
            return isMobile() ? 1.5 : 1.3;
        case 'pdf':
            return isMobile() ? 1.6 : 1.4;
        case 'cbr':
        default:
            return 1;
    }
}

async function normalizeCoverBlob(rawCover: unknown, fallbackMimeType: string): Promise<Blob | null> {
    if (!rawCover) {
        return null;
    }

    if (rawCover instanceof Blob) {
        if (rawCover.size > 0) {
            
            if (!rawCover.type) {
                return new Blob([rawCover], { type: fallbackMimeType });
            }
            return rawCover;
        }
        return null;
    }

    if (rawCover instanceof ArrayBuffer) {
        return rawCover.byteLength > 0 ? new Blob([rawCover], { type: fallbackMimeType }) : null;
    }

    if (ArrayBuffer.isView(rawCover)) {
        return rawCover.byteLength > 0 ? new Blob([rawCover as BlobPart], { type: fallbackMimeType }) : null;
    }

    if (typeof rawCover === 'string' && rawCover.startsWith('data:')) {
        try {
            const response = await fetch(rawCover);
            const blob = await response.blob();
            return blob.size > 0 ? blob : null;
        } catch {
            return null;
        }
    }

    if (typeof rawCover === 'string' && rawCover.length > 0) {
        try {
            const response = await fetch(rawCover);
            if (response.ok) {
                const blob = await response.blob();
                return blob.size > 0 ? blob : null;
            }
        } catch {
            
        }
    }

    if (typeof rawCover === 'object' && rawCover !== null) {
        const obj = rawCover as Record<string, unknown>;
        if (obj.data instanceof ArrayBuffer) {
            return normalizeCoverBlob(obj.data, fallbackMimeType);
        }
        if (obj.buffer instanceof ArrayBuffer) {
            return normalizeCoverBlob(obj.buffer, fallbackMimeType);
        }
    }

    return null;
}

export function buildFallbackCoverSvg(title: string, author: string): string {
    const normalizedTitle = (title || 'Untitled').trim();
    const normalizedAuthor = (author || 'Unknown Author').trim();

    const escapedTitle = normalizedTitle
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .slice(0, 60);
    const escapedAuthor = normalizedAuthor
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .slice(0, 48);

    return `
<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1350" viewBox="0 0 900 1350" role="img" aria-label="Book cover">
  <rect width="900" height="1350" fill="#09090b"/>
  <!-- Outer hairline frame -->
  <rect x="54" y="54" width="792" height="1242" fill="none" stroke="#27272a" stroke-width="2"/>
  <!-- Inner double rule -->
  <rect x="72" y="72" width="756" height="1206" fill="none" stroke="#18181b" stroke-width="1"/>
  
  <!-- Header series mark -->
  <text x="450" y="160" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="18" fill="#71717a" font-weight="700" letter-spacing="8">THEOREM CLASSICS</text>
  <line x1="360" y1="190" x2="540" y2="190" stroke="#3f3f46" stroke-width="1.5"/>

  <!-- Title & Author Block -->
  <g transform="translate(450, 620)">
    <text x="0" y="-40" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="52" fill="#ffffff" font-weight="700" letter-spacing="1">
      ${escapedTitle}
    </text>
    <line x1="-80" y1="40" x2="80" y2="40" stroke="#52525b" stroke-width="1"/>
    <text x="0" y="90" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="24" fill="#a1a1aa" font-weight="500" letter-spacing="3">
      ${escapedAuthor}
    </text>
  </g>

  <!-- Bottom emblem -->
  <g transform="translate(442, 1170)">
    <rect x="0" y="0" width="3.5" height="28" fill="#71717a"/>
    <rect x="0" y="12" width="18" height="3.5" fill="#71717a"/>
  </g>
  <text x="450" y="1230" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="14" fill="#71717a" font-weight="700" letter-spacing="4">THEOREM</text>
</svg>`;
}

async function createAndPersistFallbackCover(
    title: string,
    author: string,
    bookId?: string,
): Promise<string | null> {
    const svg = buildFallbackCoverSvg(title, author);
    const blob = new Blob([svg], { type: 'image/svg+xml' });

    if (bookId) {
        try {
            return await saveCoverImage(bookId, blob);
        } catch (error) {
        }
    }

    return blobToDataUrl(blob);
}

async function ensureCoverFallback(
    result: ExtractedMetadata,
    filename: string,
    bookId?: string,
): Promise<void> {
    if (result.coverDataUrl) {
        return;
    }

    const fallbackTitle = result.title || filename.replace(/\.[^/.]+$/, '');
    const fallbackAuthor = result.author || 'Unknown Author';
    result.coverDataUrl = await createAndPersistFallbackCover(fallbackTitle, fallbackAuthor, bookId);
}

export async function extractMetadata(
    data: ArrayBuffer,
    format: BookFormat,
    filename: string,
    bookId?: string,
    options?: MetadataExtractionOptions,
): Promise<ExtractedMetadata> {
    const metadataTimeoutMs = Math.max(500, options?.metadataTimeoutMs ?? DEFAULT_METADATA_TIMEOUT_MS);
    const baseCoverTimeoutMs = options?.coverTimeoutMs ?? DEFAULT_COVER_TIMEOUT_MS;
    const coverTimeoutMs = Math.max(
        300,
        Math.round(baseCoverTimeoutMs * getCoverTimeoutMultiplier(format)),
    );
    const allowFallbackCover = options?.allowFallbackCover ?? true;
    const result: ExtractedMetadata = {
        title: '',
        author: '',
    };

    if (format === 'pdf') {
        try {
            const pdfjsLib = await getConfiguredPdfJs();

            const rawPdfData = new Uint8Array(data);
            const serializableData = (() => {
                if (rawPdfData.buffer && rawPdfData.buffer instanceof ArrayBuffer) {
                    if (rawPdfData.byteOffset !== 0 || rawPdfData.byteLength !== rawPdfData.buffer.byteLength) {
                        return new Uint8Array(rawPdfData.buffer.slice(rawPdfData.byteOffset, rawPdfData.byteOffset + rawPdfData.byteLength));
                    }
                    return rawPdfData;
                }
                return new Uint8Array(Array.from(rawPdfData));
            })();

            const loadingTask = pdfjsLib.getDocument({
                ...PDFJS_ASSET_OPTIONS,
                data: serializableData,
            });

            const pdf = await withTimeout(loadingTask.promise, metadataTimeoutMs, 'loading PDF metadata');

            const metadata = await withTimeout(pdf.getMetadata(), metadataTimeoutMs, 'reading PDF metadata');
            const metaInfo = metadata.info as Record<string, unknown>;

            result.title = (metaInfo?.Title as string) || filename.replace(/\.[^/.]+$/, '');
            result.title = stripBookExtension(result.title);
            result.author = (metaInfo?.Author as string) || '';

            try {
                const page = await withTimeout(pdf.getPage(1), coverTimeoutMs, 'opening PDF page for cover');
                const viewport = page.getViewport({ scale: isMobile() ? 0.3 : 0.5 });
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');

                if (ctx) {
                    const maxDimension = isMobile() ? 400 : 1000;
                    let scale = isMobile() ? 0.3 : 0.5;
                    if (viewport.width > maxDimension || viewport.height > maxDimension) {
                        const maxViewportDim = Math.max(viewport.width, viewport.height);
                        scale = (maxDimension / maxViewportDim) * scale;
                    }

                    const adjustedViewport = page.getViewport({ scale });
                    
                    canvas.width = Math.min(adjustedViewport.width, maxDimension);
                    canvas.height = Math.min(adjustedViewport.height, maxDimension);

                    await withTimeout(
                        page.render({
                            canvas,
                            viewport: adjustedViewport,
                        }).promise,
                        coverTimeoutMs,
                        'rendering PDF cover',
                    );

                    const blob = await new Promise<Blob | null>((resolve) => {
                        canvas.toBlob((value) => resolve(value), 'image/jpeg', 0.8);
                    });

                    if (blob && bookId) {
                        result.coverDataUrl = await saveCoverImage(bookId, blob);
                    } else if (blob) {
                        const downsampled = await downsampleCoverImage(blob);
                        result.coverDataUrl = await blobToDataUrl(downsampled);
                    }
                }

                page.cleanup();
            } catch (coverError) {
            }

            pdf.cleanup();
            if (allowFallbackCover) {
                await ensureCoverFallback(result, filename, bookId);
            }
            return result;
        } catch (pdfError) {
            result.title = filename.replace(/\.[^/.]+$/, '');
            if (allowFallbackCover) {
                result.coverDataUrl = await createAndPersistFallbackCover(result.title, result.author || 'Unknown Author', bookId);
            }
            return result;
        }
    }

    try {
        const { makeBook } = await import('../../features/reader/foliate-js-runtime/view.js');
        const mimeType = getMimeType(format);

        let bookInput: File | Blob;
        if (isMobile()) {
            bookInput = new Blob([data], { type: mimeType });
        } else {
            bookInput = new File([data], filename, { type: mimeType });
        }

        let book: any;

        try {
            book = await withTimeout(
                makeBook(bookInput),
                metadataTimeoutMs,
                'opening book with foliate',
            );
        } catch (openError) {
            if (isMobile() && !(bookInput instanceof File)) {
                const fileFallback = new File([data], filename, { type: mimeType });
                book = await withTimeout(
                    makeBook(fileFallback),
                    metadataTimeoutMs,
                    'opening book with File fallback',
                );
            } else {
                throw openError;
            }
        }

        if (book.metadata) {
            const fallbackTitle = filename.replace(/\.[^/.]+$/, '');
            const normalizedTitle = normalizeMetadataTitle(book.metadata.title);
            result.title = normalizedTitle && !isPlaceholderMetadataTitle(normalizedTitle)
                ? stripBookExtension(normalizedTitle)
                : fallbackTitle;
            result.author = normalizeAuthor(book.metadata.author);
            result.description = normalizeMetadataString(book.metadata.description);
            result.publisher = normalizeMetadataString(book.metadata.publisher);
            result.language = normalizeMetadataString(book.metadata.language);
            result.publishedDate = normalizeMetadataString(book.metadata.publishedDate);
            result.identifier = normalizeMetadataString(book.metadata.identifier);
        }

        if (book.getCover) {
            try {
                const rawCoverBlob = await withTimeout(book.getCover(), coverTimeoutMs, 'extracting cover');
                const coverBlob = await normalizeCoverBlob(rawCoverBlob, mimeType);
                if (coverBlob) {
                    if (bookId) {
                        result.coverDataUrl = await saveCoverImage(bookId, coverBlob);
                    } else {
                        const downsampled = await downsampleCoverImage(coverBlob);
                        result.coverDataUrl = await blobToDataUrl(downsampled);
                    }
                }
            } catch (coverError) {
            }
        }

        if (book.destroy) {
            try {
                book.destroy();
            } catch {
                
            }
        }

        if (allowFallbackCover) {
            await ensureCoverFallback(result, filename, bookId);
        }
        return result;
    } catch (error) {
        result.title = filename.replace(/\.[^/.]+$/, '');
        if (allowFallbackCover) {
            result.coverDataUrl = await createAndPersistFallbackCover(result.title, result.author || 'Unknown Author', bookId);
        }
        return result;
    }
}

export async function extractCover(
    data: ArrayBuffer,
    format: BookFormat,
    filename: string,
    bookId: string,
): Promise<string | null> {
    const metadata = await extractMetadata(data, format, filename, bookId);
    return metadata.coverDataUrl || null;
}
