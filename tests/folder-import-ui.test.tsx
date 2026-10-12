import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FolderImportModal } from "../src/features/library/components/modals/FolderImportModal";
import { SourceFolderBrowser } from "../src/features/library/components/SourceFolderBrowser";

vi.mock("../src/ui", () => ({
    Modal: ({ isOpen, children }: { isOpen: boolean; children: React.ReactNode }) => isOpen ? <div role="dialog">{children}</div> : null,
    ModalHeader: ({ title }: { title: string }) => <h2>{title}</h2>,
    ModalBody: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    ModalFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
const button = (label: string) => [...host.querySelectorAll("button")].find(b => b.textContent === label)!;

describe("folder import choice", () => {
    it("offers preservation by default, lets the user choose flat import, and does not start work on cancel", () => {
        const onContinue = vi.fn(); const onClose = vi.fn();
        act(() => root.render(<FolderImportModal isOpen onClose={onClose} onContinue={onContinue} />));
        const radios = host.querySelectorAll<HTMLInputElement>('input[type="radio"]');
        expect(radios[0].checked).toBe(true);
        act(() => button("Choose folder").click());
        expect(onContinue).toHaveBeenLastCalledWith(true);
        act(() => radios[1].click());
        act(() => button("Choose folder").click());
        expect(onContinue).toHaveBeenLastCalledWith(false);
        act(() => button("Cancel").click());
        expect(onClose).toHaveBeenCalledOnce();
        expect(onContinue).toHaveBeenCalledTimes(2);
    });
    it("does not show a choice when closed", () => {
        act(() => root.render(<FolderImportModal isOpen={false} onClose={vi.fn()} onContinue={vi.fn()} />));
        expect(host.querySelector('[role="dialog"]')).toBeNull();
    });
});
describe("folder navigation", () => {
    const index = new Map([["C:/Books", { name: "Books", folders: new Map([
        ["", new Set(["a"])], ["Engineering", new Set(["a"])], ["Engineering/Electronics", new Set(["a"])],
    ]) }]]);
    it("navigates children and breadcrumbs, and can return to all books", () => {
        const onSelect = vi.fn();
        act(() => root.render(<SourceFolderBrowser index={index} selected={{ root: "C:/Books", path: "Engineering" }} onSelect={onSelect} />));
        act(() => button("Electronics (1)").click());
        expect(onSelect).toHaveBeenLastCalledWith({ root: "C:/Books", path: "Engineering/Electronics" });
        act(() => button("Books").click());
        expect(onSelect).toHaveBeenLastCalledWith({ root: "C:/Books", path: "" });
        const select = host.querySelector("select")!;
        act(() => { select.value = ""; select.dispatchEvent(new Event("change", { bubbles: true })); });
        expect(onSelect).toHaveBeenLastCalledWith(null);
    });
});
