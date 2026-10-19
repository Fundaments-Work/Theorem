/**
 * Fails if a Buy Me Momo URL in this repo has drifted from the canonical one
 * in Fundaments-Work/content.
 *
 * Why a script and not a vitest case: the point is to compare against a remote
 * source of truth, which needs the network. A unit test that needs the network
 * stops being a unit test, and the day it starts skipping on timeout it stops
 * being a gate. So this runs in CI and before a release, where network access
 * is a given, and `pnpm test` stays hermetic.
 *
 * Why compare the whole set of Buy Me Momo URLs in a file rather than parsing
 * one constant: the URL appears in manifests, YAML and template literals, and
 * a regex that has to understand each of those formats is a regex that breaks
 * when the format changes. Collecting the URLs and comparing the set catches
 * both drift and leftovers, with no format knowledge at all.
 *
 *   node scripts/check-content.mjs           resolve and check
 *   node scripts/check-content.mjs --from ../content
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const CONTENT_REPO = 'Fundaments-Work/content';
const RAW_BASE = `https://raw.githubusercontent.com/${CONTENT_REPO}`;
const CHANNEL_ID = 'buyMeMomo';

// Every file that may legitimately carry the link. Missing files are skipped,
// so the same script works in both apps without a per-repo config.
const CANDIDATES = [
  '.github/FUNDING.yml',
  'manifest.json',
  'package.json',
  'README.md',
  'src/core/lib/support-prompt.ts',
  'src/ui/FSRSSettingsTab.ts',
];

const fromFlag = process.argv.indexOf('--from');
const explicitSource =
  fromFlag !== -1 && process.argv[fromFlag + 1]
    ? resolve(process.cwd(), process.argv[fromFlag + 1])
    : process.env.CONTENT_DIR;
const localSource = explicitSource ?? resolve(root, '..', 'content');

const die = (message) => {
  console.error(`check-content: ${message}`);
  process.exit(1);
};

async function loadCanonical() {
  const file = join(localSource, 'support.json');
  if (existsSync(file)) {
    try {
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      die(`could not parse ${file}: ${error.message}`);
    }
  }

  try {
    const response = await fetch(`${RAW_BASE}/main/support.json`);
    if (response.ok) return await response.json();
  } catch {
    // Offline: fall through to the instruction below.
  }

  die(
    `could not read ${CONTENT_REPO}/support.json.\n` +
      `Clone ${CONTENT_REPO} next to this repo, or pass --from <path> / set CONTENT_DIR.`,
  );
}

const canonical = await loadCanonical();
const channel = canonical?.channels?.find((entry) => entry.id === CHANNEL_ID);
if (!channel?.url) {
  die(`no "${CHANNEL_ID}" channel with a url in ${CONTENT_REPO}/support.json`);
}

const URL_PATTERN = /https:\/\/buymemomo\.com\/[^\s'"<>)\]]+/g;

const drifted = [];
let checked = 0;

for (const relative of CANDIDATES) {
  const path = join(root, relative);
  if (!existsSync(path)) continue;

  const found = readFileSync(path, 'utf8').match(URL_PATTERN) ?? [];
  if (found.length === 0) continue;
  checked += 1;

  const wrong = found.filter((url) => url !== channel.url);
  if (wrong.length > 0) {
    drifted.push(`${relative}: expected ${channel.url}, found ${[...new Set(wrong)].join(', ')}`);
  }
}

if (checked === 0) {
  die(`found no Buy Me Momo URL in any of ${CANDIDATES.join(', ')} — the check is not wired up`);
}

if (drifted.length > 0) {
  console.error(`check-content: ${drifted.length} file(s) drifted from ${CONTENT_REPO}\n`);
  for (const line of drifted) console.error(`  ${line}`);
  console.error(`\nCanonical url: ${channel.url}\nChange it in ${CONTENT_REPO}, not here.`);
  process.exit(1);
}

console.log(`check-content: ${checked} file(s) match ${CONTENT_REPO} (${channel.url})`);