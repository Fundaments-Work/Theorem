import { isTauri, isTauriDesktop, isTauriMobile } from "./env";
import { getBookBlob } from "./storage";
import { showSaveFileDialog, showOpenDirectoryDialog } from "./dialogs";
import type { Book, BookFormat } from "../types";

export const BOOK_FORMAT_EXTENSIONS: Record<BookFormat, string> = {
    epub: "epub",
    mobi: "mobi",
    azw: "azw",
    azw3: "azw3",
    fb2: "fb2",
    cbz: "cbz",
    cbr: "cbr",
    pdf: "pdf",
};

export interface ExportResult {
    ok: boolean;
    message?: string;
}

function sanitizeFilenamePart(value: string): string {
    return value.replace(/[/\\?%*:|"<>]/g, "").trim();
}

export function buildExportFilename(book: Book, suffix?: number): string {
    const base = sanitizeFilenamePart(book.title) || "Untitled";
    const ext = BOOK_FORMAT_EXTENSIONS[book.format] || "epub";
    return suffix && suffix > 1 ? `${base} (${suffix}).${ext}` : `${base}.${ext}`;
}

function blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
            const result = reader.result as string;
            resolve(result.split(",")[1]);
        };
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

async function triggerBrowserDownload(blob: Blob, filename: string): Promise<void> {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }, 1000);
}

async function writeOnDesktop(path: string, blob: Blob): Promise<void> {
    const { writeFile } = await import("@tauri-apps/plugin-fs");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    await writeFile(path, bytes);
}

async function writeOnMobile(filename: string, blob: Blob): Promise<void> {
    const { invoke } = await import("@tauri-apps/api/core");
    const base64Data = await blobToBase64(blob);
    await invoke("save_file_mobile", { filename, base64Data });
}

/**
 * Save arbitrary bytes the way book export does: desktop save dialog, Android
 * Downloads/Theorem, browser download.
 */
export async function saveFileAs(filename: string, blob: Blob): Promise<ExportResult> {
    try {
        if (isTauriMobile()) {
            await writeOnMobile(filename, blob);
            return { ok: true, message: `Saved "${filename}" to Downloads/Theorem` };
        }
        if (isTauriDesktop()) {
            const path = await showSaveFileDialog({ title: "Save File", defaultPath: filename });
            if (!path) return { ok: false, message: "Save cancelled" };
            await writeOnDesktop(path, blob);
            return { ok: true, message: `Saved to ${path}` };
        }
        await triggerBrowserDownload(blob, filename);
        return { ok: true, message: `Downloaded "${filename}"` };
    } catch (e) {
        return { ok: false, message: String(e instanceof Error ? e.message : e) };
    }
}

async function resolveExportBlob(book: Book): Promise<Blob> {
    if (book.syncedWithoutFile) {
        const { downloadBookOnDemand } = await import("./sync-orchestrator");
        const downloaded = await downloadBookOnDemand(book.id);
        if (!downloaded) {
            throw new Error("This book's file is not on this device yet and no peer is available. Please sync with a device that has it, then try again.");
        }
    }
    const blob = await getBookBlob(book.id, book.storagePath ?? book.filePath);
    if (!blob || blob.size === 0) {
        throw new Error("Book file is unavailable (no bytes found in app storage).");
    }
    return blob;
}

export async function exportBook(book: Book): Promise<ExportResult> {
    try {
        const blob = await resolveExportBlob(book);
        const filename = buildExportFilename(book);

        if (isTauriMobile()) {
            await writeOnMobile(filename, blob);
            return { ok: true, message: `Exported "${filename}" to Downloads/Theorem` };
        }

        if (isTauriDesktop()) {
            const path = await showSaveFileDialog({
                title: "Export Book",
                defaultPath: filename,
                filters: [{ name: book.format.toUpperCase(), extensions: [BOOK_FORMAT_EXTENSIONS[book.format]] }],
            });
            if (!path) {
                return { ok: false, message: "Export cancelled" };
            }
            await writeOnDesktop(path, blob);
            return { ok: true, message: `Exported to ${path}` };
        }

        await triggerBrowserDownload(blob, filename);
        return { ok: true, message: `Downloaded "${filename}"` };
    } catch (e) {
        return { ok: false, message: String(e instanceof Error ? e.message : e) };
    }
}

export async function exportBooks(books: Book[]): Promise<{ succeeded: number; failed: { title?: string; reason: string }[] }> {
    const results = {
        succeeded: 0,
        failed: [] as { title?: string; reason: string }[],
    };

    if (books.length === 0) return results;

    if (isTauri() && !isTauriMobile()) {
        const dirPath = await showOpenDirectoryDialog({ title: "Choose Export Folder" });
        if (!dirPath) {
            results.failed.push({ reason: "Export cancelled" });
            return results;
        }

        const usedNames = new Set<string>();
        for (const book of books) {
            try {
                const blob = await resolveExportBlob(book);
                let filename = buildExportFilename(book);
                let suffix = 2;
                while (usedNames.has(filename.toLowerCase())) {
                    filename = buildExportFilename(book, suffix++);
                }
                usedNames.add(filename.toLowerCase());

                const { join } = await import("@tauri-apps/api/path");
                const target = await join(dirPath, filename);
                await writeOnDesktop(target, blob);
                results.succeeded++;
            } catch (e) {
                results.failed.push({
                    title: book.title,
                    reason: e instanceof Error ? e.message : String(e),
                });
            }
        }
        return results;
    }

    for (const book of books) {
        try {
            const blob = await resolveExportBlob(book);
            const filename = buildExportFilename(book);
            if (isTauriMobile()) {
                await writeOnMobile(filename, blob);
            } else {
                await triggerBrowserDownload(blob, filename);
            }
            results.succeeded++;
        } catch (e) {
            results.failed.push({
                title: book.title,
                reason: e instanceof Error ? e.message : String(e),
            });
        }
    }

    return results;
}