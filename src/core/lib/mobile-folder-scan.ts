import type { ScannedBookFile } from "./source-folders";
import { invoke } from "@tauri-apps/api/core";
import { isMobile, isTauri } from "./env";

export async function pickLibraryFolderMobile(): Promise<string | null> {
    if (!isTauri() || !isMobile()) {
        return null;
    }

    const folderUri = await invoke<string | null>("pick_library_folder_mobile");
    if (!folderUri) {
        return null;
    }
    return folderUri.trim() || null;
}

export async function scanLibraryFolderMobile(treeUri: string): Promise<ScannedBookFile[]> {
    if (!isTauri() || !isMobile()) {
        return [];
    }

    const normalizedTreeUri = treeUri.trim();
    if (!normalizedTreeUri) {
        return [];
    }

    const files = await invoke<ScannedBookFile[]>("scan_library_folder_mobile", {
        treeUri: normalizedTreeUri,
    });
    return Array.isArray(files) ? files : [];
}
