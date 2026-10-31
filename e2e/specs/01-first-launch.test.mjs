// Flow 1: a first launch shows onboarding; Skip lands on an empty library.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { Sandbox } from "../lib/app.mjs";

const box = new Sandbox("first-launch");
after(() => box.dispose());

test("first launch shows onboarding, Skip leads to the empty library", async () => {
    const app = await box.launch();
    await app.find({ role: "heading", name: "Make room for reading" }, { timeout: 20000 });
    assert.ok(await app.exists({ role: "button", name: "Start reading" }));
    await app.click({ role: "button", name: "Skip setup" });

    await app.find({ role: "heading", name: "No Books Yet" });
    assert.ok(await app.exists({ role: "button", name: "Import Books" }));
    assert.ok(await app.exists({ role: "button", name: "Scan Folder" }));
    assert.ok(await app.exists({ role: "navigation", name: "Main navigation" }));
});

test("onboarding is not shown again after a restart", async () => {
    await box.quit();
    const app = await box.launch();
    await app.find({ role: "heading", name: "No Books Yet" }, { timeout: 20000 });
    assert.equal(await app.exists({ role: "heading", name: "Make room for reading" }), false);
});
