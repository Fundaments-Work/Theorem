import { join } from "node:path";
import { after, before, test } from "node:test";
import { Sandbox } from "../lib/app.mjs";
import { makeEpub } from "../lib/fixtures.mjs";
import { backToLibrary, goTo, highlightFirstWord, importBooks, launchFresh, openBook } from "../lib/flows.mjs";

const box = new Sandbox("reader-notes");
const titles = ["Reader note book", "Workbench note book"];
const files = titles.map((title, index) => makeEpub(join(box.files, `notes-${index}.epub`), {
    title, author: "Notes Author", marker: "Marker sentence for the note test.",
}));
let app;
before(async () => {
    app = await launchFresh(box);
    await importBooks(app, files, { expectTitles: titles });
});
after(() => box.dispose());

const editor = { role: "textbox", name: "Add your note..." };

test("Save on a note added to selected EPUB text persists it in Workbench Notes", async () => {
    await openBook(app, titles[0]);
    await highlightFirstWord(app, { colour: "Add Note" });
    await app.fill(editor, "A note saved inside the reader");
    await app.click({ role: "button", name: "Save" });
    await app.waitGone(editor);
    await backToLibrary(app);
    await goTo(app, "Workbench");
    await app.click({ role: "tab", name: "Notes" });
    await app.waitForText("A note saved inside the reader");
    await app.waitForText("1 note from 1 book");
});

test("a note added to a highlight in Workbench also appears in Notes", async () => {
    await goTo(app, "Library");
    await openBook(app, titles[1]);
    await highlightFirstWord(app);
    await backToLibrary(app);
    await goTo(app, "Workbench");
    await app.click({ role: "tab", name: "Highlights" });
    await app.waitForText(titles[1]);
    await app.click({ role: "button", name: "Actions" });
    await app.click({ role: "menuitem", name: "Edit note" });
    await app.fill(editor, "A note attached in Workbench");
    await app.click({ role: "button", name: "Save" });
    await app.waitGone(editor);
    await app.click({ role: "tab", name: "Notes" });
    await app.waitForText("A note attached in Workbench");
    await app.waitForText("2 notes from 2 books");
});

test("both notes remain available after restarting the app", async () => {
    await box.quit();
    app = await box.launch();
    await app.find({ role: "heading", name: "Library" });
    await goTo(app, "Workbench");
    await app.click({ role: "tab", name: "Notes" });
    await app.waitForText("A note attached in Workbench");
    await app.waitForText("A note saved inside the reader");
    await app.waitForText("2 notes from 2 books");
});
