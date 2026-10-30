# Design: Physical Card Deck & Bookmark Ribbon Redesign

**Date**: 2026-10-29  
**Status**: ✅ Implemented (`ReviewCardStack.tsx`, and the bookmark ribbon card inside `Bookmarks.tsx` rather than a separate `BookmarkRibbonCard.tsx`; shipping in 1.6.1)  
**Inspiration**: Physical playing/tarot card deck (`media_1793275031006.png`) adhering to Theorem's Swiss editorial design system.

---

## 1. Context & Objectives

1. **Physical Card Deck (`ReviewCardStack`)**:
   - Currently, cards in `ReviewCardStack` are rectangular boxes with a 1px colored line on top. They look like flat digital divs rather than a tactile deck of cards.
   - For bookmarks, `ReviewCardStack` displayed empty quote blocks because bookmarks rarely have selected text.
   - The inspiration image demonstrates a physical card deck with `rounded-2xl` cards, an inset tinted card face, a visible deck of cards underneath with physical depth and edge layering, and a bold card number badge in the top-right corner.

2. **Bookmarks Tab in Workbench (`Bookmarks.tsx`)**:
   - Currently, bookmarks reuse `AnnotationListCard` (designed for highlights and notes), resulting in an awkward blank card with just a small location string.
   - Bookmarks should look like authentic physical bookmarks: ribbon tab styling, book cover preview, chapter title, page/progress badge, and direct reader jump.

---

## 2. Design System Integration

All changes strictly adhere to Theorem's design tokens and aesthetic:
- **Surfaces**: `var(--color-surface)`, `var(--color-surface-muted)`, `var(--color-border)`, `var(--color-border-subtle)`.
- **Colors**: Accent color (`var(--color-accent)`) + `CARD_PALETTES` (terracotta, sage, cobalt, warm ochre, mauve, teal, rose).
- **Typography**:
  - UI / Metadata: `font-sans` (Inter).
  - Quotes / Literature: `font-serif` (Charter/Georgia).
  - Numbers / Badges / Dates: `font-mono` (JetBrains Mono).
- **Radii**: `rounded-2xl` for outer cards, `rounded-xl` for inner card faces, `rounded-lg` for badges.
- **Elevation**: Multi-layered shadows (`shadow-xl dark:shadow-2xl`) combined with layered background cards to simulate physical deck thickness.

---

## 3. Component Details

### A. Physical Card Deck (`ReviewCardStack.tsx`)

1. **Outer Frame & Card Body**:
   - Card dimensions: max width `42rem`, min height `380px`.
   - Card container: `rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-xl p-3 sm:p-4`.
   - Inner face: Inset container `rounded-xl border border-[var(--color-border-subtle)] p-5 sm:p-7 flex flex-col justify-between` with subtle tint background wash.
2. **Physical Deck Underneath**:
   - Card 2 (immediately below): `rounded-2xl`, offset `translate3d(0, 8px, 0)`, slight rotation `1deg`, `scale(0.97)`.
   - Card 3 (base layer): `rounded-2xl`, offset `translate3d(0, 16px, 0)`, counter-rotation `-1.2deg`, `scale(0.94)`.
   - Stack edge shadow simulating 10+ stacked cards beneath.
3. **Card Header**:
   - Left: Source badge pill (`border border-[var(--color-border-subtle)] bg-[var(--color-surface)]/80 px-2.5 py-1 rounded-full text-xs`).
   - Right: Bold index badge (`01`, `02`... of total) styled with `font-mono font-bold text-xs px-2.5 py-1 rounded-lg bg-[var(--color-surface)] border border-[var(--color-border-subtle)] shadow-xs`).
   - Open in reader icon button.
4. **Card Center**:
   - **Highlights/Notes**: Large editorial serif quote + note block with watermark.
   - **Bookmarks**: Bookmark centerpiece with book cover thumbnail, chapter title, page/progress badge, and location.

### B. Bookmarks Tab List View (`BookmarkRibbonCard.tsx` / `Bookmarks.tsx`)

1. **Bookmark Ribbon Item**:
   - Card layout with a left bookmark ribbon accent tab (crimson/accent ribbon fold).
   - Miniature book cover preview thumbnail (`TheoremBookCover` fallback).
   - Chapter title (`font-serif font-medium text-sm text-[color:var(--color-text-primary)]`).
   - Book title and author line.
   - Position & Progress pill: `font-mono text-[11px] px-2 py-0.5 rounded bg-[var(--color-surface-muted)] text-[color:var(--color-text-secondary)]` (e.g. `Page 142 · 38%`).
   - Date created.
   - Direct "Resume Reading" button (`ArrowUpRight`) and more menu.
2. **Virtualization**:
   - Fixed height (~92px) with `useVirtualizer`, perfectly aligned with TanStack virtual scroll.

---

## 4. Verification & Quality Gates

- `pnpm typecheck`
- `pnpm test` (full suite including `tests/workbench-daily-review.test.tsx`)
- `pnpm build` (bundle budget < 700 kB)
- `cargo fmt --check`
