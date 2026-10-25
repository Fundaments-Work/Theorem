// Flow 3: open a book, turn pages, leave; reopening (also after a restart)
// returns to the same page.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Sandbox } from "../lib/app.mjs";
import { BOOKS, writeStandardBooks } from "../lib/fixtures.mjs";
import { backToLibrary, importBooks, launchFresh, nextPage, openBook, readerPage } from "../lib/flows.mjs";

const box = new Sandbox("reader");
const files = writeStandardBooks(box.files);
const title = BOOKS.lamplighter.title;
let app;
before(async () => {
    app = await launchFresh(box);
    await importBooks(app, [files.lamplighter], { expectTitles: [title] });
});
after(() => box.dispose());

test("a new book opens on page 1 and pages turn forward and back", async () => {
    const start = await openBook(app, title);
    assert.equal(start.page, 1);
    assert.ok(start.total > 3, `book should span several pages, got ${start.total}`);
    await nextPage(app);
    const third = await nextPage(app);
    assert.equal(third.page, 3);

    await app.revealReaderChrome();
    await app.click({ role: "button", name: "Previous page" });
    await app.waitFor(async () => (await readerPage(app))?.page === 2, { what: "page 2" });
    const again = await nextPage(app);
    assert.equal(again.page, 3);
});

test("reopening the book returns to the same page", async () => {
    await backToLibrary(app);
    await openBook(app, title);
    const settled = await app.waitFor(async () => ((await readerPage(app))?.page === 3 ? 3 : null), { timeout: 8000, what: "page 3 on reopen" }).catch(async () => (await readerPage(app))?.page);
    assert.equal(settled, 3);
});

test("the position survives an app restart", async () => {
    await backToLibrary(app);
    await box.quit();
    app = await box.launch();
    await openBook(app, title);
    // The reader may show page 1 for a moment before it jumps to the saved spot.
    const settled = await app.waitFor(async () => ((await readerPage(app))?.page === 3 ? 3 : null), { timeout: 8000, what: "page 3 after restart" }).catch(async () => (await readerPage(app))?.page);
    assert.equal(settled, 3);
});
