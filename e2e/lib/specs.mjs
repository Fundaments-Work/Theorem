// Keep smoke coverage explicit. The default remains every E2E spec.
export const SMOKE_SPECS = Object.freeze([
    '01-first-launch.test.mjs',
    '02-library-import-search.test.mjs',
    '03-reader-position.test.mjs',
]);

export function selectSpecs(files, { smoke = false, filters = [] } = {}) {
    const specs = files.filter(file => file.endsWith('.test.mjs'));
    if (smoke) {
        for (const file of SMOKE_SPECS) {
            if (!specs.includes(file)) throw new Error(`Smoke spec missing: ${file}`);
        }
    }
    const selected = specs
        .filter(file => !smoke || SMOKE_SPECS.includes(file))
        .filter(file => filters.length === 0 || filters.some(filter => file.includes(filter)))
        .sort();
    // `node --test` without file arguments discovers tests automatically.
    // An empty selection must fail rather than unexpectedly running everything.
    if (selected.length === 0) throw new Error('No E2E specs match the requested selection');
    return selected;
}
