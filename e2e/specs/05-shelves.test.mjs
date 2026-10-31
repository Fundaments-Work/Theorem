// Flow 5: create a shelf while adding a book to it; the shelf shows only that
// book and the library can be filtered back.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Sandbox } from "../lib/app.mjs";
import { BOOKS, writeStandardBooks } from "../lib/fixtures.mjs";
import { bookButton, goTo, importBooks, launchFresh } from "../lib/flows.mjs";

const box = new Sandbox("shelves");
const files = writeStandardBooks(box.files);
const SHELF = "Evening Reading";
let app;
before(async () => {
    app = await launchFresh(box);
    await importBooks(app, [files.lamplighter, files.harbour], { expectTitles: [BOOKS.lamplighter.title, BOOKS.harbour.title] });
});
after(() => box.dispose());

test("Shelves starts empty", async () => {
    await goTo(app, "Shelves");
    await app.find({ role: "heading", name: "No Shelves Yet" });
});

test("select a book and add it to a new shelf", async () => {
    await goTo(app, "Library");
    const card = await app.find(bookButton(BOOKS.harbour.title));
    const point = await app.session.execute("arguments[0].scrollIntoView({block:'center'}); const r=arguments[0].getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}", card);
    await app.session.pointer([{type:"move", ...point}, {type:"down",button:2}, {type:"up",button:2}]);
    await app.click({ role: "menuitem", name: "Select" });
    await app.find({ role: "checkbox", name: `Select ${BOOKS.harbour.title}`, checked: true });
    await app.click({ role: "button", name: "Add selected to shelf" });

    await app.find({ role: "dialog", name: "Add to Shelf" });
    // An empty name cannot be created.
    const create = await app.find({ role: "button", name: "Create" });
    assert.equal(await app.session.execute("return arguments[0].disabled", create), true);
    await app.fill({ role: "textbox", name: "New shelf name" }, SHELF);
    assert.equal(await app.value({ role: "textbox", name: "New shelf name" }), SHELF);
    await app.click({ role: "button", name: "Create" });
    await app.waitGone({ role: "dialog", name: "Add to Shelf" });
    if (await app.exists({ role: "button", name: /^Done/ })) await app.click({ role: "button", name: /^Done/ });
});

test("the shelf lists exactly the added book", async () => {
    await goTo(app, "Shelves");
    await app.waitForText(SHELF);
    await app.click({ text: SHELF });
    await app.find(bookButton(BOOKS.harbour.title));
    assert.equal(await app.exists(bookButton(BOOKS.lamplighter.title)), false);
});

test("the shelf survives a restart", async () => {
    await box.quit();
    app = await box.launch();
    await goTo(app, "Shelves");
    await app.waitForText(SHELF);
    await app.click({ text: SHELF });
    await app.find(bookButton(BOOKS.harbour.title));
    assert.equal(await app.exists(bookButton(BOOKS.lamplighter.title)), false);
});
