// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useImportStore, type NativeImportSnapshot } from "../src/core/store";
import ImportProgressPanel, { formatImportBytes } from "../src/features/library/components/ImportProgressPanel";

const commands = vi.hoisted(() => ({ stop: vi.fn(async () => {}), resume: vi.fn(async () => {}), discard: vi.fn(async () => {}) }));
vi.mock("../src/core/lib/native-import-jobs", () => ({ stopNativeImport: commands.stop, resumeNativeImport: commands.resume, discardNativeImport: commands.discard }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let host: HTMLDivElement;
let root: Root;
const snapshot = (over: Partial<NativeImportSnapshot> = {}): NativeImportSnapshot => ({ id: "job", active: true, resumable: false, total: 3, completed: 1, imported: 1, duplicates: 0, errors: [], current: { name: "Large.cbr", stage: "copying", completedBytes: 1024, totalBytes: 2048 }, ...over });
const render = (value: NativeImportSnapshot | null) => act(() => {
    useImportStore.setState({ snapshot: value, error: null });
    root.render(<ImportProgressPanel />);
});
const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === text)!;
beforeEach(() => {
    vi.clearAllMocks(); useImportStore.setState({ snapshot: null, error: null });
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe("import progress panel", () => {
    it("is absent before a job and after successful metadata persistence", () => {
        render(null); expect(host.textContent).toBe("");
        render(snapshot({ active: false, completed: 3, imported: 3 })); expect(host.textContent).toBe("");
    });

    it("copying 100 percent still shows an active job until saving finishes", () => {
        render(snapshot({ current: { name: "Large.cbr", stage: "copying", completedBytes: 2048, totalBytes: 2048 } }));
        expect(host.querySelector("progress")?.value).toBe(2048);
        expect(host.textContent).toContain("1 / 3 files");
        render(snapshot({ current: { name: "Large.cbr", stage: "saving", completedBytes: 0, totalBytes: null } }));
        expect(host.querySelector("progress")?.hasAttribute("value")).toBe(false);
        expect(host.querySelector('[role="status"]')?.textContent).toContain("Saving");
        expect(button("Stop import")).toBeDefined();
    });

    it("unknown and zero totals are indeterminate and large counts retain GiB units", () => {
        for (const totalBytes of [null, 0]) {
            render(snapshot({ current: { name: "Unknown.epub", stage: "copying", completedBytes: 0, totalBytes } }));
            expect(host.querySelector("progress")?.hasAttribute("value")).toBe(false);
            expect(host.textContent).toContain("total unknown");
        }
        expect(formatImportBytes(5 * 1024 ** 3)).toBe("5 GiB");
        expect(formatImportBytes(0)).toBe("0 B");
        expect(formatImportBytes(Number.NaN)).toBe("Unknown size");
    });

    it("resume starts work without preventing the Stop action on the resumed job", async () => {
        render(snapshot({ active: false, resumable: true }));
        await act(async () => { button("Resume import").click(); });
        expect(commands.resume).toHaveBeenCalledTimes(1);
        render(snapshot());
        expect(button("Stop import").disabled).toBe(false);
        await act(async () => { button("Stop import").click(); });
        expect(commands.stop).toHaveBeenCalledTimes(1);
    });

    it("offers discard only for stopped pending work", async () => {
        render(snapshot()); expect(button("Discard pending import")).toBeUndefined();
        render(snapshot({ active: false, resumable: true }));
        await act(async () => { button("Discard pending import").click(); });
        expect(commands.discard).toHaveBeenCalledTimes(1);
    });

    it("shows per-file failures and retains a corrupt-checkpoint error", () => {
        render(snapshot({ active: false, errors: [{ source: "Broken.cbr", message: "Archive is corrupt" }] }));
        expect([...host.querySelectorAll('[role="alert"]')].map((item) => item.textContent)).toContain("Broken.cbr: Archive is corrupt");
        act(() => button("Dismiss").click()); expect(host.textContent).toBe("");
        act(() => useImportStore.getState().setError("Checkpoint is corrupt and has been retained"));
        expect(host.querySelector('[role="alert"]')?.textContent).toContain("has been retained");
    });
});
