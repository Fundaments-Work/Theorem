import { invoke } from '@tauri-apps/api/core';
import { isTauri } from './env';
import type { TocItem } from '../types';

export interface EpubPrefetchResult {
    container?: string;
    opf_path?: string;
    opf?: string;
    nav_path?: string;
    nav?: string;
    ncx_path?: string;
    ncx?: string;
    encryption?: string;
    sizes: Record<string, number>;
    
    sections?: Record<string, string>;
    toc?: TocItem[];
}

export interface PrefetchCache {
    textCache: Map<string, string>;
    sizes: Map<string, number>;
    toc?: TocItem[];
    /** Inflate one entry in Rust; `null` when the archive has no such entry. */
    readEntry?: (name: string) => Promise<ArrayBuffer | null>;
}

/** Must match `ENTRY_NOT_FOUND` in `src-tauri/src/epub_entries.rs`. */
const ENTRY_NOT_FOUND = 'EPUB_ENTRY_NOT_FOUND';

export function makeNativeEntryReader(path: string): (name: string) => Promise<ArrayBuffer | null> {
    return async (name: string) => {
        try {
            const data = await invoke<ArrayBuffer | Uint8Array | number[]>('epub_read_entry', { path, name });
            if (data instanceof ArrayBuffer) return data;
            const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
            return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        } catch (error) {
            if (String(error).includes(ENTRY_NOT_FOUND)) return null;
            throw error;
        }
    };
}

export async function tryNativePrefetchEpub(path: string): Promise<PrefetchCache | null> {
    if (!isTauri()) return null;
    try {
        const result: EpubPrefetchResult = await invoke('prefetch_zip_metadata', { path });
        const textCache = new Map<string, string>();

        if (result.container) {
            textCache.set('META-INF/container.xml', result.container);
        }
        if (result.opf_path && result.opf) {
            textCache.set(result.opf_path, result.opf);
        }
        if (result.nav_path && result.nav) {
            textCache.set(result.nav_path, result.nav);
        }
        if (result.ncx_path && result.ncx) {
            textCache.set(result.ncx_path, result.ncx);
        }
        if (result.encryption) {
            textCache.set('META-INF/encryption.xml', result.encryption);
        }
        
        if (result.sections) {
            for (const [href, text] of Object.entries(result.sections)) {
                textCache.set(href, text);
            }
        }

        const sizes = new Map<string, number>(Object.entries(result.sizes));

        return { textCache, sizes, toc: result.toc, readEntry: makeNativeEntryReader(path) };
    } catch {
        return null;
    }
}
