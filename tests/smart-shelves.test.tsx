import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSmartShelves } from "../src/core/lib/useSmartShelves";
import { ShelfModal } from "../src/features/library/components/modals/ShelfModal";
import { mergeCollections } from "../src/core/lib/sync-import";
import { CollectionSchema } from "../src/core/lib/sync-schemas";
import type { Book, Collection, SmartShelfDefinition } from "../src/core/types";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: vi.fn(() => true) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("../src/core/lib/env", () => ({ isTauri: mocks.isTauri }));
vi.mock("../src/ui", () => ({
    Modal: ({ isOpen, children }: { isOpen: boolean; children: React.ReactNode }) => isOpen ? <div>{children}</div> : null,
    ModalBody: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    ModalFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
const rules: SmartShelfDefinition = { mode: "all", conditions: [{ field: "status", operator: "equals", value: "unread" }] };
const shelf = (id: string, smartRules?: SmartShelfDefinition): Collection => ({ id, name: id, kind: "general", bookIds: [], createdAt: new Date("2026-01-01"), smartRules });
let host: HTMLDivElement; let root: Root;
beforeEach(() => {
    vi.useFakeTimers(); mocks.invoke.mockReset(); mocks.isTauri.mockReturnValue(true);
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); });

describe("dynamic smart shelves", () => {
    it("ignores stale results after progress changes and does not persist derived IDs", async () => {
        let resolveOld!: (result: { id: string; bookIds: string[] }[]) => void;
        mocks.invoke.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
            .mockResolvedValueOnce([{ id: "smart", bookIds: [] }]);
        const definitions = [shelf("smart", rules), { ...shelf("manual"), bookIds: ["b"] }];
        const initial = [{ id: "b", progress: 0 }] as Book[];
        let current!: ReturnType<typeof useSmartShelves>;
        function View({ books }: { books: Book[] }) { current = useSmartShelves(books, definitions); return null; }
        act(() => root.render(<View books={initial} />));
        expect(current.ready).toBe(false);
        await act(async () => { await vi.advanceTimersByTimeAsync(60); });
        await act(async () => { root.render(<View books={[{ ...initial[0], progress: 1 }]} />); });
        await act(async () => { await vi.advanceTimersByTimeAsync(60); });
        expect(current.ready).toBe(true);
        await act(async () => { resolveOld([{ id: "smart", bookIds: ["b"] }]); });
        expect(current.collections[0].bookIds).toEqual([]);
        expect(current.collections[1].bookIds).toEqual(["b"]);
        expect(definitions[0].bookIds).toEqual([]);
    });
    it("fails closed on native errors and keeps manual shelves usable", async () => {
        mocks.invoke.mockRejectedValue(new Error("failed"));
        const definitions = [shelf("smart", rules), { ...shelf("manual"), bookIds: ["b"] }];
        let current!: ReturnType<typeof useSmartShelves>;
        const books: Book[] = [];
        function View() { current = useSmartShelves(books, definitions); return null; }
        act(() => root.render(<View />));
        await act(async () => { await vi.advanceTimersByTimeAsync(60); });
        expect(current.ready).toBe(false); expect(current.error).toContain("Could not update");
        expect(current.collections[0].bookIds).toEqual([]); expect(current.collections[1].bookIds).toEqual(["b"]);
    });
    it("skips native evaluation for manual shelves", () => {
        const definitions = [shelf("manual")]; let ready = false;
        function View() { ready = useSmartShelves([], definitions).ready; return null; }
        act(() => root.render(<View />));
        expect(ready).toBe(true); expect(mocks.invoke).not.toHaveBeenCalled();
    });
});

describe("smart shelf editor and sync", () => {
    it("saves existing rules and requires a value before saving a new rule", () => {
        const onSave=vi.fn(); const definition=shelf("Unread",rules);
        act(() => root.render(<ShelfModal isOpen shelf={definition} onClose={vi.fn()} onSave={onSave} />));
        const submit=host.querySelector<HTMLButtonElement>('button[type="submit"]')!;
        expect(submit.disabled).toBe(false);
        act(() => host.querySelector('form')!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
        expect(onSave).toHaveBeenCalledWith("Unread","",rules);
        act(() => [...host.querySelectorAll('button')].find((b)=>b.textContent==="Add rule")!.click());
        expect(submit.disabled).toBe(true);
    });
    it("creates rules through the field and value controls", () => {
        const onSave = vi.fn();
        act(() => root.render(<ShelfModal isOpen shelf={shelf("Comics")} onClose={vi.fn()} onSave={onSave} />));
        act(() => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
        const field = host.querySelector<HTMLSelectElement>('[aria-label="Rule 1 field"]')!;
        act(() => { field.value="format"; field.dispatchEvent(new Event("change",{bubbles:true})); });
        const value=host.querySelector<HTMLSelectElement>('[aria-label="Rule 1 value"]')!;
        act(() => { value.value="cbr"; value.dispatchEvent(new Event("change",{bubbles:true})); });
        act(() => host.querySelector('form')!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
        expect(onSave).toHaveBeenCalledWith("Comics","",{mode:"all",conditions:[{field:"format",operator:"equals",value:"cbr"}]});
    });
    it("syncs the newer definition without storing computed membership, and supports conversion back to manual", () => {
        const old={...shelf("s"),bookIds:["old"],updatedAt:new Date("2026-01-01")};
        const incoming={...shelf("s",rules),bookIds:["transient"],updatedAt:new Date("2026-01-02")};
        const merged=mergeCollections([incoming],[old]);
        expect(merged[0].smartRules).toEqual(rules); expect(merged[0].bookIds).toEqual([]);
        const manual={...shelf("s"),bookIds:["b"],updatedAt:new Date("2026-01-03")};
        expect(mergeCollections([manual],merged)[0].smartRules).toBeUndefined();
        expect(CollectionSchema.safeParse({...incoming,smartRules:{mode:"all",conditions:[]}}).success).toBe(false);
        expect(CollectionSchema.safeParse({...incoming,smartRules:{mode:"all",conditions:[{field:"status",operator:"equals",value:"unknown"}]}}).success).toBe(false);
    });
});
