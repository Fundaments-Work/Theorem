// Dev helper for writing specs (not a test): launch the app in a sandbox with
// the standard books in $FILES, run EXPLORE_STEPS, print the accessible outline
// after each step (EXPLORE_SHOTS=1 also saves screenshots to e2e/.artifacts).
//   EXPLORE_STEPS='[{"click":{"name":"Skip"}},{"queue":{"kind":"open","value":["$FILES/harbour.epub"]},"click":{"name":"Import Books"}}]' \
//     node e2e/run.mjs --explore
import { Sandbox, sleep } from "./lib/app.mjs";
import { writeStandardBooks } from "./lib/fixtures.mjs";

const box = new Sandbox("explore");
const books = writeStandardBooks(box.files);

try {
    const app = await box.launch({ args: process.argv.slice(2) });
    await sleep(3000);
    console.log(await app.outline());
    if (process.env.EXPLORE_SHOTS) await app.screenshot("explore-0");
    const raw = (process.env.EXPLORE_STEPS || "[]").replaceAll("$FILES", box.files).replaceAll("$HOME", box.home);
    const steps = JSON.parse(raw);
    void books;
    let i = 1;
    for (const step of steps) {
        console.error(`[${new Date().toISOString()}] step ${i} start`);
        if (step.queue) await app.queueDialog(step.queue.kind, step.queue.value);
        if (step.call) console.log(JSON.stringify(await app[step.call]()));
        if (step.click) await app.click(step.click.text !== undefined || step.click.label !== undefined ? step.click : { role: step.click.role || "button", name: step.click.re ? new RegExp(step.click.re) : step.click.name });
        if (step.fill) await app.fill(step.fill.q, step.fill.text);
        if (step.pointer) await app.session.pointer(step.pointer);
        if (step.drag) await app.drag(step.drag[0], step.drag[1]);
        if (step.keys) await app.keys(...step.keys);
        if (step.eval) console.log(JSON.stringify(await app.session.execute(step.eval)));
        await sleep(step.wait ?? 1500);
        console.log(`\n=== after step ${i}: ${JSON.stringify(step)} ===`);
        console.log(await app.outline());
        if (process.env.EXPLORE_SHOTS) await app.screenshot(`explore-${i}`);
        i++;
    }
} catch (e) {
    console.error(e);
    console.error(box.driverLog?.join(""));
} finally {
    await box.dispose();
}
