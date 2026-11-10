import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Sandbox } from "../lib/app.mjs";
import { copyFixture, makeEpub } from "../lib/fixtures.mjs";
import { backToLibrary, importBooks, launchFresh, openBook } from "../lib/flows.mjs";

const box = new Sandbox("media-overlay");
const narrated = copyFixture("epub/media-overlay.epub", join(box.files, "narrated.epub"));
const plain = makeEpub(join(box.files, "plain.epub"), { title: "Plain Reader Book", author: "Reader Test" });
let app;

before(async () => {
    app = await launchFresh(box);
    await importBooks(app, [narrated, plain], { expectTitles: ["Media Overlay Fixture", "Plain Reader Book"] });
});
after(() => box.dispose());

async function changedPhrasePixels(before) {
    const after = (await app.session.screenshot()).toString("base64");
    return app.session.execute(`
const images = [arguments[0], arguments[1]];
return Promise.all(images.map(data => new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = 360; canvas.height = 140;
        const context = canvas.getContext('2d');
        context.drawImage(img, 50, 120, 360, 140, 0, 0, 360, 140);
        resolve(context.getImageData(0, 0, 360, 140).data);
    };
    img.onerror = reject;
    img.src = 'data:image/png;base64,' + data;
}))).then(([a, b]) => {
    let changed = 0;
    for (let i = 0; i < a.length; i += 4)
        if (a[i] !== b[i] || a[i+1] !== b[i+1] || a[i+2] !== b[i+2]) changed++;
    return changed;
});`, before, after);
}

test("book narration plays, pauses and stops when switching books", async () => {
    await openBook(app, "Media Overlay Fixture");
    await app.revealReaderChrome();
    await app.click({ role: "button", name: "Immersion Reading" });
    await app.waitForText("Starts at the beginning of this section");
    const before = (await app.session.screenshot()).toString("base64");
    await app.click({ role: "button", name: "Play" });
    await app.find({ role: "button", name: "Pause" });
    await app.click({ role: "button", name: "Pause" });
    await app.waitForText("Paused");
    await app.waitFor(async () => (await changedPhrasePixels(before)) > 500, { what: "spoken phrase to be highlighted" });
    await app.click({ role: "button", name: "Speed 1.25x" });
    await app.click({ role: "button", name: "Next phrase" });
    await app.waitForText("Paused");
    await backToLibrary(app);
    await openBook(app, "Plain Reader Book");
    assert.equal(await app.exists({ role: "button", name: "Next phrase" }), false);
});
