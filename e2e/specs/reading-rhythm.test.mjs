import assert from "node:assert/strict";
import { after, test } from "node:test";
import { Sandbox } from "../lib/app.mjs";
import { BOOKS, writeStandardBooks } from "../lib/fixtures.mjs";
import { importBooks, openBook, goTo, backToLibrary } from "../lib/flows.mjs";

const box = new Sandbox("reading-rhythm");
const files = writeStandardBooks(box.files);
after(() => box.dispose());
let app;

test("choose a reading rhythm, add a book, and reach reading", async () => {
    app = await box.launch();
    await app.click({role:"button",name:"Start reading"},{timeout:20000});
    await app.find({role:"combobox",name:"Reading days per week"});
    await app.click({role:"button",name:"Save rhythm"});
    await app.click({role:"button",name:"Open Library to add a book"});
    await app.find({role:"heading",name:"No Books Yet"});
    await importBooks(app,[files.harbour],{expectTitles:[BOOKS.harbour.title]});
    await app.waitForText("0 of 4 reading days this week");
    await openBook(app,BOOKS.harbour.title);
    await app.find({role:"main",name:"Reader"});
    await backToLibrary(app);
    await app.find({role:"button",name:"Resume"});
    await app.screenshot("reading-rhythm-library");
});

test("the reading rhythm survives restarting and remains editable", async () => {
    await box.quit();
    app = await box.launch();
    await app.waitForText("0 of 4 reading days this week");
    await goTo(app,"Statistics");
    await app.waitForText("Level 1");
    assert.equal(await app.value({role:"combobox",name:"Reading days per week"}),"4");
    await app.find({role:"checkbox",name:"Hide motivational progress in Library"});
    await app.screenshot("reading-rhythm-statistics");
});
