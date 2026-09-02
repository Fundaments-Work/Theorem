import type { DeletionTombstone } from "../types";
import { useLibraryStore } from "../store/libraryStore";
import { useRssStore } from "../store/rssStore";

// Tombstones prevent deleted entities from resurrecting when an offline peer
// reconnects. Once a tombstone is older than this window it is pruned so the
// stores don't grow forever (Unbreakable P2P Sync plan, Phase 3).
const TOMBSTONE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export function pruneExpiredTombstones(): void {
    const cutoff = new Date(Date.now() - TOMBSTONE_RETENTION_MS);

    const prune = (tombstones: DeletionTombstone[] | undefined) =>
        (tombstones ?? []).filter((t) => {
            const deleted = Date.parse(t.deletedAt);
            return Number.isNaN(deleted) || deleted >= cutoff.getTime();
        });

    const library = useLibraryStore.getState();
    const prunedLibrary = prune(library.deletionTombstones);
    if (prunedLibrary.length !== library.deletionTombstones.length) {
        useLibraryStore.setState({ deletionTombstones: prunedLibrary });
    }

    const rss = useRssStore.getState();
    const prunedRss = prune(rss.deletionTombstones);
    if (prunedRss.length !== rss.deletionTombstones.length) {
        useRssStore.setState({ deletionTombstones: prunedRss });
    }
}
