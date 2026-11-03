import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Sandbox } from "../lib/app.mjs";
import { makeEpub } from "../lib/fixtures.mjs";
import { importBooks, launchFresh, openSettingsTab, goTo } from "../lib/flows.mjs";

const box = new Sandbox("library-navigation");
const titles = Array.from({ length: 24 }, (_, index) => `Navigation Book ${String(index+1).padStart(2,"0")}`);
const files = titles.map((title,index) => makeEpub(join(box.files,`navigation-${index}.epub`), { title, author:"Navigation Author", chapters:1, paragraphsPerChapter:2 }));
let app;
before(async()=>{ app=await launchFresh(box);await importBooks(app,files,{expectTitles:titles}); });
after(()=>box.dispose());

async function bounds() {
    return app.session.execute(`const main=document.querySelector('main'),grid=document.querySelector('[aria-label="Library books"]'),r=grid.getBoundingClientRect();return {width:r.width,height:r.height,top:r.top,bottom:r.bottom,mainTop:main.scrollTop,gridScroll:grid.scrollTop,viewport:innerHeight};`);
}

for(const [layout,width,height] of [["desktop",1280,800],["phone",390,844]]) {
    test(`Library retains its full viewport after returning from scrolled Settings on ${layout}`,async()=>{
        await box.quit();
        app=await box.launch();
        await app.find({role:"heading",name:"Library"});
        // Startup restores SQLite after the page heading is mounted. Measure
        // the populated grid, not the temporary empty Library shell.
        await app.find({role:"button",name:/^Open Navigation Book /});
        await app.invoke("plugin:window|unmaximize",{label:"main"});
        await app.waitFor(async()=>!(await app.invoke("plugin:window|is_maximized",{label:"main"})),{what:"window leaving maximized state"});
        await app.session.cmd("POST","/window/rect",{width,height,x:0,y:0});
        await app.waitFor(async()=>await app.session.execute("return innerWidth===arguments[0]",width),{what:`${width}px viewport`});
        await app.screenshot(`library-viewport-${layout}-before`);
        await goTo(app,"Library");
        await app.find({role:"button",name:/^Open Navigation Book /});
        const before=await bounds();
        assert.ok(before.height>height/2,"Library initially has a usable viewport");
        assert.ok(before.top>=0,"Library initially starts inside the viewport");
        await openSettingsTab(app,"General");
        await app.session.cmd("POST","/actions",{actions:[{type:"wheel",id:"settings-scroll",actions:[{type:"scroll",origin:"viewport",x:Math.round(width/2),y:Math.round(height/2),deltaX:0,deltaY:1800,duration:100}]}]});
        await app.session.cmd("DELETE","/actions");
        await app.waitFor(async()=>await app.session.execute("return document.querySelector('main').scrollTop>100"),{what:"Settings actually scrolled"});
        await goTo(app,"Library");
        const returned=await bounds();
        await app.screenshot(`library-return-${layout}`);
        assert.ok(Math.abs(returned.height-before.height)<2,`Library height changed after Settings: ${JSON.stringify({before,returned})}`);
        assert.ok(Math.abs(returned.width-before.width)<2,`Library width changed after Settings: ${JSON.stringify({before,returned})}`);
        assert.ok(Math.abs(returned.top-before.top)<2,`Library is clipped after Settings: ${JSON.stringify({before,returned})}`);
        console.log("library geometry",layout,JSON.stringify({before,returned}));
    });
}


test("returning from Settings preserves the book grid's own scroll position",async()=>{
    await box.quit();app=await box.launch();
    await app.find({role:"button",name:/^Open Navigation Book /});
    await app.invoke("plugin:window|unmaximize",{label:"main"});
    await app.waitFor(async()=>!(await app.invoke("plugin:window|is_maximized",{label:"main"})),{what:"window leaving maximized state"});
    await app.session.cmd("POST","/window/rect",{width:1280,height:800,x:0,y:0});
    await app.waitFor(async()=>await app.session.execute("return innerWidth===1280"),{what:"desktop viewport"});
    await goTo(app,"Library");
    await app.session.cmd("POST","/actions",{actions:[{type:"wheel",id:"book-grid-scroll",actions:[{type:"scroll",origin:"viewport",x:640,y:400,deltaX:0,deltaY:800,duration:100}]}]});
    await app.session.cmd("DELETE","/actions");
    await app.waitFor(async()=>await app.session.execute("return document.querySelector('[aria-label=\"Library books\"]').scrollTop>100"),{what:"book grid actually scrolled"});
    const before=await bounds();
    await openSettingsTab(app,"General");
    await app.session.cmd("POST","/actions",{actions:[{type:"wheel",id:"settings-scroll",actions:[{type:"scroll",origin:"viewport",x:640,y:400,deltaX:0,deltaY:1800,duration:100}]}]});
    await app.session.cmd("DELETE","/actions");
    await app.waitFor(async()=>await app.session.execute("return document.querySelector('main').scrollTop>100"),{what:"Settings actually scrolled"});
    await goTo(app,"Library");
    const returned=await bounds();
    assert.ok(Math.abs(returned.gridScroll-before.gridScroll)<2,`Book scroll changed: ${JSON.stringify({before,returned})}`);
    assert.ok(Math.abs(returned.top-before.top)<2,`Grid viewport shifted: ${JSON.stringify({before,returned})}`);
});
