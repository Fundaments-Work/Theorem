import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Sandbox } from "../lib/app.mjs";
import { launchFresh, openSettingsTab } from "../lib/flows.mjs";

const box = new Sandbox("navigation-visibility");
let app;
before(async () => { app = await launchFresh(box); });
after(() => box.dispose());

async function choose(name, value) {
    const group = await app.find({ role: "group", name });
    await app.click({ role: "button", name: value, within: group });
    await app.find({ role: "button", name: value, checked: true, within: group });
}

async function expectDestination(name, visible) {
    const query = { role: "button", name };
    if (visible) await app.find(query);
    else await app.waitGone(query);
    assert.equal(await app.exists(query), visible);
}

test("Discover and Feeds can be hidden independently on desktop and phone and survive restart", async () => {
    await app.invoke("plugin:window|unmaximize", { label: "main" });
    await app.waitFor(async () => !(await app.invoke("plugin:window|is_maximized", { label: "main" })), { what: "window leaving maximized state" });
    for (const width of [1280, 390]) {
        await app.session.cmd("POST", "/window/rect", { width, height: 844, x: 0, y: 0 });
        await app.waitFor(async () => await app.session.execute("return innerWidth === arguments[0]", width), { what: `${width}px viewport` });
        await openSettingsTab(app, "General");
        await expectDestination("Discover", true);
        await expectDestination("Feeds", true);
        await choose("Show Discover", "Off");
        await expectDestination("Discover", false);
        await expectDestination("Feeds", true);
        await choose("Show Feeds", "Off");
        await expectDestination("Discover", false);
        await expectDestination("Feeds", false);
        for (const name of ["Library", "Shelves", "Workbench"]) await expectDestination(name, true);
        await choose("Show Discover", "On");
        await expectDestination("Discover", true);
        await expectDestination("Feeds", false);
        await choose("Show Feeds", "On");
        await expectDestination("Feeds", true);
    }
    await choose("Show Discover", "Off");
    await choose("Show Feeds", "Off");
    await box.quit();
    app = await box.launch();
    await app.find({ role: "heading", name: "Library" });
    await expectDestination("Discover", false);
    await expectDestination("Feeds", false);
    await openSettingsTab(app, "General");
    for (const name of ["Show Discover", "Show Feeds"]) {
        const group = await app.find({ role: "group", name });
        await app.find({ role: "button", name: "Off", checked: true, within: group });
        await choose(name, "On");
    }
    await expectDestination("Discover", true);
    await expectDestination("Feeds", true);
});
