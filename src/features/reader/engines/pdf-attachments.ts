/**
 * Files embedded in a PDF. pdf.js 6 `getAttachments()` returns a `Map` of
 * metadata; the bytes come from `getAttachmentContent(key)` on demand.
 */

export interface PdfAttachmentInfo {
    /** Key in the `getAttachments()` map; `getAttachmentContent(key)` returns the bytes. */
    key: string;
    /** Safe file name to save under. */
    name: string;
    /** Only when pdf.js already holds the bytes; not read just to show a size. */
    size?: number;
    description?: string;
}

interface RawAttachment {
    filename?: unknown;
    rawFilename?: unknown;
    content?: unknown;
    description?: unknown;
}

/**
 * File name safe to offer in a save dialog: last path component only (PDF
 * file specs may carry `dir/name` or `C:\dir\name`), no control characters,
 * never empty, "." or "..".
 */
export function safeAttachmentName(raw: unknown, fallback: string): string {
    const text = typeof raw === "string" ? raw : "";
    const base = text.split(/[\\/]/).pop() ?? "";
    // eslint-disable-next-line no-control-regex
    const cleaned = base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_").trim();
    return cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : fallback;
}

function entriesOf(raw: unknown): [string, RawAttachment][] {
    if (raw instanceof Map) return [...raw.entries()] as [string, RawAttachment][];
    if (raw && typeof raw === "object") return Object.entries(raw as Record<string, RawAttachment>);
    return [];
}

const firstName = (...candidates: unknown[]) =>
    candidates.find((c) => typeof c === "string" && c.trim() !== "");

/** Sorted, display-ready list; empty for `null` or malformed input. */
export function listPdfAttachments(raw: unknown): PdfAttachmentInfo[] {
    const list: PdfAttachmentInfo[] = [];
    for (const [key, value] of entriesOf(raw)) {
        if (!value || typeof value !== "object") continue;
        const content = value.content;
        const size = content instanceof Uint8Array ? content.byteLength : undefined;
        const description = typeof value.description === "string" && value.description.trim()
            ? value.description.trim()
            : undefined;
        list.push({
            key,
            name: safeAttachmentName(firstName(value.filename, value.rawFilename, key), `attachment-${list.length + 1}`),
            size,
            description,
        });
    }
    return list.sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
}

/** Bytes already inlined in a `getAttachments()` result, or `null`. */
export function attachmentBytes(raw: unknown, key: string): Uint8Array | null {
    const value = entriesOf(raw).find(([k]) => k === key)?.[1];
    return value && value.content instanceof Uint8Array ? value.content : null;
}

export function formatAttachmentSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
