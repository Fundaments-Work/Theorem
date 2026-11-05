import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Sandbox } from "../lib/app.mjs";
import { goTo, launchFresh, openSettingsTab } from "../lib/flows.mjs";

const box = new Sandbox("settings-help");
let app;
before(async () => {
    app = await launchFresh(box);
});
after(() => box.dispose());

async function phoneLayout() {
    // Public browser platform setup; the app still uses its real native
    // backend. Native Android file saving is covered separately in unit tests.
    await app.session.execute("Object.defineProperty(navigator, 'userAgent', { configurable:true, value:'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36' })");
    await goTo(app, "Library");
    // Settings stays mounted across navigation; changing its selected tab
    // makes it render against the simulated browser platform.
    await openSettingsTab(app, "General");
}

test("Help & Diagnostics exports a ZIP and its controls fit a phone", async () => {
    await openSettingsTab(app, "Help");
    await app.find({ role: "button", name: "Check for Updates" });
    // The stand-in dialog does not grant a dynamic filesystem scope; choose
    // the sandbox's own home, which is already an allowed save destination.
    const output = join(box.home, "logs.zip");
    app.queueDialog("save", output);
    await app.click({ role: "button", name: "Export Logs" });
    await app.waitFor(() => existsSync(output), { what: "exported log archive" });
    assert.deepEqual([...readFileSync(output).subarray(0, 4)], [0x50, 0x4b, 3, 4]);

    await phoneLayout();
    await openSettingsTab(app, "Help");
    assert.equal(await app.exists({ role: "button", name: "Check for Updates" }), false);
    assert.equal(await app.exists({ role: "button", name: "Shortcuts" }), false);

    for (const width of [320, 390]) {
        await app.session.cmd("POST", "/window/rect", { width, height: 844, x: 0, y: 0 });
        await app.waitFor(async () => await app.session.execute("return innerWidth === arguments[0]", width), { what: `${width}px viewport` });
        assert.equal((await app.findAll({ role: "button", name: /^(General|Dictionary|Devices|Data & Storage|About|Help)$/ })).length, 6);
        for (const query of [
            { role: "button", name: "Export Logs" },
            { role: "link", name: "Report an Issue" },
            { role: "link", name: "Download Latest Release" },
        ]) {
            const element = await app.find(query);
            const rect = await app.session.execute(`const r=arguments[0].getBoundingClientRect(); return {left:r.left,right:r.right,width:innerWidth};`, element);
            assert.ok(rect.left >= 0 && rect.right <= rect.width, `${query.name} fits at ${width}px: ${JSON.stringify(rect)}`);
            assert.equal(await app.isClickable(query), true);
        }
    }
    await app.screenshot("settings-help-phone");
});
