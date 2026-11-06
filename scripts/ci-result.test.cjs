const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assertCiResult } = require('./ci-result.cjs');

const jobs = (selected, overrides = {}) => ({
    changes: { result: 'success', outputs: selected },
    'workflow-check': { result: selected.workflows === 'true' ? 'success' : 'skipped' },
    web: { result: selected.web === 'true' || selected.rust === 'true' ? 'success' : 'skipped' },
    'rust-check': { result: selected.rust === 'true' ? 'success' : 'skipped' },
    'rust-android-check': { result: selected.android === 'true' ? 'success' : 'skipped' },
    ...overrides,
});
const none = { web: 'false', rust: 'false', android: 'false', workflows: 'false' };

test('accepts intentional skips and selected successes', () => {
    assert.doesNotThrow(() => assertCiResult(jobs(none)));
    assert.doesNotThrow(() => assertCiResult(jobs({ web: 'false', rust: 'true', android: 'true', workflows: 'true' })));
});

test('rejects failed, cancelled, or unexpectedly skipped selected jobs', () => {
    for (const result of ['failure', 'cancelled', 'skipped']) {
        assert.throws(() => assertCiResult(jobs({ ...none, web: 'true' }, { web: { result } })));
    }
    assert.throws(() => assertCiResult(jobs(none, { changes: { result: 'failure', outputs: {} } })));
    assert.throws(() => assertCiResult(jobs({ ...none, web: '' })));
});
