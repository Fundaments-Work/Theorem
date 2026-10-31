// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/core/lib/cover-download", () => ({downloadCoverImage:vi.fn()}));
vi.mock("../src/core/lib/book-edit", () => ({applyBookEdits:vi.fn().mockResolvedValue({ok:true})}));
import { downloadCoverImage } from "../src/core/lib/cover-download";
import { applyBookEdits } from "../src/core/lib/book-edit";
import { EditBookModal } from "../src/features/library/components/modals/EditBookModal";
import type { Book } from "../src/core/types";

(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
const book: Book={id:"book",title:"A Book",author:"Author",format:"epub",filePath:"book.epub",fileSize:1,addedAt:new Date(),progress:0,tags:[],isFavorite:false,readingTime:0};
let host:HTMLDivElement; let root:Root;
const close=vi.fn();
const render=(open=true, value=book)=>act(()=>root.render(<EditBookModal isOpen={open} book={value} onClose={close} />));
const button=(text:string)=>[...document.querySelectorAll<HTMLButtonElement>("button")].find(item=>item.textContent?.trim()===text)!;
async function load() {
    await act(async()=>button("From URL").click());
    const input=document.querySelector<HTMLInputElement>('[aria-label="Cover image URL"]')!;
    await act(async()=>{
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,"https://example.org/cover.jpg");
        input.dispatchEvent(new Event("input",{bubbles:true}));
    });
    await act(async()=>button("Load").click());
}
beforeEach(()=>{
    vi.clearAllMocks();
    vi.stubGlobal("URL", class extends URL {static createObjectURL=vi.fn(()=>"blob:cover"); static revokeObjectURL=vi.fn();});
    host=document.createElement("div");document.body.append(host);root=createRoot(host);
});
afterEach(()=>{act(()=>root.unmount());host.remove();vi.unstubAllGlobals();});
describe("editing a cover from a URL",()=>{
    it("previews and saves the downloaded image through the normal book edit path",async()=>{
        const image=new Blob(["image"],{type:"image/jpeg"});
        vi.mocked(downloadCoverImage).mockResolvedValue(image);
        render(); await load();
        expect(document.querySelector('img[src="blob:cover"]')).not.toBeNull();
        await act(async()=>document.querySelector("form")!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
        expect(applyBookEdits).toHaveBeenCalledExactlyOnceWith(book.id,{}, {blob:image});
        expect(close).toHaveBeenCalledOnce();
    });
    it("blocks Save while loading and ignores a result after the editor is closed",async()=>{
        let resolve!:(blob:Blob)=>void;
        vi.mocked(downloadCoverImage).mockReturnValue(new Promise(done=>{resolve=done;}));
        render(); await load();
        expect(button("Save").disabled).toBe(true);
        expect(document.querySelector<HTMLInputElement>('[aria-label="Cover image URL"]')!.disabled).toBe(true);
        render(false);
        await act(async()=>resolve(new Blob(["old"],{type:"image/jpeg"})));
        render(true,{...book,id:"other",title:"Other Book"});
        expect(document.querySelector('img[src="blob:cover"]')).toBeNull();
        expect(URL.createObjectURL).not.toHaveBeenCalled();
        expect(button("Save").disabled).toBe(false);
    });
    it("shows a failed download without replacing the existing cover",async()=>{
        vi.mocked(downloadCoverImage).mockRejectedValue(new Error("URL did not return an image."));
        render(true,{...book,coverPath:"https://example.org/old.jpg"}); await load();
        expect(document.querySelector('[role="alert"]')?.textContent).toContain("not return an image");
        expect(document.querySelector('img[src="https://example.org/old.jpg"]')).not.toBeNull();
        expect(button("Save").disabled).toBe(false);
    });
});
