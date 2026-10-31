import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Sandbox, REPO } from "../lib/app.mjs";
import { BOOKS, writeStandardBooks } from "../lib/fixtures.mjs";
import { bookButton, importBooks, launchFresh } from "../lib/flows.mjs";

const box=new Sandbox("cover-url");
const files=writeStandardBooks(box.files);
const title=BOOKS.harbour.title;
const image=readFileSync(join(REPO,"public/favicon-48x48.png"));
let app, base, downloads=0;
// Deliberately no Access-Control-Allow-Origin: cover sites commonly omit it.
const server=createServer((request,response)=>{
    if(request.url==="/not-image") {response.writeHead(200,{"Content-Type":"text/html"});response.end("not an image");return;}
    downloads++;
    response.writeHead(200,{"Content-Type":"application/octet-stream"});response.end(image);
});
before(async()=>{
    await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
    base=`http://127.0.0.1:${server.address().port}`;
    app=await launchFresh(box);
    await importBooks(app,[files.harbour],{expectTitles:[title]});
});
after(async()=>{await box.dispose();await new Promise(resolve=>server.close(resolve));});
async function edit() {
    const card=await app.find(bookButton(title));
    const point=await app.session.execute("arguments[0].scrollIntoView({block:'center'});const r=arguments[0].getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}",card);
    await app.session.pointer([{type:"move",...point},{type:"down",button:2},{type:"up",button:2}]);
    await app.click({role:"menuitem",name:"More…"});
    await app.click({role:"menuitem",name:"Edit Info"});
    return app.find({role:"dialog",name:"Edit Book Info"});
}
test("add a cover from a URL without CORS headers and save it",async()=>{
    const dialog=await edit();
    await app.click({role:"button",name:"From URL",within:dialog});
    await app.fill({role:"textbox",name:"Cover image URL"},`${base}/cover`);
    assert.equal(await app.value({role:"textbox",name:"Cover image URL"}),`${base}/cover`);
    await app.click({role:"button",name:"Load",within:dialog});
    await app.waitFor(async()=>await app.session.execute("const i=arguments[0].querySelector('img');return i?.complete&&i.naturalWidth===48&&i.naturalHeight===48",dialog),{what:"downloaded cover preview"});
    await app.click({role:"button",name:"Save",within:dialog});
    await app.waitGone({role:"dialog",name:"Edit Book Info"});
    assert.equal(downloads,1);
});
test("the new cover survives restart without another network download",async()=>{
    await box.quit(); app=await box.launch();
    const card=await app.find(bookButton(title));
    await app.waitFor(async()=>await app.session.execute("const i=arguments[0].querySelector('img');return i?.complete&&i.naturalWidth===48&&i.naturalHeight===48",card),{what:"persisted cover image"});
    assert.equal(downloads,1);
});
test("a non-image URL shows an error and preserves the saved cover",async()=>{
    const dialog=await edit();
    await app.click({role:"button",name:"From URL",within:dialog});
    await app.fill({role:"textbox",name:"Cover image URL"},`${base}/not-image`);
    await app.click({role:"button",name:"Load",within:dialog});
    await app.find({role:"alert",within:dialog});
    assert.equal(await app.session.execute("const i=arguments[0].querySelector('img');return i?.naturalWidth",dialog),48);
    await app.click({role:"button",name:"Cancel",within:dialog});
});
