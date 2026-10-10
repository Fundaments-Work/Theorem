import { beforeEach, describe, expect, it, vi } from "vitest";
import { zipSync, unzipSync } from "fflate";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), save: vi.fn(), read: vi.fn(), stat: vi.fn(), upload: vi.fn(), cover: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("../src/core/lib/env", () => ({ isTauri: () => true, isMobile: () => false }));
vi.mock("../src/core/lib/storage", () => ({ saveBookData: mocks.save, getBookData: mocks.read, saveCoverDataUrl: mocks.cover }));
vi.mock("@tauri-apps/plugin-fs", () => ({ stat: mocks.stat }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("../src/core/lib/native-book-import", () => ({ importNativeBookFile: mocks.upload }));
import { readCbrAsCbz } from "../src/core/lib/cbr";
import { createBookEntry, createBookEntryFromFile } from "../src/core/lib/import";
const page = new Uint8Array([1, 2, 3, 4]);
const zip = zipSync({ "nested/page.png": page });
const archive = new Uint8Array([0x52,0x61,0x72,0x21,0x1a,7,1,0]).buffer;
beforeEach(() => {
    vi.resetAllMocks();
    mocks.save.mockResolvedValue("/cache/comic.book");
    mocks.cover.mockImplementation(async (_id: string, cover: string) => cover);
    mocks.read.mockResolvedValue(archive);
    mocks.stat.mockResolvedValue({ size: archive.byteLength });
});
describe("CBR binary conversion and import", () => {
    it.each(["ArrayBuffer", "typed view", "byte array"])("preserves exact ZIP contents from a %s response", async (kind) => {
        const padded = new Uint8Array(zip.length + 8); padded.set(zip, 4);
        const raw = kind === "ArrayBuffer" ? zip.slice().buffer : kind === "byte array" ? [...zip] : padded.subarray(4,4+zip.length);
        mocks.invoke.mockResolvedValue(raw);
        const converted = await readCbrAsCbz("/cache/comic.book");
        expect(converted.byteLength).toBe(zip.length);
        expect(unzipSync(new Uint8Array(converted))["nested/page.png"]).toEqual(page);
    });
    it("stores converted bytes, not undefined, for Android path imports", async () => {
        mocks.invoke.mockResolvedValue(zip.slice().buffer);
        const book = await createBookEntry("/storage/comic.cbr");
        expect(book?.format).toBe("cbz");
        const stored = mocks.save.mock.calls[1][1] as ArrayBuffer;
        expect(unzipSync(new Uint8Array(stored))["nested/page.png"]).toEqual(page);
    });
    it("converts native File-picker imports before publishing the book", async () => {
        mocks.upload.mockResolvedValue({ storagePath: '/cache/comic.book', contentHash: 'hash', format: 'cbz' });
        const readWholeFile = vi.fn(() => Promise.resolve(archive));
        const file = { name: "comic.cbr", size: archive.byteLength, arrayBuffer: readWholeFile } as unknown as File;
        const book = await createBookEntryFromFile(file);
        expect(book?.format).toBe("cbz");
        expect(book?.contentHash).toBe('hash');
        expect(mocks.upload).toHaveBeenCalledWith(book?.id, file, 'cbr');
        expect(readWholeFile).not.toHaveBeenCalled();
        expect(mocks.save).not.toHaveBeenCalled();
    });
    it("publishes native comic metadata and cover without scheduling whole-archive extraction", async () => {
        mocks.upload.mockResolvedValue({ storagePath: '/cache/comic.book', contentHash: 'hash', format: 'cbz',
            metadata: { title: 'Comic title', author: 'Author', coverDataUrl: 'data:image/jpeg;base64,YQ==', series: 'Series', seriesIndex: 2 } });
        const file = { name: 'comic.cbr', size: 1024 } as File;
        const book = await createBookEntryFromFile(file);
        expect(book).toMatchObject({ title: 'Comic title', author: 'Author', series: 'Series', seriesIndex: 2,
            coverPath: 'data:image/jpeg;base64,YQ==', coverExtractionDone: true, format: 'cbz' });
        expect(mocks.cover).toHaveBeenCalledWith(book?.id, 'data:image/jpeg;base64,YQ==');
    });
    it("uses a small fallback cover when native comic metadata has no usable cover", async () => {
        mocks.upload.mockResolvedValue({ storagePath: '/cache/comic.book', contentHash: 'hash', format: 'cbz',
            metadata: { title: '', author: '' } });
        const book = await createBookEntryFromFile({ name: 'comic.cbr', size: 1024 } as File);
        expect(book?.title).toBe('comic');
        expect(book?.coverPath).toMatch(/^data:image\/svg\+xml,/);
        expect(book?.coverExtractionDone).toBe(true);
        expect(mocks.cover).toHaveBeenCalledWith(book?.id, book?.coverPath);
    });
    it.each([undefined, new ArrayBuffer(0), new Uint8Array([0x50,0x4b,5,6]).buffer])("rejects missing, empty or entryless conversion data", async (raw) => {
        mocks.invoke.mockResolvedValue(raw);
        await expect(createBookEntry("/storage/comic.cbr")).rejects.toThrow(/CBR conversion failed/);
        expect(mocks.save).toHaveBeenCalledTimes(1);
    });
});
