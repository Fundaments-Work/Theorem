import type { Book } from "../types";
import { attachSourceFolder, type FolderScanResult, type ScanIssue, type ScannedBookFile } from "./source-folders";
import { importBooksIncremental, normalizeImportPath, type ImportOptions } from "./import";
import { normalizeFilePath } from "./utils";

/** What a folder import is doing, for the progress line. */
export interface FolderImportProgress {
    phase: "scanning" | "importing";
    /** Files handled so far (imported, failed or already in the library). */
    completed: number;
    /** Files that needed importing. */
    total: number;
}

export interface FolderImportFailure {
    source: string;
    message: string;
}

export interface FolderImportResult {
    /** Supported book files the scan found. */
    found: number;
    imported: number;
    /** Already in the library: same file, or the same bytes elsewhere. */
    alreadyInLibrary: number;
    /** Every file or folder that could not be used, with the reason. */
    failures: FolderImportFailure[];
    cancelled: boolean;
}

export interface FolderImportDeps {
    scan: (root: string, signal?: AbortSignal) => Promise<FolderScanResult>;
    importBooks?: typeof importBooksIncremental;
    getBooks: () => Book[];
    /** Add a batch of books (deduplicating, persisted). */
    addBooks: (books: Book[]) => void;
    /** Apply changes to books already in the library, in one store update. */
    updateBooks: (updates: ReadonlyArray<readonly [string, Partial<Book>]>) => void;
    /** Called with each batch once it is in the library. */
    onBooksAdded?: (books: Book[]) => void;
    onProgress?: (progress: FolderImportProgress) => void;
}

/** Books reach the store in batches, not one `set` per book. */
const FLUSH_INTERVAL_MS = 250;
const FLUSH_MAX_BOOKS = 200;
const PROGRESS_INTERVAL_MS = 100;

function pathKey(path: string): string {
    return normalizeFilePath(normalizeImportPath(path));
}

function issueToFailure(issue: ScanIssue): FolderImportFailure {
    return { source: issue.path, message: issue.reason };
}

