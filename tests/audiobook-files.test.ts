// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Book, BookAudioTrack } from "../src/core/types";

const deleteFile = vi.hoisted(() => vi.fn());
vi.mock("../src/core/lib/audiobook-files", () => ({ deleteGeneratedAudiobookFile: deleteFile }));

import { useLibraryStore } from "../src/core/store";

const track = (filePath: string): BookAudioTrack => ({
    filePath, format: "opus", durationSec: 60, currentPositionSec: 0, playbackSpeed: 1, chapters: [],
});
const book = (id: string, audioTrack?: BookAudioTrack): Book => ({ id, title: id, author: "A", filePath: id,
    format: "epub", fileSize: 1, addedAt: new Date(), progress: 0, readingTime: 0, tags: [], isFavorite: false, audioTrack });

beforeEach(() => {
    deleteFile.mockClear();
    useLibraryStore.setState({
        books: [book("a", track("/data/audiobooks/a.ogg")), book("b"), book("c", track("/music/c.m4b"))],
        collections: [],
    });
});

describe("generated audiobook cleanup", () => {
    it("detaching asks to delete the recording's file", () => {
        useLibraryStore.getState().removeAudiobook("a");
        expect(deleteFile).toHaveBeenCalledWith("/data/audiobooks/a.ogg");
    });

    it("deleting books cleans up each attached recording and ignores books without one", () => {
        useLibraryStore.getState().removeBooks(["a", "b", "c"]);
        expect(deleteFile.mock.calls.map((c) => c[0])).toEqual(["/data/audiobooks/a.ogg", undefined, "/music/c.m4b"]);
    });

    it("replacing the recording frees the old file but never the one being attached", () => {
        useLibraryStore.getState().attachAudiobook("a", track("/music/other.m4b"));
        expect(deleteFile).toHaveBeenCalledWith("/data/audiobooks/a.ogg");
        deleteFile.mockClear();
        useLibraryStore.getState().attachAudiobook("c", track("/music/c.m4b")); // same file re-attached
        expect(deleteFile).not.toHaveBeenCalled();
    });

    it("regenerating to the same path does not delete the fresh file", () => {
        useLibraryStore.getState().attachAudiobook("a", track("/data/audiobooks/a.ogg"));
        expect(deleteFile).not.toHaveBeenCalled();
    });
});

describe("deleteGeneratedAudiobookFile", () => {
    afterEach(() => {
        delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
        vi.doUnmock("@tauri-apps/api/core");
    });

    it("is a no-op for empty paths and outside Tauri", async () => {
        vi.resetModules();
        vi.doUnmock("../src/core/lib/audiobook-files");
        const invoke = vi.fn();
        vi.doMock("@tauri-apps/api/core", () => ({ invoke }));
        const { deleteGeneratedAudiobookFile } = await import("../src/core/lib/audiobook-files");
        deleteGeneratedAudiobookFile(undefined);
        deleteGeneratedAudiobookFile("/x.ogg"); // not in Tauri
        await Promise.resolve();
        expect(invoke).not.toHaveBeenCalled();
    });

    it("asks the backend to delete, and swallows its failure", async () => {
        vi.resetModules();
        vi.doUnmock("../src/core/lib/audiobook-files");
        (window as unknown as { __TAURI_INTERNALS__: object }).__TAURI_INTERNALS__ = {};
        const invoke = vi.fn().mockRejectedValue(new Error("nope"));
        vi.doMock("@tauri-apps/api/core", () => ({ invoke }));
        const { deleteGeneratedAudiobookFile } = await import("../src/core/lib/audiobook-files");
        expect(() => deleteGeneratedAudiobookFile("/data/audiobooks/a.ogg")).not.toThrow();
        await new Promise((r) => setTimeout(r, 0));
        expect(invoke).toHaveBeenCalledWith("delete_generated_audiobook", { path: "/data/audiobooks/a.ogg" });
    });
});
