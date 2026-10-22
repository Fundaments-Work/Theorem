# Settings

## Architecture

Settings live in `settingsStore` (Zustand, version 11, persisted). A single `AppSettings` type holds all user preferences, divided into sub-stores for logical grouping:

| Sub-store | What it controls |
|-----------|-----------------|
| `ReaderSettings` | Theme, font, layout, margins, zoom, animations |
| `VocabularySettings` | Toggle vocabulary lookups, pronunciation |
| `TtsSettings` | Voice, speed, enable/disable |
| `VaultIntegrationSettings` | Vault path, auto-export, filenames |
| `DeviceSyncSettings` | Device identity, paired devices, auto-sync |
| Top-level | Theme, library view mode, sort, sidebar, scan folders |

The `AppSettings` type is also used as the Zod schema (`AppSettingsSchema`) for sync validation.

## Settings Page Tabs

The Settings page (`Settings.tsx`) has 6 tabs:

### General
- Theme: Light, Dark, System
- Accent color: 8 preset colors
- Reading goals: Daily minutes, yearly books
- Sidebar: Collapsed by default
- Text-to-Speech toggle
- Neural Voice (desktop): Supertonic install status, one-click download of the ~400MB model/runtime/voice bundle with per-file progress, installed size/path, removal — see [tts.md](tts.md)
- Text-to-Speech Engine (Android): pick the engine Theorem narrates through; recommends the Theorem Neural Voice companion app

### Dictionary
- Installed StarDict dictionaries
- Download dictionaries from GitHub releases
- Dictionary size and import status

### Devices & Export (id: `integrations`)
- **Vault sync**: Path to Obsidian/Logseq vault, auto-export toggle, filenames. Rendered only when `isTauriDesktop()`; on mobile and web the section is hidden and the tab is labelled "Devices"
- **Device sync**: Device identity, QR pair, paired devices list, unpair, auto-sync toggle
- **CLI Setup**: enable/disable the headless `theorem` CLI with auto-heal — see [plans/done/2026-09-01-headless-cli-architecture.md](plans/done/2026-09-01-headless-cli-architecture.md)

