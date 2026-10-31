import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/core/lib/env", async importOriginal => ({...await importOriginal<object>(), isTauri: vi.fn(() => false)}));
vi.mock("@tauri-apps/api/core", async importOriginal => ({...await importOriginal<object>(), invoke:vi.fn().mockResolvedValue(null)}));
import { isTauri } from "../src/core/lib/env";
vi.mock("../src/core/lib/sqlite-storage", async importOriginal => ({...await importOriginal<object>(), sqliteRecordReadingChunk: vi.fn()}));
import { useSettingsStore } from "../src/core/store";
import { sqliteRecordReadingChunk } from "../src/core/lib/sqlite-storage";
import { queueReadingChunk, flushReadingOutbox } from "../src/core/lib/reading-records";

beforeEach(() => { vi.mocked(isTauri).mockReturnValue(true); useSettingsStore.setState({ readingOutbox: {} }); });
afterEach(() => vi.restoreAllMocks());
describe("reading time retry outbox", () => {
    it("retains failures and replays the same identity before removing successful chunks", async () => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        vi.mocked(sqliteRecordReadingChunk).mockRejectedValueOnce(new Error("busy"));
        queueReadingChunk("2026-10-31", 0.5, "book");
        await flushReadingOutbox().catch(() => {});
        const entries = Object.entries(useSettingsStore.getState().readingOutbox);
        expect(entries).toHaveLength(1);
        vi.mocked(sqliteRecordReadingChunk).mockResolvedValue(undefined);
        await flushReadingOutbox();
        expect(sqliteRecordReadingChunk).toHaveBeenLastCalledWith(entries[0][0], "2026-10-31", 0.5, "book");
        expect(useSettingsStore.getState().readingOutbox).toEqual({});
    });
    it("flushes entries recovered from persisted state", async () => {
        useSettingsStore.setState({readingOutbox:{"chunk:restart":{date:"2026-10-31",minutes:2,bookId:"book"}}});
        vi.mocked(sqliteRecordReadingChunk).mockResolvedValue(undefined);
        await Promise.all([flushReadingOutbox(),flushReadingOutbox()]);
        expect(sqliteRecordReadingChunk).toHaveBeenCalledExactlyOnceWith("chunk:restart","2026-10-31",2,"book");
        expect(useSettingsStore.getState().readingOutbox).toEqual({});
    });
});
