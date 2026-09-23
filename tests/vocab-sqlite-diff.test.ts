import { describe, expect, it } from "vitest";
import { diffVocabularyForSqlite } from "../src/core/lib/vocab-sqlite-diff";
import type { VocabularyTerm } from "../src/core/types";

const term = (id: string, extra: Partial<VocabularyTerm> = {}) =>
    ({ id, term: id, createdAt: "2026-09-01", ...extra }) as unknown as VocabularyTerm;

describe("diffVocabularyForSqlite", () => {
    it("writes nothing when a merge changes nothing (was: every term)", () => {
        const list = Array.from({ length: 5000 }, (_, i) => term(`t${i}`));
        const copy = list.map((t) => ({ ...t }));
        expect(diffVocabularyForSqlite(list, copy)).toEqual({ upserts: [], deletes: [] });
    });

    it("upserts only new and changed terms", () => {
        const before = [term("a"), term("b")];
        const after = [term("a"), term("b", { definition: "new" } as never), term("c")];
        const { upserts, deletes } = diffVocabularyForSqlite(before, after);
        expect(upserts.map((t) => t.id)).toEqual(["b", "c"]);
        expect(deletes).toEqual([]);
    });

    it("deletes terms the merge removed, so they cannot resurrect", () => {
        const { upserts, deletes } = diffVocabularyForSqlite([term("a"), term("gone")], [term("a")]);
        expect(upserts).toEqual([]);
        expect(deletes).toEqual(["gone"]);
    });

    it("handles empty lists", () => {
        expect(diffVocabularyForSqlite([], [])).toEqual({ upserts: [], deletes: [] });
        expect(diffVocabularyForSqlite([], [term("x")]).upserts).toHaveLength(1);
        expect(diffVocabularyForSqlite([term("x")], []).deletes).toEqual(["x"]);
    });
});
