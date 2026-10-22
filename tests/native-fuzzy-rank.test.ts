// @vitest-environment jsdom
/**
 * In-app search boxes rank with the Rust nucleo matcher: the Tauri command on
 * desktop/Android, the WebAssembly build of the same matcher in the browser.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

const wasmFuzzyRank = vi.fn();
const initTheoremCoreWasm = vi.fn(async () => true);
let wasmReady = true;
vi.mock("../src/core/lib/theorem-core", () => ({
    isWasmCoreReady: () => wasmReady,
    initTheoremCoreWasm: () => initTheoremCoreWasm(),
    wasmFuzzyRank: (...args: unknown[]) => wasmFuzzyRank(...args),
}));

import {
    createFuzzyRanker,
    FuzzyRankUnavailableError,
    joinFields,
    rankByNativeFuzzy,
    type RankedMatch,
} from "../src/core/lib/search/native-rank";
import { useFuzzyRank } from "../src/core/lib/search/useFuzzyRank";

type Item = { name: string; note?: string };
const items: Item[] = [
    { name: "Dune", note: "desert" },
    { name: "Emma" },
    { name: "Dune Messiah", note: "sequel" },
    { name: "Dunes of Arrakis" },
];
const fields = (i: Item) => ({ primary: i.name, secondary: i.note });
const names = (r: RankedMatch<Item>[] | null) => r?.map((m) => m.item.name) ?? null;

const setTauri = (on: boolean) => {
    if (on) (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    else delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
};

beforeEach(() => {
    invoke.mockReset();
    wasmFuzzyRank.mockReset();
    initTheoremCoreWasm.mockReset();
    initTheoremCoreWasm.mockResolvedValue(true);
    wasmReady = true;
    setTauri(false);
});
afterEach(() => setTauri(false));

describe("rankByNativeFuzzy", () => {
    it("an empty or blank query returns every item in order, without calling a matcher", async () => {
        expect(names(await rankByNativeFuzzy(items, "", fields))).toEqual(["Dune", "Emma", "Dune Messiah", "Dunes of Arrakis"]);
        expect(names(await rankByNativeFuzzy(items, "   ", fields, 2))).toEqual(["Dune", "Emma"]);
        expect(invoke).not.toHaveBeenCalled();
        expect(wasmFuzzyRank).not.toHaveBeenCalled();
    });

    it("no items means no results and no matcher call", async () => {
        expect(await rankByNativeFuzzy([], "dune", fields)).toEqual([]);
        expect(invoke).not.toHaveBeenCalled();
        expect(wasmFuzzyRank).not.toHaveBeenCalled();
    });

    it("on Tauri calls the native command with every item and the trimmed query", async () => {
        setTauri(true);
        invoke.mockResolvedValue([
            { id: "2", score: 90, titleIndices: [0, 1, 2, 3], authorIndices: [] },
            { id: "0", score: 120, titleIndices: [0, 1, 2, 3], authorIndices: [] },
        ]);
        const ranked = await rankByNativeFuzzy(items, "  dune ", fields);
        expect(invoke).toHaveBeenCalledWith("fuzzy_rank_candidates", {
            candidates: [
                { id: "0", title: "Dune", author: "desert" },
                { id: "1", title: "Emma" },
                { id: "2", title: "Dune Messiah", author: "sequel" },
                { id: "3", title: "Dunes of Arrakis" },
            ],
            query: "dune",
            limit: 4,
        });
        expect(names(ranked)).toEqual(["Dune", "Dune Messiah"]);
        expect(ranked[0].primaryIndices).toEqual([0, 1, 2, 3]);
        expect(wasmFuzzyRank).not.toHaveBeenCalled();
    });

    it("on Tauri falls back to WebAssembly when the native command fails", async () => {
        setTauri(true);
        invoke.mockRejectedValue(new Error("ipc down"));
        wasmFuzzyRank.mockReturnValue([{ id: "1", score: 10, titleIndices: [0], authorIndices: [] }]);
        expect(names(await rankByNativeFuzzy(items, "emma", fields))).toEqual(["Emma"]);
    });

    it("in the browser uses the WebAssembly matcher, initialising it first when needed", async () => {
        wasmReady = false;
        initTheoremCoreWasm.mockImplementation(async () => {
            wasmReady = true;
            return true;
        });
        wasmFuzzyRank.mockReturnValue([{ id: "3", score: 5, titleIndices: [0], authorIndices: [] }]);
        expect(names(await rankByNativeFuzzy(items, "arrakis", fields))).toEqual(["Dunes of Arrakis"]);
        expect(initTheoremCoreWasm).toHaveBeenCalledTimes(1);
        expect(invoke).not.toHaveBeenCalled();
    });

    it("rejects when no matcher can run, rather than reporting no matches", async () => {
        wasmReady = false;
        initTheoremCoreWasm.mockResolvedValue(false);
        await expect(rankByNativeFuzzy(items, "dune", fields)).rejects.toBeInstanceOf(FuzzyRankUnavailableError);
    });

    it("orders best first and keeps input order for equal scores, whatever order the backend returns", async () => {
        wasmFuzzyRank.mockReturnValue([
            { id: "3", score: 50, titleIndices: [], authorIndices: [] },
            { id: "0", score: 80, titleIndices: [], authorIndices: [] },
            { id: "2", score: 50, titleIndices: [], authorIndices: [] },
            { id: "1", score: 50, titleIndices: [], authorIndices: [] },
        ]);
        expect(names(await rankByNativeFuzzy(items, "x", fields))).toEqual(["Dune", "Emma", "Dune Messiah", "Dunes of Arrakis"]);
    });

    it("applies the limit after ordering and ignores ids it never sent", async () => {
        wasmFuzzyRank.mockReturnValue([
            { id: "9", score: 999, titleIndices: [], authorIndices: [] },
            { id: "nope", score: 999, titleIndices: [], authorIndices: [] },
            { id: "2", score: 10, titleIndices: [], authorIndices: [] },
            { id: "0", score: 20, titleIndices: [], authorIndices: [] },
        ]);
        expect(names(await rankByNativeFuzzy(items, "dune", fields, 1))).toEqual(["Dune"]);
    });
});

describe("joinFields", () => {
    it("skips empty parts and separates the rest", () => {
        expect(joinFields("a", "", undefined, null, "  ", "b")).toBe("a · b");
        expect(joinFields()).toBe("");
    });
});

describe("createFuzzyRanker", () => {
    it("drops an answer that arrives after a newer query was asked", async () => {
        setTauri(true);
        let resolveOld: (v: unknown) => void = () => {};
        invoke
            .mockImplementationOnce(() => new Promise((r) => (resolveOld = r)))
            .mockResolvedValueOnce([{ id: "1", score: 1, titleIndices: [], authorIndices: [] }]);
        const ranker = createFuzzyRanker();
        const older = ranker.rank(items, "dune", fields);
        const newer = ranker.rank(items, "emma", fields);
        expect(names(await newer)).toEqual(["Emma"]);
        resolveOld([{ id: "0", score: 1, titleIndices: [], authorIndices: [] }]);
        expect(await older).toBeNull();
    });

    it("cancel makes the pending answer resolve to null, and swallows its failure", async () => {
        setTauri(true);
        let rejectOld: (e: unknown) => void = () => {};
        invoke.mockImplementationOnce(() => new Promise((_r, rej) => (rejectOld = rej)));
        wasmReady = false;
        initTheoremCoreWasm.mockResolvedValue(false);
        const ranker = createFuzzyRanker();
        const pending = ranker.rank(items, "dune", fields);
        ranker.cancel();
        rejectOld(new Error("ipc down"));
        expect(await pending).toBeNull();
    });
});

describe("useFuzzyRank", () => {
    let container: HTMLDivElement;
    let root: Root;
    let latest: RankedMatch<Item>[] | null = null;
    function Probe(props: { items: Item[]; query: string; debounceMs?: number }) {
        latest = useFuzzyRank(props.items, props.query, fields, { debounceMs: props.debounceMs });
        return null;
    }
    const render = async (props: { items: Item[]; query: string; debounceMs?: number }) => {
        await act(async () => root.render(createElement(Probe, props)));
        await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    };

    beforeEach(() => {
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        container = document.createElement("div");
        root = createRoot(container);
        latest = null;
    });
    afterEach(() => act(() => root.unmount()));

    it("returns null for an empty query and the ranking once it arrives", async () => {
        wasmFuzzyRank.mockReturnValue([{ id: "1", score: 3, titleIndices: [], authorIndices: [] }]);
        await render({ items, query: "" });
        expect(latest).toBeNull();
        expect(wasmFuzzyRank).not.toHaveBeenCalled();
        await render({ items, query: "emma" });
        expect(names(latest)).toEqual(["Emma"]);
        await render({ items, query: "" });
        expect(latest).toBeNull();
    });

    it("keeps the previous ranking, minus removed items, while a new one is pending", async () => {
        setTauri(true);
        invoke.mockResolvedValueOnce([
            { id: "0", score: 9, titleIndices: [], authorIndices: [] },
            { id: "2", score: 5, titleIndices: [], authorIndices: [] },
        ]);
        await render({ items, query: "dune", debounceMs: 0 });
        expect(names(latest)).toEqual(["Dune", "Dune Messiah"]);

        let resolveNext: (v: unknown) => void = () => {};
        invoke.mockImplementationOnce(() => new Promise((r) => (resolveNext = r)));
        const fewer = [items[1], items[2], items[3]];
        await render({ items: fewer, query: "dune", debounceMs: 0 });
        expect(names(latest)).toEqual(["Dune Messiah"]);
        await act(async () => resolveNext([{ id: "2", score: 4, titleIndices: [], authorIndices: [] }]));
        expect(names(latest)).toEqual(["Dunes of Arrakis"]);
    });

    it("never shows a stale answer over a newer one", async () => {
        setTauri(true);
        let resolveOld: (v: unknown) => void = () => {};
        invoke
            .mockImplementationOnce(() => new Promise((r) => (resolveOld = r)))
            .mockResolvedValueOnce([{ id: "1", score: 1, titleIndices: [], authorIndices: [] }]);
        await render({ items, query: "dune", debounceMs: 0 });
        await render({ items, query: "emma", debounceMs: 0 });
        expect(names(latest)).toEqual(["Emma"]);
        await act(async () => resolveOld([{ id: "0", score: 1, titleIndices: [], authorIndices: [] }]));
        expect(names(latest)).toEqual(["Emma"]);
    });

    it("debounces: only the last of quick changes is ranked", async () => {
        setTauri(true);
        invoke.mockResolvedValue([{ id: "1", score: 1, titleIndices: [], authorIndices: [] }]);
        await act(async () => root.render(createElement(Probe, { items, query: "e", debounceMs: 30 })));
        await act(async () => root.render(createElement(Probe, { items, query: "em", debounceMs: 30 })));
        await act(async () => root.render(createElement(Probe, { items, query: "emma", debounceMs: 30 })));
        expect(invoke).not.toHaveBeenCalled();
        await act(async () => { await new Promise((r) => setTimeout(r, 60)); });
        expect(invoke).toHaveBeenCalledTimes(1);
        expect(invoke.mock.calls[0][1]).toMatchObject({ query: "emma" });
        expect(names(latest)).toEqual(["Emma"]);
    });

    it("shows the list unfiltered (null) when no matcher can run", async () => {
        wasmReady = false;
        initTheoremCoreWasm.mockResolvedValue(false);
        await render({ items, query: "dune" });
        expect(latest).toBeNull();
    });
});
