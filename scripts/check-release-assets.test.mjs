import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const script = resolve('scripts/check-release-assets.sh');
const assets = ['deb/Theorem.deb', 'appimage/Theorem.AppImage', 'appimage/Theorem.AppImage.sig'];
const patterns = 'deb/*.deb appimage/*.AppImage appimage/*.AppImage.sig';
function check(files, target = 'src-tauri/target/native target/release/bundle') {
    const dir = mkdtempSync(join(tmpdir(), 'theorem-bundles-'));
    try {
        for (const file of files) {
            const path = join(dir, target, file);
            mkdirSync(dirname(path), { recursive: true });
            writeFileSync(path, 'test asset');
        }
        return spawnSync('/bin/bash', [script, patterns], { cwd: dir, encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
    } finally { rmSync(dir, { recursive: true, force: true }); }
}
test('all installers and signatures are required for explicit-target and default bundles', () => {
    for (const target of ['src-tauri/target/native target/release/bundle', 'src-tauri/target/release/bundle']) {
        const result = check(assets, target);
        assert.equal(result.status, 0, result.stderr);
    }
});
test('a missing signature fails instead of disappearing through nullglob', () => {
    const result = check(assets.slice(0, -1));
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /missing appimage\/\*\.AppImage\.sig/);
});
test('each missing installer or signature fails independently', () => {
    for (const absent of assets) {
        assert.equal(check(assets.filter(asset => asset !== absent)).status, 1, absent);
    }
});
test('no bundle output fails explicitly', () => {
    const result = check([]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /No bundle directory/);
});
