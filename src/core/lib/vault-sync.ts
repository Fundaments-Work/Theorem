import { isTauri } from "./env";
import {
    useLibraryStore,
    useRssStore,
    useSettingsStore,
    useUIStore,
    useVocabularyStore,
} from "../store";
import type {
    Annotation,
    Book,
    RssArticle,
    VaultIntegrationSettings,
    VocabularyTerm,
} from "../types";

const DEFAULT_HIGHLIGHTS_FOLDER_NAME = "Books";
const DEFAULT_VOCABULARY_FILE_NAME = "Vocabulary.md";
const MAX_BOOK_PAGE_FILE_NAME_LENGTH = 180;
let tauriFs: typeof import("@tauri-apps/plugin-fs") | null = null;

export type VaultSyncResult =
    | { status: "synced"; message: string; filePaths: string[] }
    | { status: "skipped"; message: string }
    | { status: "error"; message: string };

interface SyncVaultMarkdownParams {
    books: Book[];
    annotations: Annotation[];
    vocabularyTerms: VocabularyTerm[];
    rssArticles?: RssArticle[];
    settings: VaultIntegrationSettings;
}

interface AppendAnnotationParams {
    annotation: Annotation;
    book?: Book;
    settings: VaultIntegrationSettings;
}

interface ExportSource {
    id: string;
    title: string;
    author: string;
    format: string;
    filePath: string;
}

interface ExportBookPage {
    source: ExportSource;
    annotations: Annotation[];
    fileName: string;
    absolutePath: string;
}

async function getTauriFs() {
    if (tauriFs) {
        return tauriFs;
    }
    tauriFs = await import("@tauri-apps/plugin-fs");
    return tauriFs;
}

function toSingleLineText(value: string | undefined, fallback = ""): string {
    const normalized = (value || "").replace(/\s+/g, " ").trim();
    return normalized || fallback;
}

function toMultilineText(value: string | undefined): string {
    return (value || "").replace(/\r\n/g, "\n").trim();
}

function toYamlString(value: string): string {
    const escaped = value
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/\n/g, "\\n");
    return `"${escaped}"`;
}

function normalizeMarkdownFileName(value: string, fallback: string): string {
    const candidate = value.trim() || fallback;
    const withExtension = candidate.toLowerCase().endsWith(".md")
        ? candidate
        : `${candidate}.md`;
    return withExtension.replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-");
}

function normalizeFolderName(value: string, fallback: string): string {
    const candidate = value.trim() || fallback;
    const cleaned = candidate
        .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-")
        .replace(/\.+$/g, "")
        .trim();
    return cleaned || fallback;
}

function normalizeFileSegment(value: string, fallback: string): string {
    const singleLine = toSingleLineText(value, fallback);
    const cleaned = singleLine
        .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-")
        .replace(/\.+$/g, "")
        .trim();
    return cleaned || fallback;
}

function normalizeDirectoryPath(value: string): string {
    const candidate = value.trim();
    if (!candidate.startsWith("file://")) {
        return candidate;
    }

    try {
        const url = new URL(candidate);
        if (url.protocol !== "file:") {
            return candidate;
        }

        const decodedPath = decodeURIComponent(url.pathname);
        if (url.host) {
            return `//${url.host}${decodedPath}`;
        }

        if (/^\/[A-Za-z]:\//.test(decodedPath)) {
            return decodedPath.slice(1);
        }

        return decodedPath;
    } catch {
        return candidate;
    }
}

