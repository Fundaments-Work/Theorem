import { beforeEach, describe, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({ invoke: vi.fn(), readDir: vi.fn(), stat: vi.fn(), mobile: false }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@tauri-apps/plugin-fs", () => ({ readDir: native.readDir, stat: native.stat }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("../src/core/lib/env", () => ({ isTauri: () => true, isMobile: () => native.mobile }));
vi.mock("../src/core/lib/storage", () => ({ saveBookData: vi.fn(), getBookData: vi.fn() }));
import { scanFolderForBooks } from "../src/core/lib/import";
import { scanLibraryFolderMobile } from "../src/core/lib/mobile-folder-scan";

beforeEach(() => { native.mobile = false; native.invoke.mockReset(); native.readDir.mockReset(); native.stat.mockReset(); });

describe("folder scan metadata", () => {
    it("retains native desktop relative paths and root labels", async () => {
        const files = [{ path: "C:\\Books\\Engineering\\book.pdf", relativePath: "Engineering/book.pdf", rootName: "Books" }];
        native.invoke.mockResolvedValue(files);
        expect(await scanFolderForBooks("C:\\Books")).toEqual(files);
        expect(native.invoke).toHaveBeenCalledWith("scan_library_folder_desktop", { folderPath: "C:\\Books" });
    });
    it("preserves names for opaque Android document IDs", async () => {
        native.mobile = true;
        const files = [{ path: "content://provider/document/88", relativePath: "Engineering/book.pdf", rootName: "Books" }];
        native.invoke.mockResolvedValue(files);
        expect(await scanLibraryFolderMobile("content://provider/tree/42")).toEqual(files);
    });
    it("keeps nested paths in the desktop fallback, including root books, and skips symlinks and unsupported files", async () => {
        native.invoke.mockRejectedValue(new Error("Native scanner unavailable"));
        native.readDir.mockImplementation(async (path: string) => {
            if (path === "/Books") return [
                { name: "root.PDF", isFile: true }, { name: "Engineering", isDirectory: true },
                { name: "alias", isDirectory: true, isSymlink: true }, { name: "notes.txt", isFile: true },
            ];
            if (path === "/Books/Engineering") return [{ name: "Electronics", isDirectory: true }];
            if (path === "/Books/Engineering/Electronics") return [{ name: "Volume 01.cbz", isFile: true }];
            throw new Error(`Unexpected path: ${path}`);
        });
        expect(await scanFolderForBooks("/Books")).toEqual([
            { path: "/Books/root.PDF", relativePath: "root.PDF", rootName: "Books" },
            { path: "/Books/Engineering/Electronics/Volume 01.cbz", relativePath: "Engineering/Electronics/Volume 01.cbz", rootName: "Books" },
        ]);
        expect(native.readDir).toHaveBeenCalledTimes(3);
    });
    it("does not invoke a scanner for an empty root", async () => {
        expect(await scanFolderForBooks(" ")).toEqual([]);
        expect(native.invoke).not.toHaveBeenCalled();
    });
});
