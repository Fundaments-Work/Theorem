import { useSettingsStore } from "../store";
import { isTauri } from "./env";
import { sqliteRecordReadingChunk } from "./sqlite-storage";

let flushing: Promise<void> | undefined;

/** Outbox is device-local persisted state; it is never included in reading_stats sync. */
export function queueReadingChunk(date: string, minutes: number, bookId: string): void {
    if (!isTauri()) return;
    const chunkId = `chunk:${crypto.randomUUID()}`;
    useSettingsStore.setState(state => ({ readingOutbox: { ...state.readingOutbox, [chunkId]: { date, minutes, bookId } } }));
    void flushReadingOutbox().catch(error => console.error("[reading] Could not save reading time; retained for retry", error));
}

export function flushReadingOutbox(): Promise<void> {
    if (!isTauri()) return Promise.resolve();
    return flushing ??= (async () => {
        while (true) {
            const entry = Object.entries(useSettingsStore.getState().readingOutbox)[0];
            if (!entry) return;
            const [id, chunk] = entry;
            await sqliteRecordReadingChunk(id, chunk.date, chunk.minutes, chunk.bookId);
            useSettingsStore.setState(state => {
                const remaining = { ...state.readingOutbox };
                delete remaining[id];
                return { readingOutbox: remaining };
            });
        }
    })().finally(() => { flushing = undefined; });
}