function toShortHash(input: string): string {
    let hash = 2166136261;
    for (let index = 0; index < input.length; index += 1) {
        hash ^= input.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
}

function truncateSegment(value: string, maxLength: number): string {
    if (value.length <= maxLength) {
        return value;
    }
    return value.slice(0, maxLength).trim();
}

function clampFileNameLength(fileName: string, maxLength: number): string {
    if (fileName.length <= maxLength) {
        return fileName;
    }

    const extension = ".md";
    const withoutExtension = fileName.endsWith(extension)
        ? fileName.slice(0, -extension.length)
        : fileName;
    const clampedBase = withoutExtension.slice(0, Math.max(8, maxLength - extension.length)).trim();
    return `${clampedBase}${extension}`;
}

function toErrorMessage(error: unknown, fallback: string): string {
    if (error instanceof Error) {
        const message = error.message.trim();
        if (message) {
            return message;
        }
    }

    if (typeof error === "string") {
        const message = error.trim();
        if (message) {
            return message;
        }
    }

    if (typeof error === "object" && error !== null) {
        const candidate = Reflect.get(error, "message");
        if (typeof candidate === "string" && candidate.trim()) {
            return candidate.trim();
        }

        try {
            const serialized = JSON.stringify(error);
            if (serialized && serialized !== "{}") {
                return serialized;
            }
        } catch {
            
        }
    }

    return fallback;
}

function removeMarkdownExtension(fileName: string): string {
    return fileName.replace(/\.md$/i, "");
}

function joinPath(basePath: string, part: string): string {
    const separator = basePath.includes("\\") ? "\\" : "/";
    const trimmedBase = basePath.endsWith("/") || basePath.endsWith("\\")
        ? basePath.slice(0, -1)
        : basePath;
    return `${trimmedBase}${separator}${part}`;
}


function toHighlightedQuote(quote: string): string {
    const trimmed = quote.trim();
    if (!trimmed) return "";
    return trimmed
        .split("\n")
        .map((line) => line ? `> ==${line}==` : ">")
        .join("\n");
}

function getHighlightAnnotations(annotations: Annotation[]): Annotation[] {
    return annotations.filter((annotation) => annotation.type === "highlight" || annotation.type === "note");
}

function sortAnnotations(annotations: Annotation[]): Annotation[] {
    return [...annotations].sort((left, right) => {
        const leftTime = new Date(left.createdAt).getTime();
        const rightTime = new Date(right.createdAt).getTime();
        if (leftTime !== rightTime) {
            return leftTime - rightTime;
        }
        return left.id.localeCompare(right.id);
    });
}

function buildFallbackSource(bookId: string): ExportSource {
    const sourceId = toSingleLineText(bookId, "unknown-source");

    if (sourceId.startsWith("rss:")) {
        return {
            id: sourceId,
            title: "RSS Article",
            author: "Unknown Author",
            format: "rss",
            filePath: "",
        };
    }

    return {
        id: sourceId,
        title: "Untitled Document",
        author: "Unknown Author",
        format: "unknown",
        filePath: "",
    };
}

function buildExportSource(
    bookId: string,
    booksById: Map<string, Book>,
    rssArticlesById: Map<string, RssArticle>,
): ExportSource {
    const rssArticleId = bookId.startsWith("rss:")
        ? toSingleLineText(bookId.slice("rss:".length))
        : "";
    const rssArticle = rssArticleId ? rssArticlesById.get(rssArticleId) : undefined;

    const book = booksById.get(bookId);
    if (book) {
        const defaultTitle = toSingleLineText(book.title, "Untitled Source");
        const fallbackTitle = toSingleLineText(rssArticle?.title, defaultTitle);
        const isSyntheticRssTitle = defaultTitle === bookId || /^RSS Article(\s|$)/i.test(defaultTitle);

        return {
            id: book.id,
            title: isSyntheticRssTitle ? fallbackTitle : defaultTitle,
            author: toSingleLineText(rssArticle?.author, toSingleLineText(book.author, "Unknown Author")),
            format: book.format,
            filePath: toSingleLineText(rssArticle?.url, toSingleLineText(book.filePath, "")),
        };
    }

    if (rssArticle) {
        return {
            id: bookId,
            title: toSingleLineText(rssArticle.title, "RSS Article"),
            author: toSingleLineText(rssArticle.author, "Unknown Author"),
            format: "rss",
            filePath: toSingleLineText(rssArticle.url, ""),
        };
    }

    return buildFallbackSource(bookId);
}

function buildUniqueFileName(
    source: ExportSource,
    usedNames: Set<string>,
): string {
    const safeTitle = truncateSegment(
        normalizeFileSegment(source.title, "Untitled Source"),
        80,
    );
    const safeAuthor = truncateSegment(
        normalizeFileSegment(source.author, "Unknown Author"),
        48,
    );
    const idSeed = normalizeFileSegment(source.id, "source");
    const shortId = toShortHash(idSeed || `${safeTitle}:${safeAuthor}`);
    const base = `${safeTitle} - ${safeAuthor} (${shortId})`;
    let candidate = clampFileNameLength(`${base}.md`, MAX_BOOK_PAGE_FILE_NAME_LENGTH);
    let index = 2;

    while (usedNames.has(candidate.toLowerCase())) {
        candidate = clampFileNameLength(`${base} ${index}.md`, MAX_BOOK_PAGE_FILE_NAME_LENGTH);
        index += 1;
    }

    usedNames.add(candidate.toLowerCase());
    return candidate;
}

export function buildBookPageMarkdown(
    source: ExportSource,
    annotations: Annotation[],
    _generatedAt?: string,
): string {
    const sorted = sortAnnotations(annotations);

    const lines: string[] = [
        "---",
        `title: ${toYamlString(source.title)}`,
        `type: ${toYamlString("theorem-book-highlights")}`,
        `author: ${toYamlString(source.author)}`,
        `total_highlights: ${sorted.length}`,
        "tags:",
        "  - theorem",
        "  - highlights",
        "---",
        "",
        `# ${source.title}`,
    ];

    if (source.author && source.author !== "Unknown Author") {
        lines.push(`*${source.author}*`);
    }

    lines.push(
        "",
        "## Highlights",
        "",
    );

    if (sorted.length === 0) {
        lines.push("_No highlights yet._", "");
        return lines.join("\n");
    }

    sorted.forEach((annotation) => {
        const quote = toMultilineText(annotation.selectedText);
        const note = toMultilineText(annotation.noteContent);

        if (quote) {
            lines.push(toHighlightedQuote(quote));
            lines.push("");
        }

        if (note) {
            lines.push(note);
            lines.push("");
        }
    });

    return lines.join("\n");
}

function collectDefinitions(term: VocabularyTerm): string[] {
    const definitions: string[] = [];
    const seen = new Set<string>();

    for (const meaning of term.meanings) {
        for (const definition of meaning.definitions) {
            const normalized = toSingleLineText(definition);
            if (!normalized) {
                continue;
            }
            if (seen.has(normalized)) {
                continue;
            }
            seen.add(normalized);
            definitions.push(normalized);
        }
    }

    return definitions;
}

export function buildVocabularyMarkdown(terms: VocabularyTerm[], generatedAt: string): string {
    const sortedTerms = [...terms].sort((left, right) => left.term.localeCompare(right.term));
    const languages = Array.from(
        new Set(sortedTerms.map((term) => toSingleLineText(term.language)).filter(Boolean)),
    ).sort((left, right) => left.localeCompare(right));

    const lines: string[] = [
        "---",
        `title: ${toYamlString("Theorem Vocabulary")}`,
        `type: ${toYamlString("theorem-vocabulary")}`,
        `generated_at: ${toYamlString(generatedAt)}`,
        `terms_total: ${sortedTerms.length}`,
        "languages:",
        ...(languages.length > 0
            ? languages.map((language) => `  - ${toYamlString(language)}`)
            : ["  - \"unknown\""]),
        "tags:",
        "  - flashcards",
        "  - theorem",
        "  - vocabulary",
        "---",
        "",
        "# Theorem Vocabulary",
        "",
        `- Exported at: ${generatedAt}`,
        `- Terms: ${sortedTerms.length}`,
        "",
    ];

    if (sortedTerms.length === 0) {
        lines.push("_No vocabulary terms available._", "");
        return lines.join("\n");
    }

    sortedTerms.forEach((term) => {
        const safeId = term.id.replace(/[^a-zA-Z0-9-]/g, "") || toShortHash(term.term);
        const blockId = `^fsrs-vocab-${safeId}`;
        const phoneticStr = term.phonetic ? ` *[/${toSingleLineText(term.phonetic)}/]*` : "";
        const contextQuote = term.contexts && term.contexts.length > 0
            ? toSingleLineText(term.contexts[0])
            : "";

        lines.push("---card---");
        lines.push(`### ${term.term}${phoneticStr} ${blockId}`);
        if (contextQuote) {
            lines.push(`> "${contextQuote}"`);
        }
        lines.push("---");

        let defIndex = 1;
        if (term.meanings && term.meanings.length > 0) {
            for (const meaning of term.meanings) {
                const pos = meaning.partOfSpeech ? `**${meaning.partOfSpeech}**: ` : "";
                for (const def of meaning.definitions) {
                    const normDef = toSingleLineText(def);
                    if (normDef) {
                        lines.push(`${defIndex}. ${pos}${normDef}`);
                        defIndex++;
                    }
                }
            }
        } else {
            const defs = collectDefinitions(term);
            defs.forEach((def) => {
                lines.push(`${defIndex}. ${def}`);
                defIndex++;
            });
        }

        lines.push("");
    });

    return lines.join("\n");
}

export function buildBookPages(
    books: Book[],
    rssArticles: RssArticle[],
    annotations: Annotation[],
    pagesDirectoryPath: string,
): ExportBookPage[] {
    const booksById = new Map(books.map((book) => [book.id, book]));
    const rssArticlesById = new Map(rssArticles.map((article) => [article.id, article]));
    const groupedAnnotations = new Map<string, Annotation[]>();

    for (const annotation of getHighlightAnnotations(annotations)) {
        const existing = groupedAnnotations.get(annotation.bookId);
        if (existing) {
            existing.push(annotation);
        } else {
            groupedAnnotations.set(annotation.bookId, [annotation]);
        }
    }

    const usedFileNames = new Set<string>();

    return Array.from(groupedAnnotations.entries()).map(([bookId, bookAnnotations]) => {
        const source = buildExportSource(bookId, booksById, rssArticlesById);
        const fileName = buildUniqueFileName(source, usedFileNames);
        const absolutePath = joinPath(pagesDirectoryPath, fileName);

        return {
            source,
            annotations: bookAnnotations,
            fileName,
            absolutePath,
        };
    });
}

export async function syncVaultMarkdownSnapshot({
    books,
    annotations,
    vocabularyTerms,
    rssArticles = [],
    settings,
}: SyncVaultMarkdownParams): Promise<VaultSyncResult> {
    if (!settings.enabled) {
        return { status: "skipped", message: "Markdown export sync is disabled." };
    }

    const vaultPath = normalizeDirectoryPath(settings.vaultPath);
    if (!vaultPath) {
        return { status: "skipped", message: "Export folder is not configured." };
    }

    if (!isTauri()) {
        return { status: "skipped", message: "Markdown export sync is available in desktop mode only." };
    }

    const rawHighlightsFolder = settings.highlightsFileName?.trim();
    const highlightsFolder = (rawHighlightsFolder && rawHighlightsFolder !== "theorem-highlights" && rawHighlightsFolder !== "theorem-highlights.md")
        ? normalizeFolderName(removeMarkdownExtension(rawHighlightsFolder), DEFAULT_HIGHLIGHTS_FOLDER_NAME)
        : DEFAULT_HIGHLIGHTS_FOLDER_NAME;

    const rawVocabFile = settings.vocabularyFileName?.trim();
    const vocabularyFileName = (rawVocabFile && rawVocabFile !== "theorem-vocabulary.md" && rawVocabFile !== "theorem-vocabulary")
        ? normalizeMarkdownFileName(rawVocabFile, DEFAULT_VOCABULARY_FILE_NAME)
        : DEFAULT_VOCABULARY_FILE_NAME;

    const theoremDir = joinPath(vaultPath, "Theorem");
    const pagesDirectoryPath = joinPath(theoremDir, highlightsFolder);
    const vocabularyPath = joinPath(theoremDir, vocabularyFileName);
    const generatedAt = new Date().toISOString();

    try {
        if (isTauri()) {
            try {
                const { invoke } = await import("@tauri-apps/api/core");
                const result = await invoke<{
                    status: string;
                    message: string;
                    filesWritten: number;
                    filePaths: string[];
                }>("vault_export_snapshot", {
                    payload: {
                        vaultPath,
                        highlightsFolder,
                        vocabularyFileName,
                        books: books.map((b) => ({
                            id: b.id,
                            title: b.title,
                            author: b.author,
                            format: b.format,
                            filePath: b.filePath,
                        })),
                        annotations: annotations.map((a) => ({
                            id: a.id,
                            bookId: a.bookId,
                            type: a.type,
                            selectedText: a.selectedText,
                            noteContent: a.noteContent,
                            color: a.color,
                            createdAt: a.createdAt,
                            updatedAt: a.updatedAt,
                        })),
                        vocabularyTerms: vocabularyTerms.map((v) => ({
                            id: v.id,
                            term: v.term,
                            language: v.language,
                            phonetic: v.phonetic,
                            meanings: v.meanings,
                            contexts: v.contexts,
                        })),
                        rssArticles: rssArticles.map((r) => ({
                            id: r.id,
                            title: r.title,
                            author: r.author,
                            url: r.url,
                        })),
                        generatedAt,
                    },
                });

                return {
                    status: "synced",
                    message: result.message,
                    filePaths: result.filePaths,
                };
            } catch (nativeErr) {
                if (import.meta.env.DEV) {
                    console.warn("[vault-sync] Native export failed, falling back to JS:", nativeErr);
                }
            }
        }

        const fs = await getTauriFs();
        await fs.mkdir(vaultPath, { recursive: true });
        await fs.mkdir(theoremDir, { recursive: true });
        await fs.mkdir(pagesDirectoryPath, { recursive: true });

        // Clean up legacy flat index if present
        const legacyHighlightsIndexPath = joinPath(vaultPath, "theorem-highlights.md");
        try { await fs.remove(legacyHighlightsIndexPath); } catch {}

        const pages = buildBookPages(books, rssArticles, annotations, pagesDirectoryPath);

        const BATCH_SIZE = 16;
        for (let i = 0; i < pages.length; i += BATCH_SIZE) {
            const batch = pages.slice(i, i + BATCH_SIZE);
            await Promise.all(batch.map((page) =>
                fs.writeTextFile(
                    page.absolutePath,
                    buildBookPageMarkdown(page.source, page.annotations, generatedAt),
                ),
            ));
        }

        await fs.writeTextFile(
            vocabularyPath,
            buildVocabularyMarkdown(vocabularyTerms, generatedAt),
        );

        const highlightsTotal = pages.reduce((sum, page) => sum + page.annotations.length, 0);
        return {
            status: "synced",
            message: `Synced ${pages.length} book page(s), ${highlightsTotal} highlight/note item(s), and ${vocabularyTerms.length} vocabulary term(s).`,
            filePaths: [
                ...pages.map((page) => page.absolutePath),
                vocabularyPath,
            ],
        };
    } catch (error) {
        const message = toErrorMessage(
            error,
            "Failed to sync markdown in selected export folder.",
        );
        return {
            status: "error",
            message,
        };
    }
}

let autoSyncTimer: ReturnType<typeof setTimeout> | null = null;
let vaultSyncQueue: Promise<void> = Promise.resolve();

export interface TriggerVaultAutoSyncOptions {
    immediate?: boolean;
    debounceMs?: number;
}

export async function runVaultAutoSync(): Promise<VaultSyncResult> {
    const { settings } = useSettingsStore.getState();
    const { setVaultSyncStatus } = useUIStore.getState();

    if (!settings.vault.enabled || !settings.vault.vaultPath.trim()) {
        return { status: "skipped", message: "Markdown export sync is not enabled or configured." };
    }

    setVaultSyncStatus("syncing", "STATUS: SYNCING_MARKDOWN_EXPORT");

    const { books, annotations } = useLibraryStore.getState();
    const { articles } = useRssStore.getState();
    const { vocabularyTerms } = useVocabularyStore.getState();

    const result = await syncVaultMarkdownSnapshot({
        books,
        annotations,
        rssArticles: articles,
        vocabularyTerms,
        settings: settings.vault,
    });

    if (result.status === "synced") {
        setVaultSyncStatus("synced", result.message, new Date().toISOString());
    } else if (result.status === "error") {
        setVaultSyncStatus("error", result.message);
    } else {
        setVaultSyncStatus("idle", result.message);
    }

    return result;
}

export function triggerVaultAutoSync(options?: TriggerVaultAutoSyncOptions): void {
    const { settings } = useSettingsStore.getState();
    if (!settings.vault.enabled || !settings.vault.vaultPath.trim()) {
        return;
    }

    if (autoSyncTimer) {
        clearTimeout(autoSyncTimer);
        autoSyncTimer = null;
    }

    if (options?.immediate) {
        vaultSyncQueue = vaultSyncQueue
            .catch(() => undefined)
            .then(() => runVaultAutoSync().then(() => undefined));
        return;
    }

    const delay = options?.debounceMs ?? 2000;
    autoSyncTimer = setTimeout(() => {
        autoSyncTimer = null;
        vaultSyncQueue = vaultSyncQueue
            .catch(() => undefined)
            .then(() => runVaultAutoSync().then(() => undefined));
    }, delay);
}

export async function appendAnnotationToVaultMarkdown({
    annotation,
    book,
    settings,
}: AppendAnnotationParams): Promise<VaultSyncResult> {
    return syncVaultMarkdownSnapshot({
        books: book ? [book] : [],
        annotations: [annotation],
        vocabularyTerms: [],
        settings,
    });
}
