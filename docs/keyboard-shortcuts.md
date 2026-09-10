# Keyboard Shortcuts

## Global (Universal)

| Shortcut | Action |
|----------|--------|
| `Ctrl+1` | Go to Library |
| `Ctrl+2` | Go to Shelves |
| `Ctrl+3` | Go to Feeds |
| `Ctrl+4` | Go to Workbench (Annotations & Vocab) |
| `Ctrl+5` | Go to Statistics |
| `Ctrl+7` | Go to Bookmarks |
| `Ctrl+,` | Go to Settings |
| `Ctrl+F` | Focus search bar |
| `Ctrl+B` | Toggle sidebar |
| `Ctrl+A` | Toggle select mode (Library/Shelves/Bookmarks) — currently a no-op; targets a missing `data-action="toggle-select-mode"` element |
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

The `useKeyboardShortcuts()` hook attaches/detaches the single global `keydown` listener on mount/unmount, using `useEffect` cleanup. This prevents shortcuts from leaking across routes.
