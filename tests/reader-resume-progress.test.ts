import { describe, it, expect } from "vitest";
import { isUserRelocation, resumeDecision } from "../src/features/reader/lib/resume-progress";

const SAVED = "epubcfi(/6/2!/4/2,/52,/74/1:169)";

describe("reader resume: what a location change means while the saved position is restored", () => {
    it("arrives when the location starts with the saved CFI", () => {
        expect(resumeDecision({ target: SAVED, cfi: SAVED })).toBe("arrived");
        expect(resumeDecision({ target: "epubcfi(/6/2!/4/2", cfi: SAVED })).toBe("arrived");
    });

    it("waits through the transient locations of the jump", () => {
        // First render at the section start, before the jump.
        expect(resumeDecision({ target: SAVED, cfi: "epubcfi(/6/2!/4)" })).toBe("wait");
        expect(resumeDecision({ target: SAVED, cfi: "epubcfi(/6/2!/4/2,/2,/26/1:169)", byUser: false })).toBe("wait");
        expect(resumeDecision({ target: SAVED, cfi: "" })).toBe("wait");
        expect(resumeDecision({ target: SAVED, cfi: undefined })).toBe("wait");
    });

    it("a fresh book (no saved CFI) waits for the reader, not only for a timer", () => {
        expect(resumeDecision({ target: null, cfi: "epubcfi(/6/2!/4/2,/2,/26/1:169)" })).toBe("wait");
        // Turning pages in the first second after opening used to be dropped, so
        // the book reopened on page 1.
        expect(resumeDecision({ target: null, cfi: "epubcfi(/6/2!/4/2,/28,/50/1:169)", byUser: true })).toBe("user");
    });

    it("a page turn during a resume ends it and is saved", () => {
        expect(resumeDecision({ target: SAVED, cfi: "epubcfi(/6/2!/4/2,/76,/84/1:169)", byUser: true })).toBe("user");
    });

    it("arriving wins over a page turn that lands on the target", () => {
        expect(resumeDecision({ target: SAVED, cfi: SAVED, byUser: true })).toBe("arrived");
    });

    it("only the paginator's page-turn reasons count as the reader's own", () => {
        for (const r of ["page", "snap", "scroll"]) expect(isUserRelocation(r)).toBe(true);
        for (const r of ["navigation", "anchor", "selection", "", undefined, null, 3]) expect(isUserRelocation(r)).toBe(false);
    });
});
