# Unbreakable, High-Performance P2P Sync — Status & Remaining Work

**Date**: 2026-09-01 · Architectural pillars are described in git history
(2026-09-01 revision) and implemented across `iroh_sync.rs`,
`sync_commands.rs`, `theorem-sync-core`. This doc tracks what remains.

## Implemented ✅

- **IPC batching (Pillar 1, step 1)**: remote iroh-docs entries are deduped and
  batched in `EntryBatcher` (300ms / 64 entries) and emitted as one
  `docs-entry-batch` event; `sync-orchestrator.ts` consumes batches through the
  same tombstone/LWW merge logic.
- **Tombstone compaction (Pillar 4, partial)**: `src/core/lib/tombstone-pruner.ts`
  prunes `deletionTombstones` older than 90 days from the library and RSS
  stores at every app startup.
- **Reconnection backoff (Pillar 5, partial)**: exponential backoff on the doc
  event stream (`subscribe_doc_events`, caps at 30s) plus the pre-existing
  auto-sync interval loop.

## Remaining

- [ ] **Phase 1 — Native SQLite ingestion**: apply incoming doc entries to
      SQLite inside Rust and emit only changed IDs (`sync_batch_applied`).
      Requires moving the merge functions (tombstones/LWW) into
      `theorem-sync-core` and re-hydrating frontend stores from SQLite.
- [ ] **Phase 2 — Resumable BLAKE3 byte-range transfers** in `file_transfer.rs`
      (256KB verified blocks, resume from `<existing_len>`).
- [ ] **Phase 3 — Hybrid Logical Clocks**: replace wall-clock ISO timestamps in
      annotation/progress merge keys with HLC `(physical, counter, device_id)`.
- [ ] **Pillar 3 — LAN fast-path racing**: verify iroh mDNS dial racing is
      effective in practice; document expected LAN throughput.
