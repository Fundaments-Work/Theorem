
import { get, set, del } from 'idb-keyval';
import { isTauri } from './env';
import {
    sqliteDeleteBookData,
    sqliteDeleteCoverImage,
    sqliteGetBookData,
    sqliteGetCoverImage,
    sqliteGetMaterializedBookPath,
    sqliteSaveBookData,
    sqliteSaveCoverImage,
} from './sqlite-storage';
import { normalizeFilePath } from './utils';

const STORE_NAME = 'theorem-books';
const COVERS_STORE = 'theorem-covers';
const BLOB_CACHE_LIMIT = 3;
const STORAGE_READ_TIMEOUT_MS = 30000;

let tauriFs: typeof import('@tauri-apps/plugin-fs') | null = null;

const COVER_CACHE_MAX = 100;
const THUMBNAIL_CACHE_MAX = 200;

const blobCache = new Map<string, Blob>();
const pendingDataReads = new Map<string, Promise<ArrayBuffer | null>>();
const pendingBlobReads = new Map<string, Promise<Blob | null>>();
const materializedPathCache = new Map<string, string>();
const coverCache = new Map<string, string>();

function lruSet<K, V>(map: Map<K, V>, key: K, value: V, maxSize: number): void {
    map.delete(key);
    map.set(key, value);
    if (map.size > maxSize) {
        const firstKey = map.keys().next().value;
        if (firstKey !== undefined) map.delete(firstKey);
    }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

    return Promise.race([
        promise,
        new Promise<T>((_, reject) => {
            timeoutHandle = setTimeout(() => {
                reject(new Error(`[Storage] Timed out while ${label}.`));
            }, timeoutMs);
        }),
    ]).finally(() => {
        if (timeoutHandle) {
            clearTimeout(timeoutHandle);
        }
    });
}

function getStorageKey(id: string, filePath?: string): string {
    if (filePath) {
        return filePath;
    }
    return `sqlite://${id}`;
}

