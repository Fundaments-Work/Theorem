import { isTauri } from "./env";
import { useLibraryStore } from "../store";
import { getBookData, getBookBlob, saveBookData, saveCoverImage, deleteCoverImage } from "./storage";
import { sqliteSaveBookMetadata } from "./sqlite-storage";
import type { Book } from "../types";
import { withBookEditLock } from "./book-edit-lock";

export interface CoverEditInput {
    blob?: Blob;
    remove?: boolean;
}

export interface BookEditResult {
    ok: boolean;
    message?: string;
}

interface EpubWriteMeta {
    title?: string;
    author?: string;
    description?: string;
    publisher?: string;
    publishedDate?: string;
    language?: string;
    isbn?: string;
    category?: string;
}

async function sha256Hex(data: Uint8Array | ArrayBuffer): Promise<string> {
    const bytes = new Uint8Array(data instanceof Uint8Array ? data : new Uint8Array(data));
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
}

function buildEpubMeta(metadata: Partial<Book>): EpubWriteMeta {
    const meta: EpubWriteMeta = {};
    if (metadata.title !== undefined) meta.title = metadata.title;
    if (metadata.author !== undefined) meta.author = metadata.author;
    if (metadata.description !== undefined) meta.description = metadata.description;
    if (metadata.publisher !== undefined) meta.publisher = metadata.publisher;
    if (metadata.publishedDate !== undefined) meta.publishedDate = metadata.publishedDate;
    if (metadata.language !== undefined) meta.language = metadata.language;
    if (metadata.isbn !== undefined) meta.isbn = metadata.isbn;
    if (metadata.category !== undefined) meta.category = metadata.category;
    return meta;
}

async function rewriteStoredEpub(book: Book, metadata: Partial<Book>, coverBytes: Uint8Array | null): Promise<{ size: number; blobHash: string }> {
    const epubMeta = buildEpubMeta(metadata);

    if (isTauri()) {
        const { invoke } = await import("@tauri-apps/api/core");
        const result = await invoke<{ size: number }>("rewrite_epub_metadata", {
            bookId: book.id,
            metadata: epubMeta,
            cover: coverBytes ? Array.from(coverBytes) : null,
        });

        const data = await getBookData(book.id, book.storagePath ?? book.filePath);
        if (!data) return { size: result.size, blobHash: "" };
        return { size: result.size, blobHash: await sha256Hex(data) };
    }

    const blob = await getBookBlob(book.id, book.storagePath ?? book.filePath);
    if (!blob) throw new Error("Could not read the stored EPUB to apply edits.");
    const { rewriteEpubWithFflate } = await import("./epub-write-browser");
    const rewritten = rewriteEpubWithFflate(
        new Uint8Array(await blob.arrayBuffer()),
        epubMeta,
        coverBytes,
    );
    const arrayBuffer = rewritten.buffer.slice(
        rewritten.byteOffset,
        rewritten.byteOffset + rewritten.byteLength,
    ) as ArrayBuffer;
    await saveBookData(book.id, arrayBuffer);
    return { size: rewritten.byteLength, blobHash: await sha256Hex(rewritten) };
}

export async function applyBookEdits(
    bookId: string,
    metadata: Partial<Book>,
    cover?: CoverEditInput,
): Promise<BookEditResult> {
    return withBookEditLock(bookId, () => applyBookEditsLocked(bookId, metadata, cover));
}

async function applyBookEditsLocked(bookId: string, metadata: Partial<Book>, cover?: CoverEditInput): Promise<BookEditResult> {
    try {
        const book = useLibraryStore.getState().getBook(bookId);
        if (!book) return { ok: false, message: "Book not found." };

        const updates: Partial<Book> = { ...metadata };
        let coverBytes: Uint8Array | null = null;

        if (cover?.remove) {
            await deleteCoverImage(bookId);
            updates.coverPath = "";
            updates.coverBlobHash = undefined;
            updates.coverExtractionDone = true;
        } else if (cover?.blob) {
            const dataUrl = await saveCoverImage(bookId, cover.blob);
            updates.coverPath = dataUrl;
            updates.coverExtractionDone = true;
            coverBytes = new Uint8Array(await cover.blob.arrayBuffer());
            updates.coverBlobHash = await sha256Hex(coverBytes);
        }

        useLibraryStore.getState().updateBookMetadata(bookId, updates);

        const updatedBook = useLibraryStore.getState().getBook(bookId);
        if (isTauri() && updatedBook) {
            await sqliteSaveBookMetadata(bookId, JSON.stringify(updatedBook)).catch((e) =>
                console.error("[book-edit] save metadata error", e),
            );
        }

        if (book.format === "epub") {
            const metaChanged =
                metadata.title !== undefined ||
                metadata.author !== undefined ||
                metadata.description !== undefined ||
                metadata.publisher !== undefined ||
                metadata.publishedDate !== undefined ||
                metadata.language !== undefined ||
                metadata.isbn !== undefined ||
                metadata.category !== undefined;
            if (metaChanged || coverBytes) {
                const rewriteMeta = { ...(metaChanged ? metadata : {}) } as Partial<Book>;
                try {
                    const { size, blobHash } = await rewriteStoredEpub(
                        updatedBook ?? book,
                        rewriteMeta,
                        coverBytes,
                    );
                    useLibraryStore.getState().updateBookMetadata(bookId, {
                        fileSize: size,
                        ...(blobHash ? { blobHash } : {}),
                    });
                } catch (e) {
                    console.error("[book-edit] EPUB write-back failed (in-app edits preserved)", e);
                }
            }
        }

        return { ok: true };
    } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
}
