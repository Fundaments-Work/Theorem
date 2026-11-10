function assertCiResult(needs) {
    if (needs.changes.result !== 'success') throw new Error('CI change selection did not succeed');
    const selected = needs.changes.outputs;
    for (const key of ['web', 'rust', 'android', 'workflows']) {
        if (!['true', 'false'].includes(selected[key])) throw new Error(`Invalid CI selection: ${key}`);
    }
    const expected = {
        'workflow-check': selected.workflows === 'true',
        web: selected.web === 'true' || selected.rust === 'true',
        'rust-check': selected.rust === 'true',
        'rust-windows-import': selected.rust === 'true',
        'rust-android-check': selected.android === 'true',
    };
    for (const [job, required] of Object.entries(expected)) {
        const result = needs[job]?.result;
        if (result !== (required ? 'success' : 'skipped')) throw new Error(`Unexpected ${job} result: ${result}`);
    }
}

module.exports = { assertCiResult };
