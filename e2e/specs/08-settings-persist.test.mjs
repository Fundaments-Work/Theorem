// Flow 8: settings changed in the UI are still set after a restart.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Keys, Sandbox, sleep } from "../lib/app.mjs";
import { launchFresh, openSettingsTab } from "../lib/flows.mjs";

const box = new Sandbox("settings");
let app;
before(async () => {
    app = await launchFresh(box);
});
after(() => box.dispose());

let chosenRetention;
const pressed = (name) => ({ role: "button", name, checked: true });

test("change theme, daily goal and article retention", async () => {
    await openSettingsTab(app, "General");
    await app.find(pressed("Dark"));
    await app.click({ role: "button", name: "Light" });
    await app.find(pressed("Light"));

    const goal = { role: "spinbutton", name: "Daily Reading Goal" };
    const before = await app.value(goal);
    await app.fill(goal, "45");
    await app.keys(Keys.Tab); // Tab: commit the field
    await app.waitFor(async () => (await app.value(goal)) === "45", { what: "goal 45" });
    assert.notEqual(before, "45");

    // Pick a different retention period the way a user does: choose an option.
    const retention = { role: "combobox", name: "Article retention period" };
    const current = await app.value(retention);
    const select = await app.find(retention);
    const option = await app.find({ role: "option", name: /\d+ days|Forever/, within: select, includeHidden: true, index: current === "15" ? 2 : 1 });
    await app.session.click(option);
    await app.waitFor(async () => (await app.value(retention)) !== current, { what: "retention to change" });
    chosenRetention = await app.value(retention);
    // Settings are saved shortly after a change.
    await sleep(1500);
});


test("the same settings are shown after a restart", async () => {
    await box.quit();
    app = await box.launch();
    await openSettingsTab(app, "General");
    await app.find(pressed("Light"));
    assert.equal(await app.value({ role: "spinbutton", name: "Daily Reading Goal" }), "45");
    assert.equal(await app.value({ role: "combobox", name: "Article retention period" }), chosenRetention);
});
