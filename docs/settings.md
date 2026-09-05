# Settings

## Architecture

Settings live in `settingsStore` (Zustand, version 9, persisted). A single `AppSettings` type holds all user preferences, divided into sub-stores for logical grouping:

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
- Language: English, Spanish, French
- Reading goals: Daily minutes, yearly books
- Library: View mode default, sort order
- Sidebar: Collapsed by default
- Text-to-Speech toggle
- Neural Voice (desktop): Supertonic install status, one-click download of the ~400MB model/runtime/voice bundle with per-file progress, installed size/path, removal — see [tts.md](tts.md)
- Text-to-Speech Engine (Android): pick the engine Theorem narrates through; recommends the Theorem Neural Voice companion app
- CLI Setup: enable/disable the headless `theorem` CLI with auto-heal — see [plans/2026-09-01-headless-cli-architecture.md](plans/2026-09-01-headless-cli-architecture.md)

### Dictionary
- Installed StarDict dictionaries
- Download dictionaries from GitHub releases
- Dictionary size and import status

### Integrations
- **Vault sync**: Path to Obsidian/Logseq vault, auto-export toggle, filenames
- **Device sync**: Device identity, QR pair, paired devices list, unpair, auto-sync toggle

### Storage
- Storage statistics (total books, covers, blobs, file cache sizes)
- Clear all data (with warning dialog)
- Export/import sync bundle (portable JSON backup)

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

Settings have the longest migration chain (v0 → v9). Each migration maps the previous schema to the next. The pattern:

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
- **v3→v4**: Added device sync settings
- **v5→v6**: Added vault integration settings
- **v7→v8**: Folded reading stats into settings store
- **v8→v9**: Added accent color and language
- **v9→v10**: Added goal notifications, reminder times, and sync notification toggles

When adding a new setting, the current version should be bumped and a migration written. Old migrations should not be removed — they may be needed if a user upgrades from a very old version.

## Storage Tab

The Storage tab provides insight into what's using disk space:

| Component | Location | How Sized |
|-----------|----------|-----------|
| Book files | `book-cache/` directory | `sqlite_get_storage_stats()` walks the directory |
| Covers | SQLite `covers` table | `SUM(length(data_url))` |
| Blobs | SQLite `blob_store` | `SUM(length(data))` |
| Total | All combined | Sum of above |

The "Clear All Data" button:
1. Shows a confirmation dialog ("This will delete all your books, annotations, settings...")
2. Calls `sqlite_clear_all_storage` (deletes all SQLite rows + removes `book-cache/`)
3. Calls `clearAllZustandStores()` (resets all 5 stores to initial state)
4. Calls `clear_sync_databases` (if paired devices exist)
5. Reloads the app
