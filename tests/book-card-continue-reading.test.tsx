// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoizedBookCard } from "../src/features/library/components/BookCard";
import type { Book, LibraryViewMode } from "../src/core/types";
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let root: Root;
let host: HTMLDivElement;
const book:Book={id:"recent",title:"A reading book",author:"Author",format:"epub",filePath:"/recent.epub",fileSize:10,addedAt:new Date(),progress:0.4,currentLocation:"saved",tags:[],isFavorite:false,readingTime:5};
const open=vi.fn();
const noop=()=>{};
function render(mode:LibraryViewMode,resume=true,selecting=false) {
    act(()=>root.render(<MemoizedBookCard book={book} viewMode={mode} isResume={resume} isSelecting={selecting} onOpenBook={open} onToggleFavorite={noop} onDeleteBook={noop} onShowInfo={noop} onAddToShelf={noop} onRename={noop} onExport={noop} onMarkAsRead={noop} onMarkAsUnread={noop} />));
}
beforeEach(()=>{host=document.createElement("div");document.body.append(host);root=createRoot(host);open.mockClear();});
afterEach(()=>{act(()=>root.unmount());host.remove();});
describe("continue reading within a book card",()=>{
    it.each(["grid","list","compact"] as const)("marks the recent %s card and opens it with the existing saved location",mode=>{
        render(mode);
        const card=host.querySelector<HTMLElement>('[role="button"][aria-label="Open A reading book"]')!;
        expect(card.querySelector('[aria-label="Continue reading"]')).not.toBeNull();
        act(()=>card.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true})));
        expect(open).toHaveBeenCalledExactlyOnceWith(book);
        expect(book.currentLocation).toBe("saved");
        expect(host.querySelector("button[aria-label=Resume]")).toBeNull();
    });
    it("updates the marker when the recent book changes without mutating the book",()=>{
        render("grid",false);expect(host.querySelector('[aria-label="Continue reading"]')).toBeNull();
        render("grid",true);expect(host.querySelector('[aria-label="Continue reading"]')).not.toBeNull();
        render("grid",false);expect(host.querySelector('[aria-label="Continue reading"]')).toBeNull();
        expect(book.progress).toBe(0.4);
    });
    it("hides the marker in selection mode",()=>{
        render("list",true,true);
        expect(host.querySelector('[aria-label="Continue reading"]')).toBeNull();
        expect(host.querySelector('[role="checkbox"]')).not.toBeNull();
    });
});
