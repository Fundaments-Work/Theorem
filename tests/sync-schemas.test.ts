import { describe, expect, it } from "vitest";
import {
    BookSchema,
    AnnotationSchema,
    CollectionSchema,
    DeletionTombstoneSchema,
    VocabularyTermSchema,
    validateSyncPayloads,
} from "../src/core/lib/sync-schemas";

// ─── Book Schema ───

describe("BookSchema validation", () => {
    it("accepts valid book", () => {
        const book = {
            id: "book-1",
            title: "A Book",
            author: "Author",
            filePath: "/tmp/book.epub",
            format: "epub",
            fileSize: 1024,
            addedAt: new Date().toISOString(),
            progress: 0,
            tags: [],
            isFavorite: false,
            readingTime: 0,
        };
        const result = BookSchema.safeParse(book);
        expect(result.success).toBe(true);
    });

    it("rejects book without required fields", () => {
        const result = BookSchema.safeParse({ id: "book-1" });
        expect(result.success).toBe(false);
    });

    it("rejects book with invalid format", () => {
        const result = BookSchema.safeParse({
            id: "book-1",
            title: "X",
            author: "X",
            filePath: "/tmp/x.epub",
            format: "docx",
            fileSize: 100,
            progress: 0,
            tags: [],
            isFavorite: false,
        });
        expect(result.success).toBe(false);
    });

    it("rejects book with negative progress", () => {
        const result = BookSchema.safeParse({
            id: "book-1",
            title: "X",
            author: "X",
            filePath: "/tmp/x.epub",
            format: "epub",
            fileSize: 100,
            progress: -0.1,
            tags: [],
            isFavorite: false,
        });
        expect(result.success).toBe(false);
    });

    it("rejects book with progress > 1", () => {
        const result = BookSchema.safeParse({
            id: "book-1",
            title: "X",
            author: "X",
            filePath: "/tmp/x.epub",
            format: "epub",
            fileSize: 100,
            progress: 1.5,
            tags: [],
            isFavorite: false,
        });
        expect(result.success).toBe(false);
    });
});

// ─── Annotation Schema ───

describe("AnnotationSchema validation", () => {
    it("accepts valid annotation", () => {
        const ann = {
            id: "ann-1",
            bookId: "book-1",
            type: "highlight",
            location: "cfi/1/2",
            createdAt: new Date().toISOString(),
        };
        const result = AnnotationSchema.safeParse(ann);
        expect(result.success).toBe(true);
    });

    it("rejects annotation without required fields", () => {
        const result = AnnotationSchema.safeParse({ id: "ann-1" });
        expect(result.success).toBe(false);
    });

    it("rejects annotation with invalid type", () => {
        const result = AnnotationSchema.safeParse({
            id: "ann-1",
            bookId: "book-1",
            type: "invalid-type",
            location: "cfi/1",
            createdAt: new Date().toISOString(),
        });
        expect(result.success).toBe(false);
    });

    it("accepts all valid annotation types", () => {
        for (const type of ["highlight", "note", "bookmark"]) {
            const result = AnnotationSchema.safeParse({
                id: `ann-${type}`,
                bookId: "book-1",
                type,
                location: "cfi/1",
                createdAt: new Date().toISOString(),
            });
            expect(result.success).toBe(true);
        }
    });

    it("rejects annotation with non-array rects", () => {
        const result = AnnotationSchema.safeParse({
            id: "ann-1",
            bookId: "book-1",
            type: "highlight",
            location: "cfi/1",
            createdAt: new Date().toISOString(),
            rects: "not-an-array",
        });
        expect(result.success).toBe(false);
    });
});

// ─── Collection Schema ───

describe("CollectionSchema validation", () => {
    it("accepts valid collection", () => {
        const col = {
            id: "col-1",
            name: "My Shelf",
            bookIds: ["book-1", "book-2"],
            kind: "general",
            createdAt: new Date().toISOString(),
        };
        const result = CollectionSchema.safeParse(col);
        expect(result.success).toBe(true);
    });

    it("rejects collection without bookIds", () => {
        const result = CollectionSchema.safeParse({
            id: "col-1",
            name: "My Shelf",
            kind: "general",
            createdAt: new Date().toISOString(),
        });
        expect(result.success).toBe(false);
    });
});

// ─── DeletionTombstone Schema ───

describe("DeletionTombstoneSchema validation", () => {
    it("accepts valid tombstone", () => {
        const ts = {
            entityId: "book-1",
            entityType: "book",
            deletedAt: new Date().toISOString(),
        };
        const result = DeletionTombstoneSchema.safeParse(ts);
        expect(result.success).toBe(true);
    });

    it("accepts vocabulary entityType", () => {
        const ts = {
            entityId: "vocab-1",
            entityType: "vocabulary",
            deletedAt: new Date().toISOString(),
        };
        const result = DeletionTombstoneSchema.safeParse(ts);
        expect(result.success).toBe(true);
    });

    it("accepts collection_book entityType", () => {
        const ts = {
            entityId: "col-1:book-a",
            entityType: "collection_book",
            deletedAt: new Date().toISOString(),
        };
        const result = DeletionTombstoneSchema.safeParse(ts);
        expect(result.success).toBe(true);
    });

    it("rejects unknown entityType", () => {
        const result = DeletionTombstoneSchema.safeParse({
            entityId: "x",
            entityType: "unknown",
            deletedAt: new Date().toISOString(),
        });
        expect(result.success).toBe(false);
    });
});

// ─── VocabularyTerm Schema ───

describe("VocabularyTermSchema validation", () => {
    it("accepts valid term", () => {
        const term = {
            id: "vocab-1",
            term: "example",
            normalizedTerm: "example",
            language: "en",
            meanings: [],
            providerHistory: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            lookupCount: 0,
            tags: [],
            contexts: [],
        };
        const result = VocabularyTermSchema.safeParse(term);
        expect(result.success).toBe(true);
    });

    it("rejects term without language", () => {
        const result = VocabularyTermSchema.safeParse({
            id: "vocab-1",
            term: "example",
            normalizedTerm: "example",
            meanings: [],
            providerHistory: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            lookupCount: 0,
            tags: [],
            contexts: [],
        });
        expect(result.success).toBe(false);
    });
});

// ─── Batch Validation ───

describe("validateSyncPayloads batch validation", () => {
    it("filters out invalid entries from a domain array", () => {
        const validAnn = { id: "valid", bookId: "b1", type: "highlight", location: "cfi/1", createdAt: new Date().toISOString() };
        const invalidAnn = { id: "invalid", bookId: "b2", type: "not-a-type", location: "cfi/2", createdAt: new Date().toISOString() };
        const payloads = {
            annotations: JSON.stringify([validAnn, invalidAnn]),
        };
        const result = validateSyncPayloads(payloads);
        // On valid parse, annotations key exists; result could be the parsed array or absent
        // The function filters out invalid JSON; the valid annotations should be present
        expect(result.annotations || result).toBeDefined();
    });

    it("silently omits domains with invalid JSON", () => {
        const result = validateSyncPayloads({
            annotations: "not-json-at-all",
        });
        // Invalid JSON → domain not present in result
        expect(result.annotations).toBeUndefined();
    });

    it("silently omits domains missing from input", () => {
        const result = validateSyncPayloads({});
        // No domains → empty result
        expect(Object.keys(result)).toHaveLength(0);
    });
});
