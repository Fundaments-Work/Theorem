import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Blob, Buffer } from 'node:buffer';
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), write: vi.fn(), mkdir: vi.fn(), remove: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/path', () => ({ appDataDir: async () => '/app', join: async (...parts: string[]) => parts.join('/') }));
vi.mock('@tauri-apps/plugin-fs', () => ({ mkdir: mocks.mkdir, writeFile: mocks.write, remove: mocks.remove }));
import { importNativeBookFile } from '../src/core/lib/native-book-import';
beforeEach(() => { vi.resetAllMocks(); mocks.remove.mockResolvedValue(undefined); });
describe('bounded native book upload', () => {
    it('preserves bytes across chunk boundaries without reading the entire file', async () => {
        const bytes = new Uint8Array(2 * 1024 * 1024 + 19);
        for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
        const blob = new Blob([bytes]);
        const wholeRead = vi.spyOn(blob, 'arrayBuffer');
        mocks.invoke.mockResolvedValue({ storagePath: '/book', contentHash: 'hash', format: 'cbz' });
        await importNativeBookFile('id', blob as unknown as globalThis.Blob, 'cbr');
        expect(wholeRead).not.toHaveBeenCalled();
        expect(mocks.write).toHaveBeenCalledTimes(3);
        const reconstructed = new Uint8Array(bytes.length);
        let offset = 0;
        for (const [path, chunk, options] of mocks.write.mock.calls) {
            expect(path).toBe('/app/book-cache/id.import');
            expect(chunk.byteLength).toBeLessThanOrEqual(1024 * 1024);
            expect(options.append).toBe(offset > 0);
            reconstructed.set(chunk, offset); offset += chunk.byteLength;
        }
        expect(Buffer.from(reconstructed).equals(Buffer.from(bytes))).toBe(true);
        expect(mocks.invoke).toHaveBeenCalledWith('finish_book_import', { id: 'id', format: 'cbr', expectedSize: bytes.length });
    });
    it('does not publish a partially written book and cleans up failed uploads', async () => {
        mocks.write.mockRejectedValue(new Error('disk full'));
        await expect(importNativeBookFile('id', new Blob(['abc']) as unknown as globalThis.Blob, 'epub')).rejects.toThrow('disk full');
        expect(mocks.invoke).not.toHaveBeenCalled();
        expect(mocks.remove).toHaveBeenCalledWith('/app/book-cache/id.import');
    });
    it('cleans up conversion failures and rejects empty files', async () => {
        mocks.invoke.mockRejectedValue(new Error('bad archive'));
        await expect(importNativeBookFile('id', new Blob(['bad']) as unknown as globalThis.Blob, 'cbr')).rejects.toThrow('bad archive');
        expect(mocks.remove).toHaveBeenCalledOnce();
        mocks.mkdir.mockClear();
        await expect(importNativeBookFile('id', new Blob([]) as unknown as globalThis.Blob, 'cbr')).rejects.toThrow('Empty');
        expect(mocks.mkdir).not.toHaveBeenCalled();
    });
});
