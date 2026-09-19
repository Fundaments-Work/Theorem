// Update-channel helpers (#106).
//
// Release convention: only X.Y.0 versions are stable; X.Y.Z with Z > 0 are
// beta / pre-releases. The Tauri updater's latest.json feed tracks the stable
// channel, so pre-release users need an explicit GitHub Releases lookup.

export interface GitHubRelease {
    tag_name: string;
    name?: string | null;
    body?: string | null;
    prerelease: boolean;
    draft: boolean;
    html_url: string;
}

export function parseSemver(version: string): [number, number, number] | null {
    const cleaned = version.trim().replace(/^[vV=]/, "");
    const match = cleaned.match(/^(\d+)\.(\d+)\.(\d+)/);
    if (!match) return null;
    return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareSemver(a: string, b: string): number {
    const pa = parseSemver(a);
    const pb = parseSemver(b);
    if (!pa && !pb) return 0;
    if (!pa) return -1;
    if (!pb) return 1;
    for (let i = 0; i < 3; i++) {
        if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
    }
    return 0;
}

// Repo convention: patch > 0 means beta / pre-release.
export function isPrereleaseVersion(version: string): boolean {
    const parsed = parseSemver(version);
    return parsed !== null && parsed[2] > 0;
}

function releaseVersion(release: GitHubRelease): string | null {
    const raw = release.tag_name || release.name || "";
    return parseSemver(raw) ? raw : null;
}

// Newest applicable release newer than `currentVersion`. Pre-releases are
// only considered when the running build is itself a pre-release.
export function findLatestApplicableRelease(
    releases: GitHubRelease[],
    currentVersion: string,
): GitHubRelease | null {
    const allowPrerelease = isPrereleaseVersion(currentVersion);
    let best: GitHubRelease | null = null;
    for (const release of releases) {
        if (release.draft) continue;
        if (release.prerelease && !allowPrerelease) continue;
        const version = releaseVersion(release);
        if (!version) continue;
        if (compareSemver(version, currentVersion) <= 0) continue;
        if (!best || compareSemver(version, releaseVersion(best) || "") > 0) {
            best = release;
        }
    }
    return best;
}

const RELEASES_API_URL =
    "https://api.github.com/repos/fundaments-work/Theorem/releases?per_page=20";

export async function fetchLatestApplicableRelease(
    currentVersion: string,
    timeoutMs = 15000,
): Promise<GitHubRelease | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(RELEASES_API_URL, {
            signal: controller.signal,
            headers: { Accept: "application/vnd.github+json" },
        });
        if (!response.ok) return null;
        const releases = (await response.json()) as GitHubRelease[];
        if (!Array.isArray(releases)) return null;
        return findLatestApplicableRelease(releases, currentVersion);
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}
