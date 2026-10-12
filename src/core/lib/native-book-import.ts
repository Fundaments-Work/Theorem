import { invoke } from '@tauri-apps/api/core';
import { appDataDir, join } from '@tauri-apps/api/path';
import { mkdir, writeFile, remove } from '@tauri-apps/plugin-fs';
import type { BookFormat } from '../types';

const CHUNK_BYTES = 1024 * 1024;
export interface ImportedBinary {
    storagePath: string; contentHash: string; format: BookFormat;
    metadata?: { title: string; author: string; coverDataUrl?: string; series?: string; seriesIndex?: number } | null;
}

/** Upload only one small slice at a time; never materialize the whole File. */
export async function importNativeBookFile(id: string, file: Blob, format: BookFormat): Promise<ImportedBinary> {
    if (!file.size) throw new Error('Empty book file');
    const directory = await join(await appDataDir(), 'book-cache');
    await mkdir(directory, { recursive: true });
    const temporary = await join(directory, `${id}.import`);
    try {
        for (let offset = 0; offset < file.size; offset += CHUNK_BYTES) {
            const bytes = new Uint8Array(await file.slice(offset, offset + CHUNK_BYTES).arrayBuffer());
            await writeFile(temporary, bytes, { append: offset > 0 });
        }
        return await invoke<ImportedBinary>('finish_book_import', { id, format, expectedSize: file.size });
    } catch (error) {
        await remove(temporary).catch(() => undefined);
        throw error;
    }
}
