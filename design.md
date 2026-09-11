# Theorem — Design Language

v1.0 · fundaments.work · 2026

> **Note**: This is the original brand/design-language spec. The shipped
> implementation is defined by `src/core/styles/design-tokens.css`
> (`--color-*`, `--font-*`, `--duration-*` tokens and `.ui-btn*` classes).
> Where the two differ, the code is authoritative; the concrete token/class
> names below are aligned with it.

## Concept

The mark is a constructed turnstile (⊢) — the logical notation for "derives" or "therefore." It is never the literal Unicode ⊢ character; it's always built from two rectangles per the anatomy spec below, so it renders identically across every platform, weight, and rasterizer.

A theorem is a statement derived from axioms through valid steps. The symbol that proof theory uses for "derives" is the same symbol that names the product. The mark isn't decorative — it's the logo and the thesis in one shape.

## Mark anatomy

| Property | Value |
|---|---|
| Vertical bar width | 12.5% of mark height |
| Horizontal bar (midbar) weight | same as vertical bar |
| Midbar position | 44% from top — **not centered**. Centering makes it read as a capital F instead of a logical symbol. |
| Midbar length | 62% of total mark width, extending right from the vertical bar |
| Minimum size | 14px tall — below this the midbar gap collapses |
| Clear space | 1× mark height on all sides, minimum |

### Reference sizes

| Context | Size |
|---|---|
| Display | 48px |
| UI (toolbar, nav) | 32px |
| Inline (buttons, lists) | 20px |
| Minimum (favicon, dense UI) | 14px |

### Construction (SVG)

The mark is authored as inline SVG (`theorem.svg`, `public/favicon.svg`) and rendered in `src/ui/TheoremBookCover.tsx`. There is no `.mark` CSS class in the codebase; the values below describe the SVG geometry.

```text
Vertical bar:   ~12.5% of mark height
Midbar:         same weight as the vertical bar, 44% from top, 62% of total width
```

### Never

- Never use the literal Unicode ⊢ (U+22A2) character — always the constructed shape, so weight and proportion stay under control.
- Never rotate, skew, or outline the mark.
- Never recolor the umbrella mark. Product-level tinting is limited to the accent rules below.

## Lockups

- **Horizontal** — mark + "Theorem" + "fundaments.work" credit beneath, in the mono stack, smaller and muted.
- **Stacked** — mark above, wordmark + credit below, left-aligned.
- **Reversed** — same lockup with ink/paper swapped, for dark surfaces (splash screen, dock icon background).

"Theorem" is always weight 300. Never bold, never italic — except for the rare editorial blockquote moment in long-form body copy.

## Color

### Neutral scale

| Token | Hex | Use |
|---|---|---|
| `--color-text-primary` | `#1a1a1a` | primary text, mark fill |
| `--color-text-secondary` | `#666666` | secondary text, captions |
| `--color-text-muted` | `#666666` | tertiary text, disabled states |
| `--color-border` | `#e5e5e5` | borders, dividers |
| `--color-surface-muted` | `#fafafa` | secondary surface, hover background |
| `--color-surface` | `#ffffff` | primary background |

### Accent

| Token | Default | Use |
|---|---|---|
| `--color-accent` | `#1a1a1a` | interactive emphasis; user-selectable (8 presets) |
| `--color-accent-hover` | `#000000` | hover state |
| `--color-accent-contrast` | `#ffffff` | text on accent surfaces |

Reading surfaces use the separate `--reader-*` tokens (`--reader-bg`, `--reader-fg`, `--reader-link`), which change per reader theme.

## Typography

Font stack (`--font-*` tokens in `src/core/styles/design-tokens.css`):
- `--font-sans`: Helvetica Neue → Helvetica → Arial → sans-serif
- `--font-serif`: EB Garamond → Lora → Georgia → serif
- `--font-mono`: SF Mono → Cascadia Code → JetBrains Mono → Consolas → monospace

Weight contrast comes from size and color, not boldness.

| Style | Font / weight | Size | Letter-spacing | Use |
|---|---|---|---|---|
| Display | Sans 300 | 32px | −3% | Marketing headlines |
| Headline | Sans 300 | 20px | −2% | Section headers |
| Body | Sans 400 | 14px | −1% | Reading UI, descriptions |
| Caption | Sans 300 | 12px | 0% | Secondary descriptions |
| Label | Mono 400 | 11px | +8%, uppercase | Format tags, metadata |
| Micro | Mono 300 | 10px | +4% | Version strings, timestamps |

## Spacing

Base unit: **4px**. All spacing is a multiple of 4 — `4, 8, 12, 16, 24, 32, 48, 64, 96`. No arbitrary values outside this scale.

- Component-internal gaps: 8–16px
- Component-to-component: 16–24px
- Section gaps: 64px
- Page margins: 48px desktop, 24px mobile

## Components

### Buttons

The kit ships `.ui-btn` (base), `.ui-btn-primary`, `.ui-btn-ghost`, and `.ui-btn-danger`. All use square corners (`--radius-*` tokens are `0`). Primary buttons use `--color-accent`; ghost/danger use transparent backgrounds with a hairline border.

No rounded corners on UI chrome, cards, or controls.

### Reading progress

Progress is rendered with the reader's `--reader-*` / `--color-accent` tokens. There are no `.progress-track` / `.progress-fill` utility classes.

### Tags

Mono, 10px. Used for format (`epub` / `pdf`), status (`reading` / `finished`), and version metadata. Status tags use `--color-accent` as an outline; all others stay neutral.

### Library list item

Cover placeholder (monochrome rect with monogram initials if no cover art) + title (sans 400) + author (mono, muted, uppercase) + inline progress bar + status tag.

## Motion

| | |
|---|---|
| Durations | `--duration-fast: 150ms` · `--duration-normal: 220ms` · `--duration-slow: 320ms` |
| Easing | `cubic-bezier(0.22, 1, 0.36, 1)` (`--transition-fast` / `--transition-normal` / `--transition-slow`) — no bounce, no spring |
| Principle | Motion confirms a reading-state change (page turned, book opened, progress updated). It never decorates. |

## Icon contexts

| Context | Spec |
|---|---|
| Favicon | 32×32, mark only, ink on paper |
| App / dock icon | 512×512 master, scaled down — mark only |
| Social avatar | mark centered in circle crop, reversed (paper mark on ink) |
| OG / share banner | reversed lockup — "Theorem" + fundaments.work credit |

## Usage rules

**Do**
- Use the mark alone wherever space is tight (favicon, dock icon, tab)
- Use the mono stack for every piece of metadata — page count, file format, file size, progress percentage
- Use `--color-accent` for interactive emphasis
- Keep "Theorem" at weight 300 everywhere
- Maintain 1× mark-height clear space around the mark

**Don't**
- Rotate, skew, or outline the mark
- Bold the wordmark for emphasis — use size, not weight
- Place the mark on a photographic or patterned background
- Round corners on UI chrome, cards, or controls

---

v1.0 · fundaments.work · 2026