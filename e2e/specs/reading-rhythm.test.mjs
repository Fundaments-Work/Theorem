import assert from "node:assert/strict";
import { after, test } from "node:test";
import { Sandbox } from "../lib/app.mjs";
import { BOOKS, writeStandardBooks } from "../lib/fixtures.mjs";
import { importBooks, openBook, goTo, backToLibrary, openSettingsTab, bookButton } from "../lib/flows.mjs";
const box=new Sandbox("reading-rhythm");
const files=writeStandardBooks(box.files);
after(()=>box.dispose());
let app;
async function cleanLibrary() {
    assert.equal(await app.exists({role:"button",name:"View reading progress"}),false);
    assert.equal(await app.exists({role:"region",name:"Reading rhythm"}),false);
    assert.equal(await app.exists({role:"region",name:"Reading journey"}),false);
    assert.equal(await app.exists({role:"button",name:"Resume"}),false);
}
test("choose a rhythm, import a book, and continue from its own card",async()=>{
    app=await box.launch();
    await app.click({role:"button",name:"Start reading"},{timeout:20000});
    await app.click({role:"button",name:"Reading days per week"});
    await app.click({role:"menuitem",name:"4 days — recommended"});
    await app.click({role:"button",name:"Save rhythm"});
    await app.click({role:"button",name:"Open Library to add a book"});
    await app.find({role:"heading",name:"No Books Yet"});
    await importBooks(app,[files.harbour],{expectTitles:[BOOKS.harbour.title]});
    await cleanLibrary();
    for (const name of ["Change view (now grid)", "Filter and sort"]) {
        const control = await app.find({role:"button",name});
        const style = await app.session.execute("const b=arguments[0],s=getComputedStyle(b),i=b.querySelector('svg').getBoundingClientRect();return {border:s.borderTopWidth,background:s.backgroundColor,size:i.width}",control);
        assert.equal(style.border,"0px");
        assert.equal(style.background,"rgba(0, 0, 0, 0)");
        assert.ok(style.size >= 24, `Toolbar icon width was ${style.size}`);
    }
    await openBook(app,BOOKS.harbour.title);
    await app.find({role:"main",name:"Reader"});
    await backToLibrary(app);
    const card=await app.find(bookButton(BOOKS.harbour.title));
    await app.find({role:"img",name:"Continue reading",within:card});
    await cleanLibrary();
    await app.screenshot("reading-rhythm-library");
});
test("Statistics is read-only and weekly goals are editable only in Settings",async()=>{
    await box.quit();app=await box.launch();
    await cleanLibrary();
    await goTo(app,"Statistics");
    const currentLevel = await app.find({role:"img",name:"Level 1"});
    const nextLevel = await app.find({role:"img",name:"Next level 2"});
    const sizes = await app.session.execute("return Array.from(arguments,el=>{const r=el.getBoundingClientRect();return {width:r.width,height:r.height}})",currentLevel,nextLevel);
    assert.deepEqual(sizes[0], sizes[1]);
    await app.find({role:"progressbar",name:"XP to level 2"});
    assert.equal(await app.exists({role:"button",name:"Reading days per week"}),false);
    assert.equal(await app.exists({role:"checkbox",name:"Hide motivational progress in Library"}),false);
    await app.screenshot("reading-rhythm-statistics");
    await openSettingsTab(app,"General");
    const goal={role:"button",name:"Reading days per week"};
    await app.waitFor(async()=>(await app.session.execute("return arguments[0].textContent",await app.find(goal))).includes("4 days"),{what:"saved weekly reading goal"});
    await app.click(goal);
    await app.click({role:"menuitem",name:"5 days"});
    await app.waitFor(async()=>(await app.session.execute("return arguments[0].textContent",await app.find(goal))).includes("5 days"),{what:"updated weekly reading goal"});
    await app.waitForText("This week: 4 days. Next Monday: 5 days.");
    await app.screenshot("reading-rhythm-settings");
});
test("the Settings goal survives restart while Library stays clean",async()=>{
    await box.quit();app=await box.launch();
    await cleanLibrary();
    await openSettingsTab(app,"General");
    await app.waitFor(async()=>(await app.session.execute("return arguments[0].textContent",await app.find({role:"button",name:"Reading days per week"}))).includes("5 days"),{what:"weekly reading goal after restart"});
});
