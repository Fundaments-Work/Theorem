# Design system: how to build UI in Theorem

This is the page to read before your first UI change. It covers what the system is, which
pieces to reuse, the rules that are checked for you, and how to add a new shared component.

The visual language itself (palette, type, spacing philosophy) is the studio-wide
`Fundaments-Work/design-system` repo, which is read-only from here. **The shipped code wins:**
`src/core/styles/design-tokens.css` and `src/core/lib/design-tokens.ts` are the reference
implementation, and if the two disagree the document is the bug.

## The five minutes version

1. Run `pnpm dev` and open **http://localhost:1420/ui-gallery.html**. Every shared component and
   colour token is on that page, in both themes, with no Tauri needed.
2. Colours come from tokens: `text-[color:var(--color-text-secondary)]`,
   `bg-[var(--color-surface)]`. Never a hex, never `bg-red-500`.
3. Buttons, icon buttons, chips and text inputs come from `src/ui`. Do not hand-write their
   classes.
4. No rounded corners, no bold. Hierarchy comes from size and colour.
5. Run `pnpm gates:fast` before you push. It runs the design checks for you.

## The pieces

```
src/core/styles/design-tokens.css   tokens (@theme) + the .ui-* classes
src/core/lib/design-tokens.ts       applyAppTheme(), resolveThemeColors(): the runtime half
src/ui/                             shared components (the only place for cross-feature UI)
src/dev/ui-gallery.tsx              the gallery (dev only; never part of `pnpm build`)
scripts/check-design-rules.mjs      the guard behind `pnpm check:design`
```

### Tokens (`design-tokens.css`)

| Group | Tokens | Notes |
|---|---|---|
| Surface | `--color-background`, `--color-surface`, `--color-surface-muted`, `--color-surface-variant`, `--color-surface-hover` | Use `surface` for panels, `surface-muted` for a quiet fill. |
| Text | `--color-text-primary`, `--color-text-secondary`, `--color-text-muted`, `--color-text-disabled` | Hierarchy is colour and size. |
| Border | `--color-border`, `--color-border-subtle`, `--color-border-strong` | `border-strong` is for form controls: it clears 3:1 contrast. Hairlines are decoration. |
| Accent | `--color-accent`, `--color-accent-hover`, `--color-accent-light`, `--color-accent-contrast` | One accent for the whole lab (acid lime `#c6f135` by default). It marks *where you are*; use it once per frame. |
| State | `--color-success`, `--color-warning`, `--color-error`, `--color-info` | |
| Type | `--font-size-4xs` … `--font-size-5xl` | Weights are 300 and 400 only. |
| Space | `--spacing-xxs` … `--spacing-4xl`, `--control-height-sm|md|lg` | |
| Layering | `--z-dropdown`, `--z-sticky`, `--z-nav`, `--z-backdrop`, `--z-modal`, `--z-popover`, `--z-tooltip` | Never write a bare `z-[999]`. |
| Motion | `--duration-fast|normal|slow` | Guard animation with `prefers-reduced-motion`. |
| Safe areas | `--safe-area-top|right|bottom|left` | Never `env(safe-area-inset-*)`. Android's WebView reports the wrong values; `system-insets.ts` feeds the real ones into these tokens. |

Tokens switch with the theme (`applyAppTheme`), and the reader re-points them at the book's
colours inside the reader. If you use tokens, your component themes for free.

### The `.ui-*` classes

Defined once in `design-tokens.css`: `ui-btn`, `ui-btn-primary`, `ui-btn-ghost`, `ui-btn-danger`,
`ui-icon-btn`, `ui-chip-btn`, `ui-tab-btn`, `ui-input`, `ui-card`, `ui-section`, `ui-page-title`,
`ui-selected`, `ui-signal-hover`. You rarely use them directly: the components below wrap them.

### Shared components (`src/ui`)

Import from the barrel in feature code (`import { Button } from "../../ui"`). Only app-shell
entry points (`main.tsx`, `App.tsx`) import specific files, to protect the startup bundle.