### Data & Storage (id: `storage`)
- Storage statistics (Books, Highlights & Notes, RSS Articles, Offline Dictionaries)
- Backup & Restore (`BackupSection.tsx`): Create Backup File (`.theorem-backup`, optional dictionaries), Restore from Backup (inspect, confirm, replace, reload), and the automatic database copies with Restore buttons. See [persistence.md](persistence.md#backups-snapshots-and-startup-safety)
- Clear all data (with warning dialog)

### Shortcuts
- Reference list of all keyboard shortcuts (read-only)

### About
- Version info, repository link, license
- **Support Theorem (Buy Me Momo)**: Link to Buy Me Momo (`https://buymemomo.com/usefundaments`), the Nepali creator-funding platform supporting domestic (Connect IPS, eSewa, Khalti) and international card rails. Always accessible from Settings regardless of the 30-day cadence nudge in the shell.
- **Build stamp** (`<git hash> · <commit date>`), baked into the binary by
  `src-tauri/build.rs` (`THEOREM_GIT_HASH` / `THEOREM_BUILD_DATE`, exposed via
  the `app_build_info` command). Desktop release binaries embed the web UI at
  compile time, so a binary can silently go stale after frontend changes —
  this stamp makes that visible at a glance.
- **Export Logs** (desktop and Android): saves `theorem-logs-<date>.zip` with
  the log files and a `diagnostics.txt` (app version, OS, architecture,
  webview version). Built by `export_logs_bundle` in
  `src-tauri/src/diagnostics.rs`; the home folder is written as `~`, and
  nothing else about the device or the library is added. The logs live in the
  platform log folder (`theorem.log`, rotated at 2 MB, four old files kept;
  Linux `~/.local/share/work.fundamentals.theorem/logs`, macOS
  `~/Library/Logs/work.fundamentals.theorem`, Windows
  `%LOCALAPPDATA%\work.fundamentals.theorem\logs`). They hold Rust log output
  at info and above (debug under `tauri dev`), every Rust panic, and errors
  caught by the React error boundaries. Never log book text, notes, keys or
  device identifiers: users attach these files to public issues.
- **Refreshing a locally built binary**: `pnpm build && (cd src-tauri && cargo
  build --release)` re-embeds the current UI into the release binary. CI
  release artifacts remain the canonical install.

## Migration Strategy

Settings have the longest migration chain (v0 → v11). Each migration maps the previous schema to the next. The pattern:

```typescript
migrate: (persisted, version) => {
    switch (version) {
        case 0: return migrateV0ToV1(persisted);
        case 1: return migrateV1ToV2(persisted);
        // ...
    }
}
```

Key migrations in history:
- **v0→v1**: Initial structured settings
- **v0→v4**: Added TTS defaults
- **v4→v5**: Added TTS `speed` default
- **v5→v6**: Added TTS `enabled` default
- **v6→v7**: Added `accentColor`
- **v7→v8**: Added `showDailyHighlight`
- **v8→v9**: Added `speedReadEnabled`
- **v9→v10**: Added goal notifications, reminder times, and sync notification toggles
- **v10→v11**: Added CLI settings (`cli`)

When adding a new setting, the current version should be bumped and a migration written. Old migrations should not be removed — they may be needed if a user upgrades from a very old version.

## Storage Tab

The Data & Storage tab provides insight into what's using disk space. The UI shows rows for:

| Component | Location | How Sized |
|-----------|----------|-----------|
| Books | `book-cache/` directory | `sqlite_get_storage_stats()` walks the directory |
| Highlights & Notes | SQLite `book_annotations` | Row counts / JSON sizes |
| RSS Articles | SQLite / persisted store | Article bodies |
| Offline Dictionaries | `dictionaries/` directory | Directory size |

The underlying `sqlite_get_storage_stats()` also returns `covers` and `blob_store` sizes, but these are not shown in the tab.

## Backup & Restore

`src/features/settings/BackupSection.tsx`, backed by `src/core/lib/db-backup.ts` and the Rust module `db_backup.rs`. Only in the desktop and Android apps; the browser build shows a note instead.

- **Create Backup File** flushes pending store writes, then calls `db_backup_create`. Desktop passes the path from a save dialog (`theorem-YYYY-MM-DD.theorem-backup`); Android passes none and the file is streamed into Downloads/Theorem (`saveFileFromPath` in the folder-scan plugin). The on/off switch beside it adds the `dictionaries/` folder. Progress arrives as `db-backup-progress` events.
- **Restore from Backup** picks a file (Android content URIs are copied to a local file first), calls `db_backup_inspect` and shows the manifest in a confirmation dialog. Confirming flushes writes to the current database, suspends persistence (`suspendPersistence`), calls `db_backup_restore`, clears the `theorem-unload:` snapshots and reloads the webview. A failure resumes persistence and shows the error.
- **Automatic copies** lists `db_list_snapshots`; Restore goes through the same confirmation and `db_restore_snapshot`.

The old "Create Backup File" wrote a JSON sync bundle with every book and dictionary base64-encoded in memory, ran out of memory on large libraries, and could not be restored. It is gone (`sync-bundle.ts` removed).

## Recovery screen

`src/shell/DatabaseRecovery.tsx`. `main.tsx` calls `db_health_status` (`src/core/lib/db-health.ts`) before rendering; when the startup guard reported `corrupt` or `migration_failed` it suspends persistence and renders this screen instead of the app. It offers each automatic copy, a backup file, and Continue Anyway (`db_health_dismiss`, resume persistence, reload).

The "Clear All Data" button:
1. Shows a confirmation dialog ("This will delete all your books, annotations, settings...")
2. Calls `clearAllApplicationStorage()`, which invokes `sqlite_clear_all_storage` (deletes all SQLite rows + removes `book-cache/`) and `clear_sync_databases` (unconditionally on Tauri)
3. Clears the persisted storage for the settings, library, vocabulary, and rss stores
4. Reloads the app
