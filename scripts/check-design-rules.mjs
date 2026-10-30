#!/usr/bin/env node
/**
 * Design-system and anti-pattern guard (`pnpm check:design`).
 *
 * The rules come from AGENTS.md and docs/design-system.md. Existing violations are recorded in
 * scripts/design-rules-baseline.json and tolerated; a file may never get MORE violations of a
 * rule than its baseline. So contributors are only held to what they add, and the baseline can
 * only shrink: when you fix a violation, run `pnpm check:design --update` and commit the result.
 *
 * Why these rules exist even though some are visual no-ops: tokens in design-tokens.css already
 * flatten every `rounded-*` to 0 and every `font-*` weight to 400, so such classes do nothing
 * today. They still mislead the next reader into thinking the design allows them, and they
 * would start to bite the moment a token changed.
 *
 * Usage:
 *   node scripts/check-design-rules.mjs            check, exit 1 on a new violation
 *   node scripts/check-design-rules.mjs --update   rewrite the baseline to current counts
 *   node scripts/check-design-rules.mjs --list     print every current violation
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SRC = join(ROOT, "src");
const BASELINE = join(ROOT, "scripts", "design-rules-baseline.json");

/** Directories and files that are vendored, generated, or define the tokens themselves. */
const SKIP = [
    `features${sep}reader${sep}foliate-js${sep}`,
    `features${sep}reader${sep}foliate-js-runtime${sep}`,
    `core${sep}lib${sep}design-tokens.ts`,
    `core${sep}lib${sep}wasm`,
];

/**
 * `ui` means the rule applies to components and class strings (.tsx); `all` also covers .ts.
 * Each rule has a `fix` hint that is printed with the violation.
 */
const RULES = [
    {
        id: "no-transition-all",
        pattern: /(?<![\w-])transition-all(?![\w-])/g,
        files: "all",
        fix: "Name the property: `transition-colors`, `transition-opacity`, `transition-transform`.",
    },
    {
        id: "no-rounded",
        pattern: /(?<![\w-])rounded(?:-(?!none\b)[a-z0-9]+)*(?![\w-])/g,
        files: "tsx",
        fix: "Corner radius is 0 everywhere (design-system rule). Drop the class.",
    },
    {
        id: "no-heavy-font-weight",
        pattern: /(?<![\w-])font-(?:medium|semibold|bold|extrabold|black|thin|extralight)(?![\w-])/g,
        files: "tsx",
        fix: "Only 300 and 400 exist (`font-light`, `font-normal`). Build hierarchy with size and colour.",
    },
    {
        id: "no-raw-hex-color",
        pattern: /#[0-9a-fA-F]{6}\b/g,
        files: "tsx",
        fix: "Use a token: `var(--color-...)` (see docs/design-system.md). The one accent is `--color-accent`.",
    },
    {
        id: "no-tailwind-palette-color",
        pattern: /(?<![\w-])(?:bg|text|border|ring|fill|stroke|from|to|via)-(?:gray|zinc|slate|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}(?![\w-])/g,
        files: "tsx",
        fix: "Use a semantic token such as `text-[color:var(--color-text-secondary)]`.",
    },
    {
        id: "no-console-log",
        pattern: /console\.log\(/g,
        files: "all",
        fix: "Guard with `import.meta.env.DEV`, or remove it.",
    },
    {
        id: "no-raw-safe-area-env",
        pattern: /env\(safe-area-inset/g,
        files: "all",
        skipFiles: [`core${sep}styles${sep}design-tokens.css`, `core${sep}lib${sep}system-insets.ts`],
        fix: "Use `var(--safe-area-top|right|bottom|left)`; Android's WebView reports wrong insets through env().",
    },
];

function walk(dir, out = []) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) out.push(full);
    }
    return out;
}

/** Lines that only document a rule (comments) are not violations. */
function isCommentOnly(line) {
    const t = line.trim();
    return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

/** A `console.log` already behind an `import.meta.env.DEV` guard on the same line is allowed. */
function isDevGuarded(line) {
    return line.includes("import.meta.env.DEV");
}

function scan() {
    /** @type {Record<string, Record<string, number>>} */
    const counts = {};
    /** @type {{ rule: string, file: string, line: number, text: string, fix: string }[]} */
    const hits = [];
    for (const abs of walk(SRC)) {
        const rel = relative(SRC, abs);
        if (SKIP.some((s) => rel.startsWith(s) || rel === s)) continue;
        const isTsx = abs.endsWith(".tsx");
        const lines = readFileSync(abs, "utf8").split("\n");
        for (const rule of RULES) {
            if (rule.files === "tsx" && !isTsx) continue;
            if (rule.skipFiles?.some((s) => rel === s)) continue;
            lines.forEach((text, i) => {
                if (isCommentOnly(text)) return;
                if (rule.id === "no-console-log" && isDevGuarded(text)) return;
                const found = text.match(rule.pattern);
                if (!found) return;
                counts[rule.id] ??= {};
                counts[rule.id][rel] = (counts[rule.id][rel] ?? 0) + found.length;
                hits.push({ rule: rule.id, file: rel, line: i + 1, text: text.trim().slice(0, 110), fix: rule.fix });
            });
        }
    }
    return { counts, hits };
}

const args = new Set(process.argv.slice(2));
const { counts, hits } = scan();

if (args.has("--list")) {
    for (const h of hits) console.log(`${h.file}:${h.line}  [${h.rule}]  ${h.text}`);
    console.log(`\n${hits.length} violation(s) in total.`);
    process.exit(0);
}

const sorted = Object.fromEntries(
    Object.entries(counts)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([rule, files]) => [rule, Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)))]),
);

if (args.has("--update")) {
    writeFileSync(BASELINE, `${JSON.stringify(sorted, null, 4)}\n`);
    const total = Object.values(sorted).flatMap((f) => Object.values(f)).reduce((a, b) => a + b, 0);
    console.log(`[check-design] baseline written: ${total} tolerated violation(s).`);
    process.exit(0);
}

const baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) : {};
const fixHint = new Map(RULES.map((r) => [r.id, r.fix]));
const regressions = [];
let tightenable = 0;

for (const [rule, files] of Object.entries(counts)) {
    for (const [file, n] of Object.entries(files)) {
        const allowed = baseline[rule]?.[file] ?? 0;
        if (n > allowed) regressions.push({ rule, file, n, allowed });
    }
}
for (const [rule, files] of Object.entries(baseline)) {
    for (const [file, allowed] of Object.entries(files)) {
        if ((counts[rule]?.[file] ?? 0) < allowed) tightenable++;
    }
}

if (regressions.length > 0) {
    console.error("[check-design] new design-rule violations:\n");
    for (const r of regressions) {
        console.error(`  ${r.file}  ${r.rule}: ${r.n} (allowed ${r.allowed})`);
        for (const h of hits.filter((h) => h.rule === r.rule && h.file === r.file)) {
            console.error(`      line ${h.line}: ${h.text}`);
        }
        console.error(`      fix: ${fixHint.get(r.rule)}`);
    }
    console.error("\nSee docs/design-system.md. Do not raise the baseline to make this pass.");
    process.exit(1);
}

console.log(
    `[check-design] ok${tightenable ? ` (${tightenable} baseline entr${tightenable === 1 ? "y" : "ies"} can be tightened: run \`pnpm check:design --update\`)` : ""}`,
);
