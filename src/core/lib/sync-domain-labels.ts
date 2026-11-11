/** Human-readable labels for synced storage/store domains shown in the UI. */
export const SYNC_DOMAIN_LABELS: Record<string, string> = {
    books: "Books",
    annotations: "Annotations",
    collections: "Collections",
    deletion_tombstones: "Deletions",
    vocabulary: "Vocabulary",
    rss_feeds: "Feeds",
    rss_articles: "Articles",
    settings: "Settings",
    reading_stats: "Reading stats",
    reading_rhythm: "Reading rhythm",
    reading_records: "Reading sessions",
};

export function formatSyncDomainLabel(domain: string): string {
    const known = SYNC_DOMAIN_LABELS[domain];
    if (known) return known;
    const words = domain.replace(/[_-]+/g, " ").trim();
    if (!words) return "Other";
    return words.charAt(0).toUpperCase() + words.slice(1);
}

export function formatUpdatedDomainsMessage(domainsUpdated: readonly string[]): string {
    const visible = [...new Set(domainsUpdated)]
        .filter((d) => d !== "deletion_tombstones")
        .map(formatSyncDomainLabel);
    if (visible.length > 0) {
        return `Updated: ${visible.join(", ")}`;
    }
    return domainsUpdated.length > 0 ? "Sync complete" : "Already in sync";
}
