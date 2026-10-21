# Accessibility & Responsive Layout

How Theorem is checked, what the last audit found, and the rules that keep it fixed.

## How it was checked

The app was driven in a real browser (desktop 1280px, phones at 390px and 320px, touch emulation) and
every screen was scanned with **axe-core** (WCAG 2.0/2.1/2.2 A and AA plus best practices) together
with two checks of our own: content poking past the viewport, and interactive elements smaller than
24×24px. Screens covered: Library (plus filter panel and selection mode), Shelves, Workbench,
Bookmarks, Feeds, Discover (home, a catalog, a book sheet, the add-catalog dialog), Statistics, every
Settings tab, and the Reader (page, reading settings, contents, search, annotations).

Repeat it after UI work: inject `axe.min.js` into the page with Playwright (`page.evaluate`), run
`axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a','wcag2aa','wcag21aa','wcag22aa','best-practice'] } })`
on each screen at 320, 390 and 1280px, and fail on any violation. `tests/a11y-shell.test.tsx` holds the
regressions that can be asserted without a browser.

## What the audit found (and fixed)

| Finding | Where | Fix |
|---------|-------|-----|
| Dialogs announced as unnamed | `Modal` labelled itself with an empty heading while the real title was a different element | The visible `ModalHeader` title names the dialog; header-less modals take `ariaLabel` |
| Closed reader panels still tabbable and announced | `FloatingPanel` only faded out | Closed = `inert` + `aria-hidden`; a `label` is required |
| Unlabelled controls | retention `<select>`, five reader sliders, "more actions" buttons | `aria-label`s |
| Controls nested inside `role="button"` | annotation cards in the reader | Card is a plain container; "Jump to" is a real button |
| State only painted | Settings On/Off toggles and option buttons | `aria-pressed` |
| Low contrast | muted text on `--color-surface-muted` (3.9:1), reader-theme muted/secondary text (3.3:1), `opacity-*` on text in several places | Tokens raised (below); `opacity` removed from text |
| No page heading on phones | the only `<h1>` was `display:none` below `sm` | Visually hidden, still in the accessibility tree |
| No landmarks | title bar was a `div`; the reader had no main region | `<header>`, `role="main"` on the reader |
| Skipped heading level | Device Sync used `h3` after `h1` | `h2` |
| Small targets | 16px breadcrumb links, 20px accent swatches, 2px-high reader sliders, 40px toolbar icons | 24px minimum; 44px on touch for toolbar buttons; sliders keep a thin track with a ~28px grab area |
| Long values widening the page | a folder path in Settings (`460 MB at /home/…/tts`) | `[overflow-wrap:anywhere]` and `min-w-0` on setting descriptions |
| Toolbars not using the phone row | Library and Shelves action clusters were right-aligned desktop clusters | Full-width row: Add stretches, icon buttons are 44px |

## Rules

- **Name every dialog.** `Modal` + `ModalHeader`, or `ariaLabel`. A `FloatingPanel` needs `label`.
- **Never leave an offscreen control reachable.** Hide with `inert` (or unmount), not just `opacity-0`.
- **Icon-only controls need `aria-label`.** Toggle-like controls need `aria-pressed`/`aria-expanded`.
- **Do not put interactive elements inside `role="button"`.** Make the primary action a real button.
- **Contrast.** Body and metadata text must reach 4.5:1 on the surface it sits on. The tokens that
  guarantee it: dark `--app-surface-muted` is `#2b2b2f` (muted text `#929292` = 4.55:1), and in reading
  mode `--color-text-secondary`/`--color-text-muted` mix 78%/70% of the reader foreground (≥4.5:1 on
  Light, Sepia and Dark). Do not dim text with `opacity-*`; choose a token.
- **Targets.** At least 24×24px everywhere; 44×44px for primary controls on touch screens.
- **Long strings wrap.** Paths, URLs and identifiers get `[overflow-wrap:anywhere]` and their flex/grid
  parent gets `min-w-0`.
- **Use explicit sizes, not named Tailwind max-widths.** `max-w-sm`/`max-w-md` are not defined by this
  project's theme and collapse to almost nothing; write `max-w-[28rem]`.
- **One `h1` per page**, present at every width.
