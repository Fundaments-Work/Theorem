import { toast } from "sonner";
import { useLibraryStore } from "../../core/store";
import type { Book, BookAudioTrackFormat } from "../../core/types";

interface AudiobookMetadataPayload {
    format: string;
    duration_sec: number;
    title: string | null;
    author: string | null;
    cover_data_url: string | null;
    chapters: { id: string; title: string; start_sec: number; end_sec: number }[];
}

export async function attachAudiobookToBook(book: Book) {
    const { showOpenFileDialog } = await import("../../core/lib/dialogs");
    const path = await showOpenFileDialog({
        title: "Attach Audiobook",
        filters: [{ name: "Audiobook", extensions: ["m4b", "m4a", "mp3"] }],
    });
    if (typeof path !== "string" || !path) return;
    try {
        const { invoke } = await import("@tauri-apps/api/core");
        const meta = await invoke<AudiobookMetadataPayload>("extract_audiobook_metadata", { path });
        useLibraryStore.getState().attachAudiobook(book.id, {
            filePath: path,
            format: meta.format as BookAudioTrackFormat,
            durationSec: meta.duration_sec,
            currentPositionSec: 0,
            playbackSpeed: 1,
            chapters: meta.chapters.map((c) => ({
                id: c.id,
                title: c.title,
                startSec: c.start_sec,
                endSec: c.end_sec,
            })),
        });
        toast.success(`Audiobook attached to "${book.title}"`);
    } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
    }
}