| Component | Use it for | Rules baked in |
|---|---|---|
| `Button` | Any text button. `variant`: `default`, `primary`, `ghost`, `danger`. | `type="button"` by default, so it never submits a form by accident. |
| `IconButton` | A bare icon action. | `label` is required (screen-reader name and tooltip). Hover is accent colour, never a background. |
| `Chip` | Filter and option chips. | Selected state is `aria-pressed`, which the tokens style. |
| `TextInput` | Single-line text fields. | Keeps the 3:1 border. Give it a `<label>` or `aria-label`. |
| `Modal`, `ModalHeader/Body/Footer` | Dialogs. | Radix-based, named by its header, Android back button handled. |
| `ConfirmDialog`, `AlertDialog` | Confirmations and notices. | Built on `Button` and `Modal`. |
| `Dropdown`, `ContextMenu` | Menus. | |
| `PageHeader`, `FloatingPanel` | Page chrome and floating panels. | |
| `Spinner`, `PageLoader`, `GlobalLoader` | Loading. | |
| `TheoremBookCover` | A book's cover, with the deterministic fallback. | |
| `toolbar-styles.ts` | Library and Shelves toolbar button classes. | One definition for both pages. |

**Before you write a `<button>`, a modal or a chip row, check this table.** If it is here,
use it. There are still hundreds of hand-written `<button>`s from before these existed;
migrating a screen to the components when you are already changing it is welcome, but do it as
its own commit with no behaviour change.

## Rules, and who checks them

`pnpm check:design` (part of `pnpm gates:fast`, and run in CI) fails if you *add* a violation
of any of these. Existing violations are listed in `scripts/design-rules-baseline.json` and
tolerated, and the file can only shrink.

| Rule | Why |
|---|---|
| No `transition-all` | Name the property (`transition-colors`, `transition-[width]`). `all` animates layout and costs frames. |
| No `rounded-*` | Corner radius is 0 everywhere. The tokens already flatten it, so the class does nothing today, but it tells the next reader the design allows it. |
| No `font-medium/semibold/bold/…` | Only 300 and 400 exist. Same reason as above. |
| No raw `#hex` colours in components | Use a token. Exceptions (share-card palettes, book cover art, the accent swatches) are in the baseline. |
| No Tailwind palette colours (`bg-red-500`) | Use `--color-error` and friends. |
| No `console.log` | Guard with `import.meta.env.DEV`. |
| No `env(safe-area-inset-*)` | Use `--safe-area-*`. |

If you fix a baseline violation, run `pnpm check:design --update` and commit the smaller
baseline. **Do not raise it to make a check pass.** `pnpm check:design --list` prints every
current violation.

These are enforced by a test or by review rather than the script: no `snap-x`, no Zustand
destructuring, no imports from the `src/core` barrel (see AGENTS.md).

## Adding a shared component

1. Put it in `src/ui/MyThing.tsx`: a named export, props typed and exported, `className`
   merged with `cn()`, native props forwarded (`ComponentProps<"button">`).
2. Build it from tokens and the `.ui-*` classes. If it needs new styling that other
   components could share, add a class to `design-tokens.css`, not a one-off.
3. Export it from `src/ui/index.ts`.
4. Add a section to `src/dev/ui-gallery.tsx`: this is how reviewers see it.
5. Add a test in `tests/ui-primitives.test.tsx` (or a file next to it) covering the contract,
   not the class names alone: what it does on click, what it is named, what it forwards.
6. If it is heavy (pulls a library in), make sure it is not imported by `main.tsx`/`App.tsx`:
   `pnpm build` fails if the startup bundle passes 700 kB.

## What is *not* shared yet (good first contributions)

- Large screens (`Library.tsx`, `Settings.tsx`, `Shelves.tsx`, `FeedsPage.tsx`) still build most
  of their buttons and fields by hand. Moving them onto `Button`, `IconButton`, `Chip` and
  `TextInput` is safe, mechanical and well covered by the gallery.
- There is no shared `Select`, `Checkbox`, `Switch`, `Tabs` or `Card` component yet; screens use
  the `.ui-*` classes directly. Add them following the steps above.
- `ReviewCardStack.tsx` and `Bookmarks.tsx` carry `rounded-*` and `font-*` classes from their
  original design; they have no visual effect and can be deleted.

### Explicit layout widths

Use `max-w-[var(--container-width-lg)]` or an appropriate `--layout-*` width
for panels/pages. Named `max-w-lg` / `max-w-4xl` resolve to the spacing namespace
in this app’s compiled theme (1.8rem / 6rem), not a page-width preset. Visual
checks must measure rendered width to catch this. Navigation and Library
controls use `NAV_CONTROL_ICON` from `ui/toolbar-styles.ts` (16px Lucide glyphs).
