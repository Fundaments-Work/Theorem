import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const script = resolve('scripts/release-tag.sh');
test('release reruns use the requested tag and classify patch releases as prereleases', () => {
    const dir = mkdtempSync(join(tmpdir(), 'theorem-release-'));
    const env = { PATH: '/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
    function git(...args) {
        const result = spawnSync('git', args, { cwd: dir, env, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        return result.stdout.trim();
    }
    try {
        git('init', '--template=', '--initial-branch=main');
        function commit(text) {
            writeFileSync(join(dir, 'revision'), text);
            git('add', 'revision');
            git('-c', 'user.name=Workflow test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgSign=false',
                '-c', 'core.hooksPath=/dev/null', 'commit', '-m', text);
            return git('rev-parse', 'HEAD');
        }
        const tagged = commit('tagged source');
        for (const tag of ['v1.6.0', 'v1.6.1', 'v1.6.0-rc.1']) git('tag', tag);
        const branch = commit('newer branch source');
        for (const [tag, prerelease] of [['v1.6.0', 'false'], ['v1.6.1', 'true'], ['v1.6.0-rc.1', 'true']]) {
            git('checkout', '--detach', branch);
            const output = join(dir, 'output');
            writeFileSync(output, '');
            const result = spawnSync('/bin/bash', [script], { cwd: dir, encoding: 'utf8', env: {
                ...env, REQUESTED_TAG: tag, GITHUB_OUTPUT: output,
            } });
            assert.equal(result.status, 0, result.stderr);
            const values = Object.fromEntries(readFileSync(output, 'utf8').trim().split('\n').map(line => line.split('=')));
            assert.equal(values.tag, tag);
            assert.equal(values.sha, tagged);
            assert.equal(values.prerelease, prerelease);
            assert.equal(git('rev-parse', 'HEAD'), tagged);
            assert.equal(readFileSync(join(dir, 'revision'), 'utf8'), 'tagged source');
        }
        for (const tag of ['v1.6.99', 'main', 'v1.6.1;touch injected', 'v1.6.1\nsha=injected']) {
            git('checkout', '--detach', branch);
            const result = spawnSync('/bin/bash', [script], { cwd: dir, encoding: 'utf8', env: {
                ...env, REQUESTED_TAG: tag, GITHUB_OUTPUT: join(dir, 'invalid-output'),
            } });
            assert.notEqual(result.status, 0, tag);
            assert.equal(git('rev-parse', 'HEAD'), branch);
        }
    } finally { rmSync(dir, { recursive: true, force: true }); }
});
