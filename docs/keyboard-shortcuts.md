# Keyboard Shortcuts

> **`Ctrl` means the platform's primary key.** Declarations such as `Ctrl+1` are written once and
> resolve at runtime: **Command (⌘)** on macOS and other Apple platforms, **Control** everywhere
> else. The help dialog and Settings show the real key (`⌘ + 1` on a Mac, `Ctrl + 1` elsewhere).
> A literal `Meta`/`Cmd` in a declaration stays the physical Command/Windows key.

## Global (Universal)

| Shortcut | Action |
|----------|--------|
| `Ctrl+1` | Go to Library |
| `Ctrl+2` | Go to Shelves |
| `Ctrl+3` | Go to Feeds |
| `Ctrl+4` | Go to Workbench (Annotations & Vocab) |
| `Ctrl+5` | Go to Statistics |
| `Ctrl+6` | Go to Discover |
| `Ctrl+7` | Go to Bookmarks |
| `Ctrl+,` | Go to Settings |
| `Ctrl+F` | Focus search bar |
| `Ctrl+A` | Select all — enters selection mode and selects every book in the current filtered Library view or open shelf (no-op elsewhere, and inside text fields it keeps its normal meaning) |
| `Shift+?` | Show shortcuts help modal |
| `Escape` | Handled per-component (Theorem Lens, editors, fullscreen), not globally |

## Reader

| Shortcut | Action |
|----------|--------|
| `Left` / `Right` | Previous / Next page |
| `Space` | Next page |
| `+` / `-` | Zoom in / Zoom out (PDF only) |
| `Ctrl+F` | Find in book |
| `Ctrl+D` | Bookmark current page |
| `Ctrl+T` | Toggle table of contents |
| `Ctrl+S` | Open reader settings |
| `Ctrl+A` | Open annotations panel |
| `F11` | Toggle fullscreen |
| `Escape` | Exit fullscreen / close Theorem Lens / close panels (component-local) |

## Library

There are currently no library-specific keyboard shortcuts. Library view mode and sort are changed from the Library page toolbar.

## Implementation

Shortcut groups are registered via `registerShortcuts()` in `src/core/lib/keyboard-shortcuts.ts`. The system is route-scoped — shortcuts only fire when their route is active. Global shortcuts (navigation, help) always work.

Matching (`matchesCombo`) is exact: the required modifiers must be down and no others
(`⌘⇧1` does not fire `Ctrl+1`; on a Mac, plain Control does not fire it either). Letters are matched
by `event.key` and, failing that, by physical key (`event.code`), so Option-modified letters on a Mac
(`⌥O` types `ø`) still match `Alt+O`. Platform detection is evaluated per event
(`isApplePlatform()`), which keeps it testable (`tests/keyboard-shortcuts.test.ts`).

`formatShortcutKeys()` renders a declaration for display (`⌘ + ⇧ + K` / `Ctrl + Shift + K`).

The `useKeyboardShortcuts()` hook attaches/detaches the single global `keydown` listener on mount/unmount, using `useEffect` cleanup. This prevents shortcuts from leaking across routes.
