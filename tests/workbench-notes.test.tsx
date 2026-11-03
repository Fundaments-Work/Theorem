// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { AnnotationsPage } from "../src/features/library/Annotations";
import { useLibraryStore, useUIStore } from "../src/core/store";
import type { Annotation, Book } from "../src/core/types";
import { WORKBENCH_VIEW_STATE_KEY } from "../src/core/lib/workbench-state";
import { render, unmountAll } from "./helpers/opds-browser-harness";

const book: Book = {
    id: "note-book", title: "Notes book", author: "Author", format: "epub",
    filePath: "/books/notes.epub", fileSize: 100, addedAt: new Date(),
    progress: 0, tags: [], isFavorite: false, readingTime: 0,
};
const mark = (noteContent?: string, type: Annotation["type"] = "highlight"): Annotation => ({
    id: "note-mark", bookId: book.id, type, location: "epubcfi(/6/2!/4/2)",
    selectedText: "Selected passage", noteContent, createdAt: new Date(),
});

beforeEach(() => {
    window.sessionStorage.clear();
    window.sessionStorage.setItem(WORKBENCH_VIEW_STATE_KEY, JSON.stringify({ activeFilter: "notes", viewMode: "cards" }));
    useUIStore.setState({ currentRoute: "annotations", searchQuery: "", workbenchFilterRequest: undefined });
    useLibraryStore.setState({ books: [book], annotations: [] });
});
afterEach(() => {
    unmountAll();
    useLibraryStore.setState({ books: [], annotations: [] });
    window.sessionStorage.clear();
});

describe("Workbench Notes", () => {
    it("shows an existing highlight's attached note without rewriting its saved type", () => {
        useLibraryStore.setState({ annotations: [mark("An attached note")] });
        const host = render(<AnnotationsPage />);
        expect(host.textContent).toContain("An attached note");
        expect(host.textContent).toContain("1 note from 1 book");
        expect(useLibraryStore.getState().annotations[0].type).toBe("highlight");
        act(() => { host.querySelector<HTMLButtonElement>('[role="tab"][aria-label="Highlights"]')!.click(); });
        expect(host.textContent).toContain("An attached note");
        expect(host.textContent).toContain("1 highlight from 1 book");
    });

    it("reflects adding, changing and clearing an attached note while Notes is open", () => {
        useLibraryStore.setState({ annotations: [mark()] });
        const host = render(<AnnotationsPage />);
        expect(host.textContent).toContain("No notes found.");
        act(() => { useLibraryStore.getState().updateAnnotation("note-mark", { noteContent: "New note" }); });
        expect(host.textContent).toContain("New note");
        act(() => { useLibraryStore.getState().updateAnnotation("note-mark", { noteContent: "Updated note" }); });
        expect(host.textContent).toContain("Updated note");
        act(() => { useLibraryStore.getState().updateAnnotation("note-mark", { noteContent: "  \n " }); });
        expect(host.textContent).toContain("No notes found.");
    });

    it.each([undefined, "", "  \n "])("excludes highlights without a meaningful note: %j", noteContent => {
        useLibraryStore.setState({ annotations: [mark(noteContent)] });
        expect(render(<AnnotationsPage />).textContent).toContain("No notes found.");
    });

    it("continues showing explicit note records", () => {
        useLibraryStore.setState({ annotations: [mark("Explicit note", "note")] });
        expect(render(<AnnotationsPage />).textContent).toContain("Explicit note");
    });
});
