# RSS Feed Swipe Actions & Daily Review Deck Design

**Date**: 2026-10-29  
**Status**: Approved / In Progress  

---

## 1. Executive Summary

This specification outlines two complementary interaction features for Theorem:
1. **Swipe Actions on RSS Feed Items**: Fluid, one-handed mobile triage for article rows in `FeedsPage.tsx` (Swipe Right to Mark Read; Swipe Left to Delete with an Undo toast).
2. **Daily Review Card Deck**: A calm, tactile fullscreen card stack for resurfacing 5–7 highlights and notes each day from books and RSS articles, complete with realistic 3D card physics, rotation, and completion states.

---

## 2. Feature 1: RSS Feed Swipe Action

### 2.1 Interaction & Behavior
- **Swipe Right**: Triggers `markArticleRead(article.id)`. The revealed background transitions to accent/success with a `CheckCheck` icon. Card snaps back to position upon release.
- **Swipe Left**: Triggers `deleteArticle(article.id)`. The revealed background transitions to destructive red with a `Trash2` icon. The card slides smoothly off-screen, followed by an undoable notification via Sonner (`"Article deleted" [Undo]`).
- **Short Drag (< 72px threshold)**: The card springs back to `translateX(0)` with a gentle ease.

### 2.2 Gesture & Virtualizer Architecture
- Component: `src/features/feeds/components/SwipeableArticleItem.tsx`
- **Direction Locking**:
  - On `onTouchStart`, records initial `(clientX, clientY)`.
  - On `onTouchMove`, computes `|dx|` and `|dy|`.
  - If `|dy| > |dx|`, the gesture is immediately locked to vertical scrolling (native browser scroll, zero horizontal translation).
  - If `|dx| >= |dy|`, horizontal touch drag is captured, applying `transform: translateX(${dx}px)` to the inner container (`will-change: transform`).
- **TanStack Virtualizer Safety**:
  - The outer row dimensions remain unaffected by the swipe transform, ensuring no layout jitter, height recalculation, or scroll jumps occur in `useVirtualizer`.

---

## 3. Feature 2: Daily Review Card Deck

### 3.1 Purpose & Philosophy
People accumulate hundreds of highlights across books and RSS articles but rarely revisit them (the "collector's fallacy"). Rather than implementing a stressful, gamified Anki-style flashcard engine with grading buttons, Theorem adopts a **calm daily resurfacing** model: 5 cards each day to read, reflect upon, or jump directly back into the book/article.

### 3.2 3D Card Stack Physics & Animation
- Component: `src/features/library/components/DailyReviewModal.tsx` and `ReviewCardStack.tsx`
- **Layered Spatial Stack**:
  - Active Card (Top): `scale(1.0)`, `translateY(0)`, elevation shadow, interactive.
  - Next Card: `scale(0.96)`, `translateY(12px)`, opacity `0.75`, providing realistic physical depth.
  - Underneath Card: `scale(0.92)`, `translateY(24px)`, opacity `0.45`.
- **Drag & Throw Physics**:
  - Supports both touch and pointer/mouse drag (`onPointerDown`, `onPointerMove`, `onPointerUp`).
  - Dynamic rotation: `rotate(${dx * 0.04}deg)` pivots from slightly below center, simulating a thumb flicking an index card.
  - As the top card is dragged, the card underneath scales up to `1.0` in direct proportion to drag distance.
  - Flinging with `velocity > 0.3 px/ms` or past `120px` accelerates the top card off-screen and advances the stack.
  - A reverse button or left swipe allows pulling back the previous card.

### 3.3 Daily Selection Algorithm
- Pulls from `useLibraryStore.getState().annotations` where `selectedText` or `noteContent` is present.
- Deterministic seed generated from `YYYY-MM-DD` so the day's deck is identical across visits.
- Selects 5 items: 3 recent (past 30 days) and 2 older resurfaced notes.
- Progress tracked in `localStorage`: `{ date: "YYYY-MM-DD", completed: boolean }`.
- Completion screen shows a serene "All caught up for today" milestone with reading stats.

### 3.4 Integration Points
- **Workbench (Annotations)**: Header action `Daily Review (5)` with unreviewed badge.
- **Library Page**: Subtle discovery card/pill in the top utility area when today's deck has not yet been reviewed.

---

## 4. Testing & Verification

1. **Unit Tests (`tests/swipeable-article-item.test.ts`)**:
   - Direction lock: Vertical scrolling is never blocked by horizontal gestures.
   - Threshold firing: Swipe right marks read; swipe left invokes delete.
   - Snap-back behavior on sub-threshold drags.
2. **Unit Tests (`tests/daily-review-deck.test.ts`)**:
   - Deterministic selection: Same date produces identical card ordering.
   - Graceful fallback for libraries with 0, 1, or < 5 annotations.
   - Review completion state persistence.
3. **Full Suite Quality Gates**:
   - `cargo fmt --check`
   - `cargo clippy --all-features --all-targets -- -D warnings`
   - `cargo test --workspace --lib --tests`
   - `pnpm typecheck`
   - `pnpm test`
   - `pnpm build`
