import { invoke } from "@tauri-apps/api/core";
import { useImportStore, useLibraryStore, type NativeImportSnapshot } from "../store";
import type { Book } from "../types";
import { isAndroid, isTauri } from "./env";
import { getBookFormat, pickBookFiles, extractFilenameFromPath, type ImportOptions } from "./import";

export interface ImportRequest {
    source: string;
    name: string;
    format: string;
    sourceFolder?: { root: string; rootName: string; relativePath: string } | null;
}
interface ResultItem {
    source: string;
    outcome: "saved" | "duplicate" | "failed";
    book: Book | null;
    message: string | null;
}
interface ResultPage { next: number; items: ResultItem[] }
let refreshing: Promise<NativeImportSnapshot> | null = null;
let activeSubmission = false;
let activeCompletion: Promise<Book[]> | null = null;

export function refreshNativeImport(): Promise<NativeImportSnapshot> {
    if (refreshing) return refreshing;
    refreshing = invoke<NativeImportSnapshot>("native_import_snapshot").then((snapshot) => {
        useImportStore.getState().setSnapshot(snapshot);
        return snapshot;
    }).catch((error: unknown) => {
        useImportStore.getState().setError(String(error));
        throw error;
    }).finally(() => { refreshing = null; });
    return refreshing;
}

export function pollNativeImports(): () => void {
    if (!isTauri()) return () => {};
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
        if (stopped || timer !== undefined) return;
        timer = setTimeout(() => {
            timer = undefined;
            void poll();
        }, 500);
    };
    const poll = async () => {
        if (stopped) return;
        let active = false;
        try {
            const snapshot = await refreshNativeImport();
            active = Boolean(snapshot?.active);
        } catch {
            /* Display the retained recovery error in the panel. */
        }
        if (!stopped && active) {
            schedule();
        }
    };
    const handleFocus = () => {
        if (!stopped) void poll();
    };
    if (typeof window !== "undefined") {
        window.addEventListener("focus", handleFocus);
    }
    void poll();
    return () => {
        stopped = true;
        if (timer !== undefined) clearTimeout(timer);
        if (typeof window !== "undefined") {
            window.removeEventListener("focus", handleFocus);
        }
    };
}

function hydrateBook(raw: Book): Book {
    return {
        ...raw,
        addedAt: new Date(raw.addedAt),
        ...(raw.lastReadAt ? { lastReadAt: new Date(raw.lastReadAt) } : {}),
        readingTime: raw.readingTime || 0,
    };
}

async function consumeJob(
    jobId: string,
    onBook?: (book: Book) => void,
    onFailure?: (source: string, error: unknown) => void,
    options: ImportOptions = {},
): Promise<Book[]> {
    const books: Book[] = [];
    if (refreshing) await refreshing.catch(() => undefined);
    let offset = 0;
    const cancel = () => { void invoke("native_import_cancel", { jobId }).catch(() => undefined); };
    options.signal?.addEventListener("abort", cancel, { once: true });
    if (options.signal?.aborted) cancel();
    try {
        while (true) {
            const snapshot = await refreshNativeImport();
            if (snapshot.id === null) { options.onCancelled?.(); return books; }
            if (snapshot.id !== jobId) throw new Error("The import job changed");
            while (offset < snapshot.completed) {
                const page = await invoke<ResultPage>("native_import_results", { jobId, offset, limit: 100 });
                if (page.next <= offset) throw new Error("Import results did not advance");
                offset = page.next;
                for (const item of page.items) {
                    if (item.outcome === "failed") { onFailure?.(item.source, new Error(item.message ?? "Import failed")); continue; }
                    if (!item.book) continue;
                    const book = hydrateBook(item.book);
                    if (item.outcome === "duplicate") {
                        options.onDuplicate?.(item.source, book.contentHash ?? "");
                        const existing = useLibraryStore.getState().getBook(book.id);
                        if (existing && JSON.stringify(existing.sourceFolders) !== JSON.stringify(book.sourceFolders)) {
                            useLibraryStore.getState().updateBook(book.id, { sourceFolders: book.sourceFolders });
                        }
                    } else {
                        books.push(book);
                        if (onBook) onBook(book);
                        else if (!useLibraryStore.getState().getBook(book.id)) useLibraryStore.getState().addBook(book);
                    }
                }
            }
            options.onProgress?.(snapshot.completed, snapshot.total);
            if (!snapshot.active) {
                if (snapshot.resumable) options.onCancelled?.();
                return books;
            }
            await new Promise<void>((resolve) => setTimeout(resolve, 250));
        }
    } finally { options.signal?.removeEventListener("abort", cancel); }
}