/** Readable names for the end-of-import list: a content URI says nothing to a person. */
function sourceNamer(sources: Map<string, ScannedBookFile>) {
    return (source: string): string => {
        if (!/^content:\/\//i.test(source)) return source;
        const file = sources.get(pathKey(source));
        return file ? `${file.rootName}/${file.relativePath}` : source;
    };
}

/**
 * Scan `root` and import the books in it.
 *
 * A rescan is cheap and idempotent: a file already imported from the same
 * path with the same size is skipped without being read, and a file whose
 * bytes are already in the library (moved, renamed or copied) is recognised
 * before it is copied. Every file is either imported or reported with a
 * reason. Aborting `signal` stops scanning and importing; books finished
 * before that stay in the library.
 */
export async function importFolder(
    root: string,
    preserve: boolean,
    deps: FolderImportDeps,
    signal?: AbortSignal,
): Promise<FolderImportResult> {
    const failures: FolderImportFailure[] = [];
    const result: FolderImportResult = { found: 0, imported: 0, alreadyInLibrary: 0, failures, cancelled: false };

    deps.onProgress?.({ phase: "scanning", completed: 0, total: 0 });
    const scan = await deps.scan(root, signal);
    failures.push(...scan.issues.map(issueToFailure));
    result.found = scan.files.length;
    if (scan.cancelled || signal?.aborted) {
        result.cancelled = true;
        return result;
    }

    const library = deps.getBooks();
    const byPath = new Map<string, Book>();
    const byHash = new Map<string, Book>();
    // Copies of a book recorded under this folder (a second copy keeps no path of its own).
    const byFolderPath = new Map<string, Book>();
    for (const book of library) {
        if (book.filePath) byPath.set(pathKey(book.filePath), book);
        if (book.contentHash) byHash.set(book.contentHash.toLowerCase(), book);
        for (const folder of book.sourceFolders ?? []) {
            if (folder.root === root) byFolderPath.set(folder.relativePath, book);
        }
    }

    // Folder locations to add to books that are already in the library.
    const updates = new Map<string, Partial<Book>>();
    const remember = (book: Book, source: ScannedBookFile | undefined, extra: Partial<Book> = {}) => {
        const merged = { ...(updates.get(book.id) ?? {}), ...extra };
        if (preserve && source) {
            const folders = attachSourceFolder({ ...book, ...merged }, source, root, true).sourceFolders ?? [];
            if (folders.length !== (book.sourceFolders?.length ?? 0)) merged.sourceFolders = folders;
        }
        if (Object.keys(merged).length > 0) updates.set(book.id, merged);
    };

    const sources = new Map<string, ScannedBookFile>();
    const toImport: string[] = [];
    const displayName = sourceNamer(sources);
    for (const file of scan.files) {
        const key = pathKey(file.path);
        if (sources.has(key)) continue;
        sources.set(key, file);
        const recorded = byFolderPath.get(file.relativePath);
        const existing = byPath.get(key)
            ?? (recorded && file.size !== undefined && recorded.fileSize === file.size ? recorded : undefined);
        const unchanged = existing && (file.size === undefined || existing.fileSize === file.size);
        if (unchanged) {
            result.alreadyInLibrary += 1;
            remember(existing, file);
        } else {
            toImport.push(file.path);
        }
    }

    // Only books whose size matches a file to import can be duplicates of it.
    const sizes = new Set(scan.files.map((file) => file.size).filter((size) => size !== undefined));
    const known = library
        .filter((book) => book.contentHash && sizes.has(book.fileSize))
        .map((book) => ({ size: book.fileSize, hash: book.contentHash!.toLowerCase() }));

    let pending: Book[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
        if (flushTimer) clearTimeout(flushTimer);
        flushTimer = null;
        if (pending.length === 0) return;
        const batch = pending;
        pending = [];
        deps.addBooks(batch);
        deps.onBooksAdded?.(batch);
    };

    let lastProgressAt = 0;
    const report = (completed: number, total: number, force = false) => {
        const now = Date.now();
        if (!force && now - lastProgressAt < PROGRESS_INTERVAL_MS) return;
        lastProgressAt = now;
        deps.onProgress?.({ phase: "importing", completed, total });
    };
    report(0, toImport.length, true);

    const options: ImportOptions = {
        signal,
        known,
        onProgress: (completed, total) => report(completed, total),
        onDuplicate: (source, contentHash) => {
            result.alreadyInLibrary += 1;
            // The same bytes are in the library, or were imported earlier in this run.
            const existing = byHash.get(contentHash.toLowerCase());
            if (!existing) return;
            const file = sources.get(pathKey(source));
            // A moved or renamed file: follow it, so the next rescan skips it unread.
            const moved = !existing.filePath || !sources.has(pathKey(existing.filePath));
            remember(existing, file, moved ? { filePath: source, fileSize: file?.size ?? existing.fileSize } : {});
        },
    };

    const importBooks = deps.importBooks ?? importBooksIncremental;
    try {
        await importBooks(
            toImport,
            (book) => {
                const added = attachSourceFolder(book, sources.get(pathKey(book.filePath)), root, preserve);
                const hash = added.contentHash?.toLowerCase();
                if (hash && byHash.has(hash)) {
                    // Recognised only after copying (Android): the store merges it
                    // into the book it duplicates and removes the copy's files.
                    options.onDuplicate?.(book.filePath, hash);
                } else {
                    result.imported += 1;
                    if (hash) byHash.set(hash, added);
                }
                pending.push(added);
                if (pending.length >= FLUSH_MAX_BOOKS) flush();
                else if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_INTERVAL_MS);
            },
            (source, error) => {
                failures.push({ source: displayName(source), message: error instanceof Error ? error.message : String(error) });
            },
            options,
        );
    } finally {
        flush();
        if (updates.size > 0) deps.updateBooks([...updates]);
    }

    report(toImport.length, toImport.length, true);
    result.cancelled = signal?.aborted === true;
    return result;
}

/** One short, plain message for the end of a folder import. */
export function describeFolderImport(result: FolderImportResult): { title: string; message: string } | null {
    const { found, imported, alreadyInLibrary, failures, cancelled } = result;
    if (!cancelled && found === 0 && failures.length === 0) {
        return { title: "No Books Found", message: "No supported books were found in the selected folder." };
    }
    if (!cancelled && failures.length === 0) return null;

    const parts = [`${imported} imported`];
    if (alreadyInLibrary > 0) parts.push(`${alreadyInLibrary} already in your library`);
    if (failures.length > 0) parts.push(`${failures.length} could not be imported`);
    let message = `${parts.join(", ")}.`;
    if (failures.length > 0) {
        const preview = failures.slice(0, 5).map((failure) => `- ${failure.source}: ${failure.message}`).join("\n");
        message += `\n\n${preview}`;
        if (failures.length > 5) message += `\n\n(+${failures.length - 5} more)`;
    }
    return { title: cancelled ? "Import Stopped" : "Import Errors", message };
}
