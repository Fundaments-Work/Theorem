import { normalizeFolderScan, type FolderScanResult, type ScannedBookFile } from "./source-folders";
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
    return (await scanLibraryFolderMobileDetailed(treeUri)).files;
}

/** Scan an Android tree URI, keeping the folders it could not read. */
export async function scanLibraryFolderMobileDetailed(treeUri: string): Promise<FolderScanResult> {
    const normalizedTreeUri = treeUri.trim();
    if (!isTauri() || !isMobile() || !normalizedTreeUri) {
        return normalizeFolderScan(null);
    }
    return normalizeFolderScan(await invoke<unknown>("scan_library_folder_mobile", {
        treeUri: normalizedTreeUri,
    }));
}
