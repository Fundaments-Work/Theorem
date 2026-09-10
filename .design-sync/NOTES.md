# Theorem UI Kit — design-sync notes

## Repo shape

Theorem is a Tauri desktop app (PDF/EPUB/RSS reader), not a standalone
component-library package. There is no Storybook and no library build
(`package.json` has no `main`/`module`/`exports`, and `pnpm build` builds
the whole app, not a component bundle). `src/ui/` is a small, genuinely
portable UI kit (~17 components) used throughout the app.

- **Shape**: `package`, with no `dist/` — the converter runs in synth-entry
  mode against `cfg.entry: "./src/ui/index.ts"` (the app's own curated
  public API for this kit) instead of scanning all of `src/`.
- **No `.d.ts` anywhere** (tsconfig has `noEmit: true`) — every component's
  props had to be hand-written into `cfg.dtsPropsFor` because ts-morph has
  no declaration tree to extract from. If a component's props change,
  update `dtsPropsFor.<Name>` by hand; nothing will auto-detect drift.
- `cfg.srcDir` is scoped to `src/ui` (not the default `src`) so fuzzy
  src-matching doesn't wander into the rest of the app.
- `cfg.cssEntry` points at `src/core/styles/design-tokens.css` (Tailwind
  `@theme` tokens + component classes like `.ui-btn*`, `.dict-definition`).
  There's also a `design.md` at the repo root describing the brand/design
  language (mark construction, color, type, spacing, motion) — useful
  background for the conventions header, not itself synced.

## Excluded

- **`GlobalLoader`** — a 6-line wrapper that reads `useUIStore` (zustand)
  and renders `PageLoader`. Not portable standalone without pulling in the
  app's store. `PageLoader`/`Spinner` (its real content) are synced
  instead. If a future sync wants `GlobalLoader` too, it would need a
  `cfg.provider`-style mock store, which isn't worth it for a 6-line
  pass-through.

## Known render-time quirks

- **`KeyboardShortcutsHelp`** calls `getAllShortcuts()` from
  `src/core/lib/keyboard-shortcuts.ts`, a module-level in-memory registry
  populated by other app code via `registerShortcuts(...)`. Outside the
  real app nothing has registered, so the component returns `null` by
  default. The authored preview seeds the registry directly via
  `registerShortcuts()` at module load with realistic sample shortcuts —
  this is the component's real public API, not a fabricated render.
- **`Modal`** calls `useAndroidBackButton`, which registers into
  `src/core/lib/back-navigation.ts` (a plain in-memory LIFO stack, no
  Tauri dependency) — confirmed safe to render standalone.
- **`RouteErrorBoundary`** is a class error boundary; its interesting state
  (the fallback UI) only appears when a child throws. The authored preview
  includes both a normal-children variant and a variant whose child throws
  in an effect, to show both states.

- **`ContextMenu`** opens on a real `contextmenu` pointer event that Radix
  handles internally — there's no prop to force it open. The authored
  preview shows only the trigger surface; the open-menu state can't be
  captured statically.
- **`Dropdown`**'s Radix `DropdownMenu.Root` is uncontrolled (no `open`
  prop exposed by our wrapper) — same limitation, previews show closed
  states only (value/placeholder/size/variant/disabled).
- **`KeyboardShortcutsHelp`** initially rendered `[RENDER] root empty`
  even with a preview that called `registerShortcuts()` at module load,
  via a relative import of `src/core/lib/keyboard-shortcuts`. Root cause:
  the preview and the main bundle are two independent esbuild passes, so
  a relative import bundles a SEPARATE copy of that module with its own
  empty registry — seeding it never reaches the copy the real component
  reads. Fix: added `cfg.extraEntries: ["./src/core/lib/keyboard-shortcuts.ts"]`
  so `registerShortcuts`/`getAllShortcuts` merge onto `window.TheoremUI`
  from the SAME bundle pass the component itself is part of, then the
  preview imports `registerShortcuts` from `'theorem'` (redirected to that
  global at preview-compile time) instead of a relative path. Any future
  preview that needs to seed shared in-repo module state should use this
  same pattern (extraEntries + import from `'theorem'`), never a relative
  import of the source file.

## Overlay overrides

Root cause, worked out by actually reading the screenshots rather than
trusting the render-check's benign-sounding hints:

