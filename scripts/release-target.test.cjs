const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    assertNewRelease,
    assertAndroidReleaseFiles,
    assertReleaseAssets,
    buildUpdaterManifest,
} = require('./release-target.cjs');

test('allows a tag with no existing release', () => {
    assert.doesNotThrow(() => assertNewRelease([{ tag_name: 'v1.6.0', draft: false }], 'v1.6.1'));
});

for (const draft of [false, true]) {
    test(`refuses an existing ${draft ? 'draft' : 'published'} release`, () => {
        assert.throws(() => assertNewRelease([{ tag_name: 'v1.6.1', draft }], 'v1.6.1'), /already exists/);
    });
}

const fullAssets = [
    'Theorem_1.6.2_amd64.deb',
    'Theorem_1.6.2_amd64.AppImage',
    'Theorem_1.6.2_amd64.AppImage.sig',
    'Theorem_1.6.2_x64.dmg',
    'Theorem_x64.app.tar.gz',
    'Theorem_x64.app.tar.gz.sig',
    'Theorem_1.6.2_aarch64.dmg',
    'Theorem_aarch64.app.tar.gz',
    'Theorem_aarch64.app.tar.gz.sig',
    'Theorem_1.6.2_x64-setup.exe',
    'Theorem_1.6.2_x64-setup.exe.sig',
    'Theorem_1.6.2_x64_en-US.msi',
    'Theorem_1.6.2_x64_en-US.msi.sig',
    'app-arm64-release.apk',
    'app-arm-release.apk',
    'app-x86_64-release.apk',
    'app-x86-release.apk',
    'app-universal-release.aab',
];

test('accepts complete release asset upload set and rejects any missing asset', () => {
    assert.doesNotThrow(() => assertReleaseAssets(fullAssets));
    for (const omitted of fullAssets) {
        assert.throws(
            () => assertReleaseAssets(fullAssets.filter((name) => name !== omitted)),
            /Missing uploaded release assets/,
            `omitting ${omitted} must fail pre-publish verification`,
        );
    }
});

test('android verification requires all 4 ABI APKs plus .aab bundle', () => {
    const androidFiles = [
        'app-arm64-release.apk',
        'app-arm-release.apk',
        'app-x86_64-release.apk',
        'app-x86-release.apk',
        'app-release.aab',
    ];
    assert.doesNotThrow(() => assertAndroidReleaseFiles(androidFiles));
    for (const omitted of androidFiles) {
        assert.throws(
            () => assertAndroidReleaseFiles(androidFiles.filter((name) => name !== omitted)),
            /Missing required Android release outputs/,
            `omitting ${omitted} must fail Android artifact gate`,
        );
    }
});

test('reconciles authoritative latest.json across all four desktop platforms without races', () => {
    const manifest = buildUpdaterManifest({
        version: 'v1.6.2',
        notes: 'Release notes',
        pubDate: '2026-11-11T00:00:00Z',
        downloadBaseUrl: 'https://github.com/fundaments-work/Theorem/releases/download/v1.6.2',
        signaturesByAsset: {
            'Theorem_1.6.2_amd64.AppImage.sig': 'linux-sig\n',
            'Theorem_x64.app.tar.gz.sig': 'intel-sig',
            'Theorem_aarch64.app.tar.gz.sig': 'arm-sig',
            'Theorem_1.6.2_x64-setup.exe.sig': 'win-sig',
        },
    });
    assert.equal(manifest.version, '1.6.2');
    assert.deepEqual(Object.keys(manifest.platforms).sort(), [
        'darwin-aarch64',
        'darwin-x86_64',
        'linux-x86_64',
        'windows-x86_64',
    ]);
    assert.equal(manifest.platforms['linux-x86_64'].signature, 'linux-sig');
    assert.match(manifest.platforms['darwin-aarch64'].url, /Theorem_aarch64\.app\.tar\.gz$/);
});
