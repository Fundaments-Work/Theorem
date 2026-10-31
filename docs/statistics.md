# Statistics

## What's Tracked

Reading statistics are stored in `settingsStore.stats` (persisted alongside settings):

| Stat | How It's Calculated |
|------|---------------------|
| Total reading time | Sum of per-session reading durations |
| Books completed | `progress >= 0.99`, or `completedAt` set, or manual read state |
| Current streak | Consecutive days with reading time > 0 |
| Longest streak | Max consecutive days ever recorded |
| Daily goal progress | Today's reading minutes vs `dailyGoal` |
| Yearly book goal | Books completed this year vs `yearlyBookGoal` |
| Daily activity | Per-day reading minutes for heatmap |

## How Reading Time Is Tracked

The reader tracks active reading time (not wall-clock time). The timer runs while the document is visible; it pauses when:
- The document becomes hidden (backgrounded)
- The OS pauses the app (Tauri `tauri://on-pause`)

It resumes on `visibilitychange` / `tauri://on-resume`.

Time is reported as `readingTime: number` (minutes) on the `Book` object and aggregated into `stats.totalReadingTime`.

## Daily Activity Heatmap

The `dailyActivity` array stores per-day reading minutes. Each entry is `{ date: string, minutes: number, booksRead: string[] }`. The Statistics page renders this as a GitHub-style heatmap grid covering the last 12 weeks (84 days).

For performance, `dailyActivity` is pruned to the most recent 84 entries in memory.

## Goals

Reading targets are user-configurable in Settings:
- **Weekly reading days**: Optional one-to-seven-day rhythm (four recommended when setting it up)
- **Daily minutes**: Target minutes per day (default: 30)
- **Yearly books**: Target books per year (default: 24)

Progress bars show completion percentage for both.

## Sharing Stats

The `ShareCardModal` generates a shareable image of the user's reading stats using `html-to-image` (dynamically imported). The image can be:
- Downloaded as PNG via `downloadImage` (desktop Downloads / Android MediaStore) or browser download (web)
- Shared via Web Share API (mobile browsers)

The share card renders `ShareCard` inline in the modal's React tree and captures the node with `html-to-image`'s `toBlob`.

## Native recording contract

`sqlite_record_reading_chunk` records an immutable `chunk:<id>` in the existing
`reading_sessions` table. Repeating the same ID and payload is a no-op; reusing
an ID with different date, book, or duration returns an InvalidInput error.
Durations must be finite, positive, and at most one day. The older
`sqlite_record_reading_session` command remains additive for existing callers.

The dependency rule used here is rusqlite's `Connection::execute` contract: it
returns the number of changed/inserted/deleted rows and delegates to the prepared
statement's `execute`. A successful zero-row `ON CONFLICT DO NOTHING` is not a
failed write. The chunk path reads back the immutable row to distinguish a safe
replay from an identity conflict. No duplicate is updated or incremented.

## Weekly reading rhythm and XP

Onboarding and Settings offer an optional weekly reading rhythm (suggested: four days).
Five recorded minutes, accumulated across sessions and books on the same local
calendar date, qualify as one reading day. Weeks run Monday–Sunday. Daily-minute goals and strict daily streaks remain separate.
Changing an established weekly goal, including turning it off, takes effect the
following Monday. Initial setup applies to the current week.

Qualifying days earn 10 XP, once per date. Reaching the effective weekly target
earns another 20 XP, once per week. Level starts at 1 and advances every 100 XP.
Extra minutes, imports, highlights, page turns and review-card swipes earn no XP.
Missing a day or week does not remove XP. For both existing rhythm profiles and readers without rhythm state,
the evaluator credits qualifying days from retained legacy daily activity.
Fractional minutes are accepted; book metadata is ignored. Existing awards and goals are preserved. A stable legacy source credits each
qualifying date once, using a five-minute lower bound instead of adding
overlapping minutes. Startup persists this backfill, and progress refreshes
when daily activity changes. Historical weeks without an established target earn no
weekly bonus. The store retains up to 365 days of legacy activity. Weekly targets are edited only in Settings → General →
Reading Goals, using the shared Dropdown (Off or one through seven days).
Statistics is read-only: a numbered shield, lifetime XP, segmented next-level
track, next-level shield of the same size, and a weekly flag/count when a goal
is enabled. The flag shows reading days, with a completion check when the weekly
goal has been met. Statistics labels the calculated current level explicitly.
When Settings has a pending goal change, its helper separates this week’s target
from the target that takes effect Monday. The shield numbers come from calculated XP.
Icons retain accessible names and tooltips. Library shows no rhythm panel.
XP progress appears inline; it does not open a celebration over the reader.
The legacy `hideReadingMotivation` field remains readable for older peers but
has no UI. `useReadingRhythmProgress` shares read-only queries between the
Statistics display and Settings control; only the latter changes goals.

The Rust rules live in `theorem-core::reading_rhythm`, called through the offloaded `evaluate_reading_rhythm` command on desktop and
mobile. The browser loads the same crate's bundled WebAssembly module lazily via
`core/lib/reading-rhythm.ts`. Native sync uses the same rules. `ReadingStats.rhythm` is version 1:
activation date, local-date/source cumulative-second counters, effective-week
goal history, and awards keyed by date or week. Reader-instance source IDs are
stable across flushes and unique across mounts. Source counters merge by maximum;
independent sources add, capped at 24 hours per date. Overlapping reading on two
devices is additive, but still yields at most one daily award. Award maps merge
by union. Goal conflicts compare their ISO timestamp, unique ID, then target.
Earned awards survive later goal conflicts and library deletions.

The counter and award maps are saved together in the existing settings snapshot,
not separate mutable XP totals. Each SQLite snapshot replaces one KV row
atomically; web persistence uses the existing IndexedDB adapter. Settings store
version 14 migrates existing preferences and introduces device-local setup progress
and device-local retry outboxes for native chunks and cumulative reading counters.
Neither outbox is part of statistics sync. Counter mutations are serialized across
native IPC and re-read current state if another writer changes it while pending.
Native chunks retry on another flush or app start with their original identity.
Pending rhythm counters replay at startup, including when the reader closed
before its native evaluation finished.
The existing persistence failure reporting applies to this snapshot as well.

Visible reading intervals use monotonic elapsed time; wall-clock corrections
change the date assignment, not the duration. Flushes split at local midnight,
retain fractional minutes when leaving a book, and do not start while hidden.
Durations render as `<1m` below a minute or completed whole minutes/hours; remaining
minutes round upward for display without changing stored time or goal thresholds.
Day keys already recorded are never reassigned after travel. A newly recorded
earlier local day after travel or clock correction is accepted without
duplicating retained legacy day credit. Visible time remains
a proxy for reading, not proof of attention or comprehension.

Native backups include both the ledger and retry outbox in the settings snapshot.
Restoring the same backup repeatedly does not add awards. A deliberate full
restore replaces local history with the snapshot's history, including XP;
subsequent peer sync unions any additional awards that peers still hold.

Statistics uses Lucide icons throughout, including goal-completion checks.
Earned achievements use an accent edge and an accent tile with contrast-colored
icons; they are shown only after their existing unlock condition is met.