async function submitRequests(requests: ImportRequest[], onBook?: (book: Book) => void, onFailure?: (source: string, error: unknown) => void, options: ImportOptions = {}): Promise<Book[]> {
    if (activeSubmission) throw new Error("An import is already running");
    activeSubmission = true;
    try {
        const jobId = await invoke<string>("native_import_start", { requests });
        activeCompletion = consumeJob(jobId, onBook, onFailure, options);
        return await activeCompletion;
    } finally { activeCompletion = null; activeSubmission = false; }
}

export async function importPathsAsNativeJob(
    paths: string[],
    onBook?: (book: Book) => void,
    onFailure?: (source: string, error: unknown) => void,
    options: ImportOptions = {},
): Promise<Book[]> {
    if (options.signal?.aborted) { options.onCancelled?.(); return []; }
    const requests = paths.map((source): ImportRequest => {
        const name = extractFilenameFromPath(options.sourceNames?.[source] ?? source);
        const format = getBookFormat(name);
        if (!format) throw new Error(`Unsupported book: ${name}`);
        return { source, name, format, sourceFolder: options.sourceFolders?.[source] ?? null };
    });
    if (!requests.length) return [];
    return submitRequests(requests, onBook, onFailure, options);
}

export async function pickAndImportNativeJob(onBook?: (book: Book) => void, onFailure?: (source: string, error: unknown) => void): Promise<Book[]> {
    if (activeSubmission) throw new Error("An import is already running");
    if (!isAndroid()) return importPathsAsNativeJob(await pickBookFiles(), onBook, onFailure);
    const documents = await invoke<{ source: string; name: string }[]>("pick_native_import_documents");
    const requests = documents.map((document): ImportRequest => {
        const format = getBookFormat(document.name);
        if (!format) throw new Error(`Unsupported book: ${document.name}`);
        return { ...document, format, sourceFolder: null };
    });
    if (!requests.length) return [];
    return submitRequests(requests, onBook, onFailure);
}

export async function resumeNativeImport(): Promise<void> {
    const previous = await refreshNativeImport();
    if (!previous.id) throw new Error("There is no pending import");
    if (previous.active) throw new Error("An import is already running");
    if (activeCompletion) await activeCompletion.catch(() => undefined);
    if (activeSubmission) throw new Error("An import is already running");
    activeSubmission = true;
    let completion: Promise<Book[]> | null = null;
    try {
        const jobId = await invoke<string>("native_import_resume", { jobId: previous.id });
        completion = consumeJob(jobId);
        activeCompletion = completion;
        void completion.catch((error: unknown) => useImportStore.getState().setError(String(error))).finally(() => {
            if (activeCompletion === completion) { activeCompletion = null; activeSubmission = false; }
        });
        await refreshNativeImport();
    } catch (error) {
        if (!completion) activeSubmission = false;
        throw error;
    }
}

export async function stopNativeImport(): Promise<void> {
    const snapshot = await refreshNativeImport();
    if (!snapshot.active || !snapshot.id) return;
    await invoke("native_import_cancel", { jobId: snapshot.id });
    await refreshNativeImport();
}

export async function discardNativeImport(): Promise<void> {
    const snapshot = await refreshNativeImport();
    if (snapshot.active) throw new Error("Stop the import before discarding pending work");
    if (!snapshot.id) return;
    if (activeCompletion) await activeCompletion.catch(() => undefined);
    await consumeJob(snapshot.id);
    await invoke("native_import_discard", { jobId: snapshot.id });
    await refreshNativeImport();
}
