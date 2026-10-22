import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VocabularyTerm } from "../src/core/types";

// Plain functions (not vi.fn) so the global clearMocks/restoreMocks settings
// cannot reset the fake SQLite between the steps of one test.
const { sqlite } = vi.hoisted(() => ({
    sqlite: {
        terms: new Map<string, unknown>(),
        failWrites: false,
        failReads: false,
        writes: [] as string[],
    },
}));

vi.mock("../src/core/lib/env", () => ({
    isTauri: () => true,
    isTauriDesktop: () => true,
    isTauriMobile: () => false,
    isMobile: () => false,
}));

vi.mock("../src/core/lib/sqlite-storage", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../src/core/lib/sqlite-storage")>();
    return {
        ...actual,
        sqliteSaveVocabularyTerm: async (term: { id: string }) => {
            sqlite.writes.push(term.id);
            if (sqlite.failWrites) throw new Error("database is locked");
            sqlite.terms.set(term.id, term);
        },
        sqliteGetVocabularyTerms: async () => {
            if (sqlite.failReads) throw new Error("database is locked");
            return [...sqlite.terms.values()];
        },
        sqliteDeleteVocabularyTerm: async (id: string) => {
            sqlite.terms.delete(id);
        },
    };
});

import { toSqliteVocabularyTerm, useVocabularyStore } from "../src/core/store/vocabularyStore";

function term(id: string, word = id): VocabularyTerm {
    return {
        id,
        term: word,
        normalizedTerm: word,
        language: "en",
        meanings: [],
        providerHistory: [],
        createdAt: new Date("2026-01-01"),
    };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const options = () => (useVocabularyStore as any).persist.getOptions();

function hydrate(persisted: Record<string, unknown>, version: number | null) {
    const after = options().onRehydrateStorage();
    const state = version === null ? persisted : options().migrate(persisted, version);
    useVocabularyStore.setState(state);
    after(useVocabularyStore.getState());
}

const persistedTerms = () => options().partialize(useVocabularyStore.getState()).vocabularyTerms as VocabularyTerm[];

async function settle() {
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
}

describe("moving legacy vocabulary from the KV copy into SQLite", () => {
    let errorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        sqlite.terms.clear();
        sqlite.failWrites = false;
        sqlite.failReads = false;
        sqlite.writes.length = 0;
        errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        useVocabularyStore.setState({ vocabularyTerms: [], installedDictionaries: [] });
    });

    afterEach(() => {
        errorSpy.mockRestore();
    });

    it("keeps legacy terms in the saved copy when the SQLite write fails", async () => {
        sqlite.failWrites = true;
        hydrate({ vocabularyTerms: [term("t1"), term("t2")], installedDictionaries: [] }, 5);
        await settle();

        expect(persistedTerms().map((t) => t.id).sort()).toEqual(["t1", "t2"]);
        expect(useVocabularyStore.getState().vocabularyTerms.map((t) => t.id).sort()).toEqual(["t1", "t2"]);
        expect(errorSpy).toHaveBeenCalled();
    });

    it("drops the saved copy once SQLite holds every term", async () => {
        hydrate({ vocabularyTerms: [term("t1"), term("t2")], installedDictionaries: [] }, 5);
        await settle();

        expect([...sqlite.terms.keys()].sort()).toEqual(["t1", "t2"]);
        expect(persistedTerms()).toEqual([]);
        expect(useVocabularyStore.getState().vocabularyTerms.map((t) => t.id).sort()).toEqual(["t1", "t2"]);
    });

    it("retries on the next launch without overwriting newer SQLite rows", async () => {
        sqlite.terms.set("t1", toSqliteVocabularyTerm(term("t1", "edited")));
        hydrate({ vocabularyTerms: [term("t1", "stale"), term("t2")], installedDictionaries: [] }, null);
        await settle();

        expect(sqlite.writes).toEqual(["t2"]);
        expect(persistedTerms()).toEqual([]);
        const byId = new Map(useVocabularyStore.getState().vocabularyTerms.map((t) => [t.id, t.term]));
        expect(byId.get("t1")).toBe("edited");
        expect(byId.get("t2")).toBe("t2");
    });

    it("a failed SQLite read keeps the terms in memory and in the saved copy", async () => {
        sqlite.failReads = true;
        hydrate({ vocabularyTerms: [term("t1")], installedDictionaries: [] }, null);
        await settle();

        expect(useVocabularyStore.getState().vocabularyTerms.map((t) => t.id)).toEqual(["t1"]);
        expect(persistedTerms().map((t) => t.id)).toEqual(["t1"]);
        expect(errorSpy).toHaveBeenCalled();
    });
});