function getMimeTypeFromPath(filePath?: string): string {
    const ext = filePath
        ? normalizeFilePath(filePath).split(/[?#]/, 1)[0].toLowerCase().split('.').pop()
        : undefined;
    if (ext === 'pdf') {
        return 'application/pdf';
    }
    if (ext === 'epub') {
        return 'application/epub+zip';
    }
    return 'application/octet-stream';
}

function resolveSqliteBookId(id: string, filePath?: string): string | null {
    if (filePath?.startsWith('sqlite://')) {
        const parsed = filePath.slice('sqlite://'.length);
        return parsed || null;
    }
    if (id.trim()) {
        return id;
    }
    return null;
}

function resolveIndexedDbBookId(id: string, filePath?: string): string | null {
    if (filePath?.startsWith('idb://')) {
        const parsed = filePath.slice('idb://'.length);
        return parsed || null;
    }
    if (id.trim()) {
        return id;
    }
    return null;
}

function isExternalFilePath(filePath?: string): boolean {
    if (!filePath) {
        return false;
    }

    return !filePath.startsWith('sqlite://')
        && !filePath.startsWith('idb://')
        && !filePath.startsWith('browser://')
        && !filePath.startsWith('content://');
}

function getCachedBlob(cacheKey: string): Blob | null {
    const cached = blobCache.get(cacheKey);
    if (!cached) {
        return null;
    }

    blobCache.delete(cacheKey);
    blobCache.set(cacheKey, cached);
    return cached;
}

function cacheBlob(cacheKey: string, blob: Blob): void {
    blobCache.set(cacheKey, blob);

    while (blobCache.size > BLOB_CACHE_LIMIT) {
        const oldestKey = blobCache.keys().next().value as string | undefined;
        if (!oldestKey) {
            break;
        }
        blobCache.delete(oldestKey);
    }
}

function clearBlobCacheForBook(id: string, filePath?: string): void {
    blobCache.delete(getStorageKey(id, filePath));
    blobCache.delete(`idb://${id}`);
    blobCache.delete(`sqlite://${id}`);
    materializedPathCache.delete(id);
}

async function getTauriFs() {
    if (!isTauri()) return null;
    if (tauriFs) return tauriFs;
    try {
        tauriFs = await import('@tauri-apps/plugin-fs');
        return tauriFs;
    } catch {
        return null;
    }
}

async function readExternalFile(path: string): Promise<ArrayBuffer | null> {
    const fs = await getTauriFs();
    if (!fs) {
        return null;
    }

    try {
        const contents = await withTimeout(
            fs.readFile(path),
            STORAGE_READ_TIMEOUT_MS,
            `reading external file '${path}'`,
        );
        if (contents instanceof Uint8Array) {
            return contents.buffer.slice(
                contents.byteOffset,
                contents.byteOffset + contents.byteLength,
            );
        }
        if ((contents as unknown) instanceof ArrayBuffer) {
            return contents;
        }
        if (Array.isArray(contents)) {
            return new Uint8Array(contents).buffer;
        }
        return null;
    } catch (error) {
        return null;
    }
}

export async function getBookMaterializedPath(id: string, filePath?: string): Promise<string | null> {
    const normalizedPath = filePath ? normalizeFilePath(filePath) : undefined;
    if (normalizedPath && isExternalFilePath(normalizedPath)) {
        return normalizedPath;
    }

    if (!isTauri()) {
        return null;
    }

    const sqliteBookId = resolveSqliteBookId(id, normalizedPath);
    if (!sqliteBookId) {
        return null;
    }

    const cachedPath = materializedPathCache.get(sqliteBookId);
    if (cachedPath) {
        return cachedPath;
    }

    try {
        const materializedPath = await withTimeout(
            sqliteGetMaterializedBookPath(sqliteBookId),
            STORAGE_READ_TIMEOUT_MS,
            `resolving materialized SQLite path for '${sqliteBookId}'`,
        );
        if (materializedPath) {
            lruSet(materializedPathCache, sqliteBookId, materializedPath, 500);
            return materializedPath;
        }
    } catch (error) {
    }

    return null;
}

export async function saveBookData(id: string, data: ArrayBuffer): Promise<string> {
    clearBlobCacheForBook(id);

    if (isTauri()) {
        try {
            const storagePath = await sqliteSaveBookData(id, data);
            return storagePath;
        } catch (error) {
        }
    }

    try {
        await set(`${STORE_NAME}-${id}`, data);
        return `idb://${id}`;
    } catch (error) {
        throw error;
    }
}

export async function getBookData(id: string, filePath?: string): Promise<ArrayBuffer | null> {
    const cacheKey = getStorageKey(id, filePath);
    const pendingRead = pendingDataReads.get(cacheKey);
    if (pendingRead) {
        return pendingRead;
    }

    const readPromise = (async () => {
        const normalizedPath = filePath ? normalizeFilePath(filePath) : undefined;
        const sqliteBookId = resolveSqliteBookId(id, normalizedPath);

        if (isTauri() && normalizedPath && isExternalFilePath(normalizedPath)) {
            const externalData = await readExternalFile(normalizedPath);
            if (externalData && externalData.byteLength > 0) {
                return externalData;
            }
        }

        if (isTauri() && sqliteBookId) {
            try {
                const materializedPath = await getBookMaterializedPath(sqliteBookId);
                if (materializedPath) {
                    const materializedData = await readExternalFile(materializedPath);
                    if (materializedData && materializedData.byteLength > 0) {
                        return materializedData;
                    }
                }
            } catch (error) {
            }

            try {
                const sqliteData = await withTimeout(
                    sqliteGetBookData(sqliteBookId),
                    STORAGE_READ_TIMEOUT_MS,
                    `reading SQLite blob for '${sqliteBookId}'`,
                );
                if (sqliteData && sqliteData.byteLength > 0) {
                    return sqliteData;
                }
            } catch (error) {
            }
        }

        const indexedDbId = resolveIndexedDbBookId(id, normalizedPath);
        if (!indexedDbId) {
            return null;
        }

        try {
            const data = await withTimeout(
                get<ArrayBuffer>(`${STORE_NAME}-${indexedDbId}`),
                STORAGE_READ_TIMEOUT_MS,
                `reading IndexedDB payload for '${indexedDbId}'`,
            );
            return data ?? null;
        } catch (error) {
            return null;
        }
    })();

    pendingDataReads.set(cacheKey, readPromise);

    try {
        return await readPromise;
    } finally {
        pendingDataReads.delete(cacheKey);
    }
}

export async function getBookBlob(id: string, filePath?: string): Promise<Blob | null> {
    const cacheKey = getStorageKey(id, filePath);
    const cachedBlob = getCachedBlob(cacheKey);
    if (cachedBlob) {
        return cachedBlob;
    }

    const pendingRead = pendingBlobReads.get(cacheKey);
    if (pendingRead) {
        return pendingRead;
    }

    const readPromise = (async () => {
        const data = await withTimeout(
            getBookData(id, filePath),
            STORAGE_READ_TIMEOUT_MS,
            `loading book data for '${id || filePath || 'unknown'}'`,
        );
        if (!data) {
            return null;
        }

        const mimeType = getMimeTypeFromPath(filePath);
        return new Blob([data], { type: mimeType });
    })();

    pendingBlobReads.set(cacheKey, readPromise);

    try {
        const blob = await readPromise;
        if (blob) {
            cacheBlob(cacheKey, blob);
        }
        return blob;
    } finally {
        pendingBlobReads.delete(cacheKey);
    }
}

export async function deleteBookData(id: string, filePath?: string): Promise<void> {
    clearBlobCacheForBook(id, filePath);

    const normalizedPath = filePath ? normalizeFilePath(filePath) : undefined;
    const sqliteBookId = resolveSqliteBookId(id, normalizedPath);
    if (isTauri() && sqliteBookId) {
        try {
            await sqliteDeleteBookData(sqliteBookId);
        } catch (error) {
        }
    }

    const indexedDbId = resolveIndexedDbBookId(id, normalizedPath);
    if (indexedDbId) {
        try {
            await del(`${STORE_NAME}-${indexedDbId}`);
        } catch (error) {
        }
    }
}

export async function downsampleCoverImage(blob: Blob, maxWidth = 200, maxHeight = 300): Promise<Blob> {
    if (blob.type === "image/svg+xml") {
        return blob;
    }

    if (isTauri()) {
        try {
            const { invoke } = await import("@tauri-apps/api/core");
            const bytes = new Uint8Array(await blob.arrayBuffer());
            const result = await invoke<{
                data: number[];
                mimeType: string;
                width: number;
                height: number;
                dominantColor?: string;
            }>("downsample_cover", {
                imageBytes: Array.from(bytes),
                maxWidth,
                maxHeight,
            });
            return new Blob([new Uint8Array(result.data)], { type: result.mimeType });
        } catch {
            // Fallback to DOM canvas
        }
    }

    if (typeof window === "undefined" || typeof document === "undefined" || !window.HTMLCanvasElement) {
        return blob;
    }
    return new Promise((resolve) => {
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => {
            URL.revokeObjectURL(url);
            let width = img.naturalWidth || img.width;
            let height = img.naturalHeight || img.height;
            if (width <= maxWidth && height <= maxHeight) {
                resolve(blob);
                return;
            }
            const ratio = Math.min(maxWidth / width, maxHeight / height);
            width = Math.round(width * ratio);
            height = Math.round(height * ratio);
            const canvas = document.createElement("canvas");
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext("2d");
            if (!ctx) {
                resolve(blob);
                return;
            }
            ctx.drawImage(img, 0, 0, width, height);
            try {
                canvas.toBlob(
                    (resizedBlob) => {
                        resolve(resizedBlob || blob);
                    },
                    "image/webp",
                    0.75,
                );
            } catch {
                canvas.toBlob(
                    (resizedBlob) => {
                        resolve(resizedBlob || blob);
                    },
                    "image/jpeg",
                    0.8,
                );
            }
        };
        img.onerror = () => {
            URL.revokeObjectURL(url);
            resolve(blob);
        };
        img.src = url;
    });
}

const thumbnailCache = new Map<string, string>();

async function generateThumbnail(dataUrl: string, maxWidth: number, maxHeight: number): Promise<string | null> {
    if (typeof window === "undefined" || !window.HTMLCanvasElement) return null;
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            const width = img.naturalWidth || img.width;
            const height = img.naturalHeight || img.height;
            if (width <= maxWidth && height <= maxHeight) {
                resolve(dataUrl);
                return;
            }
            const ratio = Math.min(maxWidth / width, maxHeight / height);
            const canvas = document.createElement("canvas");
            canvas.width = Math.round(width * ratio);
            canvas.height = Math.round(height * ratio);
            const ctx = canvas.getContext("2d");
            if (!ctx) {
                resolve(null);
                return;
            }
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            try {
                canvas.toBlob(
                    (blob) => {
                        if (!blob) { resolve(null); return; }
                        const reader = new FileReader();
                        reader.onloadend = () => resolve(reader.result as string);
                        reader.onerror = () => resolve(null);
                        reader.readAsDataURL(blob);
                    },
                    "image/webp",
                    0.7,
                );
            } catch {
                resolve(null);
            }
        };
        img.onerror = () => resolve(null);
        img.src = dataUrl;
    });
}

