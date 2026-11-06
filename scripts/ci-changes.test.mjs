import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const script = resolve('scripts/ci-changes.sh');
function select({ files = [], event = 'pull_request', base = 'base', previous = 'validated', unavailable = false, apiFailure = false } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'theorem-ci-'));
    try {
        writeFileSync(join(dir, 'files'), files.join('\n'));
        writeFileSync(join(dir, 'previous'), previous);
        writeFileSync(join(dir, 'git'), `#!/bin/bash
case "$1" in
  cat-file) ${unavailable ? 'exit 1' : 'exit 0'} ;;
  diff) printf '%s\\n' "$@" > '${dir}/diff-args'; cat '${dir}/files' ;;
  *) exit 2 ;;
esac
`, { mode: 0o755 });
        writeFileSync(join(dir, 'gh'), `#!/bin/bash
${apiFailure ? 'exit 1' : `cat '${dir}/previous'`}
`, { mode: 0o755 });
        const result = spawnSync('/bin/bash', [script], { encoding: 'utf8', env: {
            PATH: `${dir}:/usr/bin:/bin`, EVENT: event, BASE: base,
            GITHUB_REPOSITORY: 'test/repo', GITHUB_SHA: 'head', GITHUB_OUTPUT: join(dir, 'output'),
        } });
        assert.equal(result.status, 0, result.stderr);
        const gates = Object.fromEntries(readFileSync(join(dir, 'output'), 'utf8').trim().split('\n').map(line => line.split('=')));
        let diff = '';
        try { diff = readFileSync(join(dir, 'diff-args'), 'utf8'); } catch {}
        return { gates, diff };
    } finally { rmSync(dir, { recursive: true, force: true }); }
}
const all = { web: 'true', rust: 'true', android: 'true', workflows: 'true' };
const none = { web: 'false', rust: 'false', android: 'false', workflows: 'false' };
test('documentation and empty diffs skip all builds', () => {
    assert.deepEqual(select({ files: ['docs/release.md', 'CHANGELOG.md'] }).gates, none);
    assert.deepEqual(select().gates, none);
});
test('frontend changes select web without native builds', () => {
    assert.deepEqual(select({ files: ['src/App.tsx'] }).gates, { ...none, web: 'true' });
});
test('native and dependency changes retain all required gates', () => {
    for (const [file, web, workflows] of [
        ['src-tauri/src/lib.rs', 'false', 'false'],
        ['src-tauri/Cargo.lock', 'false', 'false'],
        ['pnpm-lock.yaml', 'true', 'false'],
        ['.github/workflows/ci.yml', 'true', 'true'],
    ]) {
        assert.deepEqual(select({ files: [file] }).gates, { web, rust: 'true', android: 'true', workflows }, file);
    }
});
test('local E2E harness edits select only fast helper checks', () => {
    assert.deepEqual(select({ files: ['e2e/lib/app.mjs'] }).gates, { ...none, workflows: 'true' });
});
test('manual runs, missing baselines, unreachable commits and API failures check everything', () => {
    for (const options of [{ event: 'workflow_dispatch' }, { base: '' }, { unavailable: true },
        { base: '0'.repeat(40) }, { event: 'push', previous: '' }, { event: 'push', apiFailure: true }]) {
        assert.deepEqual(select(options).gates, all);
    }
});
test('pushes compare against the last validated commit rather than a cancelled predecessor', () => {
    const { gates, diff } = select({ event: 'push', base: 'cancelled', previous: 'validated', files: ['src/App.tsx'] });
    assert.match(diff, /validated\nhead\n/);
    assert.doesNotMatch(diff, /cancelled/);
    assert.equal(gates.web, 'true');
});
test('PRs use their base without querying main validation', () => {
    assert.match(select({ apiFailure: true }).diff, /base\nhead\n/);
});
test('large diffs do not lose matches through grep SIGPIPE under pipefail', () => {
    assert.equal(select({ files: ['src/App.tsx', ...Array(20000).fill('docs/long-path.md')] }).gates.web, 'true');
});

test('workflow edits select lint without unrelated native jobs', () => {
    assert.deepEqual(select({ files: ['.github/workflows/release.yml'] }).gates, { ...none, workflows: 'true' });
    assert.equal(select({ files: ['scripts/ci-changes.sh'] }).gates.workflows, 'true');
    assert.equal(select({ files: ['scripts/release-target.cjs'] }).gates.workflows, 'true');
    assert.equal(select({ files: ['scripts/ci-result.cjs'] }).gates.workflows, 'true');
});

test('every local E2E edit avoids hosted application builds', () => {
    for (const file of ['e2e/run.mjs', 'e2e/lib/specs.mjs', 'e2e/specs/reading-rhythm.test.mjs']) {
        assert.deepEqual(select({ files: [file] }).gates, { ...none, workflows: 'true' });
    }
});