- `cardMode: "single"` wraps the story in a `transform`-bearing div, which
  becomes the **containing block** for any `position: fixed` descendant
  that *isn't* portalled elsewhere. That wrapper's own height comes only
  from ordinary in-flow content — a `fixed inset-0` child (out-of-flow by
  definition) contributes nothing to it. With no other sibling, the
  wrapper collapses to 0 height, `inset-0` resolves against that 0-tall
  box, and the fixed element paints as a 0-height sliver (a black bg or
  gray overlay you'd never see) while any text inside it still overflows
  and paints wherever flex-centering puts it around that collapsed line.
- **`Backdrop`** and **`SplashScreen`** hit this (they render a plain
  `fixed` div directly, no portal) — fixed by wrapping the component in a
  plain (non-fixed) div with an explicit height in the preview `.tsx`
  itself, so the single-card wrapper has real in-flow height for the
  fixed child to fill against. `cardMode: "single"` is still needed too
  (`viewport` only annotates the `@dsCard` comment for the app's card
  sizing — it does NOT affect what our local Playwright render-check
  screenshots). After the wrapper fix, SplashScreen's screenshot shows the
  full black splash (icon, title, subtitle, loading line) correctly.
  Backdrop's screenshot is a plain gray-filled rectangle with no text —
  confirmed by reading the actual PNG pixels, not assumed: that's the real
  component (a dimming overlay has no content by design), and the small
  file size (`RENDER_BLANK`, PNG <5KB) is expected for a flat color fill,
  not a bug. Recorded as a known render warn, not fixed further.
- **`Modal`/`ConfirmDialog`/`AlertDialog`/`KeyboardShortcutsHelp`** did
  NOT need this fix — they're built on Radix `Dialog.Portal`, which mounts
  to `document.body`, a sibling of the single-card wrapper, not a
  descendant. Their fixed positioning resolves against the real page
  viewport instead, so they rendered correctly with no wrapper div needed.
- Any FUTURE component whose root is a plain (non-portalled) `fixed`
  element and gets `cardMode: "single"` will need this same explicit-height
  wrapper in its preview `.tsx` — this isn't a one-off Backdrop/SplashScreen
  fix, it's the general rule for that combination.

## Grading note: square spinner is correct, not a bug

`Spinner`'s ring renders as a square, not a circle, even though it uses
`rounded-full`. Checked `--radius-full` in `design-tokens.css`: it's `0`,
along with every other `--radius-*` token. This matches `design.md`
exactly ("No rounded corners anywhere, on any element" / "Round any
corner, anywhere" is listed under "Don't"). Every component in this DS is
intentionally square-cornered — don't "fix" square corners on anything
here without checking design.md first.

## Grouping

No `docsDir`/story categories exist, so components group by their `src/ui`
subdirectory: everything flat under `src/ui/` lands in `general`, the
`loading/` subfolder becomes group `loading`. Finer grouping (Overlays,
Forms, Feedback, etc.) could be added later via `cfg.docsMap` stub files
(`---\ncategory: <Group>\n---`) if the DS pane's flat grouping feels too
coarse.

## guidelinesGlob override

The default `guidelinesGlob` (`docs/guides/**/*.md`, `docs/*.md`,
`guides/**/*.md`) would have swept up all 22 files in the repo's `docs/`
folder — these are engineering docs (architecture, Android build, signing
keys, distribution, even a competitive-strategy blueprint), not design
guidance, and several are sensitive. Overrode `guidelinesGlob` to just
`["design.md"]` (the repo-root brand/design-language spec — mark
construction, color, type, spacing, motion). Keep this override on any
re-sync; don't let a future run fall back to the default.

## Fonts

`design-tokens.css` (the synced `cssEntry`) references font-family fallback
chains that name several families the converter flagged as
`[FONT_MISSING]`: "Nimbus Sans L", "EB Garamond", "Lora", "Cascadia Code",
"JetBrains Mono". Checked each:

- **EB Garamond** IS actually shipped by the app — `src/index.css` (not
  `cssEntry`, so the converter's scrape never saw it) declares `@font-face`
  rules loading `public/fonts/eb-garamond-latin-400{,italic}.woff2` via
  Vite's root-absolute `/fonts/...` convention. The font extractor resolves
  `url()` relative to the CSS file's own directory, so a root-absolute path
  can't be followed as-is. Wired via `cfg.extraFonts: [".design-sync/fonts.extra.css"]`
  — a small committed file that mirrors those exact `@font-face` rules with
  the `url()` path rewritten relative to itself. Keep it in sync with
  `src/index.css` if the shipped weights/styles change.
- **"Nimbus Sans L", "Lora", "Cascadia Code", "JetBrains Mono"** — genuinely
  not shipped anywhere in this repo (no `@font-face`, no font files). They're
  plain fallback-chain entries in the CSS variables themselves (e.g.
  `--font-sans: "Helvetica Neue", Helvetica, Arial, "Nimbus Sans L", ...`) —
  the app already relies on the OS/browser having them, or degrading further
  down the same chain. Left as substitutes; this matches the app's own
  real behavior, not an invented approximation.

## Build

No `buildCmd` — nothing needs building before the converter; it reads
`src/ui/*.tsx` directly through the synth entry.

## Re-sync risks

- `dtsPropsFor` is hand-maintained and WILL go stale if a component's
  props change in `src/ui/*.tsx` without a matching config edit — there is
  no automated detection for this given the no-`.d.ts` shape.
- The `KeyboardShortcutsHelp` preview depends on calling the real
  `registerShortcuts()` API at module load; if that function's signature
  changes, the preview needs updating too.
- Default `general`/`loading` grouping is coarse; a future sync could
  improve it without any risk of going stale (grouping is presentational).
