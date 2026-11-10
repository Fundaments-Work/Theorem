import assert from "node:assert/strict";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { Sandbox } from "../lib/app.mjs";
import { makeEpub } from "../lib/fixtures.mjs";
import { backToLibrary, bookButton, importBooks, launchFresh, openBook, nextPage, readerPage } from "../lib/flows.mjs";

const box = new Sandbox("native-import-jobs");
const existing = makeEpub(join(box.files, "existing.epub"), { title: "Existing reader book", author: "Job Tests" });
const first = makeEpub(join(box.files, "first.epub"), { title: "First queued book", author: "Job Tests" });
const second = makeEpub(join(box.files, "second.epub"), { title: "Second queued book", author: "Job Tests" });
const gate = join(box.dialogs, "hold-import");
let app;
before(async () => { app = await launchFresh(box); await importBooks(app, [existing], { expectTitles: ["Existing reader book"] }); });
after(() => box.dispose());

async function startBatch() {
    writeFileSync(gate, "1");
    app.queueDialog("open", [first, second]);
    await app.click({ role: "button", name: /^Add Books\b/ });
    await app.find(bookButton("First queued book"));
    await app.find({ role: "region", name: "Import progress" });
    await app.waitForText("1 / 2 files");
}

async function panelFits() {
    const geometry = await app.session.execute("const p=document.querySelector('section[aria-label=\"Import progress\"]');const r=p.getBoundingClientRect();const m=document.querySelector('#app-main').getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,mainTop:m.top,width:innerWidth,height:innerHeight}");
    assert.ok(geometry.left >= 0 && geometry.right <= geometry.width, JSON.stringify(geometry));
    assert.ok(geometry.top >= 0 && geometry.bottom <= geometry.height, JSON.stringify(geometry));
    assert.ok(geometry.bottom <= geometry.mainTop + 1, JSON.stringify(geometry));
}

test("native import progress remains above Library and hides while reading", async () => {
    await startBatch();
    await panelFits();
    await app.invoke("plugin:window|unmaximize", { label: "main" });
    await app.waitFor(async () => !(await app.invoke("plugin:window|is_maximized", { label: "main" })), { what: "window to leave maximized state" });
    await app.session.cmd("POST", "/window/rect", { width: 390, height: 844, x: 0, y: 0 });
    await app.waitFor(async () => await app.session.execute("return innerWidth===390"), { what: "390px viewport" });
    await panelFits();
    await app.session.execute("document.querySelector('#app-main').scrollTop=300");
    await panelFits();
    await openBook(app, "Existing reader book");
    await app.waitFor(async () => !(await app.session.execute("return !!document.querySelector('section[aria-label=\"Import progress\"]')")), { what: "import panel to hide in the reader" });
    await backToLibrary(app);
    await app.find({ role: "region", name: "Import progress" });
    await app.waitForText("1 / 2 files");
});

test("an interrupted native import resumes after restart without duplicating saved books", async () => {
    await box.quit({ hard: true });
    app = await box.launch();
    await app.find({ role: "button", name: "Resume import" });
    await app.find(bookButton("First queued book"));
    rmSync(gate);
    await app.click({ role: "button", name: "Resume import" });
    await app.find(bookButton("Second queued book"));
    await app.waitFor(async () => !(await app.session.execute("return !!document.querySelector('section[aria-label=\"Import progress\"]')")), { what: "saved import to complete" });
    assert.equal((await app.findAll(bookButton("First queued book"))).length, 1);
    await box.quit(); app = await box.launch();
    await app.find(bookButton("First queued book"));
    await app.find(bookButton("Second queued book"));
});

