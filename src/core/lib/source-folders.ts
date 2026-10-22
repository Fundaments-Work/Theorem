import type { Book, BookSourceFolder } from "../types";

export interface ScannedBookFile {
    path: string;
    relativePath: string;
    rootName: string;
    /** Size in bytes, when the scanner could read it. */
    size?: number;
    /** Last modification time (Unix ms), when known. */
    modifiedMs?: number;
}

/** A folder or book file a scan could not use, and why. */
export interface ScanIssue {
    path: string;
    reason: string;
}

export interface FolderScanResult {
    files: ScannedBookFile[];
    issues: ScanIssue[];
    /** The scan stopped before it finished. */
    cancelled: boolean;
}

/** Accept the current scanner result or the older plain list of files. */
export function normalizeFolderScan(value: unknown): FolderScanResult {
    if (Array.isArray(value)) return { files: value as ScannedBookFile[], issues: [], cancelled: false };
    const scan = (value ?? {}) as Partial<FolderScanResult>;
    return {
        files: Array.isArray(scan.files) ? scan.files : [],
        issues: Array.isArray(scan.issues) ? scan.issues : [],
        cancelled: scan.cancelled === true,
    };
}

/** Apply scan metadata only when preservation was explicitly selected. */
export function attachSourceFolder(book: Book, source: ScannedBookFile | undefined, root: string, preserve: boolean): Book {
    if (!preserve || !source || !validRelativeBookPath(source.relativePath)) return book;
    return { ...book, sourceFolders: mergeSourceFolders(book.sourceFolders,
        [{ root, name: source.rootName, relativePath: source.relativePath }]) };
}

export interface SourceFolderSelection {
    root: string;
    path: string;
}

export function validRelativeBookPath(path: unknown): path is string {
    return typeof path === "string" && path.length > 0
        && !path.startsWith("/") && !path.includes("\\")
        && !/^[a-zA-Z]:/.test(path)
        && path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

export function normalizeSourceFolders(value: unknown): BookSourceFolder[] {
    if (!Array.isArray(value)) return [];
    const result: BookSourceFolder[] = [];
    const seen = new Set<string>();
    for (const entry of value) {
        if (!entry || typeof entry.root !== "string" || !entry.root
            || !validRelativeBookPath(entry.relativePath)) continue;
        const key = JSON.stringify([entry.root, entry.relativePath]);
        if (seen.has(key)) continue;
        seen.add(key);
        result.push({ root: entry.root, name: typeof entry.name === "string" && entry.name ? entry.name : entry.root,
            relativePath: entry.relativePath });
    }
    return result;
}

export function mergeSourceFolders(existing: BookSourceFolder[] = [], incoming: BookSourceFolder[] = []): BookSourceFolder[] {
    return normalizeSourceFolders([...existing, ...incoming]);
}

/** Build the folder navigation index once when library metadata changes. */
export function buildSourceFolderIndex(books: Book[]) {
    const roots = new Map<string, { name: string; folders: Map<string, Set<string>> }>();
    for (const book of books) {
        for (const source of book.sourceFolders ?? []) {
            let root = roots.get(source.root);
            if (!root) {
                root = { name: source.name, folders: new Map() };
                roots.set(source.root, root);
            }
            const parts = source.relativePath.split("/");
            parts.pop();
            for (let depth = 0; depth <= parts.length; depth++) {
                const path = parts.slice(0, depth).join("/");
                let ids = root.folders.get(path);
                if (!ids) { ids = new Set(); root.folders.set(path, ids); }
                ids.add(book.id);
            }
        }
    }
    return roots;
}
