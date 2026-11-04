import test from 'node:test';
import assert from 'node:assert/strict';
import { selectSpecs, SMOKE_SPECS } from './specs.mjs';

const files = [...SMOKE_SPECS, 'onboarding-appearance.test.mjs', 'backup-restore.test.mjs', 'README.md'];
test('the default runs every spec, including screenshot and backup coverage', () => {
    assert.deepEqual(selectSpecs(files), files.filter(file => file.endsWith('.test.mjs')).sort());
});
test('smoke selects launch, import/search and reader persistence without changing specs', () => {
    assert.deepEqual(selectSpecs([...files].reverse(), { smoke: true }), [...SMOKE_SPECS]);
});
test('existing substring filters work in full and smoke modes', () => {
    assert.deepEqual(selectSpecs(files, { filters: ['backup', 'appearance'] }), ['backup-restore.test.mjs', 'onboarding-appearance.test.mjs']);
    assert.deepEqual(selectSpecs(files, { smoke: true, filters: ['reader'] }), ['03-reader-position.test.mjs']);
});
test('no match and empty directories fail instead of triggering automatic test discovery', () => {
    assert.throws(() => selectSpecs(files, { filters: ['does-not-exist'] }), /No E2E specs/);
    assert.throws(() => selectSpecs([]), /No E2E specs/);
    assert.throws(() => selectSpecs(files, { smoke: true, filters: ['backup'] }), /No E2E specs/);
});
test('a missing smoke spec is an error even when a narrower filter would omit it', () => {
    for (const missing of SMOKE_SPECS) {
        assert.throws(() => selectSpecs(files.filter(file => file !== missing), { smoke: true, filters: ['reader'] }), /Smoke spec missing/);
    }
});
