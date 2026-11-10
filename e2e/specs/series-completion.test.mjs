import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Sandbox } from "../lib/app.mjs";
import { copyFixture, makeEpub } from "../lib/fixtures.mjs";
import { bookButton, goTo, importBooks, launchFresh } from "../lib/flows.mjs";

const box = new Sandbox("series-completion");
const titles = ["series-first", "Series Second"];
const files = [
    copyFixture("pdf/page-labels.pdf", join(box.files, "series-first.pdf")),
    makeEpub(join(box.files, "series-second.epub"), { title: titles[1], author: "Series Author" }),
];
let app;

before(async () => {
    app = await launchFresh(box);
    await importBooks(app, files, { expectTitles: titles });
    for (const [index, title] of titles.entries()) {
        const card = await app.find(bookButton(title));
        const point = await app.session.execute("arguments[0].scrollIntoView({block:'center'});const r=arguments[0].getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}", card);
        await app.session.pointer([{ type: "move", ...point }, { type: "down", button: 2 }, { type: "up", button: 2 }]);
        await app.click({ role: "menuitem", name: "More…" });
        await app.click({ role: "menuitem", name: "Edit Info" });
        const dialog = await app.find({ role: "dialog", name: "Edit Book Info" });
        await app.waitFor(async () => (await app.value({ role: "textbox", name: "Title", within: dialog })) === title, { what: "book editor to load" });
        await app.fill({ role: "textbox", name: "Series Name", within: dialog }, "Navigation Series");
        await app.fill({ role: "spinbutton", name: "Volume / Index", within: dialog }, String(index + 1));
        assert.equal(await app.value({ role: "textbox", name: "Series Name", within: dialog }), "Navigation Series");
        await app.click({ role: "button", name: "Save", within: dialog });
        await app.waitGone({ role: "dialog", name: "Edit Book Info" });
        await goTo(app, "Settings");
        await goTo(app, "Library");
        const savedCard = await app.find(bookButton(title));
        const savedPoint = await app.session.execute("arguments[0].scrollIntoView({block:'center'});const r=arguments[0].getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}", savedCard);
        await app.session.pointer([{ type: "move", ...savedPoint }, { type: "down", button: 2 }, { type: "up", button: 2 }]);
        await app.click({ role: "menuitem", name: "More…" });
        await app.click({ role: "menuitem", name: "Edit Info" });
        const savedDialog = await app.find({ role: "dialog", name: "Edit Book Info" });
        await app.waitFor(async () => (await app.value({ role: "textbox", name: "Series Name", within: savedDialog })) === "Navigation Series", { what: "saved series metadata" });
        await app.click({ role: "button", name: "Cancel", within: savedDialog });
        await app.waitGone({ role: "dialog", name: "Edit Book Info" });
    }
});
after(() => box.dispose());

test("Read Next opens the next book and dismisses its notification", async () => {
    await app.click(bookButton(titles[0]));
    await app.find({ role: "heading", name: "Page Labels Fixture" });
    for (let i = 0; i < 6; i++) {
        const before = await app.text();
        await app.revealReaderChrome();
        await app.click({ role: "button", name: "Next page" });
        await app.waitFor(async () => (await app.text()) !== before, { what: "PDF page to change" });
    }
    const action = { role: "button", name: "Read Next" };
    await app.find(action, { timeout: 10000 });
    await app.click(action);
    await app.waitGone(action);
    await app.waitForText(titles[1]);
    assert.equal(await app.exists(action), false);
});
