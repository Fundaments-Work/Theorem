// Flow 2: import books through the file picker; the library lists them and
// search narrows the list.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Sandbox } from "../lib/app.mjs";
import { BOOKS, writeStandardBooks } from "../lib/fixtures.mjs";
import { bookButton, importBooks, launchFresh } from "../lib/flows.mjs";

const box = new Sandbox("library");
const files = writeStandardBooks(box.files);
let app;
before(async () => {
    app = await launchFresh(box);
});
after(() => box.dispose());

const titles = Object.values(BOOKS).map((b) => b.title);

test("importing three EPUBs lists all three", async () => {
    await importBooks(app, Object.values(files), { expectTitles: titles });
    await app.waitForText("3 books");
    assert.deepEqual(app.dialogCalls().map((c) => c.kind), ["open"]);
});

test("importing the same file again does not duplicate it", async () => {
    await importBooks(app, [files.harbour]);
    await app.waitFor(() => app.dialogCalls().length === 2, { what: "the second file pick" });
    // The import of a known book is a no-op; give it the time a real one takes.
    await new Promise((r) => setTimeout(r, 1500));
    await app.waitFor(async () => !(await app.exists({ role: "button", name: /^Importing/ })), { what: "import to finish" });
    // Whatever the app says about the duplicate, the library still holds one copy.
    if (await app.exists({ role: "button", name: "OK" })) await app.click({ role: "button", name: "OK" });
    await app.waitForText("3 books");
    assert.equal((await app.findAll(bookButton(BOOKS.harbour.title))).length, 1);
});

test("search by title finds one book; clearing restores the list", async () => {
    await app.fill({ role: "textbox", name: "Search" }, "Harbour");
    await app.waitGone(bookButton(BOOKS.lamplighter.title));
    assert.ok(await app.exists(bookButton(BOOKS.harbour.title)));
    assert.equal(await app.exists(bookButton(BOOKS.clouds.title)), false);

    await app.click({ role: "button", name: "Clear search" });
    for (const t of titles) await app.find(bookButton(t));
});

test("search by author works and a nonsense query shows no books", async () => {
    await app.fill({ role: "textbox", name: "Search" }, "Cora Wren");
    await app.waitGone(bookButton(BOOKS.harbour.title));
    assert.ok(await app.exists(bookButton(BOOKS.clouds.title)));

    await app.fill({ role: "textbox", name: "Search" }, "zzqxv nothing matches");
    await app.waitGone(bookButton(BOOKS.clouds.title));
    for (const t of titles) assert.equal(await app.exists(bookButton(t)), false);
    await app.click({ role: "button", name: "Clear search" });
});
