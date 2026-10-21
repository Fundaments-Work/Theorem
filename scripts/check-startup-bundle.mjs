#!/usr/bin/env node
// Fails the build when the JS the app shell loads at startup grows past its budget
// or drags in a library that is meant to load on demand. Reads dist/index.html, so
// run it after `vite build`.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const DIST = process.argv[2] ?? "dist";
/** Startup JS budget in kB (uncompressed). Raise deliberately, with a reason. */
const BUDGET_KB = 700;
/** Chunks that must only ever be fetched on demand. */
const LAZY = [/^pdf-/, /^pdfjs/, /^knap-templates/, /^i18n-/, /^sentry/, /^ui-overlays/, /^reader-/, /^foliate/];

const html = readFileSync(join(DIST, "index.html"), "utf8");
const files = [...new Set([...html.matchAll(/\/assets\/([^"']+\.js)/g)].map((m) => m[1]))];
if (files.length === 0) {
    console.error("[check-startup-bundle] no scripts found in index.html");
    process.exit(1);
}

let total = 0;
const rows = files.map((f) => {
    const kb = statSync(join(DIST, "assets", f)).size / 1024;
    total += kb;
    return { f, kb };
});
rows.sort((a, b) => b.kb - a.kb);
for (const { f, kb } of rows.slice(0, 5)) console.log(`  ${kb.toFixed(0).padStart(4)} kB  ${f}`);
console.log(`[check-startup-bundle] ${total.toFixed(0)} kB startup JS (budget ${BUDGET_KB} kB)`);

const problems = [];
for (const { f } of rows) {
    if (LAZY.some((re) => re.test(f))) problems.push(`${f} is loaded at startup but must be lazy`);
}
if (total > BUDGET_KB) problems.push(`startup JS is ${total.toFixed(0)} kB, over the ${BUDGET_KB} kB budget`);
if (problems.length) {
    for (const p of problems) console.error(`[check-startup-bundle] ${p}`);
    console.error("Find the static import that pulled it in (a barrel, or a manualChunks group absorbing a shared helper).");
    process.exit(1);
}
