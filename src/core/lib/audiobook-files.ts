import { isTauri } from "./env";

/**
 * Removes an audiobook file Theorem generated itself (Save as Audiobook), so
 * detaching or replacing it, or deleting the book, doesn't leak disk space.
 * The backend only deletes files inside its own `audiobooks` folder; a
 * recording the user attached from elsewhere is never touched.
 */
export function deleteGeneratedAudiobookFile(path: string | undefined): void {
    if (!path || !isTauri()) return;
    void import("@tauri-apps/api/core")
        .then(({ invoke }) => invoke("delete_generated_audiobook", { path }))
        .catch(() => { /* best effort: a leftover file is harmless */ });
}
