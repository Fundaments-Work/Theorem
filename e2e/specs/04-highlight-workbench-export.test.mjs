// Flow 4: highlight text in the reader; it shows in the Workbench and the
// Markdown export writes it to the chosen folder.
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Sandbox } from "../lib/app.mjs";
import { BOOKS, writeStandardBooks } from "../lib/fixtures.mjs";
import { backToLibrary, goTo, highlightFirstWord, importBooks, launchFresh, openBook, openSettingsTab } from "../lib/flows.mjs";

const box = new Sandbox("highlight");
const files = writeStandardBooks(box.files);
const book = BOOKS.lamplighter;
const exportDir = join(box.root, "vault");
mkdirSync(exportDir);
let app;
before(async () => {
    app = await launchFresh(box);
    await importBooks(app, [files.lamplighter], { expectTitles: [book.title] });
});
after(() => box.dispose());

function markdownFiles(dir) {
    const out = [];
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) out.push(...markdownFiles(p));
        else if (name.endsWith(".md")) out.push(p);
    }
    return out;
}

test("double-clicking a word and choosing a colour highlights it", async () => {
    await openBook(app, book.title);
    await highlightFirstWord(app);
    await backToLibrary(app);
});

test("the highlight appears in the Workbench with its book", async () => {
    await goTo(app, "Workbench");
    await app.waitForText("1 highlight");
    await app.waitForText("Marker");
    await app.waitForText(`${book.title} | ${book.author}`);

    await app.click({ role: "tab", name: "Highlights" });
    await app.waitForText("Marker");
    await app.click({ role: "tab", name: "Notes" });
    await app.waitFor(async () => !/\bMarker\b/.test(await app.text()), { what: "Notes tab without the highlight" });
    await app.click({ role: "tab", name: "All" });
});

test("Markdown export writes the highlight into the chosen folder", async () => {
    await openSettingsTab(app, "Devices & Export");
    app.queueDialog("open", exportDir);
    await app.click({ role: "button", name: "Pick folder" });
    // The chosen folder is shown in the export-folder field.
    await app.waitFor(async () => (await app.value({ role: "textbox", name: "Export folder" })) === exportDir, { what: "the chosen folder in the field" });
    await app.click({ role: "button", name: /^Export (now|Markdown)/ });

    const file = await app.waitFor(() => {
        const found = markdownFiles(exportDir).find((f) => readFileSync(f, "utf8").includes("Marker"));
        return found ?? null;
    }, { timeout: 20000, what: "a Markdown file containing the highlight" });
    const md = readFileSync(file, "utf8");
    assert.match(md, new RegExp(book.title));
    assert.match(md, new RegExp(book.author));
    assert.match(md, /Marker/);
    assert.match(file, /\.md$/);
});
