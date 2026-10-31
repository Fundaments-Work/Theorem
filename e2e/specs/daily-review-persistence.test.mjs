import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import { Keys, Sandbox } from "../lib/app.mjs";
import { BOOKS, writeStandardBooks } from "../lib/fixtures.mjs";
import { backToLibrary, goTo, highlightFirstWord, importBooks, launchFresh, openBook, openSettingsTab } from "../lib/flows.mjs";

const dismissed=new Sandbox("review-dismissed");
const completed=new Sandbox("review-completed");
const dialog={role:"dialog",name:"Daily Review"};
afterEach(async()=>{await dismissed.quit();await completed.quit();});
after(async()=>{await dismissed.dispose();await completed.dispose();});
async function prepare(box) {
    const files=writeStandardBooks(box.files);
    const app=await launchFresh(box);
    await importBooks(app,[files.lamplighter],{expectTitles:[BOOKS.lamplighter.title]});
    await openBook(app,BOOKS.lamplighter.title);
    await highlightFirstWord(app);
    await backToLibrary(app);
    await openSettingsTab(app,"General");
    const row=await app.session.execute("return Array.from(document.querySelectorAll('label')).find(l=>l.textContent.trim()==='Daily Review').parentElement.parentElement");
    await app.click({role:"button",name:"On",within:row});
    assert.equal(await app.exists(dialog),false,"Review must stay inside the Library route");
    await goTo(app,"Library");
    await app.find(dialog);
    return app;
}
test("review fills the viewport without a stray scrollbar and dismissal survives restart",async()=>{
    let app=await prepare(dismissed);
    const overlay=await app.find(dialog);
    const layout=await app.session.execute("const e=arguments[0],r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,screenWidth:innerWidth,screenHeight:innerHeight,overflowX:e.scrollWidth>e.clientWidth,overflowY:e.scrollHeight>e.clientHeight}",overlay);
    assert.equal(layout.x,0);assert.equal(layout.y,0);
    assert.equal(layout.width,layout.screenWidth);assert.equal(layout.height,layout.screenHeight);
    assert.equal(layout.overflowX,false);assert.equal(layout.overflowY,false);
    await app.screenshot("daily-review-viewport");
    await app.click({role:"button",name:"Dismiss for today",within:overlay});
    await app.waitGone(dialog);
    await goTo(app,"Workbench");await goTo(app,"Library");
    assert.equal(await app.exists(dialog),false);
    await dismissed.quit();app=await dismissed.launch();
    await app.find({role:"heading",name:"Library"});
    assert.equal(await app.exists(dialog),false);
});
test("completing a deck remains completed after navigation and restart",async()=>{
    let app=await prepare(completed);
    await app.keys(Keys.Right);
    await app.waitGone(dialog);
    await goTo(app,"Workbench");await goTo(app,"Library");
    assert.equal(await app.exists(dialog),false);
    await completed.quit();app=await completed.launch();
    await app.find({role:"heading",name:"Library"});
    assert.equal(await app.exists(dialog),false);
});
