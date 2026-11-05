import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { APP_ID, Sandbox } from "../lib/app.mjs";
import { BOOKS, writeStandardBooks } from "../lib/fixtures.mjs";
import { bookButton, goTo, importBooks, launchFresh, openSettingsTab } from "../lib/flows.mjs";

const box = new Sandbox("settings-backup-delete");
const files = writeStandardBooks(box.files);
let app;
before(async () => {
    app = await launchFresh(box);
    await importBooks(app, [files.lamplighter], { expectTitles: [BOOKS.lamplighter.title] });
});
after(() => box.dispose());

async function phoneLayout() {
    await app.session.execute("Object.defineProperty(navigator, 'userAgent', { configurable:true, value:'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36' })");
    await goTo(app, "Library");
    await openSettingsTab(app, "General");
}

test("an automatic copy can be cancelled, then deleted without removing the library", async () => {
    // A new installation has no previous library to copy. Simulate an
    // upgrade in the isolated health fixture, then let the real startup
    // guard create its normal pre-migration snapshot.
    await box.quit();
    writeFileSync(join(box.home, ".local/share", APP_ID, "db-health.json"), JSON.stringify({ lastCheckAt: 0, lastCheckVersion: "0.0.0" }));
    app = await box.launch();
    assert.equal((await app.invoke("db_list_snapshots")).length, 1);
    await phoneLayout();
    await app.session.cmd("POST", "/window/rect", { width: 390, height: 844, x: 0, y: 0 });
    await app.waitFor(async () => await app.session.execute("return innerWidth === 390"), { what: "phone viewport" });
    await openSettingsTab(app, "Data & Storage");
    const copy = await app.find({ role: "button", name: /^Delete the copy from/ });
    const label = await app.session.execute("return arguments[0].getAttribute('aria-label')", copy);
    await app.click({ role: "button", name: label });
    await app.find({ role: "dialog", name: "Delete Automatic Copy" });
    await app.screenshot("settings-delete-copy-phone");
    await app.click({ role: "button", name: "Cancel" });
    await app.find({ role: "button", name: label });
    await app.click({ role: "button", name: label });
    await app.click({ role: "button", name: "Delete Copy" });
    await app.waitGone({ role: "button", name: label });
    assert.equal((await app.invoke("db_list_snapshots")).length, 0);
    await app.find({ role: "button", name: "Create Backup File" });
    await app.find({ role: "button", name: "Restore from Backup" });
    await goTo(app, "Library");
    await app.find(bookButton(BOOKS.lamplighter.title));
});
