// Flow 7: make a backup file, wipe the app's data (a new install), restore the
// backup: books, highlights and shelves come back and the book still opens.
import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Sandbox } from "../lib/app.mjs";
import { BOOKS, writeStandardBooks } from "../lib/fixtures.mjs";
import {
    backToLibrary,
    bookButton,
    goTo,
    highlightFirstWord,
    importBooks,
    launchFresh,
    openBook,
    openSettingsTab,
} from "../lib/flows.mjs";

const box = new Sandbox("backup");
const files = writeStandardBooks(box.files);
const backupFile = join(box.root, "library.theorem-backup");
let app;
before(async () => {
    app = await launchFresh(box);
    await importBooks(app, [files.lamplighter, files.clouds], { expectTitles: [BOOKS.lamplighter.title, BOOKS.clouds.title] });
    await openBook(app, BOOKS.lamplighter.title);
    await highlightFirstWord(app);
    await backToLibrary(app);
});
after(() => box.dispose());

test("Create Backup File writes a backup where the user chose", async () => {
    await openSettingsTab(app, "Data & Storage");
    app.queueDialog("save", backupFile);
    await app.click({ role: "button", name: /^Create Backup File/ });
    await app.waitFor(() => existsSync(backupFile) && statSync(backupFile).size > 0, { timeout: 30000, what: "the backup file" });
    const save = app.dialogCalls().find((c) => c.kind === "save");
    assert.match(save.args.defaultPath, /^theorem-\d{4}-\d{2}-\d{2}\.theorem-backup$/);
});

test("after wiping the data the app starts empty", async () => {
    await box.quit();
    box.wipeData();
    app = await launchFresh(box);
    await app.find({ role: "heading", name: "No Books Yet" });
});

test("Restore from Backup brings back books and highlights", async () => {
    await openSettingsTab(app, "Data & Storage");
    app.queueDialog("open", backupFile);
    await app.click({ role: "button", name: /^Restore from Backup/ });
    // The app explains what restoring replaces and asks to confirm.
    await app.click({ role: "button", name: "Replace Library" }, { timeout: 20000 });

    // Restoring reloads the interface on the restored database.
    await goToLibraryAfterReload(app);
    await app.find(bookButton(BOOKS.lamplighter.title), { timeout: 30000 });
    await app.find(bookButton(BOOKS.clouds.title));

    await goTo(app, "Workbench");
    await app.waitForText("1 highlight");
    await app.waitForText("Marker");
});

test("a restored book opens", async () => {
    await goTo(app, "Library");
    const pos = await openBook(app, BOOKS.lamplighter.title);
    assert.ok(pos.total > 1);
    await backToLibrary(app);
});

async function goToLibraryAfterReload(app) {
    await app.waitFor(
        async () => {
            if (await app.exists({ role: "button", name: "Skip setup" })) await app.click({ role: "button", name: "Skip setup" });
            return app.exists({ role: "heading", name: "Library" });
        },
        { timeout: 30000, what: "the app to come back after the restore" },
    );
    await goTo(app, "Library");
}