export async function getCoverThumbnail(bookId: string, coverPath: string, size = 120): Promise<string> {
    const cacheKey = `${bookId}:${size}`;
    const cached = thumbnailCache.get(cacheKey);
    if (cached) return cached;

    const thumb = await generateThumbnail(coverPath, size, Math.round(size * 1.5));
    const result = thumb || coverPath;
    lruSet(thumbnailCache, cacheKey, result, THUMBNAIL_CACHE_MAX);
    return result;
}

async function blobToDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

export async function saveCoverImage(bookId: string, blob: Blob): Promise<string> {
    let finalBlob = blob;
    try {
        finalBlob = await downsampleCoverImage(blob);
    } catch (e) {
        
    }
    const dataUrl = await blobToDataUrl(finalBlob);
    lruSet(coverCache, bookId, dataUrl, COVER_CACHE_MAX);

    if (isTauri()) {
        try {
            await sqliteSaveCoverImage(bookId, dataUrl);
            return dataUrl;
        } catch (error) {
        }
    }

    try {
        await set(`${COVERS_STORE}-${bookId}`, dataUrl);
        return dataUrl;
    } catch (error) {
        throw error;
    }
}

export async function getCoverImage(bookId: string): Promise<string | null> {
    const cached = coverCache.get(bookId);
    if (cached !== undefined) return cached || null;

    if (isTauri()) {
        try {
            const cover = await sqliteGetCoverImage(bookId);
            if (cover) {
                lruSet(coverCache, bookId, cover, COVER_CACHE_MAX);
                return cover;
            }
        } catch (error) {
        }
    }

    try {
        const dataUrl = await get<string>(`${COVERS_STORE}-${bookId}`);
        const result = dataUrl ?? null;
        lruSet(coverCache, bookId, result || '', COVER_CACHE_MAX);
        return result;
    } catch (error) {
        lruSet(coverCache, bookId, '', COVER_CACHE_MAX);
        return null;
    }
}

export async function deleteCoverImage(bookId: string): Promise<void> {
    coverCache.delete(bookId);

    if (isTauri()) {
        try {
            await sqliteDeleteCoverImage(bookId);
        } catch (error) {
        }
    }

    try {
        await del(`${COVERS_STORE}-${bookId}`);
    } catch (error) {
    }
}
