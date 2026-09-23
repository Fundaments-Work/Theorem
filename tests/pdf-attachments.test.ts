// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
    attachmentBytes,
    formatAttachmentSize,
    listPdfAttachments,
    safeAttachmentName,
} from "../src/features/reader/engines/pdf-attachments";

describe("embedded files in a real PDF (tests/fixtures/pdf/attachments.pdf)", () => {
    it("lists both files with safe names, sizes and descriptions, and returns their bytes", async () => {
        const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
        const data = new Uint8Array(readFileSync(join(process.cwd(), "tests/fixtures/pdf/attachments.pdf")));
        const task = pdfjs.getDocument({ data, verbosity: 0 });
        try {
            const doc = await task.promise;
            const raw = await doc.getAttachments();
            const list = listPdfAttachments(raw);
            expect(list.map((a) => a.name)).toEqual(["notes.txt", "table.csv"]);
            expect(list[0]).toMatchObject({ key: "notes.txt", description: "Reading notes" });
            expect(list[1]).toMatchObject({ key: "data/table.csv", description: undefined });

            // What the engine does on save: inlined bytes, else fetch by key.
            const bytesFor = async (key: string) => attachmentBytes(raw, key) ?? await doc.getAttachmentContent(key);
            const decode = (bytes: Uint8Array | null) => new TextDecoder().decode(bytes ?? new Uint8Array());
            expect(decode(await bytesFor(list[0].key))).toBe("Chapter 1: remember the lighthouse.\n");
            expect(decode(await bytesFor(list[1].key))).toBe("term,count\nlighthouse,3\n");
            expect(attachmentBytes(raw, "missing")).toBeNull();
        } finally {
            await task.destroy();
        }
    });

    it("a PDF without attachments lists nothing", async () => {
        const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
        const data = new Uint8Array(readFileSync(join(process.cwd(), "tests/fixtures/pdf/page-labels.pdf")));
        const task = pdfjs.getDocument({ data, verbosity: 0 });
        try {
            const doc = await task.promise;
            expect(listPdfAttachments(await doc.getAttachments())).toEqual([]);
        } finally {
            await task.destroy();
        }
    });
});

describe("attachment helpers", () => {
    it("keeps only a safe last path component", () => {
        expect(safeAttachmentName("dir/sub/report.pdf", "x")).toBe("report.pdf");
        expect(safeAttachmentName("C:\\Users\\a\\evil.exe", "x")).toBe("evil.exe");
        expect(safeAttachmentName("../..", "fallback")).toBe("fallback");
        expect(safeAttachmentName("a\u0000b:c?.txt", "x")).toBe("a_b_c_.txt");
        expect(safeAttachmentName("  ", "fallback")).toBe("fallback");
        expect(safeAttachmentName(undefined, "fallback")).toBe("fallback");
        expect(safeAttachmentName("dir/", "fallback")).toBe("fallback");
    });

    it("tolerates null, malformed and content-less entries", () => {
        expect(listPdfAttachments(null)).toEqual([]);
        expect(listPdfAttachments("nope")).toEqual([]);
        expect(listPdfAttachments({ a: null, b: 3 })).toEqual([]);
        expect(listPdfAttachments({ k: { filename: "", content: "not bytes" } })).toEqual([
            { key: "k", name: "k", size: undefined, description: undefined },
        ]);
        const map = new Map([["m", { filename: "x.bin", content: new Uint8Array(3) }]]);
        expect(listPdfAttachments(map)).toEqual([{ key: "m", name: "x.bin", size: 3, description: undefined }]);
        expect(attachmentBytes(map, "m")?.byteLength).toBe(3);
        expect(attachmentBytes(null, "k")).toBeNull();
        expect(attachmentBytes({ k: { content: [1, 2] } }, "k")).toBeNull();
    });

    it("sorts by name, then key, so duplicates stay distinct and stable", () => {
        const bytes = new Uint8Array(1);
        const list = listPdfAttachments({
            z: { filename: "b.txt", content: bytes },
            y: { filename: "a.txt", content: bytes },
            x: { filename: "a.txt", content: bytes },
        });
        expect(list.map((a) => a.key)).toEqual(["x", "y", "z"]);
    });

    it("formats sizes at unit boundaries", () => {
        expect(formatAttachmentSize(0)).toBe("0 B");
        expect(formatAttachmentSize(1023)).toBe("1023 B");
        expect(formatAttachmentSize(1024)).toBe("1.0 KB");
        expect(formatAttachmentSize(1024 * 1024)).toBe("1.0 MB");
    });
});
