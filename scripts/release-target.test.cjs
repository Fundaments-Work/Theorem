const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assertNewRelease } = require('./release-target.cjs');

test('allows a tag with no existing release', () => {
    assert.doesNotThrow(() => assertNewRelease([{ tag_name: 'v1.6.0', draft: false }], 'v1.6.1'));
});

for (const draft of [false, true]) {
    test(`refuses an existing ${draft ? 'draft' : 'published'} release`, () => {
        assert.throws(() => assertNewRelease([{ tag_name: 'v1.6.1', draft }], 'v1.6.1'), /already exists/);
    });
}
