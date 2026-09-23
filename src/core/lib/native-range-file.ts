import { invoke } from "@tauri-apps/api/core";

/**
 * A read-only, Blob-like view of a file on disk that reads byte ranges on
 * demand (desktop/mobile). EPUB/CBZ go through zip.js, which only needs
 * `size`, `slice()` and `arrayBuffer()`, and reads just the central directory
 * plus the entries actually opened. Passing this instead of a Blob keeps the
 * whole book (tens of MB for illustrated EPUBs) out of the WebView heap; the
 * PDF path already reads ranges the same way.
 *
 * Deliberately not a Blob subclass: native Blob internals (new File([b]),
 * FileReader, Response) would see an empty blob instead of failing loudly.
 */
export class NativeRangeFile {
    readonly isNativeRangeFile = true;

    constructor(
        readonly path: string,
        readonly name: string,
        readonly type: string,
        private readonly start: number,
        private readonly end: number,
    ) {}

    get size(): number {
        return Math.max(0, this.end - this.start);
    }

    /** Blob.slice semantics: relative, clamped, negative offsets count from the end. */
    slice(start = 0, end = this.size, contentType = this.type): NativeRangeFile {
        const size = this.size;
        const relStart = start < 0 ? Math.max(size + start, 0) : Math.min(start, size);
        const relEnd = end < 0 ? Math.max(size + end, 0) : Math.min(end, size);
        const from = this.start + relStart;
        const to = this.start + Math.max(relStart, relEnd);
        return new NativeRangeFile(this.path, this.name, contentType, from, to);
    }

    async arrayBuffer(): Promise<ArrayBuffer> {
        if (this.size === 0) return new ArrayBuffer(0);
        const data = await invoke<ArrayBuffer | Uint8Array | number[]>("read_pdf_range", {
            path: this.path,
            offset: this.start,
            length: this.size,
        });
        if (data instanceof ArrayBuffer) return data;
        const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    }

    async text(): Promise<string> {
        return new TextDecoder().decode(await this.arrayBuffer());
    }
}

/** What the reflowable reader can open. */
export type BookSource = File | Blob | NativeRangeFile;

export function isNativeRangeFile(value: unknown): value is NativeRangeFile {
    return typeof value === "object" && value !== null && (value as NativeRangeFile).isNativeRangeFile === true;
}

/** Open `path` for ranged reads; null if it does not exist or is empty. */
export async function openNativeRangeFile(path: string, name: string, type: string): Promise<NativeRangeFile | null> {
    try {
        const size = await invoke<number>("read_pdf_file_size", { path });
        if (!Number.isFinite(size) || size <= 0) return null;
        return new NativeRangeFile(path, name, type, 0, size);
    } catch {
        return null;
    }
}
