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

test("shelf actions and their dropdown stay on screen at phone widths", async () => {
    try {
        for (const width of [320, 390, 640, 1280]) {
            await app.session.cmd("POST", "/window/rect", { width, height: 844, x: 0, y: 0 });
            await app.waitFor(async () => await app.session.execute("return innerWidth === arguments[0]", width), { what: `${width}px viewport` });
            const more = await app.find({ role: "button", name: "More actions" });
            const bounds = await app.session.execute(`
                const r = arguments[0].getBoundingClientRect();
                return { left: r.left, right: r.right, width: innerWidth };
            `, more);
            assert.ok(bounds.left > bounds.width / 2, `Actions should be on the right at ${width}px: ${JSON.stringify(bounds)}`);
            await app.click({ role: "button", name: "More actions" });
            for (const name of ["Group by Series", "Manage Series…", "Select Books", "New sub-shelf…"]) {
                // Use visible menu text: a separate keyboard-only toolbar
                // control also has the accessible name "Select Books".
                const item = await app.find({ text: name });
                const rect = await app.session.execute(`
                    const r = arguments[0].closest('button').getBoundingClientRect();
                    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: innerWidth, height: innerHeight };
                `, item);
                assert.ok(rect.left >= 0 && rect.right <= rect.width && rect.top >= 0 && rect.bottom <= rect.height,
                    `${name} should fit at ${width}px: ${JSON.stringify(rect)}`);
                assert.equal(await app.isClickable({ text: name }), true, `${name} is reachable at ${width}px`);
            }
            await app.click({ role: "button", name: "More actions" });
        }
    } finally {
        await app.session.cmd("POST", "/window/rect", { width: 1280, height: 844, x: 0, y: 0 });
    }
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
