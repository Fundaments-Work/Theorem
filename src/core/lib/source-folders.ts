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

const CONTENT_URI = /^content:\/\//i;

/**
 * The readable location inside an Android tree URI
 * (`…/tree/primary%3ABooks%2FScan` → `Books/Scan`, `…/tree/1A2B-3C4D%3AScan`
 * → `1A2B-3C4D: Scan`), or null when it cannot be decoded.
 */
function androidTreeLocation(uri: string): string | null {
    const match = /\/tree\/([^/?#]+)/.exec(uri);
    if (!match) return null;
    let documentId: string;
    try {
        documentId = decodeURIComponent(match[1]);
    } catch {
        return null;
    }
    const colon = documentId.indexOf(":");
    if (colon < 0) return documentId || null;
    const volume = documentId.slice(0, colon);
    const path = documentId.slice(colon + 1);
    if (volume === "primary") return path || "Internal storage";
    return path ? `${volume}: ${path}` : volume;
}

/**
 * What the source-folder picker shows for a scanned root. An Android folder is
 * keyed by its content URI, which means nothing to a person: it is shown by
 * its name, with its readable location only when another root has the same
 * name. A desktop folder keeps its path, which is readable.
 */
export function sourceFolderRootLabel(root: string, name: string, duplicateName: boolean): string {
    if (CONTENT_URI.test(root)) {
        const location = androidTreeLocation(root);
        // Records without a name fell back to the root URI itself.
        const readableName = name && !CONTENT_URI.test(name) ? name : "";
        if (!readableName) return location ?? "Folder";
        return duplicateName && location ? `${readableName} (${location})` : readableName;
    }
    return name && name !== root ? `${name} — ${root}` : root;
}

/** Picker entries for every root in the index, keyed by the stable root. */
export function sourceFolderRootOptions(index: ReturnType<typeof buildSourceFolderIndex>): { root: string; label: string }[] {
    const nameCounts = new Map<string, number>();
    for (const { name } of index.values()) nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
    return [...index].map(([root, { name }]) => ({
        root,
        label: sourceFolderRootLabel(root, name, (nameCounts.get(name) ?? 0) > 1),
    }));
}
