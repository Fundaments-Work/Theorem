import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import { Sandbox } from "../lib/app.mjs";
const boxes=[];
afterEach(async()=>{for(const box of boxes) await box.quit();});
after(async()=>{for(const box of boxes) await box.dispose();});
for(const [layout,width,height] of [["desktop",1280,800],["phone",390,844]]) {
    test(`onboarding and feature guide fit the ${layout} viewport`,async()=>{
        const box=new Sandbox(`onboarding-${layout}`);boxes.push(box);
        const app=await box.launch();
        await app.find({role:"main",name:"Reading setup"},{timeout:20000});
        await app.invoke("plugin:window|unmaximize", {label:"main"});
        await app.waitFor(async()=>!(await app.invoke("plugin:window|is_maximized",{label:"main"})),{what:"window leaving maximized state"});
        await app.session.cmd("POST","/window/rect",{width,height,x:0,y:0});
        await app.waitFor(async()=>await app.session.execute("return innerWidth===arguments[0]",width),{what:`${width}px viewport`});
        let footerBounds;
        const capture=async(step)=>{
            const bounds=await app.session.execute("const m=document.querySelector('main'),r=m.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth}");
            assert.ok(bounds.x>=0&&bounds.y>=0&&bounds.right<=bounds.width&&bounds.bottom<=bounds.height);
            assert.equal(bounds.overflow,false);
            assert.ok(bounds.right-bounds.x >= Math.min(bounds.width-48,800),"Setup must not collapse to a spacing-token width");
            const controls=await app.session.execute("return Array.from(document.querySelectorAll('button')).map(b=>{const r=b.getBoundingClientRect();return {name:b.getAttribute('aria-label')||b.textContent.trim(),width:r.width,height:r.height,x:r.x,y:r.y,right:r.right,bottom:r.bottom}}).filter(r=>r.width&&r.height)");
            for(const control of controls) {
                assert.ok(control.width>=44&&control.height>=44,`${control.name} needs a 44px touch target`);
                assert.ok(control.x>=0&&control.y>=0&&control.right<=bounds.width&&control.bottom<=bounds.height,`${control.name} must be on screen`);
            }
            const footer=await app.session.execute("const r=document.querySelector('footer').getBoundingClientRect();return {top:r.top,height:r.height}");
            if(footerBounds) assert.deepEqual(footer,footerBounds,"Footer actions must not shift between steps");
            footerBounds=footer;
            await app.screenshot(`onboarding-${layout}-${step}`);
        };
        await capture("welcome");
        await app.click({role:"button",name:"Explore features"});
        for(let step=1;step<=5;step++) {
            await capture(`guide-${step}`);
            await app.click({role:"button",name:step===5?"Get Started":"Next"});
        }
        await app.find({role:"main",name:"Reading setup"});
        await app.click({role:"button",name:"Start reading"});
        await app.click({role:"button",name:"Reading days per week"});
        await app.click({role:"menuitem",name:"5 days"});
        await capture("rhythm");
        await app.click({role:"button",name:"Save rhythm"});
        await capture("library");
        await app.click({role:"button",name:"Open Library to add a book"});
        await app.find({role:"heading",name:"No Books Yet"});
        await box.quit();
        const restarted=await box.launch();
        await restarted.find({role:"heading",name:"Library"});
        assert.equal(await restarted.exists({role:"main",name:"Reading setup"}),false);
    });
}
