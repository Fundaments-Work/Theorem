function assertNewRelease(releases, tag) {
    if (releases.some((release) => release.tag_name === tag)) {
        throw new Error(`A release or draft for ${tag} already exists. Stop and follow the release recovery procedure; do not start another release.`);
    }
}

module.exports = { assertNewRelease };
