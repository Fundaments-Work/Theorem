# Unbreakable, High-Performance P2P Sync — Status

**Date**: 2026-09-01 · The sync engine (iroh + iroh-docs + iroh-blobs +
iroh-gossip) is implemented across `iroh_sync.rs`, `sync_commands.rs`, and
`theorem-sync-core`. This doc records what was hardened and what was
explicitly closed.

## Hardened ✅

- **IPC batching**: remote doc entries are deduped and batched in
  `EntryBatcher` (300ms / 64 entries) and emitted as one `docs-entry-batch`
  event; `sync-orchestrator.ts` consumes batches through the same
  tombstone/LWW merge logic. This removed the per-entry IPC storm the
  original plan targeted.
- **Tombstone compaction**: `src/core/lib/tombstone-pruner.ts` prunes
  tombstones older than 90 days from the library and RSS stores at startup.
- **Reconnection backoff**: exponential backoff on the doc event stream
  (caps at 30s) plus the auto-sync interval loop.

## Explicitly closed (do not re-add without new evidence)

- **Native SQLite ingestion** (apply entries in Rust, emit changed IDs): the
  batching above already removed the IPC bottleneck; JS merge of batched
  entries is adequate at realistic library sizes. The re-architecture risk
  outweighs the residual gain.
- **Custom byte-range resume in `file_transfer.rs`**: iroh-blobs already
  streams BLAKE3-verified chunks; a hand-rolled byte-range layer would
  duplicate the protocol.
- **Hybrid Logical Clocks**: consumer multi-device sync with NTP-corrected
  clocks; LWW + tombstones already cover the realistic conflict space, and an
  HLC migration would touch every sync payload format.
- **LAN fast-path racing work**: iroh performs direct/relay transport racing
  (with mDNS lookup) internally; nothing to implement.
