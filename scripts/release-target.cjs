function assertNewRelease(releases, tag) {
    if (releases.some((release) => release.tag_name === tag)) {
        throw new Error(`A release or draft for ${tag} already exists. Stop and follow the release recovery procedure; do not start another release.`);
    }
}

const REQUIRED_ANDROID_APK_PATTERNS = [
    { label: 'arm64 APK', test: (name) => /arm64.*\.apk$/i.test(name) },
    { label: 'armeabi/arm 32-bit APK', test: (name) => /(?:^|[-_])arm(?:eabi-v7a)?-release\.apk$|armeabi.*\.apk$/i.test(name) },
    { label: 'x86_64 APK', test: (name) => /x86_64.*\.apk$/i.test(name) },
    { label: 'x86 APK', test: (name) => /(?:^|[-_])x86-release\.apk$/i.test(name) },
];

const REQUIRED_RELEASE_CHECKS = [
    { label: 'Linux .deb', test: (name) => /\.deb$/i.test(name) },
    { label: 'Linux .AppImage', test: (name) => /\.AppImage$/i.test(name) },
    { label: 'Linux .AppImage.sig', test: (name) => /\.AppImage\.sig$/i.test(name) },
    { label: 'macOS Intel .dmg', test: (name) => /(x64|x86_64).*\.dmg$/i.test(name) },
    { label: 'macOS Intel .app.tar.gz', test: (name) => /(x64|x86_64).*\.app\.tar\.gz$/i.test(name) },
    { label: 'macOS Intel .app.tar.gz.sig', test: (name) => /(x64|x86_64).*\.app\.tar\.gz\.sig$/i.test(name) },
    { label: 'macOS Apple Silicon .dmg', test: (name) => /aarch64.*\.dmg$/i.test(name) },
    { label: 'macOS Apple Silicon .app.tar.gz', test: (name) => /aarch64.*\.app\.tar\.gz$/i.test(name) },
    { label: 'macOS Apple Silicon .app.tar.gz.sig', test: (name) => /aarch64.*\.app\.tar\.gz\.sig$/i.test(name) },
    { label: 'Windows NSIS .exe', test: (name) => /-setup\.exe$/i.test(name) },
    { label: 'Windows NSIS .exe.sig', test: (name) => /-setup\.exe\.sig$/i.test(name) },
    { label: 'Windows .msi', test: (name) => /\.msi$/i.test(name) },
    { label: 'Windows .msi.sig', test: (name) => /\.msi\.sig$/i.test(name) },
    ...REQUIRED_ANDROID_APK_PATTERNS,
    { label: 'Android .aab bundle', test: (name) => /\.aab$/i.test(name) },
];

function assertAndroidReleaseFiles(fileNames) {
    const missing = [...REQUIRED_ANDROID_APK_PATTERNS, { label: 'Android .aab bundle', test: (n) => /\.aab$/i.test(n) }]
        .filter((rule) => !fileNames.some((name) => rule.test(name)))
        .map((rule) => rule.label);
    if (missing.length > 0) {
        throw new Error(`Missing required Android release outputs: ${missing.join(', ')}`);
    }
}

function assertReleaseAssets(assetNames) {
    const missing = REQUIRED_RELEASE_CHECKS
        .filter((rule) => !assetNames.some((name) => rule.test(name)))
        .map((rule) => rule.label);
    if (missing.length > 0) {
        throw new Error(`Missing uploaded release assets before publishing: ${missing.join(', ')}`);
    }
}

const UPDATER_PLATFORM_RULES = [
    {
        target: 'linux-x86_64',
        binaryTest: (name) => /\.AppImage$/i.test(name),
        sigTest: (name) => /\.AppImage\.sig$/i.test(name),
    },
    {
        target: 'darwin-x86_64',
        binaryTest: (name) => /(x64|x86_64).*\.app\.tar\.gz$/i.test(name),
        sigTest: (name) => /(x64|x86_64).*\.app\.tar\.gz\.sig$/i.test(name),
    },
    {
        target: 'darwin-aarch64',
        binaryTest: (name) => /aarch64.*\.app\.tar\.gz$/i.test(name),
        sigTest: (name) => /aarch64.*\.app\.tar\.gz\.sig$/i.test(name),
    },
    {
        target: 'windows-x86_64',
        binaryTest: (name) => /-setup\.exe$/i.test(name),
        sigTest: (name) => /-setup\.exe\.sig$/i.test(name),
    },
];

function buildUpdaterManifest({ version, notes = '', pubDate, downloadBaseUrl, signaturesByAsset }) {
    const assetNames = Object.keys(signaturesByAsset);
    const platforms = {};
    for (const rule of UPDATER_PLATFORM_RULES) {
        const sigName = assetNames.find((name) => rule.sigTest(name));
        if (!sigName) {
            throw new Error(`Missing updater signature asset for platform ${rule.target}`);
        }
        const sig = String(signaturesByAsset[sigName] || '').trim();
        if (!sig) {
            throw new Error(`Empty updater signature for ${sigName}`);
        }
        const binaryName = sigName.replace(/\.sig$/i, '');
        if (!rule.binaryTest(binaryName)) {
            throw new Error(`Unexpected updater signature filename ${sigName} for ${rule.target}`);
        }
        platforms[rule.target] = {
            signature: sig,
            url: `${downloadBaseUrl.replace(/\/+$/, '')}/${binaryName}`,
        };
    }
    return {
        version: String(version).replace(/^v/, ''),
        notes,
        pub_date: pubDate,
        platforms,
    };
}

module.exports = {
    assertNewRelease,
    assertAndroidReleaseFiles,
    assertReleaseAssets,
    buildUpdaterManifest,
};
