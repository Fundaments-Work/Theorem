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
const all = { web: 'true', rust: 'true', android: 'true', e2e: 'true', workflows: 'true' };
const none = { web: 'false', rust: 'false', android: 'false', e2e: 'false', workflows: 'false' };
test('documentation and empty diffs skip all builds', () => {
    assert.deepEqual(select({ files: ['docs/release.md', 'CHANGELOG.md'] }).gates, none);
    assert.deepEqual(select().gates, none);
});
test('frontend changes select web and native E2E without Android lint', () => {
    assert.deepEqual(select({ files: ['src/App.tsx'] }).gates, { ...none, web: 'true', e2e: 'true' });
});
test('native and dependency changes retain all required gates', () => {
    for (const file of ['src-tauri/src/lib.rs', 'src-tauri/Cargo.lock', 'pnpm-lock.yaml', '.github/workflows/ci.yml']) {
        const { gates } = select({ files: [file] });
        assert.equal(gates.rust, 'true', file);
        assert.equal(gates.android, 'true', file);
        assert.equal(gates.e2e, 'true', file);
    }
});
test('E2E harness edits select its runner', () => {
    assert.deepEqual(select({ files: ['e2e/lib/app.mjs'] }).gates, { ...none, e2e: 'true', workflows: 'true' });
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
    assert.equal(gates.e2e, 'true');
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
});

test('nightly runs select native E2E without repeating web tests or Rust/Android checks', () => {
    assert.deepEqual(select({ event: 'schedule', apiFailure: true }).gates, { ...none, e2e: 'true' });
});
