import { join } from "node:path";
import { after, before, test } from "node:test";
import { Sandbox } from "../lib/app.mjs";
import { copyFixture, makeEpub } from "../lib/fixtures.mjs";
import { backToLibrary, bookButton, importBooks, launchFresh, openBook } from "../lib/flows.mjs";

const box = new Sandbox("audiobook-playback");
const title = "Audiobook Reader";
const aacTitle = "AAC Audiobook Reader";
const book = makeEpub(join(box.files, "book.epub"), { title, author: "Reader Test" });
const aacBook = makeEpub(join(box.files, "aac-book.epub"), { title: aacTitle, author: "Reader Test" });
const audio = copyFixture("audio/narration.mp3", join(box.files, "narration.mp3"));
const aacAudio = copyFixture("audio/narration.m4a", join(box.files, "narration.m4a"));
let app;

async function attachAudiobook(bookTitle, file) {
    const card = await app.find(bookButton(bookTitle));
    const point = await app.session.execute("arguments[0].scrollIntoView({block:'center'});const r=arguments[0].getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}", card);
    await app.session.pointer([{ type: "move", ...point }, { type: "down", button: 2 }, { type: "up", button: 2 }]);
    await app.click({ role: "menuitem", name: "More…" });
    app.queueDialog("open", file);
    await app.click({ role: "menuitem", name: "Attach Audiobook..." });
    await app.waitForText("Audiobook attached");
}

before(async () => {
    app = await launchFresh(box);
    await importBooks(app, [book, aacBook], { expectTitles: [title, aacTitle] });
    await attachAudiobook(title, audio);
    await attachAudiobook(aacTitle, aacAudio);
});
after(() => box.dispose());

test("an attached MP3 plays, seeks and resumes in the reader", async () => {
    await openBook(app, title);
    await app.revealReaderChrome();
    await app.click({ role: "button", name: "Immersion Reading" });
    await app.waitFor(async () => !(await app.session.execute("return arguments[0].disabled", await app.find({ role: "button", name: "Play" }))), { what: "audiobook metadata to load" });
    await app.click({ role: "button", name: "Play" });
    await app.find({ role: "button", name: "Pause" }, { timeout: 10000 });
    const position = { role: "slider", name: "Playback position" };
    await app.waitFor(async () => Number(await app.session.execute("return arguments[0].getAttribute('aria-valuenow')", await app.find(position))) >= 1, { what: "audiobook playback to advance" });
    await app.click({ role: "button", name: "Speed 1.25x" });
    await app.click({ role: "button", name: "Forward 15 seconds" });
    await app.waitFor(async () => Number(await app.session.execute("return arguments[0].getAttribute('aria-valuenow')", await app.find(position))) >= 14, { what: "audiobook to seek forward" });
    await app.click({ role: "button", name: "Pause" });
    await app.find({ role: "button", name: "Play" });
    await backToLibrary(app);
    await openBook(app, title);
    await app.revealReaderChrome();
    await app.click({ role: "button", name: "Immersion Reading" });
    await app.waitFor(async () => Number(await app.session.execute("return arguments[0].getAttribute('aria-valuenow')", await app.find(position))) >= 14, { what: "saved audiobook position" });
    await backToLibrary(app);
});

test("an attached AAC audiobook plays in the reader", async () => {
    await openBook(app, aacTitle);
    await app.revealReaderChrome();
    await app.click({ role: "button", name: "Immersion Reading" });
    await app.waitFor(async () => !(await app.session.execute("return arguments[0].disabled", await app.find({ role: "button", name: "Play" }))), { what: "AAC audiobook metadata to load" });
    await app.click({ role: "button", name: "Play" });
    await app.find({ role: "button", name: "Pause" }, { timeout: 10000 });
    const position = { role: "slider", name: "Playback position" };
    await app.waitFor(async () => Number(await app.session.execute("return arguments[0].getAttribute('aria-valuenow')", await app.find(position))) >= 1, { what: "AAC audiobook playback to advance" });
});