test("Stop retains pending work and Discard permits a new batch", async () => {
    const third = makeEpub(join(box.files, "third.epub"), { title: "Third queued book", author: "Job Tests" });
    writeFileSync(gate, "0");
    app.queueDialog("open", [third]);
    await app.click({ role: "button", name: /^Add Books\b/ });
    await app.find({ role: "region", name: "Import progress" });
    await app.click({ role: "button", name: "Stop import" });
    await app.find({ role: "button", name: "Resume import" });
    await app.click({ role: "button", name: "Discard pending import" });
    await app.waitFor(async () => !(await app.session.execute("return !!document.querySelector('section[aria-label=\"Import progress\"]')")), { what: "pending import to be discarded" });
    rmSync(gate);
    await importBooks(app, [third], { expectTitles: ["Third queued book"] });
    await app.find(bookButton("First queued book"));
    await app.find(bookButton("Second queued book"));
});


test("resuming a pending queue preserves an imported book's saved reading position", async () => {
    const reading = makeEpub(join(box.files, "reading.epub"), { title: "Journalled reading book", author: "Job Tests" });
    const pending = makeEpub(join(box.files, "pending.epub"), { title: "Still pending book", author: "Job Tests" });
    writeFileSync(gate, "1");
    app.queueDialog("open", [reading, pending]);
    await app.click({ role: "button", name: /^Add Books\b/ });
    await app.find(bookButton("Journalled reading book"));
    await app.find({ role: "region", name: "Import progress" });
    await app.invoke("plugin:window|unmaximize", { label: "main" });
    await app.waitFor(async () => !(await app.invoke("plugin:window|is_maximized", { label: "main" })), { what: "window to leave maximized state" });
    await app.session.cmd("POST", "/window/rect", { width: 1280, height: 800, x: 0, y: 0 });
    await app.waitFor(async () => await app.session.execute("return innerWidth===1280"), { what: "desktop reader viewport" });
    await openBook(app, "Journalled reading book");
    await nextPage(app);
    await nextPage(app);
    await backToLibrary(app);
    await box.quit(); app = await box.launch();
    await app.find({ role: "button", name: "Resume import" });
    rmSync(gate);
    await app.click({ role: "button", name: "Resume import" });
    await app.find(bookButton("Still pending book"));
    await openBook(app, "Journalled reading book");
    await app.waitFor(async () => (await readerPage(app))?.page === 3, { what: "saved page 3 after import recovery" });
    assert.equal((await readerPage(app)).page, 3);
});


test("recovery skips an already-saved identity even if its original source is unavailable", async () => {
    await backToLibrary(app);
    const records = (await app.invoke("sqlite_load_all_books")).map((value) => JSON.parse(value));
    const saved = records.find((book) => book.title === "Journalled reading book");
    assert.ok(saved);
    const checkpoint = { version: 1, id: randomUUID(), entries: [{ bookId: saved.id, request: { source: join(box.files, "unavailable.epub"), name: "unavailable.epub", format: "epub", sourceFolder: null }, outcome: { state: "pending" } }] };
    await app.invoke("sqlite_set_kv", { key: "native-import-job:v1", value: JSON.stringify(checkpoint) });
    await app.find({ role: "button", name: "Resume import" });
    await app.click({ role: "button", name: "Resume import" });
    await app.waitFor(async () => !(await app.session.execute("return !!document.querySelector('section[aria-label=\"Import progress\"]')")), { what: "already-saved identity to complete without reimporting its source" });
    await openBook(app, "Journalled reading book");
    await app.waitFor(async () => (await readerPage(app))?.page === 3, { what: "saved page after replaying a completed identity" });
});

test("corrupt recovery data is reported without blocking access to saved books", async () => {
    await backToLibrary(app);
    await app.invoke("sqlite_set_kv", { key: "native-import-job:v1", value: "{broken" });
    await box.quit(); app = await box.launch();
    await app.waitForText("Import recovery data is damaged and has been retained");
    await app.find(bookButton("First queued book"));
    await app.find(bookButton("Second queued book"));
    await app.find(bookButton("Journalled reading book"));
    await app.find({ role: "region", name: "Import progress" });
    const page = await openBook(app, "First queued book");
    assert.ok(page.page > 0);
});
