// Flow 6: scan a folder holding new books, a book already in the library, a
// byte-identical copy and a broken file; the app imports the good ones and
// reports the rest.
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Sandbox } from "../lib/app.mjs";
import { BOOKS, writeStandardBooks } from "../lib/fixtures.mjs";
import { bookButton, importBooks, launchFresh } from "../lib/flows.mjs";

const box = new Sandbox("folder-scan");
const files = writeStandardBooks(box.files);
const scan = join(box.root, "scan");
let app;
before(async () => {
    mkdirSync(join(scan, "Nested"), { recursive: true });
    copyFileSync(files.harbour, join(scan, "harbour.epub")); // already imported below
    copyFileSync(files.clouds, join(scan, "Nested", "clouds.epub"));
    copyFileSync(files.clouds, join(scan, "Nested", "clouds (copy).epub")); // same bytes, other name
    copyFileSync(files.lamplighter, join(scan, "lamplighter.epub"));
    writeFileSync(join(scan, "broken.epub"), "this is not a zip archive");
    writeFileSync(join(scan, "notes.txt"), "not a book");
    app = await launchFresh(box);
    await importBooks(app, [files.harbour], { expectTitles: [BOOKS.harbour.title] });
});
after(() => box.dispose());

test("Scan asks how to import, then which folder", async () => {
    await app.click({ role: "button", name: "Scan" });
    await app.find({ role: "dialog", name: "Import a folder" });
    assert.ok(await app.exists({ role: "radio", name: /^Preserve folder structure/ }));
    assert.ok(await app.exists({ role: "radio", name: /^Import as a flat library/ }));
    app.queueDialog("open", scan);
    await app.click({ role: "button", name: "Choose folder" });
});

test("new books are imported, the duplicate and the broken file are reported", async () => {
    await app.find({ role: "dialog", name: "Import Errors" }, { timeout: 30000 });
    const report = await app.text();
    assert.match(report, /2 imported/);
    assert.match(report, /already in your library/);
    assert.match(report, /1 could not be imported/);
    assert.match(report, /broken\.epub/);
    assert.doesNotMatch(report, /notes\.txt/);
    await app.click({ role: "button", name: "OK" });

    await app.waitForText("3 books");
    for (const b of Object.values(BOOKS)) {
        await app.waitFor(async () => (await app.findAll(bookButton(b.title))).length >= 1 || (await app.text()).includes(b.title), { what: b.title });
    }
    assert.equal(app.dialogCalls().filter((c) => c.kind === "open").length, 2);
});

test("scanning the same folder again imports nothing new", async () => {
    await app.click({ role: "button", name: "Scan" });
    await app.find({ role: "dialog", name: "Import a folder" });
    app.queueDialog("open", scan);
    await app.click({ role: "button", name: "Choose folder" });
    await app.find({ role: "dialog", name: "Import Errors" }, { timeout: 30000 });
    const report = await app.text();
    assert.match(report, /0 imported|already in your library/);
    assert.match(report, /broken\.epub/);
    await app.click({ role: "button", name: "OK" });
    await app.waitForText("3 books");
});
