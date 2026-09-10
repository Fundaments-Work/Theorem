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
- **Vault sync**: Path to Obsidian/Logseq vault, auto-export toggle, filenames
- **Device sync**: Device identity, QR pair, paired devices list, unpair, auto-sync toggle
- **CLI Setup**: enable/disable the headless `theorem` CLI with auto-heal — see [plans/done/2026-09-01-headless-cli-architecture.md](plans/done/2026-09-01-headless-cli-architecture.md)

### Data & Storage (id: `storage`)
- Storage statistics (Books, Highlights & Notes, RSS Articles, Offline Dictionaries)
- Clear all data (with warning dialog)
- Export sync bundle (portable JSON backup)

### Shortcuts
- Reference list of all keyboard shortcuts (read-only)

### About
- Version info, repository link, license
- **Build stamp** (`<git hash> · <commit date>`), baked into the binary by
  `src-tauri/build.rs` (`THEOREM_GIT_HASH` / `THEOREM_BUILD_DATE`, exposed via
  the `app_build_info` command). Desktop release binaries embed the web UI at
  compile time, so a binary can silently go stale after frontend changes —
  this stamp makes that visible at a glance.
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

The "Clear All Data" button:
1. Shows a confirmation dialog ("This will delete all your books, annotations, settings...")
2. Calls `clearAllApplicationStorage()`, which invokes `sqlite_clear_all_storage` (deletes all SQLite rows + removes `book-cache/`) and `clear_sync_databases` (unconditionally on Tauri)
3. Clears the persisted storage for the settings, library, vocabulary, and rss stores
4. Reloads the app
